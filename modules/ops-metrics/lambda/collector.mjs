import { counterNames, seriesMeta } from './series.mjs'
import {
  BUCKET_MS,
  DAY_MS,
  STATE_KEY,
  bucketStarts,
  ceilToBucket,
  dayKey,
  floorToBucket,
  isoTime,
  readState,
  splitByUtcDay,
  toSlots,
  upsertDay,
  utcDayStart,
  writeState,
  zeroFill
} from './store.mjs'
import { parseBinTime, runInsightsQuery } from './insights.mjs'
import { getMetricSummaries } from './metrics.mjs'

// A run stops before a day when less than this is left of the Lambda timeout.
// It must exceed the time to process one day, which is mostly the Insights
// query deadline in insights.mjs.
const MIN_REMAINING_MS = 60_000

export const MAX_CATCH_UP_MS = DAY_MS

// CloudWatch can add a datapoint to a bucket some minutes after the bucket
// closed, so a scheduled run reads the metrics again this far back.
export const METRICS_LOOKBACK_MS = 6 * BUCKET_MS

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
      parseInt(process.env.INGESTION_DELAY_SECONDS ?? '300', 10) * 1000
  }
}

export function latestClosedEnd(nowMs, ingestionDelayMs) {
  return floorToBucket(nowMs - ingestionDelayMs)
}

// Gives NaN when there is no watermark.
function parseWatermark(value) {
  if (value === undefined) return NaN
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  if (Number.isNaN(ms) || ms % BUCKET_MS !== 0) {
    throw new Error(
      `Invalid watermark in ${STATE_KEY}: ${JSON.stringify(value)}`
    )
  }
  return ms
}

// A watermarkMs of NaN means that there is no watermark. Then only the bucket
// that ends at endMs is processed.
export function scheduledRange(watermarkMs, endMs, lookbackMs) {
  const start = Number.isNaN(watermarkMs) ? endMs - BUCKET_MS : watermarkMs
  const fromMs = Math.min(start, endMs - lookbackMs)
  return { fromMs, toMs: Math.min(endMs, fromMs + MAX_CATCH_UP_MS) }
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
      stateKey: 'logs',
      lookbackMs: 0,
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
      stateKey: 'metrics',
      lookbackMs: METRICS_LOOKBACK_MS,
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
// other sources are still written. Returns the failures of the sources.
async function storeRange(cfg, rangeSources, fromMs, toMs) {
  const outcomes = await Promise.allSettled(
    rangeSources.map((source) => source.collect(fromMs, toMs))
  )
  const succeeded = rangeSources.filter(
    (_, i) => outcomes[i].status === 'fulfilled'
  )
  const values = mergeValues(
    outcomes.filter((o) => o.status === 'fulfilled').map((o) => o.value)
  )
  const series = seriesMeta(succeeded.flatMap((source) => source.series))

  for (const [day, dayValues] of groupByDay(values)) {
    await upsertDay(cfg.bucket, dayKey(day), series, toSlots(dayValues))
  }

  return outcomes
    .map((o, i) =>
      o.status === 'rejected'
        ? `${rangeSources[i].name}: ${o.reason?.message ?? o.reason}`
        : null
    )
    .filter(Boolean)
}

function rangeText(fromMs, toMs) {
  return `${isoTime(fromMs)}..${isoTime(toMs)}`
}

// The watermark of a source is the end of the last bucket that it stored.
// A source that fails keeps its watermark, so the next run retries it.
async function runScheduled(cfg, nowMs, context) {
  const endMs = latestClosedEnd(nowMs, cfg.ingestionDelayMs)
  const state = await readState(cfg.bucket)
  const processed = {}
  const failures = []

  const scheduledSources = sources(cfg)
  const watermarks = scheduledSources.map((source) =>
    parseWatermark(state[source.stateKey])
  )

  for (const [i, source] of scheduledSources.entries()) {
    const watermarkMs = watermarks[i]
    const { fromMs, toMs } = scheduledRange(
      watermarkMs,
      endMs,
      source.lookbackMs
    )
    for (const chunk of splitByUtcDay(fromMs, toMs)) {
      if (context.getRemainingTimeInMillis() < MIN_REMAINING_MS) {
        console.log(
          `Stopped ${source.name} before ${isoTime(chunk.fromMs)}, the next run continues`
        )
        break
      }
      let chunkFailures
      try {
        chunkFailures = await storeRange(
          cfg,
          [source],
          chunk.fromMs,
          chunk.toMs
        )
      } catch (err) {
        chunkFailures = [`${source.name}: ${err.message}`]
      }
      if (chunkFailures.length > 0) {
        failures.push(
          `Failed to collect ${rangeText(chunk.fromMs, chunk.toMs)}: ${chunkFailures.join('; ')}`
        )
        break
      }
      // The metrics lookback, or a retried run for an earlier time, can process
      // chunks that end before the watermark.
      if (Number.isNaN(watermarkMs) || chunk.toMs > watermarkMs) {
        state[source.stateKey] = isoTime(chunk.toMs)
        await writeState(cfg.bucket, state)
      }
      processed[source.stateKey] = {
        from: processed[source.stateKey]?.from ?? isoTime(chunk.fromMs),
        to: isoTime(chunk.toMs)
      }
      console.log(
        `Processed ${source.name} ${rangeText(chunk.fromMs, chunk.toMs)}`
      )
    }
  }

  if (failures.length > 0) throw new Error(failures.join('; '))
  return processed
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
    const failures = await storeRange(
      cfg,
      sources(cfg),
      chunk.fromMs,
      chunk.toMs
    )
    if (failures.length > 0) {
      throw new Error(
        `Failed to collect ${rangeText(chunk.fromMs, chunk.toMs)}: ${failures.join('; ')}`
      )
    }
    console.log(`Backfilled ${rangeText(chunk.fromMs, chunk.toMs)}`)
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
      Number.isNaN(scheduledMs) ? Date.now() : scheduledMs,
      context
    )
  }
  console.log('Unknown event type:', JSON.stringify(event))
}
