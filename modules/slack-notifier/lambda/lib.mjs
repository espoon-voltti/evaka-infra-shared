// Shared helpers for the notifier: the Slack sink, the SSM webhook cache, the
// Logs Insights query runner, log-group resolution, and the small formatting
// utilities the checks and message handlers reuse. Everything specific to one
// kind of alert lives in its own file under checks/ or messages/.

import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeLogGroupsCommand
} from '@aws-sdk/client-cloudwatch-logs'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

export const REGION = process.env.AWS_REGION ?? 'eu-west-1'

// The overlap and indexing-delay assume the EventBridge schedule's rate(5
// minutes) cadence, same as LOG_QUERY_SECONDS's default.
export const LOG_QUERY_SECONDS = parseInt(
  process.env.LOG_QUERY_SECONDS ?? '300',
  10
)
export const OVERLAP_SECONDS = 10
export const CLOUDWATCH_INDEXING_DELAY_SECONDS = 5 * 60

// Delays (ms) before each GetQueryResults poll: fast initial checks, max ~10s.
export const POLL_DELAYS_MS = [
  0, 100, 200, 400, 800, 1200, 1500, 1800, 2000, 2000
]

// CloudWatch Logs Insights rejects a query naming more than this many log groups.
export const MAX_QUERY_LOG_GROUPS = 50

const logsClient = new CloudWatchLogsClient({ region: REGION })
const ssmClient = new SSMClient()

let cachedWebhookUrl = null

export async function getSlackWebhookUrl() {
  if (cachedWebhookUrl) return cachedWebhookUrl
  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: process.env.SLACK_WEBHOOK_SSM_NAME,
      WithDecryption: true
    })
  )
  return result.Parameter.Value
}

export async function postToSlack(payload) {
  const webhookUrl = await getSlackWebhookUrl()
  const channel = process.env.SLACK_CHANNEL
  const username = process.env.SLACK_USERNAME
  const body = {
    ...payload,
    ...(channel ? { channel } : {}),
    ...(username ? { username } : {})
  }
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  console.log(`Slack response: ${response.status}`)

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to post to Slack: ${response.status} ${text}`)
  }

  // Cache only a URL confirmed to work. A bad value (e.g. an unset SSM
  // placeholder) makes fetch reject before this point, so it is never cached
  // for the lifetime of a warm container.
  cachedWebhookUrl = webhookUrl
}

export async function warnSlack(reason) {
  await postToSlack({
    attachments: [
      {
        color: '#ff9800',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:warning: *Log error check failed* — ${reason}`
            }
          }
        ]
      }
    ]
  })
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function consoleDomain(partition) {
  return partition === 'aws-eusc' ? 'amazonaws-eusc.eu' : 'aws.amazon.com'
}

export function formatTimestamp(isoString) {
  const date = new Date(isoString)
  if (isNaN(date.getTime())) return isoString
  return date.toLocaleString('fi-FI', {
    timeZone: 'Europe/Helsinki',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export async function discoverLogGroupNames(prefixes) {
  const names = new Set()
  for (const prefix of prefixes) {
    let nextToken
    do {
      const response = await logsClient.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken })
      )
      for (const group of response.logGroups ?? []) {
        if (group.logGroupName) names.add(group.logGroupName)
      }
      nextToken = response.nextToken
    } while (nextToken)
  }
  return names
}

export async function resolveSourceLogGroupNames(source) {
  // Explicitly configured names go in first so they survive the cap below.
  const names = new Set(source.log_group_names ?? [])
  if (source.log_group_name_prefixes?.length) {
    for (const name of await discoverLogGroupNames(
      source.log_group_name_prefixes
    )) {
      names.add(name)
    }
  }

  const resolved = [...names]
  if (resolved.length <= MAX_QUERY_LOG_GROUPS) return resolved

  const dropped = resolved.slice(MAX_QUERY_LOG_GROUPS)
  console.warn(
    `Resolved ${resolved.length} log groups, more than the ${MAX_QUERY_LOG_GROUPS} a query accepts — not scanning: ${dropped.join(
      ', '
    )}`
  )
  return resolved.slice(0, MAX_QUERY_LOG_GROUPS)
}

// A source name alone (e.g. "service") is ambiguous once one Lambda/channel
// serves several projects on the same account. Prefer "<app-env>/<sourceName>"
// parsed off the resolved log group's /aws/ecs/<app-env>/<component> convention.
// Falls back to the source name alone when a source resolves to zero or several
// log groups, or an unfamiliar naming scheme.
export function deriveSourceLabel(sourceName, logGroupNames) {
  if (logGroupNames.length === 1) {
    const match = logGroupNames[0].match(/^\/aws\/ecs\/(.+)\/[^/]+$/)
    if (match) return `${match[1]}/${sourceName}`
  }
  return sourceName
}

// The scheduled checks share one query window: overlap past the schedule and
// allow for indexing delay so an event on a boundary is not missed.
export function defaultQueryWindow() {
  const endTime =
    Math.floor(Date.now() / 1000) - CLOUDWATCH_INDEXING_DELAY_SECONDS
  const startTime = endTime - LOG_QUERY_SECONDS - OVERLAP_SECONDS
  return { startTime, endTime }
}

// Run a Logs Insights query to completion. Returns { results, statistics } on
// success, or { results: null, lastStatus, attempts, elapsedMs } on
// failure/timeout so the caller can report it.
export async function runInsightsQuery(
  logGroupNames,
  queryString,
  startTime,
  endTime
) {
  let queryId
  try {
    ;({ queryId } = await logsClient.send(
      new StartQueryCommand({ logGroupNames, startTime, endTime, queryString })
    ))
  } catch (err) {
    // A log group younger than the query window (just created) or a window past
    // its retention makes StartQuery reject the whole query. Either way the
    // window holds no data, so report nothing rather than paging — this is the
    // normal state of a freshly created log source for its first few minutes.
    if (
      err.name === 'MalformedQueryException' &&
      /creation time|retention/i.test(err.message ?? '')
    ) {
      console.log(
        `No queryable window yet for ${logGroupNames.join(', ')}: ${err.message}`
      )
      return { results: [] }
    }
    throw err
  }

  let lastStatus = 'Running'
  let attempts = 0
  const pollStartMs = Date.now()
  for (const delayMs of POLL_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs)
    attempts++
    const response = await logsClient.send(
      new GetQueryResultsCommand({ queryId })
    )
    if (response.status === 'Complete') {
      return {
        results: response.results ?? [],
        statistics: response.statistics ?? null
      }
    }
    lastStatus = response.status
    if (['Failed', 'Cancelled', 'Timeout'].includes(response.status)) break
  }
  return {
    results: null,
    lastStatus,
    attempts,
    elapsedMs: Date.now() - pollStartMs
  }
}
