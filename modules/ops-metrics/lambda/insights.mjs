import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand
} from '@aws-sdk/client-cloudwatch-logs'

// A backfill starts a day only with MIN_REMAINING_MS of the Lambda timeout
// left (collector.mjs), so a query deadline must stay well under it.
const QUERY_DEADLINE_MS = 45_000

// Delays (ms) before successive GetQueryResults polls: quick at first, since
// most queries finish in under a second, then POLL_INTERVAL_MS apart.
const POLL_BACKOFF_MS = [0, 100, 200, 400, 800, 1200, 1500, 1800]
const POLL_INTERVAL_MS = 2000

// A stats query over one day by bin(5m) and a few labels gives about 1000 rows,
// which is the default limit.
const RESULT_LIMIT = 10_000

const logsClient = new CloudWatchLogsClient({})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runInsightsQuery(
  logGroupNames,
  queryString,
  fromMs,
  toMs,
  { deadlineMs = QUERY_DEADLINE_MS } = {}
) {
  const { queryId } = await logsClient.send(
    new StartQueryCommand({
      logGroupNames,
      queryString,
      startTime: Math.floor(fromMs / 1000),
      endTime: Math.floor(toMs / 1000),
      limit: RESULT_LIMIT
    })
  )

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
      return (response.results ?? []).map(rowToObject)
    }
    lastStatus = response.status
    if (['Failed', 'Cancelled', 'Timeout'].includes(response.status)) break
  }
  throw new Error(
    `Insights query ${queryId} did not complete: status ${lastStatus} after ${attempts} polls`
  )
}

export function rowToObject(row) {
  return Object.fromEntries(row.map(({ field, value }) => [field, value]))
}

// bin() values come back as "2026-10-06 00:05:00.000", in UTC with no zone.
export function parseBinTime(value) {
  const iso = value.includes('T') ? value : value.replace(' ', 'T')
  const ms = Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`)
  if (Number.isNaN(ms)) throw new Error(`Unexpected bin time: ${value}`)
  return ms
}
