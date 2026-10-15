// Every series the collector writes. The type selects the aggregation rule
// that the tracker page applies when it combines buckets.

const SERIES = {
  'citizen.login{auth=strong}': { type: 'counter' },
  'citizen.login{auth=weak}': { type: 'counter' },
  'rds.cpu': { type: 'gaugeSummary' }
}

export function seriesMeta(names) {
  return Object.fromEntries(names.map((name) => [name, SERIES[name]]))
}

export function counterNames(names) {
  return names.filter((name) => SERIES[name].type === 'counter')
}
