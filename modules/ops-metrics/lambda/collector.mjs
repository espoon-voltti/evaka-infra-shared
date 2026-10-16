import { seriesMeta } from './series.mjs'
import {
  BUCKET_MS,
  DAY_MS,
  STATE_KEY,
  ceilToBucket,
  dayKey,
  floorToBucket,
  isoTime,
  readState,
  splitIntoChunks,
  toSlots,
  upsertDay,
  utcDayStart,
  writeState
} from './store.mjs'
import { queryBuckets } from './insights.mjs'
import { getMetricSummaries } from './metrics.mjs'
import {
  APIGW_MAX_RANGE_MS,
  APIGW_QUERY,
  APIGW_SERIES,
  PROXY_MAX_RANGE_MS,
  PROXY_QUERY,
  PROXY_SERIES,
  SERVICE_MAX_RANGE_MS,
  SERVICE_QUERY,
  SERVICE_SERIES,
  apigwValuesFromRows,
  proxyValuesFromRows,
  serviceValuesFromRows
} from './queries.mjs'

// A run stops before a source or a backfill chunk when less than this is left
// of the Lambda timeout. It must exceed the time to process one chunk, which is
// mostly the Insights query deadline in insights.mjs. A result that reaches the
// row limit adds a query for each half, which this does not cover.
const MIN_REMAINING_MS = 60_000

// CloudWatch can add a datapoint to a bucket some minutes after the bucket
// closed, so a scheduled run reads the metrics again this far back.
export const METRICS_LOOKBACK_MS = 6 * BUCKET_MS

function config() {
  return {
    bucket: process.env.BUCKET,
    serviceLogGroupName: process.env.SERVICE_LOG_GROUP_NAME,
    apigwLogGroupName: process.env.APIGW_LOG_GROUP_NAME || null,
    proxyLogGroupName: process.env.PROXY_LOG_GROUP_NAME || null,
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
export function scheduledRange(watermarkMs, endMs, lookbackMs, maxRangeMs) {
  const start = Number.isNaN(watermarkMs) ? endMs - BUCKET_MS : watermarkMs
  const fromMs = Math.min(start, endMs - lookbackMs)
  return { fromMs, toMs: Math.min(endMs, fromMs + maxRangeMs) }
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

function logSource(
  name,
  logGroupName,
  maxRangeMs,
  queryString,
  series,
  toValues
) {
  return {
    name,
    lookbackMs: 0,
    maxRangeMs,
    series,
    async collect(fromMs, toMs) {
      const rows = await queryBuckets([logGroupName], queryString, fromMs, toMs)
      return toValues(rows, fromMs, toMs)
    }
  }
}

// The name of a source is also its key in the state file. maxRangeMs is the
// longest range of one query or GetMetricData call. A log group without a
// name has no source.
function sources(cfg) {
  return [
    logSource(
      'service',
      cfg.serviceLogGroupName,
      SERVICE_MAX_RANGE_MS,
      SERVICE_QUERY,
      SERVICE_SERIES,
      serviceValuesFromRows
    ),
    cfg.apigwLogGroupName &&
      logSource(
        'apigw',
        cfg.apigwLogGroupName,
        APIGW_MAX_RANGE_MS,
        APIGW_QUERY,
        APIGW_SERIES,
        apigwValuesFromRows
      ),
    cfg.proxyLogGroupName &&
      logSource(
        'proxy',
        cfg.proxyLogGroupName,
        PROXY_MAX_RANGE_MS,
        PROXY_QUERY,
        PROXY_SERIES,
        proxyValuesFromRows
      ),
    {
      name: 'metrics',
      lookbackMs: METRICS_LOOKBACK_MS,
      maxRangeMs: DAY_MS,
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
  ].filter(Boolean)
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
  // A series with an open-ended label is only in the values.
  const valueKeys = [...values.values()].flatMap((slot) => Object.keys(slot))
  const series = seriesMeta([
    ...new Set([...succeeded.flatMap((source) => source.series), ...valueKeys])
  ])

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
// Each run makes at most one query or call for each source, from its
// watermark. A source that fails keeps its watermark, so the next run retries
// it, and the other sources continue.
async function runScheduled(cfg, nowMs, context) {
  const endMs = latestClosedEnd(nowMs, cfg.ingestionDelayMs)
  const state = await readState(cfg.bucket)
  const processed = {}
  const failures = []

  const scheduledSources = sources(cfg)
  const watermarks = scheduledSources.map((source) =>
    parseWatermark(state[source.name])
  )

  for (const [i, source] of scheduledSources.entries()) {
    const watermarkMs = watermarks[i]
    const { fromMs, toMs } = scheduledRange(
      watermarkMs,
      endMs,
      source.lookbackMs,
      source.maxRangeMs
    )
    if (fromMs >= toMs) continue
    if (context.getRemainingTimeInMillis() < MIN_REMAINING_MS) {
      console.log(`Stopped before ${source.name}, the next run continues`)
      break
    }
    let sourceFailures
    try {
      sourceFailures = await storeRange(cfg, [source], fromMs, toMs)
    } catch (err) {
      sourceFailures = [`${source.name}: ${err.message}`]
    }
    if (sourceFailures.length > 0) {
      failures.push(
        `Failed to collect ${rangeText(fromMs, toMs)}: ${sourceFailures.join('; ')}`
      )
      continue
    }
    // The metrics lookback, or a retried run for an earlier time, can process
    // a range that ends before the watermark.
    if (Number.isNaN(watermarkMs) || toMs > watermarkMs) {
      state[source.name] = isoTime(toMs)
      await writeState(cfg.bucket, state)
    }
    processed[source.name] = { from: isoTime(fromMs), to: isoTime(toMs) }
    console.log(`Processed ${source.name} ${rangeText(fromMs, toMs)}`)
  }

  if (failures.length > 0) throw new Error(failures.join('; '))
  return processed
}

// Gives the sources named in `names`, or all of them without names.
export function selectSources(available, names) {
  if (names === undefined) return available
  const known = available.map((source) => source.name)
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.some((name) => !known.includes(name))
  ) {
    throw new Error(
      `Invalid backfill sources ${JSON.stringify(names)}, the configured sources are ${known.join(', ')}`
    )
  }
  return available.filter((source) => names.includes(source.name))
}

async function runBackfill(cfg, backfill, context) {
  const { fromMs, toMs } = backfillRange(
    backfill,
    Date.now(),
    cfg.ingestionDelayMs
  )
  const backfillSources = selectSources(sources(cfg), backfill.sources)
  const chunkMs = Math.min(
    ...backfillSources.map((source) => source.maxRangeMs)
  )
  const processed = []
  for (const chunk of splitIntoChunks(fromMs, toMs, chunkMs)) {
    if (context.getRemainingTimeInMillis() < MIN_REMAINING_MS) {
      const next = {
        from: isoTime(chunk.fromMs),
        to: isoTime(toMs),
        ...(backfill.sources && { sources: backfill.sources })
      }
      console.log(
        `Backfill stopped before ${next.from}, invoke again with ${JSON.stringify({ backfill: next })}`
      )
      return { processed, next }
    }
    const failures = await storeRange(
      cfg,
      backfillSources,
      chunk.fromMs,
      chunk.toMs
    )
    const range = rangeText(chunk.fromMs, chunk.toMs)
    if (failures.length > 0) {
      throw new Error(`Failed to collect ${range}: ${failures.join('; ')}`)
    }
    console.log(`Backfilled ${range}`)
    processed.push(range)
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
