import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { ssmStub } from './stub-ssm.mjs'

process.env.BUCKET = 'test-bucket'
process.env.TOKEN_SSM_NAME = '/staging/evaka/ops-metrics-token'

const { bearerToken, parseRange, tokensMatch } = await import('./reader.mjs')

// The token cache is module-scope state. A unique query string gives each test
// that depends on it a fresh instance.
let moduleLoadCount = 0
function freshReader() {
  return import(`./reader.mjs?case=${moduleLoadCount++}`)
}

function request({
  authorization = 'Bearer stub-token',
  query,
  path = '/files',
  method = 'GET'
} = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: authorization ? { authorization } : {},
    queryStringParameters: query ?? {
      from: '2026-10-05T00:00Z',
      to: '2026-10-06T12:00Z'
    }
  }
}

describe('bearerToken', () => {
  it('reads the token from a bearer header', () => {
    assert.equal(bearerToken('Bearer abc'), 'abc')
    assert.equal(bearerToken('bearer abc'), 'abc')
  })

  it('gives null for a missing or different scheme', () => {
    assert.equal(bearerToken(undefined), null)
    assert.equal(bearerToken('Basic abc'), null)
    assert.equal(bearerToken('Bearer '), null)
  })
})

describe('tokensMatch', () => {
  it('matches only the same token', () => {
    assert.equal(tokensMatch('secret', 'secret'), true)
    assert.equal(tokensMatch('secret', 'secreT'), false)
    assert.equal(tokensMatch('secret', 'secret-but-longer'), false)
  })

  it('never matches an empty token', () => {
    assert.equal(tokensMatch('', ''), false)
    assert.equal(tokensMatch(null, 'secret'), false)
    assert.equal(tokensMatch('secret', undefined), false)
  })
})

describe('parseRange', () => {
  it('accepts ISO times with and without seconds', () => {
    assert.deepEqual(
      parseRange('2026-10-05T00:00Z', '2026-10-06T12:00:00.000Z'),
      {
        fromMs: Date.parse('2026-10-05T00:00Z'),
        toMs: Date.parse('2026-10-06T12:00Z')
      }
    )
  })

  it('accepts exactly 31 days', () => {
    assert.equal(
      parseRange('2026-10-01T00:00Z', '2026-11-01T00:00Z').error,
      undefined
    )
  })

  it('refuses a missing, malformed, reversed or too long range', () => {
    assert.ok(parseRange(undefined, '2026-10-06T00:00Z').error)
    assert.ok(parseRange('yesterday', '2026-10-06T00:00Z').error)
    assert.ok(parseRange('2026-10-06T00:00Z', '2026-10-05T00:00Z').error)
    assert.ok(parseRange('2026-10-05T00:00Z', '2026-10-05T00:00Z').error)
    assert.ok(parseRange('2026-10-01T00:00Z', '2026-11-01T00:00:01Z').error)
  })
})

describe('handler', () => {
  beforeEach(() => ssmStub.reset())

  it('returns presigned URLs for each UTC day of the range', async () => {
    const { handler } = await freshReader()
    const response = await handler(request())
    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.resolution, '5min')
    assert.deepEqual(body.files, [
      {
        key: '5min/2026/10/05.json',
        url: 'https://test-bucket.s3.stub/5min/2026/10/05.json?X-Amz-Expires=900'
      },
      {
        key: '5min/2026/10/06.json',
        url: 'https://test-bucket.s3.stub/5min/2026/10/06.json?X-Amz-Expires=900'
      }
    ])
    assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const expiresInMs = Date.parse(body.expiresAt) - Date.now()
    assert.ok(expiresInMs > 890_000 && expiresInMs <= 900_000)
    assert.equal(
      ssmStub.calls[0].input.Name,
      '/staging/evaka/ops-metrics-token'
    )
    assert.equal(ssmStub.calls[0].input.WithDecryption, true)
  })

  it('returns 401 for a wrong or missing token', async () => {
    const { handler } = await freshReader()
    for (const authorization of ['Bearer wrong', null, 'stub-token']) {
      const response = await handler(request({ authorization }))
      assert.equal(response.statusCode, 401)
      assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' })
    }
  })

  it('checks the token before the range', async () => {
    const { handler } = await freshReader()
    const response = await handler(
      request({ authorization: 'Bearer wrong', query: {} })
    )
    assert.equal(response.statusCode, 401)
  })

  it('returns 400 for a bad range', async () => {
    const { handler } = await freshReader()
    const response = await handler(
      request({ query: { from: '2026-09-01T00:00Z', to: '2026-10-06T00:00Z' } })
    )
    assert.equal(response.statusCode, 400)
  })

  it('returns 404 for another path and 405 for another method', async () => {
    const { handler } = await freshReader()
    assert.equal((await handler(request({ path: '/' }))).statusCode, 404)
    assert.equal((await handler(request({ method: 'POST' }))).statusCode, 405)
  })

  it('returns 500 when the token cannot be read', async () => {
    const { handler } = await freshReader()
    ssmStub.error = new Error('ssm down')
    const response = await handler(request())
    assert.equal(response.statusCode, 500)
  })

  it('reads the token from SSM again only after the cache time', async () => {
    const { getToken, TOKEN_CACHE_MS } = await freshReader()
    await getToken(1_000)
    ssmStub.parameterValue = 'rotated'
    assert.equal(await getToken(1_000 + TOKEN_CACHE_MS - 1), 'stub-token')
    assert.equal(ssmStub.calls.length, 1)
    assert.equal(await getToken(1_000 + TOKEN_CACHE_MS), 'rotated')
    assert.equal(ssmStub.calls.length, 2)
  })
})
