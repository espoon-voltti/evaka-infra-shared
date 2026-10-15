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

// The overlap and indexing-delay assume the EventBridge schedule's 5-minute
// cadence, same as LOG_QUERY_SECONDS's default.
export const LOG_QUERY_SECONDS = parseInt(
  process.env.LOG_QUERY_SECONDS ?? '300',
  10
)
export const OVERLAP_SECONDS = 10
export const CLOUDWATCH_INDEXING_DELAY_SECONDS = 5 * 60

// Logs Insights sometimes keeps a query Scheduled for over 20 s before running
// it, so a check keeps polling this long before reporting the query as failed.
// It must stay well under the lambda timeout in main.tf: an invocation killed
// while a scan is still polling cannot warn Slack at all.
export const QUERY_DEADLINE_MS = 40_000

// Delays (ms) before successive GetQueryResults polls: quick at first, since
// most queries finish in under a second, then POLL_INTERVAL_MS apart.
const POLL_BACKOFF_MS = [0, 100, 200, 400, 800, 1200, 1500, 1800]
const POLL_INTERVAL_MS = 2000

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

// channelOverride routes one source's messages somewhere other than the
// account's channel, e.g. a noisy source to an infra channel while the app's
// own alerts stay where its team reads them.
export async function postToSlack(payload, channelOverride) {
  const webhookUrl = await getSlackWebhookUrl()
  const channel = channelOverride ?? process.env.SLACK_CHANNEL
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

export async function warnSlack(reason, headline = 'Log error check failed') {
  await postToSlack({
    attachments: [
      {
        color: '#ff9800',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:warning: *${headline}* — ${reason}`
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

export function buildAlarmConsoleUrl(alarmName, region, partition = 'aws') {
  return (
    `https://${region}.console.${consoleDomain(partition)}/cloudwatch/deeplink.js` +
    `?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`
  )
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

// Date and time, for an event that may be days old where the time alone would
// not say which day. sv-SE is the locale whose format is ISO-like.
export function formatDateTime(date) {
  const parsed = date instanceof Date ? date : new Date(date)
  if (isNaN(parsed.getTime())) return String(date)
  return parsed.toLocaleString('sv-SE', {
    timeZone: 'Europe/Helsinki',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`
  if (hours > 0) {
    const rest = minutes % 60
    return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`
  }
  return `${minutes} min`
}

export function buildLogInsightsUrl(
  query,
  logGroups,
  startTime,
  endTime,
  region = REGION,
  partition = 'aws'
) {
  // CloudWatch console URL fragment encoding is undocumented by AWS.
  // See https://github.com/aws/aws-sdk-js-v3/issues/6016
  const encode = (str) =>
    str.replace(
      /[~'()*\s"\\|/=<>]/g,
      (ch) => '*' + ch.charCodeAt(0).toString(16).padStart(2, '0')
    )
  const sourceList = logGroups.map((g) => `~'${encode(g)}`).join('')
  return (
    `https://${region}.console.${consoleDomain(partition)}/cloudwatch/home` +
    `?region=${region}#logsV2:logs-insights` +
    `$3FqueryDetail$3D~(` +
    `end~${endTime * 1000}` +
    `~start~${startTime * 1000}` +
    `~timeType~'ABSOLUTE` +
    `~unit~'seconds` +
    `~editorString~'${encode(query)}` +
    `~source~(${sourceList}))`
  )
}

export function resolveMatchedCount(statistics, resultsLength) {
  const matched = statistics?.recordsMatched
  return typeof matched === 'number' ? Math.round(matched) : resultsLength
}

export function formatRemainder(matchedCount, shownCount) {
  const remainder = matchedCount - shownCount
  return remainder > 0 ? `_...and ${remainder} more not shown_` : null
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
  endTime,
  { deadlineMs = QUERY_DEADLINE_MS } = {}
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
  for (;;) {
    const delayMs = POLL_BACKOFF_MS[attempts] ?? POLL_INTERVAL_MS
    if (Date.now() - pollStartMs + delayMs > deadlineMs) break
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
