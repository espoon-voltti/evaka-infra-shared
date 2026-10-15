import { counterNames, seriesMeta } from './series.mjs'
import {
  BUCKET_MS,
  bucketStarts,
  ceilToBucket,
  dayKey,
  floorToBucket,
  isoTime,
  splitByUtcDay,
  toSlots,
  upsertDay,
  utcDayStart,
  zeroFill
} from './store.mjs'
import { parseBinTime, runInsightsQuery } from './insights.mjs'
import { getMetricSummaries } from './metrics.mjs'

// The scheduled run writes the last SCHEDULED_BUCKETS buckets again, so a
// missed run or a late log line is fixed on the next runs.
export const SCHEDULED_BUCKETS = 6

// A backfill stops before a day when less than this is left of the Lambda
// timeout. It must exceed the time to process one day, which is mostly the
// Insights query deadline in insights.mjs.
const MIN_REMAINING_MS = 60_000

export const LOGIN_SERIES_BY_EVENT_CODE = {
  CitizenLogin: 'citizen.login{auth=strong}',
  CitizenWeakLogin: 'citizen.login{auth=weak}',
  CitizenPasskeyLogin: 'citizen.login{auth=weak}'
}

const LOGIN_SERIES = [...new Set(Object.values(LOGIN_SERIES_BY_EVENT_CODE))]

// The event codes in the filter must be the keys of LOGIN_SERIES_BY_EVENT_CODE.
export const LOGIN_QUERY = `fields @timestamp
| filter type = "app-audit-events" and eventCode in ["CitizenLogin", "CitizenWeakLogin", "CitizenPasskeyLogin"]
| stats count() as n by bin(5m) as t, eventCode`

function config() {
  return {
    bucket: process.env.BUCKET,
    serviceLogGroupName: process.env.SERVICE_LOG_GROUP_NAME,
    rdsInstanceIdentifier: process.env.RDS_INSTANCE_IDENTIFIER,
    ingestionDelayMs:
      parseInt(process.env.INGESTION_DELAY_SECONDS ?? '180', 10) * 1000
  }
}

export function latestClosedEnd(nowMs, ingestionDelayMs) {
  return floorToBucket(nowMs - ingestionDelayMs)
}

export function scheduledRange(nowMs, ingestionDelayMs) {
  const toMs = latestClosedEnd(nowMs, ingestionDelayMs)
  return { fromMs: toMs - SCHEDULED_BUCKETS * BUCKET_MS, toMs }
}

// Buckets that are not closed yet are left out: zero-fill would write zeros
// for log lines that are not ingested yet.
export function backfillRange(backfill, nowMs, ingestionDelayMs) {
  const from = Date.parse(backfill?.from)
  const to = Date.parse(backfill?.to)
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error(`Invalid backfill range: ${JSON.stringify(backfill)}`)
  }
  return {
    fromMs: floorToBucket(from),
    toMs: Math.min(ceilToBucket(to), latestClosedEnd(nowMs, ingestionDelayMs))
  }
}

export function loginCountsFromRows(rows, fromMs, toMs) {
  const counts = new Map()
  for (const row of rows) {
    const series = LOGIN_SERIES_BY_EVENT_CODE[row.eventCode]
    if (!series) continue
    const t = parseBinTime(row.t)
    if (t < fromMs || t >= toMs) continue
    const values = counts.get(t) ?? {}
    values[series] = (values[series] ?? 0) + Number(row.n)
    counts.set(t, values)
  }
  return zeroFill(
    counts,
    bucketStarts(fromMs, toMs),
    counterNames(LOGIN_SERIES)
  )
}

function rdsCpuMetric(rdsInstanceIdentifier) {
  return {
    Namespace: 'AWS/RDS',
    MetricName: 'CPUUtilization',
    Dimensions: [{ Name: 'DBInstanceIdentifier', Value: rdsInstanceIdentifier }]
  }
}

export function summariesToValues(summaries, seriesName, fromMs, toMs) {
  const values = new Map()
  for (const [t, summary] of summaries) {
    if (t >= fromMs && t < toMs) values.set(t, { [seriesName]: summary })
  }
  return values
}

function sources(cfg) {
  return [
    {
      name: 'citizen logins',
      series: LOGIN_SERIES,
      async collect(fromMs, toMs) {
        const rows = await runInsightsQuery(
          [cfg.serviceLogGroupName],
          LOGIN_QUERY,
          fromMs,
          toMs
        )
        return loginCountsFromRows(rows, fromMs, toMs)
      }
    },
    {
      name: 'rds cpu',
      series: ['rds.cpu'],
      async collect(fromMs, toMs) {
        const summaries = await getMetricSummaries(
          rdsCpuMetric(cfg.rdsInstanceIdentifier),
          fromMs,
          toMs
        )
        return summariesToValues(summaries, 'rds.cpu', fromMs, toMs)
      }
    }
  ]
}

export function mergeValues(valueMaps) {
  const merged = new Map()
  for (const values of valueMaps) {
    for (const [t, slotValues] of values) {
      merged.set(t, { ...merged.get(t), ...slotValues })
    }
  }
  return merged
}

export function groupByDay(valuesByTime) {
  const days = new Map()
  for (const [t, values] of valuesByTime) {
    const day = utcDayStart(t)
    if (!days.has(day)) days.set(day, new Map())
    days.get(day).set(t, values)
  }
  return days
}

// A failed source leaves its keys out, so its buckets show as gaps, and the
// other sources are still written. The error is thrown after the write so that
// the invocation is marked as failed.
export async function processRange(cfg, fromMs, toMs) {
  const all = sources(cfg)
  const outcomes = await Promise.allSettled(
    all.map((source) => source.collect(fromMs, toMs))
  )
  const succeeded = all.filter((_, i) => outcomes[i].status === 'fulfilled')
  const values = mergeValues(
    outcomes.filter((o) => o.status === 'fulfilled').map((o) => o.value)
  )
  const series = seriesMeta(succeeded.flatMap((source) => source.series))

  for (const [day, dayValues] of groupByDay(values)) {
    await upsertDay(cfg.bucket, dayKey(day), series, toSlots(dayValues))
  }

  const failures = outcomes
    .map((o, i) =>
      o.status === 'rejected'
        ? `${all[i].name}: ${o.reason?.message ?? o.reason}`
        : null
    )
    .filter(Boolean)
  if (failures.length > 0) {
    throw new Error(
      `Failed to collect ${isoTime(fromMs)}..${isoTime(toMs)}: ${failures.join('; ')}`
    )
  }
}

async function runScheduled(cfg, nowMs) {
  const { fromMs, toMs } = scheduledRange(nowMs, cfg.ingestionDelayMs)
  await processRange(cfg, fromMs, toMs)
  console.log(`Processed ${isoTime(fromMs)}..${isoTime(toMs)}`)
  return { from: isoTime(fromMs), to: isoTime(toMs) }
}

async function runBackfill(cfg, backfill, context) {
  const { fromMs, toMs } = backfillRange(
    backfill,
    Date.now(),
    cfg.ingestionDelayMs
  )
  const processed = []
  for (const chunk of splitByUtcDay(fromMs, toMs)) {
    if (context.getRemainingTimeInMillis() < MIN_REMAINING_MS) {
      const next = { from: isoTime(chunk.fromMs), to: isoTime(toMs) }
      console.log(
        `Backfill stopped before ${next.from}, invoke again with ${JSON.stringify({ backfill: next })}`
      )
      return { processed, next }
    }
    await processRange(cfg, chunk.fromMs, chunk.toMs)
    console.log(`Backfilled ${isoTime(chunk.fromMs)}..${isoTime(chunk.toMs)}`)
    processed.push(dayKey(chunk.fromMs))
  }
  return { processed, next: null }
}

export async function handler(event, context) {
  const cfg = config()
  if (event.backfill) return runBackfill(cfg, event.backfill, context)
  if (event.source === 'aws.events') {
    const scheduledMs = Date.parse(event.time)
    return runScheduled(
      cfg,
      Number.isNaN(scheduledMs) ? Date.now() : scheduledMs
    )
  }
  console.log('Unknown event type:', JSON.stringify(event))
}
