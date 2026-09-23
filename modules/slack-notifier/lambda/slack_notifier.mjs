// Entry point. Two registries of small, self-contained handlers, each in its own
// file, are loaded here and looped over:
//   - messages/ : SNS payloads (a CloudWatch alarm, or a plain notification),
//                 matched by a predicate.
//   - checks/   : scheduled Logs Insights scans, dispatched by a source's
//                 `format`.
// Adding an alert is a new file plus one import line below, not a branch here.

import {
  REGION,
  postToSlack,
  warnSlack,
  resolveSourceLogGroupNames,
  deriveSourceLabel
} from './lib.mjs'

import logError from './checks/log-error.mjs'
import sessionAudit from './checks/session-audit.mjs'
import alarm from './messages/alarm.mjs'
import notification from './messages/notification.mjs'

// Order matters: notification.matches() is the catch-all, so it stays last.
const MESSAGES = [alarm, notification]

const CHECKS = [logError, sessionAudit]
const checkByFormat = Object.fromEntries(
  CHECKS.flatMap((check) => check.formats.map((format) => [format, check]))
)

const LOG_GROUP_NAMES = (process.env.LOG_GROUP_NAMES ?? '')
  .split(',')
  .filter(Boolean)
const LOG_SOURCES = JSON.parse(process.env.LOG_SOURCES_JSON ?? '{}')

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
    // Concurrently: each scan polls its query for up to QUERY_DEADLINE_MS, which
    // sequentially would run several scans past the lambda's timeout, and a
    // timed-out invocation cannot report anything to Slack.
    await Promise.all([
      runScan('the eVaka log scan', () => handleLogCheck(partition)),
      ...Object.entries(LOG_SOURCES).map(([name, source]) =>
        runScan(`log source "${name}"`, () =>
          handleLogSourceCheck(name, source, partition)
        )
      )
    ])
  } else {
    console.log('Unknown event type:', JSON.stringify(event))
  }
}

async function handleSnsRecord(record, partition) {
  const raw = record.Sns?.Message ?? ''

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = raw
  }

  const handler = MESSAGES.find((h) => h.matches(parsed, raw))
  const payload = handler.build(
    { parsed, raw, subject: record.Sns?.Subject },
    { region: REGION, partition }
  )
  await postToSlack(payload)
}

// The eVaka LOG_GROUP_NAMES scan is a log-error check with the eVaka preset,
// synthesised here so it is not a special path — its query and mutes live in the
// check like every other source's.
async function handleLogCheck(partition) {
  if (LOG_GROUP_NAMES.length === 0) return
  await handleLogSourceCheck(
    '',
    { format: 'evaka', log_group_names: LOG_GROUP_NAMES },
    partition
  )
}

async function handleLogSourceCheck(sourceName, source, partition) {
  const check = checkByFormat[source.format]
  if (!check) {
    console.warn(
      `Log source "${sourceName}" has an unknown format "${source.format}", skipping`
    )
    return
  }

  const logGroupNames = await resolveSourceLogGroupNames(source)
  if (logGroupNames.length === 0) {
    console.log(`Log source "${sourceName}" has no log groups yet, skipping`)
    return
  }

  // Report a scan failure under the environment-qualified label rather than the
  // bare source name the caller's runScan has: with one channel serving several
  // environments, the bare name cannot say which one failed. Resolving the log
  // groups above can still fail before a label exists; that propagates to
  // runScan and is reported under the bare name.
  const label = deriveSourceLabel(sourceName, logGroupNames)
  try {
    await check.run(sourceName, source, logGroupNames, partition)
  } catch (err) {
    await reportScanFailure(`log source "${label}"`, err)
  }
}

async function reportScanFailure(label, err) {
  console.error(`Failed to run ${label}:`, err)
  try {
    await warnSlack(`${label} could not be run: ${err.message ?? err}`)
  } catch (warnErr) {
    console.error(`Failed to warn Slack about ${label}:`, warnErr)
  }
}

async function runScan(label, scan) {
  try {
    await scan()
  } catch (err) {
    await reportScanFailure(label, err)
  }
}

export { handleSnsRecord, handleLogCheck, handleLogSourceCheck }

// Public surface, re-exported from the modules that own each piece so callers
// (and the tests) have one import point.
export {
  getSlackWebhookUrl,
  postToSlack,
  formatTimestamp,
  discoverLogGroupNames,
  resolveSourceLogGroupNames,
  deriveSourceLabel
} from './lib.mjs'
export {
  buildQueryParts,
  buildInsightsFields,
  extractThrowSite,
  buildLogInsightsUrl,
  resolveMatchedCount,
  formatErrorCount,
  formatRemainder,
  FORMAT_PRESETS,
  EVAKA_PRESET
} from './checks/log-error.mjs'
export { buildSessionDigestPayload } from './checks/session-audit.mjs'
export { buildAlarmPayload } from './messages/alarm.mjs'
export { buildNotificationPayload } from './messages/notification.mjs'
