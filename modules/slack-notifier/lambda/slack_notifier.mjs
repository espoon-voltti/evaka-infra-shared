import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand
} from '@aws-sdk/client-cloudwatch-logs'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const ssmClient = new SSMClient()
let cachedWebhookUrl = null

async function getSlackWebhookUrl() {
  if (cachedWebhookUrl) return cachedWebhookUrl
  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: process.env.SLACK_WEBHOOK_SSM_NAME,
      WithDecryption: true
    })
  )
  cachedWebhookUrl = result.Parameter.Value
  return cachedWebhookUrl
}
const LOG_GROUP_NAMES = (process.env.LOG_GROUP_NAMES ?? '')
  .split(',')
  .filter(Boolean)
const LOG_QUERY_SECONDS = parseInt(process.env.LOG_QUERY_SECONDS ?? '300', 10)
const REGION = process.env.AWS_REGION ?? 'eu-west-1'

const logsClient = new CloudWatchLogsClient({ region: REGION })

export async function handler(event) {
  if ('Records' in event) {
    for (const record of event.Records) {
      try {
        const message = JSON.parse(record.Sns.Message)
        await handleAlarm(message)
      } catch (err) {
        console.error(
          'Failed to process SNS record:',
          err,
          JSON.stringify(record)
        )
      }
    }
  } else if (event.source === 'aws.events') {
    try {
      await handleLogCheck()
    } catch (err) {
      console.error('Failed to handle log check:', err)
    }
  } else {
    console.log('Unknown event type:', JSON.stringify(event))
  }
}

function buildAlarmPayload(message, region) {
  const alarmName = message.AlarmName ?? 'Unknown alarm'
  const newState = message.NewStateValue ?? 'UNKNOWN'
  const reason = message.NewStateReason ?? ''
  const description = message.AlarmDescription ?? ''
  const timestamp = message.StateChangeTime ?? ''

  const color = newState === 'ALARM' ? '#d32f2f' : '#4caf50'
  const emoji = newState === 'ALARM' ? ':red_circle:' : ':large_green_circle:'

  const consoleUrl =
    `https://${region}.console.aws.amazon.com/cloudwatch/deeplink.js` +
    `?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${alarmName}* is now *${newState}*`
      }
    }
  ]

  const fields = []
  if (description) {
    fields.push({ type: 'mrkdwn', text: `*Description:*\n${description}` })
  }
  if (reason) {
    const shortReason =
      reason.length > 300 ? reason.slice(0, 300) + '...' : reason
    fields.push({ type: 'mrkdwn', text: `*Reason:*\n${shortReason}` })
  }
  if (timestamp) {
    fields.push({
      type: 'mrkdwn',
      text: `*Time:*\n${formatTimestamp(timestamp)}`
    })
  }

  if (fields.length > 0) {
    blocks.push({ type: 'section', fields })
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `<${consoleUrl}|:mag: View in CloudWatch>`
    }
  })

  return { attachments: [{ color, blocks }] }
}

async function handleAlarm(message) {
  const payload = buildAlarmPayload(message, REGION)
  await postToSlack(payload)
}

async function handleLogCheck() {
  if (LOG_GROUP_NAMES.length === 0) {
    console.log('LOG_GROUP_NAMES not set, skipping log check')
    return
  }

  // We might miss an error due to trigger drift and indexing delay,
  // so we overlap the query window a bit and allow some time for logs to be indexed before querying.
  const OVERLAP_SECONDS = 10
  const CLOUDWATCH_INDEXING_DELAY_SECONDS = 5 * 60
  const endTime =
    Math.floor(Date.now() / 1000) - CLOUDWATCH_INDEXING_DELAY_SECONDS
  const startTime = endTime - LOG_QUERY_SECONDS - OVERLAP_SECONDS

  const queryParts = [
    'filter tolower(logLevel) = "error"',
    'filter not (loggerName like /^evaka\\.core\\.shared\\.async\\.AsyncJobPool\\./ and meta.remainingAttempts > 0)',
    'filter loggerName not like /^evaka\\.core\\.varda\\./',
    'filter not (exception = "UnableToExecuteStatementException" and (message like /staff_attendance_no_overlaps/ or message like /staff_attendance_plan_no_overlaps/))',
    'sort @timestamp asc',
    'limit 20'
  ]
  const query = ['fields @timestamp, @message', ...queryParts].join('\n| ')
  const insightsFields =
    'fields @timestamp, appName, if(not isempty(httpMethod) and not isempty(httpRoute), concat(httpMethod, " ", httpRoute), loggerName) as endpoint, logLevel, message, stackTrace'
  const insightsQuery = [insightsFields, ...queryParts].join('\n| ')

  const startResponse = await logsClient.send(
    new StartQueryCommand({
      logGroupNames: LOG_GROUP_NAMES,
      startTime,
      endTime,
      queryString: query
    })
  )

  const queryId = startResponse.queryId

  // Delays (ms) before each poll attempt: fast initial checks, max. ~10s total.
  const delays = [0, 100, 200, 400, 800, 1200, 1500, 1800, 2000, 2000]
  let results = null
  let lastStatus = 'Running'
  let attempts = 0
  const pollStartMs = Date.now()
  for (const delayMs of delays) {
    if (delayMs > 0) await sleep(delayMs)
    attempts++

    const response = await logsClient.send(
      new GetQueryResultsCommand({ queryId })
    )

    if (response.status === 'Complete') {
      results = response.results ?? []
      break
    }

    lastStatus = response.status
    if (['Failed', 'Cancelled', 'Timeout'].includes(response.status)) {
      console.error(
        `Log query ended with status: ${
          response.status
        } after ${attempts} attempts (${Date.now() - pollStartMs}ms elapsed)`
      )
      break
    }
  }

  if (!results) {
    const elapsedMs = Date.now() - pollStartMs
    console.warn(
      `Log query failed — last status: ${lastStatus}, ${attempts} attempts, ${elapsedMs}ms elapsed`
    )
    await warnSlack(
      `log error query failed — last status: ${lastStatus}, ${attempts} attempts, ${elapsedMs}ms elapsed`
    )
    return
  }

  if (results.length === 0) {
    return
  }

  const errorLines = []
  for (const row of results.slice(0, 10)) {
    const timestamp = row.find((f) => f.field === '@timestamp')?.value ?? ''
    const message = row.find((f) => f.field === '@message')?.value ?? ''

    if (!message) continue

    try {
      const parsed = JSON.parse(message)
      const ts = formatTimestamp(timestamp)
      const logger = parsed.loggerName ?? ''
      let msg = parsed.message ?? ''
      if (msg.length > 200) msg = msg.slice(0, 200) + '...'

      const traceId = parsed.traceId ?? ''
      const safeTraceId = traceId.replace(/[^a-fA-F0-9\-]/g, '')

      // Line 1: timestamp, HTTP method/path, logger
      const line1Parts = []
      if (safeTraceId) {
        const traceQuery = [
          'fields @timestamp, appName, if(not isempty(httpMethod) and not isempty(httpRoute), concat(httpMethod, " ", httpRoute), loggerName) as endpoint, logLevel, message, stackTrace',
          `filter traceId = "${safeTraceId}"`,
          'sort @timestamp asc'
        ].join('\n| ')
        const traceUrl = buildLogInsightsUrl(
          traceQuery,
          LOG_GROUP_NAMES,
          startTime,
          endTime
        )
        line1Parts.push(`<${traceUrl}|${ts}>`)
      } else {
        line1Parts.push(ts)
      }

      const method = parsed.httpMethod ?? ''
      const path = parsed.path ?? ''
      if (method && path) {
        line1Parts.push(`*${method} ${path}*`)
      }

      if (logger) {
        const shortLogger = logger.split('.').pop()
        line1Parts.push(shortLogger)
      }

      // Line 2: exception class + message
      const exception = parsed.exception ?? ''
      const shortException = exception ? exception.split('.').pop() : ''
      const line2 = shortException ? `${shortException}: ${msg}` : msg

      // Line 3: stack trace throw site
      let line3 = ''
      if (parsed.stackTrace) {
        const traceLine = extractThrowSite(parsed.stackTrace)
        if (traceLine) {
          line3 = `\`${traceLine}\``
        }
      }

      const lines = [line1Parts.join(' '), line2]
      if (line3) lines.push(line3)
      errorLines.push(lines.join('\n'))
    } catch {
      const shortMsg = message.slice(0, 200)
      errorLines.push(`\`${formatTimestamp(timestamp)}\` ${shortMsg}`)
    }
  }

  const hasMore = results.length > 10
  const periodMinutes = Math.floor(LOG_QUERY_SECONDS / 60)
  const header = `:red_circle: *${
    hasMore ? 'More than 10' : results.length
  } error(s) in the last ${periodMinutes} minutes*`

  const insightsUrl = buildLogInsightsUrl(
    insightsQuery,
    LOG_GROUP_NAMES,
    startTime,
    endTime
  )

  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: header } }]

  for (const line of errorLines) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: line } })
  }

  if (hasMore) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `_...and there's more_` }
    })
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `<${insightsUrl}|:mag: View in CloudWatch Logs>`
    }
  })

  try {
    await postToSlack({ attachments: [{ color: '#d32f2f', blocks }] })
  } catch (err) {
    console.error('Failed to post detailed message, trying fallback:', err)
    const fallbackBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *${results.length} error(s) detected but failed to send detailed report*`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<${insightsUrl}|:mag: View in CloudWatch Logs>`
        }
      }
    ]
    await postToSlack({
      attachments: [{ color: '#d32f2f', blocks: fallbackBlocks }]
    })
  }
}

async function postToSlack(payload) {
  const webhookUrl = await getSlackWebhookUrl()
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  console.log(`Slack response: ${response.status}`)

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to post to Slack: ${response.status} ${body}`)
  }
}

async function warnSlack(reason) {
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

function formatTimestamp(isoString) {
  const date = new Date(isoString)
  if (isNaN(date.getTime())) return isoString
  return date.toLocaleString('fi-FI', {
    timeZone: 'Europe/Helsinki',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractThrowSite(stackTrace) {
  const lines = stackTrace.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Find first "at" line from evaka code (skip framework/library frames)
    if (
      trimmed.startsWith('at evaka.') &&
      !trimmed.includes('ExceptionHandler')
    ) {
      // Extract "at evaka.foo.Bar.method(File.kt:42)" -> "foo.Bar.method(File.kt:42)"
      const match = trimmed.match(/^at evaka\.(.+)$/)
      if (match) return match[1]
    }
  }
  return null
}

function buildLogInsightsUrl(
  query,
  logGroups,
  startTime,
  endTime,
  region = REGION
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
    `https://${region}.console.aws.amazon.com/cloudwatch/home` +
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

export {
  formatTimestamp,
  extractThrowSite,
  buildLogInsightsUrl,
  buildAlarmPayload
}
