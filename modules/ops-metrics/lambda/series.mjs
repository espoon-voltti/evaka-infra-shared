// Every series the collector writes. The type selects the aggregation rule
// that the tracker page applies when it combines buckets.

// Three bounds for each decade, 10^((i + 1) / 3) ms rounded to 2 decimals.
export const RESPONSE_TIME_BOUNDS = [
  2.15, 4.64, 10, 21.54, 46.42, 100, 215.44, 464.16, 1000, 2154.43, 4641.59,
  10000
]

export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx']

const APIGW_APPS = ['citizen', 'mobile', 'employee', 'other']

const COUNTER = { type: 'counter' }
const RESPONSE_TIME = { type: 'histogram', bounds: RESPONSE_TIME_BOUNDS }

export function withLabels(name, labels) {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}=${value}`)
  return `${name}{${pairs.join(',')}}`
}

export const APIGW_REQUEST_SERIES = Object.fromEntries(
  APIGW_APPS.flatMap((app) => [
    ...STATUS_CLASSES.map((statusClass) => [
      withLabels('apigw.requests', { app, class: statusClass }),
      COUNTER
    ]),
    [withLabels('apigw.status401', { app }), COUNTER],
    [withLabels('apigw.status429', { app }), COUNTER],
    [withLabels('apigw.responseTime', { app }), RESPONSE_TIME]
  ])
)

const SERIES = {
  'citizen.login{auth=strong}': COUNTER,
  'citizen.login{auth=weak}': COUNTER,
  'rds.cpu': { type: 'gaugeSummary' },

  'service.errors': COUNTER,
  'service.asyncJob.failed': COUNTER,
  'service.asyncJob.permanentlyFailed': COUNTER,
  'service.requests{class=2xx}': COUNTER,
  'service.requests{class=3xx}': COUNTER,
  'service.requests{class=4xx}': COUNTER,
  'service.requests{class=5xx}': COUNTER,
  'service.responseTime': RESPONSE_TIME,
  'employee.login{method=ad}': COUNTER,
  'employee.login{method=sfi}': COUNTER,
  'employee.login{method=pin}': COUNTER,
  'citizen.loginAttempt{auth=weak}': COUNTER,
  'message.sent{by=employee}': COUNTER,
  'message.sent{by=citizen}': COUNTER,
  'message.sent{by=reply}': COUNTER,
  'passkey.registered': COUNTER,
  'push.subscribed{app=citizen}': COUNTER,
  'push.subscribed{app=employee}': COUNTER,
  'integration.failed{system=email}': COUNTER,
  'integration.failed{system=webpush}': COUNTER,
  'integration.failed{system=varda}': COUNTER,
  'integration.failed{system=dvv}': COUNTER,
  'vtj.requests{result=ok}': COUNTER,
  'vtj.requests{result=error}': COUNTER,
  'sanityCheck.failed': COUNTER,

  ...APIGW_REQUEST_SERIES,
  'login.failed{method=sfi}': COUNTER,
  'login.failed{method=ad}': COUNTER,
  'login.failed{method=weak}': COUNTER,
  'login.failed{method=passkey}': COUNTER,
  'login.rateLimited': COUNTER,

  'proxy.requests{class=2xx}': COUNTER,
  'proxy.requests{class=3xx}': COUNTER,
  'proxy.requests{class=4xx}': COUNTER,
  'proxy.requests{class=5xx}': COUNTER,
  'proxy.status502': COUNTER,
  'proxy.status504': COUNTER
}

// The collector also writes these series for each job type, with the label
// type=<job type>. The job types are not known in advance.
export const JOB_TYPE_SERIES = [
  'service.asyncJob.failed',
  'service.asyncJob.permanentlyFailed'
]

function metaOf(name) {
  const [base] = name.split('{')
  const meta =
    SERIES[name] ?? (JOB_TYPE_SERIES.includes(base) ? SERIES[base] : undefined)
  if (!meta) throw new Error(`Unknown series ${name}`)
  return meta
}

export function seriesMeta(names) {
  return Object.fromEntries(names.map((name) => [name, metaOf(name)]))
}
