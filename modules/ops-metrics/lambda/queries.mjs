// One Logs Insights query for each log group. Each query keeps only the lines
// of its series and counts them with one `stats ... by bin(5m) as t` over a few
// derived keys; the functions below map the result rows to series.

import {
  APIGW_REQUEST_SERIES,
  JOB_TYPE_SERIES,
  RESPONSE_TIME_BOUNDS,
  STATUS_CLASSES,
  seriesMeta,
  withLabels
} from './series.mjs'
import { bucketStarts, zeroFill } from './store.mjs'
import { parseBinTime } from './insights.mjs'

const HOUR_MS = 60 * 60 * 1000

const LAST_RESPONSE_TIME_INDEX = RESPONSE_TIME_BOUNDS.length

// The index of the histogram count of a response time. Logs Insights has only
// the natural log, and 3 * log(1000) / log(10) is 8.999999999999998 in double
// precision, so the epsilon puts a value that is exactly at a bound into the
// count above it.
function responseTimeIndexExpression(field) {
  return `least(${LAST_RESPONSE_TIME_INDEX}, floor(3 * log(greatest(${field}, 1)) / log(10) + 0.000001))`
}

// Each indicator is 1 for its status class and 0 for the others.
function statusClassIndicators(statusField) {
  return [
    `fields floor(${statusField} / 100) as statusClass`,
    `fields ${STATUS_CLASSES.map((c) => `1 - least(1, abs(statusClass - ${c[0]})) as is${c}`).join(', ')}`
  ]
}

function statusIndicator(statusField, status) {
  return `1 - least(1, abs(${statusField} - ${status})) as is${status}`
}

const STATUS_CLASS_SUMS = STATUS_CLASSES.map((c) => `sum(is${c}) as n${c}`)

function query(commands) {
  return commands.join('\n| ')
}

function list(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`
}

function count(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function add(slot, series, n) {
  if (series) slot[series] = (slot[series] ?? 0) + n
}

function addToHistogram(slot, series, index, n) {
  if (!Number.isInteger(index) || index < 0) return
  if (index > LAST_RESPONSE_TIME_INDEX) return
  slot[series] ??= new Array(LAST_RESPONSE_TIME_INDEX + 1).fill(0)
  slot[series][index] += n
}

function addStatusClasses(slot, seriesName, labels, row) {
  for (const statusClass of STATUS_CLASSES) {
    add(
      slot,
      withLabels(seriesName, { ...labels, class: statusClass }),
      count(row[`n${statusClass}`])
    )
  }
}

// Calls addRow(slot, row) for each row in [fromMs, toMs) and zero-fills the
// series of the source in each bucket of the range.
function valuesFromRows(rows, fromMs, toMs, series, addRow) {
  const values = new Map()
  for (const row of rows) {
    const t = parseBinTime(row.t)
    if (t < fromMs || t >= toMs) continue
    if (!values.has(t)) values.set(t, {})
    addRow(values.get(t), row)
  }
  return zeroFill(values, bucketStarts(fromMs, toMs), seriesMeta(series))
}

// service

export const SERVICE_SERIES_BY_EVENT_CODE = {
  CitizenLogin: 'citizen.login{auth=strong}',
  CitizenWeakLogin: 'citizen.login{auth=weak}',
  CitizenPasskeyLogin: 'citizen.login{auth=weak}',
  EmployeeLogin: 'employee.login{method=ad}',
  EmployeeSfiLogin: 'employee.login{method=sfi}',
  PinLogin: 'employee.login{method=pin}',
  CitizenWeakLoginAttempt: 'citizen.loginAttempt{auth=weak}',
  CitizenPasskeyLoginAttempt: 'citizen.loginAttempt{auth=weak}',
  MessagingNewMessageWrite: 'message.sent{by=employee}',
  MessagingCitizenSendMessage: 'message.sent{by=citizen}',
  MessagingReplyToThreadWrite: 'message.sent{by=reply}',
  CitizenPasskeyRegister: 'passkey.registered',
  CitizenPushSubscriptionCreate: 'push.subscribed{app=citizen}',
  PushSubscriptionUpsert: 'push.subscribed{app=employee}'
}

export const SERVICE_SERIES_BY_VTJ_STATUS = {
  'response received': 'vtj.requests{result=ok}',
  'error during request': 'vtj.requests{result=error}',
  'response parsing failure': 'vtj.requests{result=error}'
}

// The keys are the texts that the `parse message` regex of SERVICE_QUERY
// captures.
export const SERVICE_SERIES_BY_MESSAGE = {
  'Failed to run async job': 'service.asyncJob.failed',
  'permanently failed (remainingAttempts=0)':
    'service.asyncJob.permanentlyFailed',
  "Couldn't send email": 'integration.failed{system=email}',
  'Web push failed': 'integration.failed{system=webpush}',
  // Every failed Varda child or unit update ends in one of these two lines.
  // The Varda client logs "request failed" before either of them, so that
  // line must not count.
  'Varda update failed': 'integration.failed{system=varda}',
  'Failed to update unit': 'integration.failed{system=varda}',
  'DVV modification service failed': 'integration.failed{system=dvv}',
  'DVV modifications service failed': 'integration.failed{system=dvv}',
  'Sanity check failed': 'sanityCheck.failed'
}

export const SERVICE_SERIES = [
  ...new Set([
    'service.errors',
    ...STATUS_CLASSES.map((c) => withLabels('service.requests', { class: c })),
    'service.responseTime',
    ...Object.values(SERVICE_SERIES_BY_EVENT_CODE),
    ...Object.values(SERVICE_SERIES_BY_VTJ_STATUS),
    ...Object.values(SERVICE_SERIES_BY_MESSAGE)
  ])
]

// A bucket has at most 14 rows of requests, 14 of audit events, 3 of VTJ
// requests and 8 of errors without a job type, and 2 for each job type that
// fails in it. The 145 buckets of 12 hours (the end is inclusive) stay under
// the 10,000 row limit unless more than 14 job types fail in a bucket on
// average.
export const SERVICE_MAX_RANGE_MS = 12 * HOUR_MS

export const SERVICE_QUERY = query([
  `filter type = "app-requests-received"
  or (type = "app-audit-events" and eventCode in ${list(Object.keys(SERVICE_SERIES_BY_EVENT_CODE))} and (eventCode != "PinLogin" or meta.status = "SUCCESS"))
  or (type = "vtj-audit-events" and status in ${list(Object.keys(SERVICE_SERIES_BY_VTJ_STATUS))})
  or (type = "app-misc" and (logLevel = "ERROR" or message like /^Failed to run async job /))`,
  "parse message /(?<msgKind>^Failed to run async job|permanently failed \\(remainingAttempts=0\\)$|^Couldn't send email|^Web push failed|^Varda update failed|^Failed to update unit|DVV modifications? service failed$|^Sanity check failed)/",
  ...statusClassIndicators('statusCode'),
  `fields ${responseTimeIndexExpression('responseTime')} as rtIndex`,
  'fields coalesce(eventCode, status, "-") as k, coalesce(logLevel, "-") as level, coalesce(msgKind, "-") as kind, coalesce(meta.jobType, "-") as jobType, coalesce(rtIndex, -1) as rt',
  `stats count() as n, ${STATUS_CLASS_SUMS.join(', ')} by bin(5m) as t, type, k, level, kind, jobType, rt`
])

function addServiceRow(slot, row) {
  const n = count(row.n)
  switch (row.type) {
    case 'app-requests-received':
      addStatusClasses(slot, 'service.requests', {}, row)
      addToHistogram(slot, 'service.responseTime', Number(row.rt), n)
      break
    case 'app-audit-events':
      add(slot, SERVICE_SERIES_BY_EVENT_CODE[row.k], n)
      break
    case 'vtj-audit-events':
      add(slot, SERVICE_SERIES_BY_VTJ_STATUS[row.k], n)
      break
    case 'app-misc': {
      if (row.level === 'ERROR') add(slot, 'service.errors', n)
      const series = SERVICE_SERIES_BY_MESSAGE[row.kind]
      add(slot, series, n)
      if (JOB_TYPE_SERIES.includes(series) && row.jobType !== '-') {
        add(slot, withLabels(series, { type: row.jobType }), n)
      }
      break
    }
  }
}

export function serviceValuesFromRows(rows, fromMs, toMs) {
  return valuesFromRows(rows, fromMs, toMs, SERVICE_SERIES, addServiceRow)
}

// apigw

// The paths of the API gateway start with /api/, and the citizen, employee and
// mobile apps each have their own prefix after it. Other paths, such as the
// Suomi.fi SAML callback /api/application/auth/saml/, are "other".
const APIGW_APP_BY_PATH_PREFIX = {
  citizen: 'citizen',
  'employee-mobile': 'mobile',
  employee: 'employee'
}

export const APIGW_SERIES_BY_EVENT_CODE = {
  'evaka.saml.suomifi.sign_in_failed': 'login.failed{method=sfi}',
  'evaka.saml.ead.sign_in_failed': 'login.failed{method=ad}',
  'evaka.citizen_weak.sign_in_failed': 'login.failed{method=weak}',
  'evaka.citizen_passkey.sign_in_failed': 'login.failed{method=passkey}'
}

const APIGW_RATE_LIMIT_MESSAGE = 'Login request hit rate limit'

export const APIGW_SERIES = [
  ...Object.keys(APIGW_REQUEST_SERIES),
  ...Object.values(APIGW_SERIES_BY_EVENT_CODE),
  'login.rateLimited'
]

// A bucket has at most 4 apps times 14 response time indexes of requests, 4
// rows of failed logins and 1 of rate limits. The 145 buckets of 12 hours (the
// end is inclusive) give at most 8,845 rows.
export const APIGW_MAX_RANGE_MS = 12 * HOUR_MS

// The pino-cli of the API gateway rewrites the access lines "request
// completed" and "request errored" to the flat fields path and statusCode, a
// string that is empty when the response has no status. It writes a "request
// aborted" line unchanged, with the nested req.path and res.statusCode and no
// path. The filter keeps only the lines with a path: a client abort has no
// real status, and its responseTime is the time until the abort. A line with an
// empty statusCode gets the status 0, which is in no status class.
export const APIGW_QUERY = query([
  `filter (type = "app-requests-received" and ispresent(path))
  or (type = "app-audit-events" and eventCode in ${list(Object.keys(APIGW_SERIES_BY_EVENT_CODE))})
  or (type = "app-misc" and message = ${JSON.stringify(APIGW_RATE_LIMIT_MESSAGE)})`,
  'fields coalesce(toNumber(statusCode), 0) as statusNumber',
  `parse path /^\\/api\\/(?<pathApp>${Object.keys(APIGW_APP_BY_PATH_PREFIX).join('|')})\\//`,
  ...statusClassIndicators('statusNumber'),
  `fields ${statusIndicator('statusNumber', 401)}, ${statusIndicator('statusNumber', 429)}`,
  `fields ${responseTimeIndexExpression('responseTime')} as rtIndex`,
  'fields coalesce(eventCode, pathApp, "other") as k, coalesce(rtIndex, -1) as rt',
  `stats count() as n, ${STATUS_CLASS_SUMS.join(', ')}, sum(is401) as n401, sum(is429) as n429 by bin(5m) as t, type, k, rt`
])

function addApigwRow(slot, row) {
  const n = count(row.n)
  switch (row.type) {
    case 'app-requests-received': {
      const app = APIGW_APP_BY_PATH_PREFIX[row.k] ?? 'other'
      addStatusClasses(slot, 'apigw.requests', { app }, row)
      add(slot, withLabels('apigw.status401', { app }), count(row.n401))
      add(slot, withLabels('apigw.status429', { app }), count(row.n429))
      addToHistogram(
        slot,
        withLabels('apigw.responseTime', { app }),
        Number(row.rt),
        n
      )
      break
    }
    case 'app-audit-events':
      add(slot, APIGW_SERIES_BY_EVENT_CODE[row.k], n)
      break
    case 'app-misc':
      add(slot, 'login.rateLimited', n)
      break
  }
}

export function apigwValuesFromRows(rows, fromMs, toMs) {
  return valuesFromRows(rows, fromMs, toMs, APIGW_SERIES, addApigwRow)
}

// proxy

export const PROXY_SERIES = [
  ...STATUS_CLASSES.map((c) => `proxy.requests{class=${c}}`),
  'proxy.status502',
  'proxy.status504'
]

// One row for each bucket.
export const PROXY_MAX_RANGE_MS = 24 * HOUR_MS

// The nginx log format of the proxy writes statusCode as a JSON string.
export const PROXY_QUERY = query([
  'filter type = "app-requests-received"',
  'fields toNumber(statusCode) as statusNumber',
  ...statusClassIndicators('statusNumber'),
  `fields ${statusIndicator('statusNumber', 502)}, ${statusIndicator('statusNumber', 504)}`,
  `stats count() as n, ${STATUS_CLASS_SUMS.join(', ')}, sum(is502) as n502, sum(is504) as n504 by bin(5m) as t`
])

function addProxyRow(slot, row) {
  addStatusClasses(slot, 'proxy.requests', {}, row)
  add(slot, 'proxy.status502', count(row.n502))
  add(slot, 'proxy.status504', count(row.n504))
}

export function proxyValuesFromRows(rows, fromMs, toMs) {
  return valuesFromRows(rows, fromMs, toMs, PROXY_SERIES, addProxyRow)
}
