// Scheduled check: roll SSM StartSession events up per user and post one digest,
// replacing the bastion_login Datadog monitor (bastion.sh retries fire
// StartSession several times per connect, so per-event alerts are noisy). The
// events reach the log group via an EventBridge rule; this counts them rather
// than scanning for errors, so it is its own check.

import {
  LOG_QUERY_SECONDS,
  postToSlack,
  warnSlack,
  deriveSourceLabel,
  defaultQueryWindow,
  runInsightsQuery
} from '../lib.mjs'

const QUERY = [
  'filter detail.eventName = "StartSession"',
  'stats count(*) as sessions by detail.userIdentity.arn, detail.requestParameters.target'
].join('\n| ')

export function buildSessionDigestPayload(results, label) {
  const labelPrefix = label ? `[${label}] ` : ''
  const cell = (row, field) => row.find((c) => c.field === field)?.value

  let total = 0
  const lines = results.slice(0, 20).map((row) => {
    const arn = cell(row, 'detail.userIdentity.arn') ?? 'unknown'
    const target = cell(row, 'detail.requestParameters.target') ?? '?'
    const count = Number(cell(row, 'sessions') ?? 0)
    total += count
    // The role-session name (an email) is the useful part of an assumed-role ARN.
    const user = arn.includes('/') ? arn.slice(arn.lastIndexOf('/') + 1) : arn
    return `• ${user} (${count}) on ${target}`
  })

  const minutes = Math.round(LOG_QUERY_SECONDS / 60)
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:bell: *${labelPrefix}${total} SSM session${
          total === 1 ? '' : 's'
        } started* in the last ~${minutes} min`
      }
    },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Usually a bastion login or a port forward (eg. PostgreSQL). No action needed if it was you.'
        }
      ]
    }
  ]

  return { attachments: [{ color: '#ff9800', blocks }] }
}

async function run(sourceName, source, logGroupNames, partition) {
  const label = deriveSourceLabel(sourceName, logGroupNames)
  const scanName = label ? ` for "${label}"` : ''

  const { startTime, endTime } = defaultQueryWindow()
  const { results, lastStatus, attempts, elapsedMs } = await runInsightsQuery(
    logGroupNames,
    QUERY,
    startTime,
    endTime
  )

  if (results === null) {
    const failure = `SSM session audit${scanName} failed after ${attempts} attempts in ${elapsedMs}ms (last status: ${lastStatus})`
    console.warn(failure)
    await warnSlack(failure)
    return
  }
  if (results.length === 0) return

  await postToSlack(buildSessionDigestPayload(results, label), source.channel)
}

export default {
  name: 'session-audit',
  formats: ['ssm-session-audit'],
  run
}
