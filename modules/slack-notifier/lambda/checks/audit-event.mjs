// Scheduled check: report audit-log entries whose eventCode a source names.
// eVaka writes them into the service's own log group, but with no level field
// and no message field, so the log-error check's filter never matches one. The
// point of the alert is that a notable action happened, not that it failed.

import {
  REGION,
  LOG_QUERY_SECONDS,
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

const RESULT_LIMIT = 20
const META_MAX_LENGTH = 300

export function buildAuditQuery(eventCodes, matchFilters) {
  const codes = eventCodes.map((code) => JSON.stringify(code)).join(', ')
  return [
    'fields @timestamp, @message',
    `filter eventCode in [${codes}]`,
    ...(matchFilters ?? []),
    'sort @timestamp desc',
    `limit ${RESULT_LIMIT}`
  ].join('\n| ')
}

function formatMeta(meta) {
  if (meta === null || meta === undefined) return ''
  const text = typeof meta === 'string' ? meta : JSON.stringify(meta)
  if (!text || text === '{}') return ''
  return text.length > META_MAX_LENGTH
    ? `\`${text.slice(0, META_MAX_LENGTH)}...\``
    : `\`${text}\``
}

function formatAuditEvent(row) {
  const cell = (field) => row.find((c) => c.field === field)?.value ?? ''
  const timestamp = formatTimestamp(cell('@timestamp'))
  const message = cell('@message')

  let parsed
  try {
    parsed = JSON.parse(message)
  } catch {
    return `\`${timestamp}\` ${message.slice(0, 200)}`
  }

  const head = [`\`${timestamp}\``, `*${parsed.eventCode ?? 'audit event'}*`]
  if (parsed.userId) head.push(`by \`${parsed.userId}\``)
  if (parsed.targetId) head.push(`on \`${parsed.targetId}\``)

  const meta = formatMeta(parsed.meta)
  return meta ? `${head.join(' ')}\n${meta}` : head.join(' ')
}

export function buildAuditEventPayload(
  results,
  label,
  matchedCount,
  insightsUrl
) {
  const labelPrefix = label ? `[${label}] ` : ''
  const minutes = Math.round(LOG_QUERY_SECONDS / 60)
  const eventLines = results.map(formatAuditEvent)

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:rotating_light: *${labelPrefix}${matchedCount} audit event${
          matchedCount === 1 ? '' : 's'
        }* in the last ~${minutes} min`
      }
    },
    ...eventLines.map((line) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: line }
    }))
  ]

  const remainder = formatRemainder(matchedCount, eventLines.length)
  if (remainder) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: remainder } })
  }
  if (insightsUrl) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<${insightsUrl}|:mag: View in CloudWatch Logs>`
      }
    })
  }

  return { attachments: [{ color: '#ff9800', blocks }] }
}

async function run(sourceName, source, logGroupNames, partition) {
  const label = deriveSourceLabel(sourceName, logGroupNames)
  const scanName = label ? ` for "${label}"` : ''

  const eventCodes = source.audit_event_codes ?? []
  if (eventCodes.length === 0) {
    console.warn(`Audit event scan${scanName} names no event codes, skipping`)
    return
  }

  const query = buildAuditQuery(eventCodes, source.audit_match_filters)
  const { startTime, endTime } = defaultQueryWindow()
  const { results, statistics, lastStatus, attempts, elapsedMs } =
    await runInsightsQuery(logGroupNames, query, startTime, endTime)

  if (results === null) {
    const failure = `Audit event scan${scanName} failed after ${attempts} attempts in ${elapsedMs}ms (last status: ${lastStatus})`
    console.warn(failure)
    await warnSlack(failure)
    return
  }
  if (results.length === 0) return

  const payload = buildAuditEventPayload(
    results,
    label,
    resolveMatchedCount(statistics, results.length),
    buildLogInsightsUrl(
      query,
      logGroupNames,
      startTime,
      endTime,
      REGION,
      partition
    )
  )
  await postToSlack(payload, source.channel)
}

export default {
  name: 'audit-event',
  formats: ['evaka-audit'],
  run
}
