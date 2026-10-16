import {
  CloudWatchClient,
  GetMetricDataCommand
} from '@aws-sdk/client-cloudwatch'

import { BUCKET_MS } from './store.mjs'

const cloudwatchClient = new CloudWatchClient({})

// Query ids double as the keys of a gaugeSummary value.
const SUMMARY_STATS = {
  min: 'Minimum',
  mean: 'Average',
  max: 'Maximum',
  n: 'SampleCount'
}

export function summaryQueries(metric) {
  return Object.entries(SUMMARY_STATS).map(([id, stat]) => ({
    Id: id,
    MetricStat: { Metric: metric, Period: BUCKET_MS / 1000, Stat: stat },
    ReturnData: true
  }))
}

// A bucket gets a value only when all four statistics have a datapoint, so a
// bucket with no samples is a gap, not a zero.
export function summariesFromMetricData(metricDataResults) {
  const partial = new Map()
  for (const { Id, Timestamps = [], Values = [] } of metricDataResults) {
    if (!(Id in SUMMARY_STATS)) continue
    Timestamps.forEach((timestamp, i) => {
      const t = new Date(timestamp).getTime()
      partial.set(t, { ...partial.get(t), [Id]: Values[i] })
    })
  }
  const summaries = new Map()
  for (const [t, summary] of partial) {
    if (Object.keys(SUMMARY_STATS).every((key) => key in summary)) {
      summaries.set(t, {
        min: summary.min,
        mean: summary.mean,
        max: summary.max,
        n: summary.n
      })
    }
  }
  return summaries
}

export async function getMetricSummaries(metric, fromMs, toMs) {
  const results = []
  let nextToken
  do {
    const response = await cloudwatchClient.send(
      new GetMetricDataCommand({
        MetricDataQueries: summaryQueries(metric),
        StartTime: new Date(fromMs),
        EndTime: new Date(toMs),
        ScanBy: 'TimestampAscending',
        NextToken: nextToken
      })
    )
    results.push(...(response.MetricDataResults ?? []))
    nextToken = response.NextToken
  } while (nextToken)
  return summariesFromMetricData(results)
}
