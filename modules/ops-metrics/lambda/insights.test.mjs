import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { cloudwatchLogsStub } from './stub-cloudwatch-logs.mjs'
import {
  RESULT_LIMIT,
  parseBinTime,
  queryBuckets,
  rowToObject,
  runInsightsQuery
} from './insights.mjs'

const ms = (iso) => Date.parse(iso)

const binRow = (t, n) => [
  { field: 't', value: t },
  { field: 'n', value: String(n) }
]

function startedRanges() {
  return cloudwatchLogsStub.calls
    .filter((c) => c.input.queryString)
    .map((c) => [c.input.startTime * 1000, c.input.endTime * 1000])
}

describe('parseBinTime', () => {
  it('reads the Insights bin format as UTC', () => {
    assert.equal(
      parseBinTime('2026-10-06 00:05:00.000'),
      Date.parse('2026-10-06T00:05:00Z')
    )
  })

  it('accepts an ISO time with a zone', () => {
    assert.equal(
      parseBinTime('2026-10-06T00:05:00Z'),
      Date.parse('2026-10-06T00:05:00Z')
    )
  })

  it('throws for a value that is not a time', () => {
    assert.throws(() => parseBinTime('nope'), /Unexpected bin time/)
  })
})

describe('rowToObject', () => {
  it('turns Insights fields into an object', () => {
    assert.deepEqual(
      rowToObject([
        { field: 't', value: '2026-10-06 00:05:00.000' },
        { field: 'n', value: '3' }
      ]),
      { t: '2026-10-06 00:05:00.000', n: '3' }
    )
  })
})

describe('runInsightsQuery', () => {
  beforeEach(() => cloudwatchLogsStub.reset())

  it('starts the query with the range in seconds and gives the rows as objects', async () => {
    cloudwatchLogsStub.queryResults = [
      { status: 'Running' },
      { status: 'Complete', results: [[{ field: 'n', value: '1' }]] }
    ]
    const rows = await runInsightsQuery(
      ['log-group'],
      'query',
      Date.parse('2026-10-06T00:00:00Z'),
      Date.parse('2026-10-06T00:30:00Z')
    )
    assert.deepEqual(rows, [{ n: '1' }])
    const start = cloudwatchLogsStub.calls[0].input
    assert.deepEqual(start.logGroupNames, ['log-group'])
    assert.equal(start.startTime, Date.parse('2026-10-06T00:00:00Z') / 1000)
    assert.equal(start.endTime, Date.parse('2026-10-06T00:30:00Z') / 1000)
  })

  it('throws when the query fails', async () => {
    cloudwatchLogsStub.queryResults = [{ status: 'Failed' }]
    await assert.rejects(
      runInsightsQuery(['g'], 'q', 0, 300_000),
      /status Failed/
    )
  })

  it('throws when the deadline passes', async () => {
    cloudwatchLogsStub.queryResults = Array(20).fill({ status: 'Running' })
    await assert.rejects(
      runInsightsQuery(['g'], 'q', 0, 300_000, { deadlineMs: 50 }),
      /status Running/
    )
  })
})

describe('queryBuckets', () => {
  beforeEach(() => cloudwatchLogsStub.reset())

  const from = ms('2026-10-06T00:00:00Z')
  const to = ms('2026-10-06T00:20:00Z')

  it('drops the bucket that starts at the inclusive end of the range', async () => {
    cloudwatchLogsStub.queryResults = [
      {
        status: 'Complete',
        results: [
          binRow('2026-10-06 00:15:00.000', 2),
          binRow('2026-10-06 00:20:00.000', 1)
        ]
      }
    ]
    const rows = await queryBuckets(['g'], 'q', from, to)
    assert.deepEqual(rows, [{ t: '2026-10-06 00:15:00.000', n: '2' }])
    assert.deepEqual(startedRanges(), [[from, to]])
  })

  it('queries each half again when a result has as many rows as the limit', async () => {
    const full = Array.from({ length: RESULT_LIMIT }, () =>
      binRow('2026-10-06 00:00:00.000', 1)
    )
    cloudwatchLogsStub.queryResults = [
      { status: 'Complete', results: full },
      {
        status: 'Complete',
        results: [
          binRow('2026-10-06 00:00:00.000', 3),
          binRow('2026-10-06 00:10:00.000', 9)
        ]
      },
      {
        status: 'Complete',
        results: [
          binRow('2026-10-06 00:10:00.000', 4),
          binRow('2026-10-06 00:20:00.000', 5)
        ]
      }
    ]
    const rows = await queryBuckets(['g'], 'q', from, to)
    const mid = ms('2026-10-06T00:10:00Z')
    assert.deepEqual(startedRanges(), [
      [from, to],
      [from, mid],
      [mid, to]
    ])
    // The first half returns the first second of the bucket at 00:10 too,
    // which the second half counts in full.
    assert.deepEqual(rows, [
      { t: '2026-10-06 00:00:00.000', n: '3' },
      { t: '2026-10-06 00:10:00.000', n: '4' }
    ])
  })

  it('splits at a bucket start', async () => {
    const full = { status: 'Complete', results: Array(RESULT_LIMIT).fill([]) }
    cloudwatchLogsStub.queryResults = [
      full,
      { status: 'Complete', results: [] },
      { status: 'Complete', results: [] }
    ]
    await queryBuckets(['g'], 'q', from, ms('2026-10-06T00:15:00Z'))
    assert.deepEqual(startedRanges().slice(1), [
      [from, ms('2026-10-06T00:05:00Z')],
      [ms('2026-10-06T00:05:00Z'), ms('2026-10-06T00:15:00Z')]
    ])
  })

  it('throws when a single bucket has as many rows as the limit', async () => {
    cloudwatchLogsStub.queryResults = [
      { status: 'Complete', results: Array(RESULT_LIMIT).fill([]) }
    ]
    await assert.rejects(
      queryBuckets(['g'], 'q', from, ms('2026-10-06T00:05:00Z')),
      /10000 rows for the bucket at 2026-10-06T00:00:00Z/
    )
  })
})
