import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand
} from '@aws-sdk/client-cloudwatch-logs'

import { floorToBucket, isoTime } from './store.mjs'

// A run starts a source or a backfill chunk only with MIN_REMAINING_MS of the
// Lambda timeout left (collector.mjs), so a query deadline must stay well
// under it.
const QUERY_DEADLINE_MS = 45_000

// Delays (ms) before successive GetQueryResults polls: quick at first, since
// most queries finish in under a second, then POLL_INTERVAL_MS apart.
const POLL_BACKOFF_MS = [0, 100, 200, 400, 800, 1200, 1500, 1800]
const POLL_INTERVAL_MS = 2000

// The most rows that one GetQueryResults call returns. A result with this many
// rows can be truncated.
export const RESULT_LIMIT = 10_000

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

// Gives the rows of a stats query `by bin(5m) as t` whose bucket starts in
// [fromMs, toMs). endTime is inclusive, so the query also returns the bucket
// that starts at toMs, with only the lines of its first second.
export async function queryBuckets(
  logGroupNames,
  queryString,
  fromMs,
  toMs,
  options
) {
  const rows = await runInsightsQuery(
    logGroupNames,
    queryString,
    fromMs,
    toMs,
    options
  )
  if (rows.length < RESULT_LIMIT) {
    return rows.filter((row) => {
      const t = parseBinTime(row.t)
      return t >= fromMs && t < toMs
    })
  }
  const midMs = floorToBucket((fromMs + toMs) / 2)
  if (midMs <= fromMs) {
    throw new Error(
      `Insights query gave ${rows.length} rows for the bucket at ${isoTime(fromMs)}`
    )
  }
  console.log(
    `Insights query gave ${rows.length} rows for ${isoTime(fromMs)}..${isoTime(toMs)}, querying each half again`
  )
  const first = await queryBuckets(
    logGroupNames,
    queryString,
    fromMs,
    midMs,
    options
  )
  const second = await queryBuckets(
    logGroupNames,
    queryString,
    midMs,
    toMs,
    options
  )
  return [...first, ...second]
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
