import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { cloudwatchLogsStub } from './stub-cloudwatch-logs.mjs'
import { cloudwatchStub } from './stub-cloudwatch.mjs'
import { s3Stub } from './stub-s3.mjs'
import { STATE_KEY, decodeDay } from './store.mjs'

process.env.BUCKET = 'test-bucket'
process.env.SERVICE_LOG_GROUP_NAME = 'evaka-srv-staging'
process.env.RDS_INSTANCE_IDENTIFIER = 'evaka-staging'
delete process.env.INGESTION_DELAY_SECONDS

const {
  METRICS_LOOKBACK_MS,
  backfillRange,
  groupByDay,
  handler,
  mergeValues,
  latestClosedEnd,
  scheduledRange,
  summariesToValues
} = await import('./collector.mjs')
const { DAY_MS } = await import('./store.mjs')
const { SERVICE_SERIES } = await import('./queries.mjs')

const ms = (iso) => Date.parse(iso)
const STRONG = 'citizen.login{auth=strong}'
const WEAK = 'citizen.login{auth=weak}'

// A result row of the service query for an audit event.
function insightsRow(t, eventCode, n) {
  return [
    { field: 't', value: t },
    { field: 'type', value: 'app-audit-events' },
    { field: 'k', value: eventCode },
    { field: 'level', value: '-' },
    { field: 'kind', value: '-' },
    { field: 'jobType', value: '-' },
    { field: 'rt', value: '0' },
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

function runScheduled(time, ctx = context()) {
  return handler({ source: 'aws.events', time }, ctx)
}

function queueEmptyQueryResults(count) {
  cloudwatchLogsStub.queryResults = Array.from({ length: count }, () => ({
    status: 'Complete',
    results: []
  }))
}

function storedState() {
  const object = s3Stub.objects.get(STATE_KEY)
  return object ? JSON.parse(object.Body) : null
}

function setStoredState(state) {
  s3Stub.objects.set(STATE_KEY, { Body: JSON.stringify(state) })
}

const isoSeconds = (seconds) =>
  new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')

function logQueryRanges() {
  return cloudwatchLogsStub.calls
    .filter((c) => c.input.queryString)
    .map((c) => [isoSeconds(c.input.startTime), isoSeconds(c.input.endTime)])
}

function metricRanges() {
  return cloudwatchStub.calls.map((c) => [
    c.input.StartTime.toISOString().replace('.000Z', 'Z'),
    c.input.EndTime.toISOString().replace('.000Z', 'Z')
  ])
}

describe('latestClosedEnd', () => {
  it('is the end of the last bucket that closed at least the delay ago', () => {
    assert.equal(
      latestClosedEnd(ms('2026-10-06T12:06:00Z'), 300_000),
      ms('2026-10-06T12:00:00Z')
    )
    assert.equal(
      latestClosedEnd(ms('2026-10-06T12:04:59Z'), 300_000),
      ms('2026-10-06T11:55:00Z')
    )
  })
})

describe('scheduledRange', () => {
  const end = ms('2026-10-06T12:00:00Z')

  it('starts at the watermark', () => {
    assert.deepEqual(
      scheduledRange(ms('2026-10-06T11:55:00Z'), end, 0, DAY_MS),
      { fromMs: ms('2026-10-06T11:55:00Z'), toMs: end }
    )
  })

  it('is only the latest closed bucket without a watermark', () => {
    assert.deepEqual(scheduledRange(NaN, end, 0, DAY_MS), {
      fromMs: ms('2026-10-06T11:55:00Z'),
      toMs: end
    })
  })

  it('is empty when the watermark is at the end', () => {
    const { fromMs, toMs } = scheduledRange(end, end, 0, DAY_MS)
    assert.equal(fromMs, toMs)
  })

  it('starts at the lookback when the watermark is later', () => {
    assert.deepEqual(scheduledRange(end, end, METRICS_LOOKBACK_MS, DAY_MS), {
      fromMs: ms('2026-10-06T11:30:00Z'),
      toMs: end
    })
  })

  it('covers at most the longest range of the source', () => {
    assert.deepEqual(
      scheduledRange(ms('2026-10-01T00:00:00Z'), end, 0, DAY_MS / 2),
      { fromMs: ms('2026-10-01T00:00:00Z'), toMs: ms('2026-10-01T12:00:00Z') }
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

  it('processes only the latest closed bucket on the first run', async () => {
    cloudwatchLogsStub.queryResults = [
      {
        status: 'Complete',
        results: [insightsRow('2026-10-06 11:55:00.000', 'CitizenLogin', 4)]
      }
    ]
    cloudwatchStub.responses = [
      metricData(['2026-10-06T11:30:00Z', '2026-10-06T11:55:00Z'], 20)
    ]

    const result = await runScheduled('2026-10-06T12:06:00Z')

    assert.deepEqual(result, {
      service: { from: '2026-10-06T11:55:00Z', to: '2026-10-06T12:00:00Z' },
      metrics: { from: '2026-10-06T11:30:00Z', to: '2026-10-06T12:00:00Z' }
    })
    assert.deepEqual(logQueryRanges(), [
      ['2026-10-06T11:55:00Z', '2026-10-06T12:00:00Z']
    ])
    assert.deepEqual(cloudwatchLogsStub.calls[0].input.logGroupNames, [
      'evaka-srv-staging'
    ])
    assert.deepEqual(metricRanges(), [
      ['2026-10-06T11:30:00Z', '2026-10-06T12:00:00Z']
    ])
    const metric =
      cloudwatchStub.calls[0].input.MetricDataQueries[0].MetricStat.Metric
    assert.deepEqual(metric.Dimensions, [
      { Name: 'DBInstanceIdentifier', Value: 'evaka-staging' }
    ])
    assert.deepEqual(storedState(), {
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })

    const day = storedDay('5min/2026/10/06.json')
    assert.deepEqual(
      Object.keys(day.series).sort(),
      [...SERVICE_SERIES, 'rds.cpu'].sort()
    )
    assert.deepEqual(day.series[STRONG], { type: 'counter' })
    assert.deepEqual(day.series['rds.cpu'], { type: 'gaugeSummary' })
    // The service series are zero-filled only in the bucket that the query
    // covered.
    const cpu = { min: 20, mean: 20, max: 20, n: 5 }
    assert.deepEqual(day.slots[0], {
      t: '2026-10-06T11:30:00Z',
      'rds.cpu': cpu
    })
    assert.equal(day.slots.length, 2)
    assert.equal(day.slots[1].t, '2026-10-06T11:55:00Z')
    assert.equal(day.slots[1][STRONG], 4)
    assert.equal(day.slots[1][WEAK], 0)
    assert.deepEqual(day.slots[1]['rds.cpu'], cpu)
    assert.equal(Object.keys(day.slots[1]).length, SERVICE_SERIES.length + 2)
  })

  it('processes one bucket after the watermark on a normal run', async () => {
    setStoredState({
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    queueEmptyQueryResults(1)

    await runScheduled('2026-10-06T12:11:00Z')

    assert.deepEqual(logQueryRanges(), [
      ['2026-10-06T12:00:00Z', '2026-10-06T12:05:00Z']
    ])
    assert.deepEqual(metricRanges(), [
      ['2026-10-06T11:35:00Z', '2026-10-06T12:05:00Z']
    ])
    assert.deepEqual(storedState(), {
      service: '2026-10-06T12:05:00Z',
      metrics: '2026-10-06T12:05:00Z'
    })
    const day = storedDay('5min/2026/10/06.json')
    assert.deepEqual(
      day.slots.map((slot) => [slot.t, slot[STRONG], slot[WEAK]]),
      [['2026-10-06T12:00:00Z', 0, 0]]
    )
  })

  it('stores the metadata of a job type series found in the rows', async () => {
    setStoredState({
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    cloudwatchLogsStub.queryResults = [
      {
        status: 'Complete',
        results: [
          [
            { field: 't', value: '2026-10-06 12:00:00.000' },
            { field: 'type', value: 'app-misc' },
            { field: 'k', value: '-' },
            { field: 'level', value: 'WARN' },
            { field: 'kind', value: 'Failed to run async job' },
            { field: 'jobType', value: 'SendMessage' },
            { field: 'rt', value: '0' },
            { field: 'n', value: '2' }
          ]
        ]
      }
    ]

    await runScheduled('2026-10-06T12:11:00Z')

    const day = storedDay('5min/2026/10/06.json')
    const series = 'service.asyncJob.failed{type=SendMessage}'
    assert.deepEqual(day.series[series], { type: 'counter' })
    assert.equal(day.slots[0][series], 2)
    assert.equal(day.slots[0]['service.asyncJob.failed'], 2)
  })

  it('runs no Insights query when no bucket closed after the watermark', async () => {
    setStoredState({
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })

    const result = await runScheduled('2026-10-06T12:09:59Z')

    assert.deepEqual(result, {
      metrics: { from: '2026-10-06T11:30:00Z', to: '2026-10-06T12:00:00Z' }
    })
    assert.deepEqual(logQueryRanges(), [])
    assert.equal(storedState().service, '2026-10-06T12:00:00Z')
  })

  it('catches up a 3-hour outage in one query', async () => {
    setStoredState({
      service: '2026-10-06T09:00:00Z',
      metrics: '2026-10-06T09:00:00Z'
    })
    queueEmptyQueryResults(1)

    await runScheduled('2026-10-06T12:06:00Z')

    assert.deepEqual(logQueryRanges(), [
      ['2026-10-06T09:00:00Z', '2026-10-06T12:00:00Z']
    ])
    assert.deepEqual(metricRanges(), [
      ['2026-10-06T09:00:00Z', '2026-10-06T12:00:00Z']
    ])
    assert.deepEqual(storedState(), {
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    assert.equal(storedDay('5min/2026/10/06.json').slots.length, 36)
  })

  it('catches up an outage one range of each source per run', async () => {
    setStoredState({
      service: '2026-10-05T06:00:00Z',
      metrics: '2026-10-05T06:00:00Z'
    })

    queueEmptyQueryResults(1)
    await runScheduled('2026-10-06T12:06:00Z')
    assert.deepEqual(storedState(), {
      service: '2026-10-05T18:00:00Z',
      metrics: '2026-10-06T06:00:00Z'
    })

    queueEmptyQueryResults(1)
    await runScheduled('2026-10-06T12:11:00Z')
    assert.deepEqual(storedState(), {
      service: '2026-10-06T06:00:00Z',
      metrics: '2026-10-06T12:05:00Z'
    })

    queueEmptyQueryResults(1)
    await runScheduled('2026-10-06T12:16:00Z')
    assert.deepEqual(storedState(), {
      service: '2026-10-06T12:10:00Z',
      metrics: '2026-10-06T12:10:00Z'
    })

    assert.deepEqual(logQueryRanges(), [
      ['2026-10-05T06:00:00Z', '2026-10-05T18:00:00Z'],
      ['2026-10-05T18:00:00Z', '2026-10-06T06:00:00Z'],
      ['2026-10-06T06:00:00Z', '2026-10-06T12:10:00Z']
    ])
    assert.deepEqual(metricRanges(), [
      ['2026-10-05T06:00:00Z', '2026-10-06T06:00:00Z'],
      ['2026-10-06T06:00:00Z', '2026-10-06T12:05:00Z'],
      ['2026-10-06T11:40:00Z', '2026-10-06T12:10:00Z']
    ])
    assert.equal(storedDay('5min/2026/10/05.json').slots.length, 216)
    assert.equal(storedDay('5min/2026/10/06.json').slots.length, 146)
  })

  it('stops before a source when the time runs low and continues on the next run', async () => {
    setStoredState({
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    queueEmptyQueryResults(1)
    const remaining = [300_000, 59_999]

    const result = await runScheduled(
      '2026-10-06T12:11:00Z',
      context(() => remaining.shift())
    )
    assert.deepEqual(Object.keys(result), ['service'])
    assert.deepEqual(metricRanges(), [])
    assert.deepEqual(storedState(), {
      service: '2026-10-06T12:05:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })

    queueEmptyQueryResults(1)
    await runScheduled('2026-10-06T12:16:00Z')
    assert.deepEqual(metricRanges(), [
      ['2026-10-06T11:40:00Z', '2026-10-06T12:10:00Z']
    ])
  })

  it('keeps the watermark of a failed source and advances the other', async () => {
    setStoredState({
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    cloudwatchLogsStub.queryResults = [{ status: 'Failed' }]
    cloudwatchStub.responses = [metricData(['2026-10-06T12:00:00Z'], 20)]

    await assert.rejects(runScheduled('2026-10-06T12:11:00Z'), /service: /)
    assert.deepEqual(storedState(), {
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:05:00Z'
    })
    assert.deepEqual(Object.keys(storedDay('5min/2026/10/06.json').series), [
      'rds.cpu'
    ])

    cloudwatchStub.error = new Error('throttled')
    queueEmptyQueryResults(1)
    await assert.rejects(
      runScheduled('2026-10-06T12:16:00Z'),
      /metrics: throttled/
    )
    assert.deepEqual(storedState(), {
      service: '2026-10-06T12:10:00Z',
      metrics: '2026-10-06T12:05:00Z'
    })
    assert.deepEqual(logQueryRanges(), [
      ['2026-10-06T12:00:00Z', '2026-10-06T12:05:00Z'],
      ['2026-10-06T12:00:00Z', '2026-10-06T12:10:00Z']
    ])
  })

  it('never queries a log time range twice across consecutive runs', async () => {
    const runs = [
      '2026-10-06T23:51:00Z',
      '2026-10-06T23:56:00Z',
      '2026-10-06T23:56:00Z',
      '2026-10-07T00:01:00Z',
      // Two runs are missed here.
      '2026-10-07T00:16:00Z',
      '2026-10-07T00:21:00Z'
    ]
    for (const time of runs) {
      queueEmptyQueryResults(1)
      await runScheduled(time)
    }

    const ranges = logQueryRanges()
    for (let i = 1; i < ranges.length; i++) {
      assert.equal(ranges[i][0], ranges[i - 1][1])
    }
    assert.deepEqual(ranges, [
      ['2026-10-06T23:40:00Z', '2026-10-06T23:45:00Z'],
      ['2026-10-06T23:45:00Z', '2026-10-06T23:50:00Z'],
      ['2026-10-06T23:50:00Z', '2026-10-06T23:55:00Z'],
      ['2026-10-06T23:55:00Z', '2026-10-07T00:10:00Z'],
      ['2026-10-07T00:10:00Z', '2026-10-07T00:15:00Z']
    ])
  })

  it('counts a log line at the boundary second only in the later run', async () => {
    setStoredState({
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    // endTime is inclusive, so the first query also returns the line stamped
    // 12:05:00 in the bin of 12:05.
    cloudwatchLogsStub.queryResults = [
      {
        status: 'Complete',
        results: [
          insightsRow('2026-10-06 12:00:00.000', 'CitizenLogin', 3),
          insightsRow('2026-10-06 12:05:00.000', 'CitizenLogin', 1)
        ]
      }
    ]
    await runScheduled('2026-10-06T12:11:00Z')
    assert.deepEqual(
      storedDay('5min/2026/10/06.json').slots.map((slot) => slot.t),
      ['2026-10-06T12:00:00Z']
    )

    cloudwatchLogsStub.queryResults = [
      {
        status: 'Complete',
        results: [insightsRow('2026-10-06 12:05:00.000', 'CitizenLogin', 2)]
      }
    ]
    await runScheduled('2026-10-06T12:16:00Z')

    assert.deepEqual(logQueryRanges(), [
      ['2026-10-06T12:00:00Z', '2026-10-06T12:05:00Z'],
      ['2026-10-06T12:05:00Z', '2026-10-06T12:10:00Z']
    ])
    const slots = storedDay('5min/2026/10/06.json').slots
    assert.deepEqual(
      slots.map((slot) => [slot.t, slot[STRONG]]),
      [
        ['2026-10-06T12:00:00Z', 3],
        ['2026-10-06T12:05:00Z', 2]
      ]
    )
  })

  it('queries the same range again on the run after a failure', async () => {
    setStoredState({
      service: '2026-10-05T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    cloudwatchLogsStub.queryResults = [{ status: 'Failed' }]

    await assert.rejects(
      runScheduled('2026-10-06T12:06:00Z'),
      /2026-10-05T12:00:00Z\.\.2026-10-06T00:00:00Z: service/
    )
    assert.equal(storedState().service, '2026-10-05T12:00:00Z')
    assert.equal(storedDay('5min/2026/10/05.json'), null)

    queueEmptyQueryResults(1)
    await runScheduled('2026-10-06T12:11:00Z')
    assert.deepEqual(logQueryRanges(), [
      ['2026-10-05T12:00:00Z', '2026-10-06T00:00:00Z'],
      ['2026-10-05T12:00:00Z', '2026-10-06T00:00:00Z']
    ])
    assert.equal(storedState().service, '2026-10-06T00:00:00Z')
  })

  it('does not move a watermark back on a run for an earlier time', async () => {
    setStoredState({
      service: '2026-10-06T12:10:00Z',
      metrics: '2026-10-06T12:10:00Z'
    })

    await runScheduled('2026-10-06T12:06:00Z')

    assert.deepEqual(logQueryRanges(), [])
    assert.deepEqual(metricRanges(), [
      ['2026-10-06T11:30:00Z', '2026-10-06T12:00:00Z']
    ])
    assert.deepEqual(storedState(), {
      service: '2026-10-06T12:10:00Z',
      metrics: '2026-10-06T12:10:00Z'
    })
  })

  for (const [name, body] of [
    ['is not JSON', '{"service": '],
    ['is not an object', '["2026-10-06T12:00:00Z"]'],
    ['has a watermark that is not a time', '{"service": "yesterday"}'],
    ['has a watermark that is not a string', '{"metrics": 1791288000000}'],
    [
      'has a watermark that is not at a bucket start',
      '{"service": "2026-10-06T12:02:00Z"}'
    ]
  ]) {
    it(`fails and queries nothing when the state file ${name}`, async () => {
      s3Stub.objects.set(STATE_KEY, { Body: body })

      await assert.rejects(
        runScheduled('2026-10-06T12:06:00Z'),
        /collector\.json/
      )
      assert.deepEqual(logQueryRanges(), [])
      assert.deepEqual(metricRanges(), [])
      assert.equal(s3Stub.objects.get(STATE_KEY).Body, body)
    })
  }

  it('backfills with one query and one metric call for each chunk', async () => {
    queueEmptyQueryResults(3)
    cloudwatchLogsStub.queryResults.unshift({
      status: 'Complete',
      results: [insightsRow('2026-10-01 08:00:00.000', 'CitizenWeakLogin', 2)]
    })
    const result = await handler(
      {
        backfill: { from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' }
      },
      context()
    )

    const chunks = [
      ['2026-10-01T00:00:00Z', '2026-10-01T12:00:00Z'],
      ['2026-10-01T12:00:00Z', '2026-10-02T00:00:00Z'],
      ['2026-10-02T00:00:00Z', '2026-10-02T12:00:00Z'],
      ['2026-10-02T12:00:00Z', '2026-10-03T00:00:00Z']
    ]
    assert.deepEqual(result, {
      processed: chunks.map(([from, to]) => `${from}..${to}`),
      next: null
    })
    assert.deepEqual(logQueryRanges(), chunks)
    assert.deepEqual(metricRanges(), chunks)
    const day = storedDay('5min/2026/10/01.json')
    assert.equal(day.slots.length, 288)
    assert.equal(day.slots[96][WEAK], 2)
  })

  it('does not read or write the watermarks on a backfill', async () => {
    const state = {
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    }
    setStoredState(state)
    const stateObject = s3Stub.objects.get(STATE_KEY)
    queueEmptyQueryResults(2)

    await handler(
      {
        backfill: { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }
      },
      context()
    )

    assert.equal(s3Stub.objects.get(STATE_KEY), stateObject)
    assert.equal(
      s3Stub.calls.some((c) => c.input.Key === STATE_KEY),
      false
    )
    assert.ok(storedDay('5min/2026/10/01.json'))
  })

  it('stops a backfill and names the next range when time runs out', async () => {
    cloudwatchLogsStub.queryResults = [{ status: 'Complete', results: [] }]
    const remaining = [300_000, 59_999]
    const result = await handler(
      {
        backfill: { from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' }
      },
      context(() => remaining.shift())
    )
    assert.deepEqual(result, {
      processed: ['2026-10-01T00:00:00Z..2026-10-01T12:00:00Z'],
      next: { from: '2026-10-01T12:00:00Z', to: '2026-10-03T00:00:00Z' }
    })
    assert.equal(storedDay('5min/2026/10/02.json'), null)
  })
})

describe('handler with the apigw and proxy log groups', () => {
  beforeEach(() => {
    cloudwatchLogsStub.reset()
    cloudwatchStub.reset()
    s3Stub.reset()
    process.env.APIGW_LOG_GROUP_NAME = 'evaka-apigw-staging'
    process.env.PROXY_LOG_GROUP_NAME = 'evaka-proxy-staging'
  })

  afterEach(() => {
    delete process.env.APIGW_LOG_GROUP_NAME
    delete process.env.PROXY_LOG_GROUP_NAME
  })

  function startedQueries() {
    return cloudwatchLogsStub.calls
      .filter((c) => c.input.queryString)
      .map((c) => [
        c.input.logGroupNames,
        isoSeconds(c.input.startTime),
        isoSeconds(c.input.endTime)
      ])
  }

  it('makes exactly one query for each log group on a run', async () => {
    setStoredState({
      service: '2026-10-06T12:00:00Z',
      apigw: '2026-10-06T12:00:00Z',
      proxy: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    queueEmptyQueryResults(3)

    await runScheduled('2026-10-06T12:11:00Z')

    assert.deepEqual(startedQueries(), [
      [['evaka-srv-staging'], '2026-10-06T12:00:00Z', '2026-10-06T12:05:00Z'],
      [['evaka-apigw-staging'], '2026-10-06T12:00:00Z', '2026-10-06T12:05:00Z'],
      [['evaka-proxy-staging'], '2026-10-06T12:00:00Z', '2026-10-06T12:05:00Z']
    ])
    assert.equal(cloudwatchStub.calls.length, 1)
    assert.deepEqual(storedState(), {
      service: '2026-10-06T12:05:00Z',
      apigw: '2026-10-06T12:05:00Z',
      proxy: '2026-10-06T12:05:00Z',
      metrics: '2026-10-06T12:05:00Z'
    })
    const slot = storedDay('5min/2026/10/06.json').slots[0]
    assert.equal(slot['apigw.requests{app=citizen,class=2xx}'], 0)
    assert.equal(slot['proxy.status502'], 0)
    assert.equal(slot['service.errors'], 0)
  })

  it('makes one query for each log group when it catches up', async () => {
    setStoredState({
      service: '2026-10-05T12:00:00Z',
      apigw: '2026-10-05T12:00:00Z',
      proxy: '2026-10-05T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    queueEmptyQueryResults(3)

    await runScheduled('2026-10-06T12:06:00Z')

    assert.deepEqual(startedQueries(), [
      [['evaka-srv-staging'], '2026-10-05T12:00:00Z', '2026-10-06T00:00:00Z'],
      [['evaka-apigw-staging'], '2026-10-05T12:00:00Z', '2026-10-06T00:00:00Z'],
      [['evaka-proxy-staging'], '2026-10-05T12:00:00Z', '2026-10-06T12:00:00Z']
    ])
  })

  it('starts a log group without a watermark at the latest closed bucket', async () => {
    setStoredState({
      service: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    queueEmptyQueryResults(3)

    await runScheduled('2026-10-06T12:16:00Z')

    assert.deepEqual(startedQueries(), [
      [['evaka-srv-staging'], '2026-10-06T12:00:00Z', '2026-10-06T12:10:00Z'],
      [['evaka-apigw-staging'], '2026-10-06T12:05:00Z', '2026-10-06T12:10:00Z'],
      [['evaka-proxy-staging'], '2026-10-06T12:05:00Z', '2026-10-06T12:10:00Z']
    ])
  })

  it('keeps the watermark of a failed log group and advances the others', async () => {
    setStoredState({
      service: '2026-10-06T12:00:00Z',
      apigw: '2026-10-06T12:00:00Z',
      proxy: '2026-10-06T12:00:00Z',
      metrics: '2026-10-06T12:00:00Z'
    })
    cloudwatchLogsStub.queryResults = [
      { status: 'Complete', results: [] },
      { status: 'Failed' },
      { status: 'Complete', results: [] }
    ]

    await assert.rejects(runScheduled('2026-10-06T12:11:00Z'), /apigw: /)

    assert.deepEqual(storedState(), {
      service: '2026-10-06T12:05:00Z',
      apigw: '2026-10-06T12:00:00Z',
      proxy: '2026-10-06T12:05:00Z',
      metrics: '2026-10-06T12:05:00Z'
    })
    const day = storedDay('5min/2026/10/06.json')
    assert.ok('proxy.status504' in day.series)
    assert.ok('service.errors' in day.series)
    assert.equal(
      Object.keys(day.series).some((name) => name.startsWith('apigw.')),
      false
    )
    assert.equal(
      Object.keys(day.slots[0]).some((name) => name.startsWith('apigw.')),
      false
    )
  })
})
