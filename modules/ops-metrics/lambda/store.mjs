import { gzipSync, gunzipSync } from 'node:zlib'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3'

export const BUCKET_MS = 5 * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000

export const STATE_KEY = 'state/collector.json'

const s3 = new S3Client({})

export function floorToBucket(ms) {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS
}

export function ceilToBucket(ms) {
  return Math.ceil(ms / BUCKET_MS) * BUCKET_MS
}

export function utcDayStart(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

export function isoTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function bucketStarts(fromMs, toMs) {
  const starts = []
  for (let t = ceilToBucket(fromMs); t < toMs; t += BUCKET_MS) starts.push(t)
  return starts
}

export function dayKey(ms) {
  const [date] = new Date(ms).toISOString().split('T')
  return `5min/${date.replaceAll('-', '/')}.json`
}

// One key for each UTC day that overlaps [fromMs, toMs).
export function dayKeysForRange(fromMs, toMs) {
  const keys = []
  for (let day = utcDayStart(fromMs); day < toMs; day += DAY_MS) {
    keys.push(dayKey(day))
  }
  return keys
}

// Chunks end at multiples of chunkMs since the epoch, so a chunkMs that
// divides a day never crosses a UTC midnight.
export function splitIntoChunks(fromMs, toMs, chunkMs) {
  const chunks = []
  for (let start = fromMs; start < toMs; ) {
    const end = Math.min(Math.floor(start / chunkMs) * chunkMs + chunkMs, toMs)
    chunks.push({ fromMs: start, toMs: end })
    start = end
  }
  return chunks
}

// A histogram has a count below the first bound, one between each two bounds,
// and one at or above the last bound.
function histogramSize(meta) {
  return meta.bounds.length + 1
}

function zeroValue(meta) {
  switch (meta.type) {
    case 'counter':
      return 0
    case 'histogram':
      return new Array(histogramSize(meta)).fill(0)
    default:
      throw new Error(`A ${meta.type} series has no zero value`)
  }
}

// Logs Insights returns no row for a count of zero. Inside a processed range a
// missing counter or histogram means zero, and only outside it does a missing
// key mean that the value is not known. `series` maps each name to fill to its
// metadata.
export function zeroFill(valuesByTime, starts, series) {
  const filled = new Map(valuesByTime)
  for (const t of starts) {
    const values = { ...filled.get(t) }
    for (const [name, meta] of Object.entries(series)) {
      values[name] ??= zeroValue(meta)
    }
    filled.set(t, values)
  }
  return filled
}

export function toSlots(valuesByTime) {
  return [...valuesByTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, values]) => ({ t: isoTime(t), ...values }))
}

// A series key in a new slot replaces the key in the stored slot with the same
// t, and the other keys of the stored slot stay. Thus a source that writes
// less often than every 5 minutes can add its keys to slots that already exist.
export function upsertSlots(day, series, slots) {
  const byTime = new Map(day.slots.map((slot) => [slot.t, slot]))
  for (const slot of slots) {
    byTime.set(slot.t, { ...byTime.get(slot.t), ...slot })
  }
  return {
    series: { ...day.series, ...series },
    slots: [...byTime.values()].sort((a, b) =>
      a.t < b.t ? -1 : a.t > b.t ? 1 : 0
    )
  }
}

function emptyDay() {
  return { series: {}, slots: [] }
}

export function encodeDay(day) {
  return gzipSync(JSON.stringify(day))
}

export function decodeDay(bytes) {
  return JSON.parse(gunzipSync(bytes).toString('utf8'))
}

// A missing object is a 404 only because the collector role has
// s3:ListBucket; without it S3 answers 403.
function isNotFound(err) {
  return err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404
}

// The SDK does not decode Content-Encoding: gzip, so the body is the
// compressed bytes.
export async function readDay(bucket, key) {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    )
    return decodeDay(await response.Body.transformToByteArray())
  } catch (err) {
    if (isNotFound(err)) return emptyDay()
    throw err
  }
}

// Cache-Control keeps the browser from reusing a stale copy of the current
// day through a presigned URL that has not expired yet.
async function writeDay(bucket, key, day) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: encodeDay(day),
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
      CacheControl: 'no-cache'
    })
  )
}

export async function upsertDay(bucket, key, series, slots) {
  const day = await readDay(bucket, key)
  await writeDay(bucket, key, upsertSlots(day, series, slots))
}

// A state file that cannot be read fails the run: starting again from the
// latest closed bucket would leave a hole in the data.
export async function readState(bucket) {
  let body
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: STATE_KEY })
    )
    body = await response.Body.transformToString()
  } catch (err) {
    if (isNotFound(err)) return {}
    throw err
  }
  let state
  try {
    state = JSON.parse(body)
  } catch (err) {
    throw new Error(`${STATE_KEY} is not valid JSON: ${err.message}`)
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`${STATE_KEY} is not a JSON object`)
  }
  return state
}

export async function writeState(bucket, state) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: STATE_KEY,
      Body: JSON.stringify(state),
      ContentType: 'application/json'
    })
  )
}
