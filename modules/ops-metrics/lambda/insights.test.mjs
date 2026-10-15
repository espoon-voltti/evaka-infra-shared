import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { cloudwatchLogsStub } from './stub-cloudwatch-logs.mjs'
import { parseBinTime, rowToObject, runInsightsQuery } from './insights.mjs'

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
