// Scheduled check: scan app logs for errors and post a red-circle report with a
// deep link into CloudWatch Logs Insights. Handles the JSON logging conventions
// eVaka's services use, selected per source by `format`.

import {
  REGION,
  postToSlack,
  warnSlack,
  formatTimestamp,
  deriveSourceLabel,
  defaultQueryWindow,
  runInsightsQuery,
  buildLogInsightsUrl,
  resolveMatchedCount,
  formatRemainder
} from '../lib.mjs'

// Field-name mapping per logging convention a log_sources entry selects via
// `format`.
// An api-gateway can write both conventions into one log group: pino lines for
// requests and older logger lines (logLevel) for startup and config. Filtering
// on one field alone drops the errors written in the other and the source looks
// healthy, so each JSON preset names the field it expects plus the one it may
// also meet.
export const FORMAT_PRESETS = {
  'logback-json': {
    level: 'logLevel',
    fallbackLevel: 'level',
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
    fallbackLevel: 'logLevel',
    logger: 'name',
    message: 'message',
    exception: 'exception',
    stackTrace: 'stackTrace',
    appName: 'appName',
    traceId: 'traceId'
  }
}

// eVaka's own shape, for the LOG_GROUP_NAMES scan. It emits both an actual
// `path` and a templated `httpRoute`; it shows the route in the Insights
// endpoint column while its Slack lines show the path, hence endpointPath
// alongside httpPath. Its async-job pool logger shares no package prefix with
// its `at evaka.` throw-site frames, so its mutes are explicit below rather than
// derived. "evaka" is not a configurable format: the entry synthesises it.
export const EVAKA_PRESET = {
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

// nginx logs plain text, so no field holds the level: the severity is the
// "[error]" tag nginx writes into the line. Matching that tag rather than the
// word "error" keeps out access-log lines for requests that merely mention it.
export const NGINX_PRESET = {
  text: true,
  severities: ['emerg', 'alert', 'crit', 'error']
}

const PRESETS = { ...FORMAT_PRESETS, evaka: EVAKA_PRESET, nginx: NGINX_PRESET }

const EVAKA_NOISE_FILTERS = [
  'filter not (loggerName like /^evaka\\.core\\.shared\\.async\\.AsyncJobPool\\./ and meta.remainingAttempts > 0)',
  'filter loggerName not like /^evaka\\.core\\.varda\\./',
  'filter not (exception = "UnableToExecuteStatementException" and (message like /staff_attendance_no_overlaps/ or message like /staff_attendance_plan_no_overlaps/))'
]

// Timing constants live in lib; re-read the window length for the header text.
const LOG_QUERY_SECONDS = parseInt(process.env.LOG_QUERY_SECONDS ?? '300', 10)

export function buildQueryParts(
  preset,
  throwSitePackagePrefix,
  extraNoiseFilters
) {
  const level = preset.fallbackLevel
    ? `coalesce(${preset.level}, ${preset.fallbackLevel})`
    : preset.level
  const parts = preset.text
    ? [`filter @message like /\\[(${preset.severities.join('|')})\\]/`]
    : [`filter tolower(${level}) = "error"`]
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

export function buildInsightsFields(preset) {
  if (preset.text) return 'fields @timestamp, @message'
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

export function extractThrowSite(stackTrace, packagePrefix = 'evaka') {
  const marker = `at ${packagePrefix}.`
  const pattern = new RegExp(`^at ${escapeRegExp(packagePrefix)}\\.(.+)$`)
  const lines = stackTrace.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // First "at" line from the app's own code (skip framework/library frames).
    if (trimmed.startsWith(marker) && !trimmed.includes('ExceptionHandler')) {
      const match = trimmed.match(pattern)
      if (match) return match[1]
    }
  }
  return null
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function formatErrorCount(matchedCount, periodMinutes) {
  return `${matchedCount} error(s) in the last ${periodMinutes} minutes`
}

async function run(sourceName, source, logGroupNames, partition) {
  const preset = PRESETS[source.format]
  const throwSitePackagePrefix =
    source.format === 'evaka' ? 'evaka' : source.throw_site_package_prefix
  const extraNoiseFilters =
    source.format === 'evaka' ? EVAKA_NOISE_FILTERS : source.extra_noise_filters

  const label = deriveSourceLabel(sourceName, logGroupNames)
  const labelPrefix = label ? `[${label}] ` : ''
  const scanName = label ? ` for "${label}"` : ''

  const queryParts = buildQueryParts(
    preset,
    throwSitePackagePrefix,
    extraNoiseFilters
  )
  const { startTime, endTime } = defaultQueryWindow()
  const query = ['fields @timestamp, @message', ...queryParts].join('\n| ')
  const insightsFields = buildInsightsFields(preset)
  const insightsQuery = [insightsFields, ...queryParts].join('\n| ')

  const { results, statistics, lastStatus, attempts, elapsedMs } =
    await runInsightsQuery(logGroupNames, query, startTime, endTime)

  if (results === null) {
    console.warn(
      `Log query${scanName} failed — last status: ${lastStatus}, ${attempts} attempts, ${elapsedMs}ms elapsed`
    )
    await warnSlack(
      `log error query${scanName} failed — last status: ${lastStatus}, ${attempts} attempts, ${elapsedMs}ms elapsed`
    )
    return
  }

  if (results.length === 0) return

  const matchedCount = resolveMatchedCount(statistics, results.length)

  const errorLines = []
  for (const row of results.slice(0, 10)) {
    const timestamp = row.find((f) => f.field === '@timestamp')?.value ?? ''
    const message = row.find((f) => f.field === '@message')?.value ?? ''

    if (!message) continue

    // Only the parse is tolerated: a log line that isn't JSON is expected and
    // renders raw, whereas a failure to format a parsed one is a defect and must
    // not masquerade as an unparseable line.
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
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remainder } })
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `<${insightsUrl}|:mag: View in CloudWatch Logs>`
    }
  })

  try {
    await postToSlack(
      { attachments: [{ color: '#d32f2f', blocks }] },
      source.channel
    )
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
    await postToSlack(
      { attachments: [{ color: '#d32f2f', blocks: fallbackBlocks }] },
      source.channel
    )
  }
}

export default {
  name: 'log-error',
  formats: ['logback-json', 'pino-json', 'evaka', 'nginx'],
  run
}
