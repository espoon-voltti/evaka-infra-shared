import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeLogGroupsCommand
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
  return result.Parameter.Value
}
const LOG_GROUP_NAMES = (process.env.LOG_GROUP_NAMES ?? '')
  .split(',')
  .filter(Boolean)
const LOG_QUERY_SECONDS = parseInt(process.env.LOG_QUERY_SECONDS ?? '300', 10)
const LOG_SOURCES = JSON.parse(process.env.LOG_SOURCES_JSON ?? '{}')
const REGION = process.env.AWS_REGION ?? 'eu-west-1'

// The lambda's overlap and CloudWatch-indexing-delay assume the EventBridge
// schedule's rate(5 minutes) cadence, same as LOG_QUERY_SECONDS's default.
const OVERLAP_SECONDS = 10
const CLOUDWATCH_INDEXING_DELAY_SECONDS = 5 * 60

// Delays (ms) before each GetQueryResults poll: fast initial checks, max. ~10s total.
const POLL_DELAYS_MS = [0, 100, 200, 400, 800, 1200, 1500, 1800, 2000, 2000]

// Field-name mapping per logging convention a log_sources entry can select via
// `format`. EVAKA_PRESET below is the same idea for log_group_names's own scan,
// kept out of this table because `format` must not select it.
// httpMethod/httpPath are omitted for a format whose error entries carry no
// request context; the endpoint column then falls back to the logger name.
// asyncJobPoolLogger must match the app's own logger, which appends the pool id:
// `<throw_site_package_prefix>.<asyncJobPoolLogger>.<pool id>`.
const FORMAT_PRESETS = {
  'logback-json': {
    level: 'logLevel',
    logger: 'loggerName',
    message: 'message',
    exception: 'exception',
    stackTrace: 'stackTrace',
    httpMethod: 'httpMethod',
    httpPath: 'path',
    appName: 'appName',
    traceId: 'traceId',
    asyncJobPoolLogger: 'shared.asyncjob.AsyncJobPool'
  },
  'pino-json': {
    level: 'level',
    logger: 'name',
    message: 'message',
    exception: 'exception',
    stackTrace: 'stackTrace',
    appName: 'appName',
    traceId: 'traceId'
  }
}

// eVaka's own shape. It emits both an actual `path` and a templated `httpRoute`,
// and shows the route in the Insights endpoint column while its Slack lines show
// the path — hence endpointPath alongside httpPath. Its async-job pool logger
// (`evaka.core.shared.async.AsyncJobPool`) shares no package prefix with its
// throw-site frames (`at evaka.`), so its mutes stay explicit below rather than
// being derived.
const EVAKA_PRESET = {
  level: 'logLevel',
  logger: 'loggerName',
  message: 'message',
  exception: 'exception',
  stackTrace: 'stackTrace',
  httpMethod: 'httpMethod',
  httpPath: 'path',
  endpointPath: 'httpRoute',
  appName: 'appName',
  traceId: 'traceId'
}

const EVAKA_NOISE_FILTERS = [
  'filter not (loggerName like /^evaka\\.core\\.shared\\.async\\.AsyncJobPool\\./ and meta.remainingAttempts > 0)',
  'filter loggerName not like /^evaka\\.core\\.varda\\./',
  'filter not (exception = "UnableToExecuteStatementException" and (message like /staff_attendance_no_overlaps/ or message like /staff_attendance_plan_no_overlaps/))'
]

// CloudWatch Logs Insights rejects a query naming more than this many log groups.
const MAX_QUERY_LOG_GROUPS = 50

const logsClient = new CloudWatchLogsClient({ region: REGION })

export async function handler(event, context) {
  const partition = context.invokedFunctionArn.split(':')[1]

  if ('Records' in event) {
    for (const record of event.Records) {
      try {
        await handleSnsRecord(record, partition)
      } catch (err) {
        console.error(
          'Failed to process SNS record:',
          err,
          JSON.stringify(record)
        )
      }
    }
  } else if (event.source === 'aws.events') {
    // Concurrently: each scan polls for its query for up to ~10s, which
    // sequentially would run several scans past the lambda's timeout — and a
    // timed-out invocation cannot report anything to Slack.
    await Promise.all([
      runScan('the eVaka log scan', () => handleLogCheck(partition)),
      ...Object.entries(LOG_SOURCES).map(([sourceName, source]) =>
        runScan(`log source "${sourceName}"`, () =>
          handleLogSourceCheck(sourceName, source, partition)
        )
      )
    ])
  } else {
    console.log('Unknown event type:', JSON.stringify(event))
  }
}

function consoleDomain(partition) {
  return partition === 'aws-eusc' ? 'amazonaws-eusc.eu' : 'aws.amazon.com'
}

function buildAlarmPayload(message, region, partition = 'aws') {
  const alarmName = message.AlarmName ?? 'Unknown alarm'
  const newState = message.NewStateValue ?? 'UNKNOWN'
  const reason = message.NewStateReason ?? ''
  const description = message.AlarmDescription ?? ''
  const timestamp = message.StateChangeTime ?? ''

  const color = newState === 'ALARM' ? '#d32f2f' : '#4caf50'
  const emoji = newState === 'ALARM' ? ':red_circle:' : ':large_green_circle:'

  const consoleUrl =
    `https://${region}.console.${consoleDomain(partition)}/cloudwatch/deeplink.js` +
    `?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`

  // Headline: prefer a human-readable AlarmDescription (e.g. "Backup failed in
  // evaka-staging"); otherwise fall back to the technical alarm name and state.
  // When a description is shown as the headline it is not repeated as a field.
  // An OK transition prefixes "Recovered:" so the description still reads right
  // with a green circle; an unexpected state keeps the state in parentheses.
  let headline
  if (!description) {
    headline = `${emoji} *${alarmName}* is now *${newState}*`
  } else if (newState === 'ALARM') {
    headline = `${emoji} *${description}*`
  } else if (newState === 'OK') {
    headline = `${emoji} *Recovered: ${description}*`
  } else {
    headline = `${emoji} *${description}* (${newState})`
  }

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: headline
      }
    }
  ]

  const fields = []
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

// Not everything on the alarm topic is a CloudWatch alarm. EventBridge rules
// can publish to it directly (e.g. a session-started or a malware finding),
// and those carry no alarm state to format — usually an input-transformed
// sentence rather than an object.
async function handleSnsRecord(record, partition) {
  const raw = record.Sns?.Message ?? ''

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = raw
  }

  if (parsed && typeof parsed === 'object' && parsed.AlarmName) {
    await handleAlarm(parsed, partition)
  } else {
    const text = typeof parsed === 'string' ? parsed : raw
    await handleNotification(text, record.Sns?.Subject)
  }
}

async function handleAlarm(message, partition) {
  const payload = buildAlarmPayload(message, REGION, partition)
  await postToSlack(payload)
}

async function handleNotification(text, subject) {
  await postToSlack(buildNotificationPayload(text, subject))
}

// Slack rejects a section over 3000 characters, and an unbounded event payload
// would otherwise silently fail the whole post.
const MAX_SECTION_LENGTH = 2900

function buildNotificationPayload(text, subject) {
  const body = (text ?? '').trim() || 'Notification with no message body'
  const truncated =
    body.length > MAX_SECTION_LENGTH
      ? body.slice(0, MAX_SECTION_LENGTH) + '...'
      : body

  const blocks = []
  if (subject) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:bell: *${subject}*` }
    })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncated } })
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:bell: ${truncated}` }
    })
  }

  return { attachments: [{ color: '#ff9800', blocks }] }
}

function buildQueryParts(preset, throwSitePackagePrefix, extraNoiseFilters) {
  const parts = [`filter tolower(${preset.level}) = "error"`]
  if (throwSitePackagePrefix && preset.asyncJobPoolLogger) {
    const loggerPrefix = escapeRegExp(
      `${throwSitePackagePrefix}.${preset.asyncJobPoolLogger}.`
    )
    parts.push(
      `filter not (${preset.logger} like /^${loggerPrefix}/ and meta.remainingAttempts > 0)`
    )
  }
  parts.push(...(extraNoiseFilters ?? []), 'sort @timestamp asc', 'limit 20')
  return parts
}

function buildInsightsFields(preset) {
  const endpointPath = preset.endpointPath ?? preset.httpPath
  const endpoint =
    preset.httpMethod && endpointPath
      ? `if(not isempty(${preset.httpMethod}) and not isempty(${endpointPath}), concat(${preset.httpMethod}, " ", ${endpointPath}), ${preset.logger})`
      : preset.logger
  return (
    `fields @timestamp, ${preset.appName}, ${endpoint} as endpoint, ` +
    `${preset.level}, ${preset.message}, ${preset.stackTrace}`
  )
}

async function discoverLogGroupNames(prefixes) {
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

async function resolveSourceLogGroupNames(source) {
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

async function reportScanFailure(label, err) {
  console.error(`Failed to run ${label}:`, err)
  try {
    await warnSlack(`${label} could not be run: ${err.message ?? err}`)
  } catch (warnErr) {
    console.error(`Failed to warn Slack about ${label}:`, warnErr)
  }
}

// A scan that cannot run at all — a denied DescribeLogGroups, too many log
// groups for one query — otherwise looks exactly like a scan that found nothing,
// so it is reported the same way a query that never completes is.
async function runScan(label, scan) {
  try {
    await scan()
  } catch (err) {
    await reportScanFailure(label, err)
  }
}

async function handleLogCheck(partition) {
  if (LOG_GROUP_NAMES.length === 0) {
    return
  }

  await runLogScan({
    label: '',
    logGroupNames: LOG_GROUP_NAMES,
    preset: EVAKA_PRESET,
    queryParts: buildQueryParts(EVAKA_PRESET, '', EVAKA_NOISE_FILTERS),
    throwSitePackagePrefix: 'evaka',
    partition
  })
}

// A source name alone (e.g. "service") is ambiguous once one Lambda/channel
// serves several projects on the same account (modules/baseline is one
// Lambda per account; its README notes an account can host several
// projects). Prefer "<app-env>/<sourceName>" parsed off the resolved log
// group's /aws/ecs/<app-env>/<component> convention — not name_prefix, which
// is the Lambda's own account-level name and can differ from the environment
// that actually owns the log group (e.g. an account named "dev" running the
// "staging" environment). Falls back to the source name alone when a source
// resolves to zero or several log groups, or an unfamiliar naming scheme.
function deriveSourceLabel(sourceName, logGroupNames) {
  if (logGroupNames.length === 1) {
    const match = logGroupNames[0].match(/^\/aws\/ecs\/(.+)\/[^/]+$/)
    if (match) return `${match[1]}/${sourceName}`
  }
  return sourceName
}

// The scan itself is caught here rather than left to the caller's runScan, so a
// query failure is reported under the environment-qualified label instead of
// the bare source name that is all runScan's caller has to go on. Resolving
// the log groups can still fail before any label can be derived; that case is
// left to propagate to the caller's runScan, which reports it under the bare
// source name.
async function handleLogSourceCheck(sourceName, source, partition) {
  const logGroupNames = await resolveSourceLogGroupNames(source)
  if (logGroupNames.length === 0) {
    console.log(`Log source "${sourceName}" has no log groups yet, skipping`)
    return
  }

  const label = deriveSourceLabel(sourceName, logGroupNames)
  const preset = FORMAT_PRESETS[source.format]
  try {
    await runLogScan({
      label,
      logGroupNames,
      preset,
      queryParts: buildQueryParts(
        preset,
        source.throw_site_package_prefix,
        source.extra_noise_filters
      ),
      throwSitePackagePrefix: source.throw_site_package_prefix,
      partition
    })
  } catch (err) {
    await reportScanFailure(`log source "${label}"`, err)
  }
}

// An empty label is the eVaka scan, whose Slack and log strings predate
// log_sources and carry no source name.
async function runLogScan({
  label,
  logGroupNames,
  preset,
  queryParts,
  throwSitePackagePrefix,
  partition
}) {
  const labelPrefix = label ? `[${label}] ` : ''
  const scanName = label ? ` for "${label}"` : ''

  // We might miss an error due to trigger drift and indexing delay,
  // so we overlap the query window a bit and allow some time for logs to be indexed before querying.
  const endTime =
    Math.floor(Date.now() / 1000) - CLOUDWATCH_INDEXING_DELAY_SECONDS
  const startTime = endTime - LOG_QUERY_SECONDS - OVERLAP_SECONDS

  const query = ['fields @timestamp, @message', ...queryParts].join('\n| ')
  const insightsFields = buildInsightsFields(preset)
  const insightsQuery = [insightsFields, ...queryParts].join('\n| ')

  const startResponse = await logsClient.send(
    new StartQueryCommand({
      logGroupNames,
      startTime,
      endTime,
      queryString: query
    })
  )
  const queryId = startResponse.queryId

  let results = null
  let statistics = null
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
      results = response.results ?? []
      statistics = response.statistics ?? null
      break
    }

    lastStatus = response.status
    if (['Failed', 'Cancelled', 'Timeout'].includes(response.status)) {
      console.error(
        `Log query${scanName} ended with status: ${
          response.status
        } after ${attempts} attempts (${Date.now() - pollStartMs}ms elapsed)`
      )
      break
    }
  }

  if (!results) {
    const elapsedMs = Date.now() - pollStartMs
    console.warn(
      `Log query${scanName} failed — last status: ${lastStatus}, ${attempts} attempts, ${elapsedMs}ms elapsed`
    )
    await warnSlack(
      `log error query${scanName} failed — last status: ${lastStatus}, ${attempts} attempts, ${elapsedMs}ms elapsed`
    )
    return
  }

  if (results.length === 0) {
    return
  }

  const matchedCount = resolveMatchedCount(statistics, results.length)

  const errorLines = []
  for (const row of results.slice(0, 10)) {
    const timestamp = row.find((f) => f.field === '@timestamp')?.value ?? ''
    const message = row.find((f) => f.field === '@message')?.value ?? ''

    if (!message) continue

    // Only the parse is tolerated: a log line that isn't JSON is expected and
    // renders raw, whereas a failure to format a parsed one is a defect and must
    // not masquerade as an unparseable line. Field values are coerced rather
    // than trusted, since nothing constrains what an app puts in them.
    let parsed
    try {
      parsed = JSON.parse(message)
    } catch {
      errorLines.push(
        `\`${formatTimestamp(timestamp)}\` ${message.slice(0, 200)}`
      )
      continue
    }

    const ts = formatTimestamp(timestamp)
    const logger = String(parsed[preset.logger] ?? '')
    let msg = String(parsed[preset.message] ?? '')
    if (msg.length > 200) msg = msg.slice(0, 200) + '...'

    const traceId = String(parsed[preset.traceId] ?? '')
    const safeTraceId = traceId.replace(/[^a-fA-F0-9\-]/g, '')

    const line1Parts = []
    if (safeTraceId) {
      const traceQuery = [
        insightsFields,
        `filter ${preset.traceId} = "${safeTraceId}"`,
        'sort @timestamp asc'
      ].join('\n| ')
      const traceUrl = buildLogInsightsUrl(
        traceQuery,
        logGroupNames,
        startTime,
        endTime,
        REGION,
        partition
      )
      line1Parts.push(`<${traceUrl}|${ts}>`)
    } else {
      line1Parts.push(ts)
    }

    const method = preset.httpMethod ? (parsed[preset.httpMethod] ?? '') : ''
    const path = preset.httpPath ? (parsed[preset.httpPath] ?? '') : ''
    if (method && path) {
      line1Parts.push(`*${method} ${path}*`)
    }

    if (logger) {
      line1Parts.push(logger.split('.').pop())
    }

    const exception = String(parsed[preset.exception] ?? '')
    const shortException = exception ? exception.split('.').pop() : ''
    const line2 = shortException ? `${shortException}: ${msg}` : msg

    let line3 = ''
    if (throwSitePackagePrefix && parsed[preset.stackTrace]) {
      const traceLine = extractThrowSite(
        String(parsed[preset.stackTrace]),
        throwSitePackagePrefix
      )
      if (traceLine) line3 = `\`${traceLine}\``
    }

    const lines = [line1Parts.join(' '), line2]
    if (line3) lines.push(line3)
    errorLines.push(lines.join('\n'))
  }

  const periodMinutes = Math.floor(LOG_QUERY_SECONDS / 60)
  const header = `:red_circle: *${labelPrefix}${formatErrorCount(
    matchedCount,
    periodMinutes
  )}*`

  const insightsUrl = buildLogInsightsUrl(
    insightsQuery,
    logGroupNames,
    startTime,
    endTime,
    REGION,
    partition
  )

  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: header } }]

  for (const line of errorLines) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: line } })
  }

  const remainder = formatRemainder(matchedCount, errorLines.length)
  if (remainder) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: remainder }
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
    console.error(
      `Failed to post detailed message${scanName}, trying fallback:`,
      err
    )
    const fallbackBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *${labelPrefix}${matchedCount} error(s) detected but failed to send detailed report*`
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
  const channel = process.env.SLACK_CHANNEL
  const body = channel ? { ...payload, channel } : payload
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  console.log(`Slack response: ${response.status}`)

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to post to Slack: ${response.status} ${body}`)
  }

  // Cache only a URL confirmed to work. A bad value (e.g. an unset SSM
  // placeholder) makes fetch reject before this point, so it is never
  // cached for the lifetime of a warm container.
  cachedWebhookUrl = webhookUrl
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

function extractThrowSite(stackTrace, packagePrefix = 'evaka') {
  const marker = `at ${packagePrefix}.`
  const pattern = new RegExp(`^at ${escapeRegExp(packagePrefix)}\\.(.+)$`)
  const lines = stackTrace.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Find first "at" line from the app's own code (skip framework/library frames)
    if (trimmed.startsWith(marker) && !trimmed.includes('ExceptionHandler')) {
      // Extract "at evaka.foo.Bar.method(File.kt:42)" -> "foo.Bar.method(File.kt:42)"
      const match = trimmed.match(pattern)
      if (match) return match[1]
    }
  }
  return null
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildLogInsightsUrl(
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

function resolveMatchedCount(statistics, resultsLength) {
  const matched = statistics?.recordsMatched
  return typeof matched === 'number' ? Math.round(matched) : resultsLength
}

function formatErrorCount(matchedCount, periodMinutes) {
  return `${matchedCount} error(s) in the last ${periodMinutes} minutes`
}

function formatRemainder(matchedCount, shownCount) {
  const remainder = matchedCount - shownCount
  return remainder > 0 ? `_...and ${remainder} more not shown_` : null
}

export {
  formatTimestamp,
  extractThrowSite,
  buildLogInsightsUrl,
  buildAlarmPayload,
  buildNotificationPayload,
  handleSnsRecord,
  getSlackWebhookUrl,
  postToSlack,
  resolveMatchedCount,
  formatErrorCount,
  formatRemainder,
  FORMAT_PRESETS,
  buildQueryParts,
  buildInsightsFields,
  EVAKA_PRESET,
  discoverLogGroupNames,
  resolveSourceLogGroupNames,
  deriveSourceLabel,
  handleLogCheck,
  handleLogSourceCheck
}
