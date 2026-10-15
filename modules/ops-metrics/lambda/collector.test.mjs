import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { cloudwatchLogsStub } from './stub-cloudwatch-logs.mjs'
import { cloudwatchStub } from './stub-cloudwatch.mjs'
import { s3Stub } from './stub-s3.mjs'
import { decodeDay } from './store.mjs'

process.env.BUCKET = 'test-bucket'
process.env.SERVICE_LOG_GROUP_NAME = 'evaka-srv-staging'
process.env.RDS_INSTANCE_IDENTIFIER = 'evaka-staging'
delete process.env.INGESTION_DELAY_SECONDS

const {
  LOGIN_QUERY,
  LOGIN_SERIES_BY_EVENT_CODE,
  backfillRange,
  groupByDay,
  handler,
  loginCountsFromRows,
  mergeValues,
  scheduledRange,
  summariesToValues
} = await import('./collector.mjs')

const ms = (iso) => Date.parse(iso)
const STRONG = 'citizen.login{auth=strong}'
const WEAK = 'citizen.login{auth=weak}'

function insightsRow(t, eventCode, n) {
  return [
    { field: 't', value: t },
    { field: 'eventCode', value: eventCode },
    { field: 'n', value: String(n) }
  ]
}

function metricData(timestamps, value) {
  return {
    MetricDataResults: ['min', 'mean', 'max', 'n'].map((Id) => ({
      Id,
      Timestamps: timestamps.map((t) => new Date(t)),
      Values: timestamps.map(() => (Id === 'n' ? 5 : value))
    }))
  }
}

function storedDay(key) {
  const object = s3Stub.objects.get(key)
  return object ? decodeDay(object.Body) : null
}

const context = (remaining = () => 300_000) => ({
  getRemainingTimeInMillis: remaining
})

describe('LOGIN_QUERY', () => {
  it('is the query of the spec', () => {
    assert.equal(
      LOGIN_QUERY,
      [
        'fields @timestamp',
        '| filter type = "app-audit-events" and eventCode in ["CitizenLogin", "CitizenWeakLogin", "CitizenPasskeyLogin"]',
        '| stats count() as n by bin(5m) as t, eventCode'
      ].join('\n')
    )
  })

  it('filters by every event code that maps to a login series', () => {
    const codes = JSON.parse(/eventCode in (\[[^\]]*\])/.exec(LOGIN_QUERY)[1])
    assert.deepEqual(codes, Object.keys(LOGIN_SERIES_BY_EVENT_CODE))
  })
})

describe('scheduledRange', () => {
  it('ends at the last bucket that closed at least the ingestion delay ago', () => {
    assert.deepEqual(scheduledRange(ms('2026-10-06T12:03:00Z'), 180_000), {
      fromMs: ms('2026-10-06T11:30:00Z'),
      toMs: ms('2026-10-06T12:00:00Z')
    })
  })

  it('does not include a bucket that closed less than the delay ago', () => {
    assert.equal(
      scheduledRange(ms('2026-10-06T12:02:59Z'), 180_000).toMs,
      ms('2026-10-06T11:55:00Z')
    )
  })
})

describe('backfillRange', () => {
  const now = ms('2026-10-06T12:03:00Z')

  it('aligns the range to buckets', () => {
    assert.deepEqual(
      backfillRange(
        { from: '2026-10-01T00:02:00Z', to: '2026-10-02T00:01:00Z' },
        now,
        180_000
      ),
      { fromMs: ms('2026-10-01T00:00:00Z'), toMs: ms('2026-10-02T00:05:00Z') }
    )
  })

  it('stops at the last closed bucket', () => {
    assert.equal(
      backfillRange(
        { from: '2026-10-06T00:00:00Z', to: '2026-10-07T00:00:00Z' },
        now,
        180_000
      ).toMs,
      ms('2026-10-06T12:00:00Z')
    )
  })

  it('throws for a time that is not valid', () => {
    assert.throws(
      () => backfillRange({ from: 'x', to: '2026-10-07T00:00:00Z' }, now, 0),
      /Invalid backfill range/
    )
  })
})

describe('loginCountsFromRows', () => {
  const from = ms('2026-10-06T00:00:00Z')
  const to = ms('2026-10-06T00:15:00Z')

  it('adds the weak login codes together and zero-fills the empty buckets', () => {
    const counts = loginCountsFromRows(
      [
        { t: '2026-10-06 00:00:00.000', eventCode: 'CitizenLogin', n: '12' },
        { t: '2026-10-06 00:00:00.000', eventCode: 'CitizenWeakLogin', n: '2' },
        {
          t: '2026-10-06 00:00:00.000',
          eventCode: 'CitizenPasskeyLogin',
          n: '1'
        },
        { t: '2026-10-06 00:10:00.000', eventCode: 'CitizenWeakLogin', n: '4' }
      ],
      from,
      to
    )
    assert.deepEqual(
      [...counts],
      [
        [ms('2026-10-06T00:00:00Z'), { [STRONG]: 12, [WEAK]: 3 }],
        [ms('2026-10-06T00:10:00Z'), { [WEAK]: 4, [STRONG]: 0 }],
        [ms('2026-10-06T00:05:00Z'), { [STRONG]: 0, [WEAK]: 0 }]
      ]
    )
  })

  it('drops rows outside the range and unknown event codes', () => {
    const counts = loginCountsFromRows(
      [
        { t: '2026-10-06 00:15:00.000', eventCode: 'CitizenLogin', n: '1' },
        { t: '2026-10-06 00:05:00.000', eventCode: 'EmployeeLogin', n: '1' }
      ],
      from,
      to
    )
    assert.equal(counts.size, 3)
    assert.equal(counts.has(ms('2026-10-06T00:15:00Z')), false)
    assert.deepEqual(counts.get(ms('2026-10-06T00:05:00Z')), {
      [STRONG]: 0,
      [WEAK]: 0
    })
  })
})

describe('summariesToValues', () => {
  it('keys each summary by the series name and drops times outside the range', () => {
    const summary = { min: 1, mean: 2, max: 3, n: 5 }
    const values = summariesToValues(
      new Map([
        [ms('2026-10-06T00:00:00Z'), summary],
        [ms('2026-10-06T00:30:00Z'), summary]
      ]),
      'rds.cpu',
      ms('2026-10-06T00:00:00Z'),
      ms('2026-10-06T00:30:00Z')
    )
    assert.deepEqual(
      [...values],
      [[ms('2026-10-06T00:00:00Z'), { 'rds.cpu': summary }]]
    )
  })
})

describe('mergeValues and groupByDay', () => {
  it('merges the values of the sources and groups them by UTC day', () => {
    const late = ms('2026-10-05T23:55:00Z')
    const early = ms('2026-10-06T00:00:00Z')
    const merged = mergeValues([
      new Map([
        [late, { a: 1 }],
        [early, { a: 2 }]
      ]),
      new Map([[late, { b: 3 }]])
    ])
    const days = groupByDay(merged)
    assert.deepEqual([...days.keys()], [ms('2026-10-05T00:00:00Z'), early])
    assert.deepEqual(days.get(ms('2026-10-05T00:00:00Z')).get(late), {
      a: 1,
      b: 3
    })
  })
})

describe('handler', () => {
  beforeEach(() => {
    cloudwatchLogsStub.reset()
    cloudwatchStub.reset()
    s3Stub.reset()
  })

  it('writes the last six buckets on a scheduled run', async () => {
    cloudwatchLogsStub.queryResults = [
      {
        status: 'Complete',
        results: [insightsRow('2026-10-06 11:50:00.000', 'CitizenLogin', 4)]
      }
    ]
    cloudwatchStub.responses = [metricData(['2026-10-06T11:50:00Z'], 20)]

    const result = await handler(
      { source: 'aws.events', time: '2026-10-06T12:03:00Z' },
      context()
    )

    assert.deepEqual(result, {
      from: '2026-10-06T11:30:00Z',
      to: '2026-10-06T12:00:00Z'
    })
    const start = cloudwatchLogsStub.calls[0].input
    assert.deepEqual(start.logGroupNames, ['evaka-srv-staging'])
    const metric =
      cloudwatchStub.calls[0].input.MetricDataQueries[0].MetricStat.Metric
    assert.deepEqual(metric.Dimensions, [
      { Name: 'DBInstanceIdentifier', Value: 'evaka-staging' }
    ])

    const day = storedDay('5min/2026/10/06.json')
    assert.deepEqual(day.series, {
      [STRONG]: { type: 'counter' },
      [WEAK]: { type: 'counter' },
      'rds.cpu': { type: 'gaugeSummary' }
    })
    assert.equal(day.slots.length, 6)
    assert.deepEqual(day.slots[4], {
      t: '2026-10-06T11:50:00Z',
      [STRONG]: 4,
      [WEAK]: 0,
      'rds.cpu': { min: 20, mean: 20, max: 20, n: 5 }
    })
    // A bucket with no RDS datapoint is a gap for rds.cpu but a zero for logins.
    assert.deepEqual(day.slots[0], {
      t: '2026-10-06T11:30:00Z',
      [STRONG]: 0,
      [WEAK]: 0
    })
  })

  it('writes to both day files when the scheduled range crosses midnight', async () => {
    cloudwatchLogsStub.queryResults = [{ status: 'Complete', results: [] }]
    await handler(
      { source: 'aws.events', time: '2026-10-06T00:13:00Z' },
      context()
    )
    assert.equal(storedDay('5min/2026/10/05.json').slots.length, 4)
    assert.equal(storedDay('5min/2026/10/06.json').slots.length, 2)
  })

  it('writes the logins and then fails when the RDS metrics fail', async () => {
    cloudwatchLogsStub.queryResults = [{ status: 'Complete', results: [] }]
    cloudwatchStub.error = new Error('throttled')
    await assert.rejects(
      handler(
        { source: 'aws.events', time: '2026-10-06T12:03:00Z' },
        context()
      ),
      /rds cpu: throttled/
    )
    const day = storedDay('5min/2026/10/06.json')
    assert.deepEqual(Object.keys(day.series), [STRONG, WEAK])
    assert.equal(day.slots.length, 6)
  })

  it('writes nothing for the logins when the Insights query fails', async () => {
    cloudwatchLogsStub.queryResults = [{ status: 'Failed' }]
    await assert.rejects(
      handler(
        { source: 'aws.events', time: '2026-10-06T12:03:00Z' },
        context()
      ),
      /citizen logins/
    )
    assert.equal(s3Stub.objects.size, 0)
  })

  it('backfills one query and one metric call for each UTC day', async () => {
    cloudwatchLogsStub.queryResults = [
      {
        status: 'Complete',
        results: [insightsRow('2026-10-01 08:00:00.000', 'CitizenWeakLogin', 2)]
      },
      { status: 'Complete', results: [] }
    ]
    const result = await handler(
      {
        backfill: { from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' }
      },
      context()
    )

    assert.deepEqual(result, {
      processed: ['5min/2026/10/01.json', '5min/2026/10/02.json'],
      next: null
    })
    const starts = cloudwatchLogsStub.calls.filter((c) => c.input.queryString)
    assert.deepEqual(
      starts.map((c) => [c.input.startTime, c.input.endTime]),
      [
        [ms('2026-10-01T00:00:00Z') / 1000, ms('2026-10-02T00:00:00Z') / 1000],
        [ms('2026-10-02T00:00:00Z') / 1000, ms('2026-10-03T00:00:00Z') / 1000]
      ]
    )
    assert.equal(cloudwatchStub.calls.length, 2)
    const day = storedDay('5min/2026/10/01.json')
    assert.equal(day.slots.length, 288)
    assert.equal(day.slots[96][WEAK], 2)
  })

  it('stops a backfill and names the next day when time runs out', async () => {
    cloudwatchLogsStub.queryResults = [{ status: 'Complete', results: [] }]
    const remaining = [300_000, 59_999]
    const result = await handler(
      {
        backfill: { from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' }
      },
      context(() => remaining.shift())
    )
    assert.deepEqual(result, {
      processed: ['5min/2026/10/01.json'],
      next: { from: '2026-10-02T00:00:00Z', to: '2026-10-03T00:00:00Z' }
    })
    assert.equal(storedDay('5min/2026/10/02.json'), null)
  })
})
