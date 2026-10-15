import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { cloudwatchStub } from './stub-cloudwatch.mjs'
import {
  getMetricSummaries,
  summariesFromMetricData,
  summaryQueries
} from './metrics.mjs'

const t0 = new Date('2026-10-06T00:00:00Z')
const t1 = new Date('2026-10-06T00:05:00Z')

describe('summaryQueries', () => {
  it('asks for min, average, max and sample count with a 5-minute period', () => {
    const queries = summaryQueries({
      Namespace: 'AWS/RDS',
      MetricName: 'CPUUtilization'
    })
    assert.deepEqual(
      queries.map((q) => [q.Id, q.MetricStat.Stat, q.MetricStat.Period]),
      [
        ['min', 'Minimum', 300],
        ['mean', 'Average', 300],
        ['max', 'Maximum', 300],
        ['n', 'SampleCount', 300]
      ]
    )
  })
})

describe('summariesFromMetricData', () => {
  it('joins the four statistics by timestamp', () => {
    const summaries = summariesFromMetricData([
      { Id: 'min', Timestamps: [t0, t1], Values: [8, 9] },
      { Id: 'mean', Timestamps: [t0, t1], Values: [12.5, 13] },
      { Id: 'max', Timestamps: [t0, t1], Values: [31, 20] },
      { Id: 'n', Timestamps: [t0, t1], Values: [5, 5] }
    ])
    assert.deepEqual(
      [...summaries],
      [
        [t0.getTime(), { min: 8, mean: 12.5, max: 31, n: 5 }],
        [t1.getTime(), { min: 9, mean: 13, max: 20, n: 5 }]
      ]
    )
  })

  it('leaves out a bucket that does not have all four statistics', () => {
    const summaries = summariesFromMetricData([
      { Id: 'min', Timestamps: [t0], Values: [8] },
      { Id: 'mean', Timestamps: [t0], Values: [12.5] }
    ])
    assert.equal(summaries.size, 0)
  })
})

describe('getMetricSummaries', () => {
  beforeEach(() => cloudwatchStub.reset())

  it('follows NextToken and joins the pages', async () => {
    cloudwatchStub.responses = [
      {
        MetricDataResults: [
          { Id: 'min', Timestamps: [t0], Values: [1] },
          { Id: 'mean', Timestamps: [t0], Values: [2] }
        ],
        NextToken: 'page-2'
      },
      {
        MetricDataResults: [
          { Id: 'max', Timestamps: [t0], Values: [3] },
          { Id: 'n', Timestamps: [t0], Values: [5] }
        ]
      }
    ]
    const summaries = await getMetricSummaries({}, t0.getTime(), t1.getTime())
    assert.deepEqual(summaries.get(t0.getTime()), {
      min: 1,
      mean: 2,
      max: 3,
      n: 5
    })
    assert.equal(cloudwatchStub.calls.length, 2)
    assert.equal(cloudwatchStub.calls[1].input.NextToken, 'page-2')
  })
})
