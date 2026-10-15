import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { RESPONSE_TIME_BOUNDS, seriesMeta } from './series.mjs'
import {
  APIGW_QUERY,
  APIGW_SERIES,
  APIGW_SERIES_BY_EVENT_CODE,
  PROXY_SERIES,
  SERVICE_QUERY,
  SERVICE_SERIES,
  SERVICE_SERIES_BY_EVENT_CODE,
  SERVICE_SERIES_BY_MESSAGE,
  SERVICE_SERIES_BY_VTJ_STATUS,
  apigwValuesFromRows,
  proxyValuesFromRows,
  serviceValuesFromRows
} from './queries.mjs'

const ms = (iso) => Date.parse(iso)

const T0 = '2026-10-06 12:00:00.000'
const FROM = ms('2026-10-06T12:00:00Z')
const TO = ms('2026-10-06T12:10:00Z')

function listAfter(query, prefix) {
  const match = new RegExp(`${prefix} (\\[[^\\]]*\\])`).exec(query)
  return JSON.parse(match[1])
}

function parseRegex(query, field) {
  const [, source] = new RegExp(`\\| parse ${field} \\/(.*)\\/$`, 'm').exec(
    query
  )
  return new RegExp(source)
}

// A result row of the service query. The keys that a line type does not use
// are "-".
function serviceRow(fields) {
  return {
    t: T0,
    k: '-',
    level: '-',
    kind: '-',
    jobType: '-',
    rt: '0',
    ...fields
  }
}

describe('RESPONSE_TIME_BOUNDS', () => {
  it('has three bounds for each decade rounded to 2 decimals', () => {
    assert.deepEqual(
      RESPONSE_TIME_BOUNDS,
      Array.from(
        { length: 12 },
        (_, i) => Math.round(10 ** ((i + 1) / 3) * 100) / 100
      )
    )
  })
})

describe('SERVICE_QUERY', () => {
  it('filters by every event code and VTJ status that maps to a series', () => {
    assert.deepEqual(
      listAfter(SERVICE_QUERY, 'eventCode in'),
      Object.keys(SERVICE_SERIES_BY_EVENT_CODE)
    )
    assert.deepEqual(
      listAfter(SERVICE_QUERY, 'status in'),
      Object.keys(SERVICE_SERIES_BY_VTJ_STATUS)
    )
  })

  it('captures the message kind of each eVaka message that maps to a series', () => {
    const regex = parseRegex(SERVICE_QUERY, 'message')
    const messages = {
      'Failed to run async job ClaimedJobRef(jobId=4f0c, jobType=SendMessage, remainingAttempts=2)':
        'Failed to run async job',
      'Async job ClaimedJobRef(jobId=4f0c, jobType=SendMessage, remainingAttempts=0) permanently failed (remainingAttempts=0)':
        'permanently failed (remainingAttempts=0)',
      "Couldn't send email (traceId: 0a1b): Throttling": "Couldn't send email",
      'Web push failed, status 500': 'Web push failed',
      'Varda update failed for child 0190a1b2': 'Varda update failed',
      'Failed to update unit Kilpikonna: java.lang.IllegalStateException: request failed POST https://varda.example/api/v1/toimipaikat/: status=400 body=x':
        'Failed to update unit',
      'Fetching the first modification of 2026-10-06 from DVV modification service failed':
        'DVV modification service failed',
      'Fetching modifications with token 123 from DVV modifications service failed':
        'DVV modifications service failed',
      'Sanity check failed - child documents with incorrect publishing status: [1] instances':
        'Sanity check failed'
    }
    for (const [message, kind] of Object.entries(messages)) {
      assert.equal(regex.exec(message)?.groups.msgKind, kind, message)
      assert.ok(kind in SERVICE_SERIES_BY_MESSAGE, kind)
    }
    assert.deepEqual(
      new Set(Object.values(messages)),
      new Set(Object.keys(SERVICE_SERIES_BY_MESSAGE))
    )
  })

  it('counts each failed Varda update once with the line of its client request', () => {
    const regex = parseRegex(SERVICE_QUERY, 'message')
    const clientLine =
      'request failed POST https://varda.example/api/v1/toimipaikat/: status=400 body=x'
    for (const updateLine of [
      'Varda update failed for child 0190a1b2',
      `Failed to update unit Kilpikonna: java.lang.IllegalStateException: ${clientLine}`
    ]) {
      const series = [clientLine, updateLine]
        .map((message) => regex.exec(message)?.groups.msgKind)
        .filter(Boolean)
        .map((kind) => SERVICE_SERIES_BY_MESSAGE[kind])
      assert.deepEqual(series, ['integration.failed{system=varda}'], updateLine)
    }
  })

  it('does not capture other messages that mention a failure', () => {
    const regex = parseRegex(SERVICE_QUERY, 'message')
    for (const message of [
      'Nekku API request failed with code 500: error',
      'Message request failed with HTTP 500 Internal Server Error: body',
      'Will not send email (traceId: 0a1b): paused',
      'Could not process dvv modification for 010101: error',
      'Failed to cancel remaining retries of async job ClaimedJobRef(jobId=1)'
    ]) {
      assert.equal(regex.exec(message), null, message)
    }
  })
})

describe('SERVICE_SERIES', () => {
  it('is the series of the contract', () => {
    assert.deepEqual(
      new Set(SERVICE_SERIES),
      new Set([
        'citizen.login{auth=strong}',
        'citizen.login{auth=weak}',
        'citizen.loginAttempt{auth=weak}',
        'employee.login{method=ad}',
        'employee.login{method=pin}',
        'employee.login{method=sfi}',
        'integration.failed{system=dvv}',
        'integration.failed{system=email}',
        'integration.failed{system=varda}',
        'integration.failed{system=webpush}',
        'message.sent{by=citizen}',
        'message.sent{by=employee}',
        'message.sent{by=reply}',
        'passkey.registered',
        'push.subscribed{app=citizen}',
        'push.subscribed{app=employee}',
        'sanityCheck.failed',
        'service.asyncJob.failed',
        'service.asyncJob.permanentlyFailed',
        'service.errors',
        'service.requests{class=2xx}',
        'service.requests{class=3xx}',
        'service.requests{class=4xx}',
        'service.requests{class=5xx}',
        'service.responseTime',
        'vtj.requests{result=error}',
        'vtj.requests{result=ok}'
      ])
    )
  })
})

describe('serviceValuesFromRows', () => {
  const rows = [
    serviceRow({
      type: 'app-requests-received',
      rt: '2',
      n: '30',
      n2xx: '25',
      n3xx: '1',
      n4xx: '3',
      n5xx: '1'
    }),
    serviceRow({
      type: 'app-requests-received',
      rt: '9',
      n: '2',
      n2xx: '1',
      n3xx: '0',
      n4xx: '0',
      n5xx: '1'
    }),
    serviceRow({ type: 'app-audit-events', k: 'CitizenLogin', n: '7' }),
    serviceRow({ type: 'app-audit-events', k: 'CitizenWeakLogin', n: '2' }),
    serviceRow({ type: 'app-audit-events', k: 'CitizenPasskeyLogin', n: '1' }),
    serviceRow({ type: 'app-audit-events', k: 'EmployeeLogin', n: '4' }),
    serviceRow({ type: 'app-audit-events', k: 'EmployeeSfiLogin', n: '1' }),
    serviceRow({ type: 'app-audit-events', k: 'PinLogin', n: '3' }),
    serviceRow({
      type: 'app-audit-events',
      k: 'CitizenWeakLoginAttempt',
      n: '5'
    }),
    serviceRow({
      type: 'app-audit-events',
      k: 'CitizenPasskeyLoginAttempt',
      n: '2'
    }),
    serviceRow({
      type: 'app-audit-events',
      k: 'MessagingNewMessageWrite',
      n: '6'
    }),
    serviceRow({
      type: 'app-audit-events',
      k: 'MessagingCitizenSendMessage',
      n: '2'
    }),
    serviceRow({
      type: 'app-audit-events',
      k: 'MessagingReplyToThreadWrite',
      n: '9'
    }),
    serviceRow({
      type: 'app-audit-events',
      k: 'CitizenPasskeyRegister',
      n: '1'
    }),
    serviceRow({
      type: 'app-audit-events',
      k: 'CitizenPushSubscriptionCreate',
      n: '2'
    }),
    serviceRow({
      type: 'app-audit-events',
      k: 'PushSubscriptionUpsert',
      n: '3'
    }),
    serviceRow({ type: 'vtj-audit-events', k: 'response received', n: '11' }),
    serviceRow({ type: 'vtj-audit-events', k: 'error during request', n: '1' }),
    serviceRow({
      type: 'vtj-audit-events',
      k: 'response parsing failure',
      n: '2'
    }),
    serviceRow({ type: 'app-misc', level: 'ERROR', n: '4' }),
    serviceRow({
      type: 'app-misc',
      level: 'WARN',
      kind: 'Failed to run async job',
      jobType: 'SendMessage',
      n: '3'
    }),
    serviceRow({
      type: 'app-misc',
      level: 'WARN',
      kind: 'Failed to run async job',
      jobType: 'UpdateVardaChild',
      n: '1'
    }),
    serviceRow({
      type: 'app-misc',
      level: 'ERROR',
      kind: 'permanently failed (remainingAttempts=0)',
      jobType: 'SendMessage',
      n: '1'
    }),
    serviceRow({
      type: 'app-misc',
      level: 'ERROR',
      kind: "Couldn't send email",
      n: '2'
    }),
    serviceRow({
      type: 'app-misc',
      level: 'ERROR',
      kind: 'Web push failed',
      n: '1'
    }),
    serviceRow({
      type: 'app-misc',
      level: 'ERROR',
      kind: 'Varda update failed',
      n: '1'
    }),
    serviceRow({
      type: 'app-misc',
      level: 'ERROR',
      kind: 'Failed to update unit',
      n: '1'
    }),
    serviceRow({
      type: 'app-misc',
      level: 'ERROR',
      kind: 'DVV modifications service failed',
      n: '1'
    }),
    serviceRow({
      type: 'app-misc',
      level: 'ERROR',
      kind: 'Sanity check failed',
      n: '2'
    })
  ]

  it('maps each kind of row to its series', () => {
    const values = serviceValuesFromRows(rows, FROM, TO)
    const responseTime = new Array(13).fill(0)
    responseTime[2] = 30
    responseTime[9] = 2
    assert.deepEqual(values.get(FROM), {
      'service.requests{class=2xx}': 26,
      'service.requests{class=3xx}': 1,
      'service.requests{class=4xx}': 3,
      'service.requests{class=5xx}': 2,
      'service.responseTime': responseTime,
      'citizen.login{auth=strong}': 7,
      'citizen.login{auth=weak}': 3,
      'employee.login{method=ad}': 4,
      'employee.login{method=sfi}': 1,
      'employee.login{method=pin}': 3,
      'citizen.loginAttempt{auth=weak}': 7,
      'message.sent{by=employee}': 6,
      'message.sent{by=citizen}': 2,
      'message.sent{by=reply}': 9,
      'passkey.registered': 1,
      'push.subscribed{app=citizen}': 2,
      'push.subscribed{app=employee}': 3,
      'vtj.requests{result=ok}': 11,
      'vtj.requests{result=error}': 3,
      'service.errors': 13,
      'service.asyncJob.failed': 4,
      'service.asyncJob.failed{type=SendMessage}': 3,
      'service.asyncJob.failed{type=UpdateVardaChild}': 1,
      'service.asyncJob.permanentlyFailed': 1,
      'service.asyncJob.permanentlyFailed{type=SendMessage}': 1,
      'integration.failed{system=email}': 2,
      'integration.failed{system=webpush}': 1,
      'integration.failed{system=varda}': 2,
      'integration.failed{system=dvv}': 1,
      'sanityCheck.failed': 2
    })
  })

  it('zero-fills every series except the job types in each bucket of the range', () => {
    const values = serviceValuesFromRows([], FROM, TO)
    assert.deepEqual([...values.keys()], [FROM, ms('2026-10-06T12:05:00Z')])
    for (const slot of values.values()) {
      assert.deepEqual(Object.keys(slot).sort(), [...SERVICE_SERIES].sort())
      assert.deepEqual(slot['service.responseTime'], new Array(13).fill(0))
      assert.equal(slot['service.errors'], 0)
    }
  })

  it('drops rows outside the range and unknown event codes', () => {
    const values = serviceValuesFromRows(
      [
        serviceRow({
          t: '2026-10-06 12:10:00.000',
          type: 'app-audit-events',
          k: 'CitizenLogin',
          n: '1'
        }),
        serviceRow({ type: 'app-audit-events', k: 'UnitRead', n: '1' })
      ],
      FROM,
      TO
    )
    assert.equal(values.size, 2)
    assert.equal(values.get(FROM)['citizen.login{auth=strong}'], 0)
    assert.equal(Object.keys(values.get(FROM)).length, SERVICE_SERIES.length)
  })

  it('gives only series that have metadata', () => {
    const values = serviceValuesFromRows(rows, FROM, TO)
    assert.doesNotThrow(() => seriesMeta(Object.keys(values.get(FROM))))
    assert.deepEqual(
      seriesMeta(['service.asyncJob.failed{type=SendMessage}']),
      { 'service.asyncJob.failed{type=SendMessage}': { type: 'counter' } }
    )
  })
})

describe('APIGW_QUERY', () => {
  it('filters by every event code that maps to a series', () => {
    assert.deepEqual(
      listAfter(APIGW_QUERY, 'eventCode in'),
      Object.keys(APIGW_SERIES_BY_EVENT_CODE)
    )
  })

  it('captures the app from the path prefix', () => {
    const regex = parseRegex(APIGW_QUERY, 'path')
    const paths = {
      '/api/citizen/children': 'citizen',
      '/api/citizen/auth/weak-login': 'citizen',
      '/api/employee/units/1': 'employee',
      '/api/employee-mobile/units/1': 'employee-mobile',
      '/api/employee-mobile/auth/pin-login': 'employee-mobile',
      '/api/application/auth/saml/login/callback': undefined,
      '/api/internal/auth/saml/login/callback': undefined,
      '/api/csp': undefined,
      '/api/citizen': undefined
    }
    for (const [path, app] of Object.entries(paths)) {
      assert.equal(regex.exec(path)?.groups.pathApp, app, path)
    }
  })
})

describe('APIGW_SERIES', () => {
  it('has 16 request counts, 4 of each status and histogram, and the logins', () => {
    const apps = ['citizen', 'mobile', 'employee', 'other']
    assert.deepEqual(
      new Set(APIGW_SERIES),
      new Set([
        ...apps.flatMap((app) =>
          ['2xx', '3xx', '4xx', '5xx'].map(
            (c) => `apigw.requests{app=${app},class=${c}}`
          )
        ),
        ...apps.map((app) => `apigw.status401{app=${app}}`),
        ...apps.map((app) => `apigw.status429{app=${app}}`),
        ...apps.map((app) => `apigw.responseTime{app=${app}}`),
        'login.failed{method=sfi}',
        'login.failed{method=ad}',
        'login.failed{method=weak}',
        'login.failed{method=passkey}',
        'login.rateLimited'
      ])
    )
    assert.equal(APIGW_SERIES.length, 33)
  })
})

describe('apigwValuesFromRows', () => {
  function apigwRow(fields) {
    return { t: T0, k: 'other', rt: '0', ...fields }
  }

  it('maps each kind of row to its series', () => {
    const values = apigwValuesFromRows(
      [
        apigwRow({
          type: 'app-requests-received',
          k: 'citizen',
          rt: '4',
          n: '20',
          n2xx: '15',
          n3xx: '1',
          n4xx: '3',
          n5xx: '1',
          n401: '2',
          n429: '1'
        }),
        apigwRow({
          type: 'app-requests-received',
          k: 'citizen',
          rt: '12',
          n: '1',
          n2xx: '0',
          n3xx: '0',
          n4xx: '0',
          n5xx: '1',
          n401: '0',
          n429: '0'
        }),
        apigwRow({
          type: 'app-requests-received',
          k: 'employee-mobile',
          rt: '5',
          n: '3',
          n2xx: '3',
          n3xx: '0',
          n4xx: '0',
          n5xx: '0',
          n401: '0',
          n429: '0'
        }),
        apigwRow({
          type: 'app-requests-received',
          k: 'other',
          rt: '3',
          n: '2',
          n2xx: '0',
          n3xx: '2',
          n4xx: '0',
          n5xx: '0',
          n401: '0',
          n429: '0'
        }),
        apigwRow({
          type: 'app-audit-events',
          k: 'evaka.saml.suomifi.sign_in_failed',
          rt: '-1',
          n: '1'
        }),
        apigwRow({
          type: 'app-audit-events',
          k: 'evaka.citizen_weak.sign_in_failed',
          rt: '-1',
          n: '4'
        }),
        apigwRow({ type: 'app-misc', rt: '-1', n: '2' })
      ],
      FROM,
      TO
    )
    const slot = values.get(FROM)
    assert.equal(slot['apigw.requests{app=citizen,class=2xx}'], 15)
    assert.equal(slot['apigw.requests{app=citizen,class=4xx}'], 3)
    assert.equal(slot['apigw.requests{app=citizen,class=5xx}'], 2)
    assert.equal(slot['apigw.status401{app=citizen}'], 2)
    assert.equal(slot['apigw.status429{app=citizen}'], 1)
    const citizenTimes = new Array(13).fill(0)
    citizenTimes[4] = 20
    citizenTimes[12] = 1
    assert.deepEqual(slot['apigw.responseTime{app=citizen}'], citizenTimes)
    assert.equal(slot['apigw.requests{app=mobile,class=2xx}'], 3)
    assert.equal(slot['apigw.requests{app=other,class=3xx}'], 2)
    assert.equal(slot['apigw.requests{app=employee,class=2xx}'], 0)
    assert.deepEqual(
      slot['apigw.responseTime{app=employee}'],
      new Array(13).fill(0)
    )
    assert.equal(slot['login.failed{method=sfi}'], 1)
    assert.equal(slot['login.failed{method=weak}'], 4)
    assert.equal(slot['login.failed{method=ad}'], 0)
    assert.equal(slot['login.rateLimited'], 2)
    assert.deepEqual(Object.keys(slot).sort(), [...APIGW_SERIES].sort())
  })

  it('zero-fills every series in each bucket of the range', () => {
    const values = apigwValuesFromRows([], FROM, TO)
    assert.equal(values.size, 2)
    for (const slot of values.values()) {
      assert.deepEqual(Object.keys(slot).sort(), [...APIGW_SERIES].sort())
      assert.equal(slot['apigw.status429{app=other}'], 0)
      assert.deepEqual(
        slot['apigw.responseTime{app=mobile}'],
        new Array(13).fill(0)
      )
    }
  })
})

describe('proxyValuesFromRows', () => {
  it('maps the status class and gateway error counts', () => {
    const values = proxyValuesFromRows(
      [
        {
          t: T0,
          n: '120',
          n2xx: '100',
          n3xx: '10',
          n4xx: '5',
          n5xx: '4',
          n502: '3',
          n504: '1'
        }
      ],
      FROM,
      TO
    )
    assert.deepEqual(values.get(FROM), {
      'proxy.requests{class=2xx}': 100,
      'proxy.requests{class=3xx}': 10,
      'proxy.requests{class=4xx}': 5,
      'proxy.requests{class=5xx}': 4,
      'proxy.status502': 3,
      'proxy.status504': 1
    })
  })

  it('zero-fills every series in each bucket of the range', () => {
    const values = proxyValuesFromRows([], FROM, TO)
    assert.deepEqual(
      [...values.values()],
      [0, 1].map(() => Object.fromEntries(PROXY_SERIES.map((n) => [n, 0])))
    )
  })
})
