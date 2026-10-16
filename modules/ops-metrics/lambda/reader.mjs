import { createHash, timingSafeEqual } from 'node:crypto'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { DAY_MS, dayKeysForRange, isoTime } from './store.mjs'

export const TOKEN_CACHE_MS = 300_000
const MAX_RANGE_MS = 31 * DAY_MS
const URL_EXPIRY_SECONDS = 900

const ssmClient = new SSMClient({})
const s3 = new S3Client({})

let cachedToken = null

export async function getToken(nowMs = Date.now()) {
  if (cachedToken && nowMs - cachedToken.fetchedAtMs < TOKEN_CACHE_MS) {
    return cachedToken.value
  }
  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: process.env.TOKEN_SSM_NAME,
      WithDecryption: true
    })
  )
  cachedToken = { value: result.Parameter.Value, fetchedAtMs: nowMs }
  return cachedToken.value
}

export function bearerToken(authorization) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '')
  return match ? match[1] : null
}

// Hashing gives buffers of equal length, which timingSafeEqual requires, and
// so the time of the compare does not show the length of the token.
export function tokensMatch(given, expected) {
  if (!given || !expected) return false
  const hash = (value) => createHash('sha256').update(value).digest()
  return timingSafeEqual(hash(given), hash(expected))
}

const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/

export function parseRange(from, to) {
  if (!ISO_TIME.test(from ?? '') || !ISO_TIME.test(to ?? '')) {
    return { error: 'from and to must be ISO 8601 times' }
  }
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return { error: 'from and to must be ISO 8601 times' }
  }
  if (toMs <= fromMs) return { error: 'to must be after from' }
  if (toMs - fromMs > MAX_RANGE_MS) {
    return { error: 'the range must not be longer than 31 days' }
  }
  return { fromMs, toMs }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }
}

async function presign(key) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: process.env.BUCKET, Key: key }),
    { expiresIn: URL_EXPIRY_SECONDS }
  )
}

async function handleFiles(event) {
  const token = await getToken()
  if (!tokensMatch(bearerToken(event.headers?.authorization), token)) {
    return json(401, { error: 'unauthorized' })
  }

  const params = event.queryStringParameters ?? {}
  const range = parseRange(params.from, params.to)
  if (range.error) return json(400, { error: range.error })

  const expiresAt = isoTime(Date.now() + URL_EXPIRY_SECONDS * 1000)
  const keys = dayKeysForRange(range.fromMs, range.toMs)
  const files = await Promise.all(
    keys.map(async (key) => ({ key, url: await presign(key) }))
  )
  return json(200, { resolution: '5min', files, expiresAt })
}

// The Function URL answers CORS preflight requests itself, so this handler
// gets only the actual requests.
export async function handler(event) {
  const method = event.requestContext?.http?.method
  if (event.rawPath !== '/files') return json(404, { error: 'not found' })
  if (method !== 'GET') return json(405, { error: 'method not allowed' })
  try {
    return await handleFiles(event)
  } catch (err) {
    console.error('Failed to handle request:', err)
    return json(500, { error: 'internal error' })
  }
}
