import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { ssmStub } from './stub-ssm.mjs'
import { cloudwatchLogsStub } from './stub-cloudwatch-logs.mjs'

// Set AWS_REGION before importing the module to avoid side-effect issues
// and to get deterministic URLs in buildLogInsightsUrl tests.
process.env.AWS_REGION = 'eu-west-1'

const {
  formatTimestamp,
  extractThrowSite,
  buildLogInsightsUrl,
  buildAlarmPayload,
  buildNotificationPayload,
  buildSessionDigestPayload,
  resolveMatchedCount,
  formatErrorCount,
  formatRemainder,
  FORMAT_PRESETS,
  EVAKA_PRESET,
  NGINX_PRESET,
  buildQueryParts,
  buildInsightsFields,
  discoverLogGroupNames,
  resolveSourceLogGroupNames,
  deriveSourceLabel
} = await import('./slack_notifier.mjs')

// The webhook cache is module-scope state in lib.mjs. Each caching test needs a
// pristine instance; a unique query string forces a fresh evaluation. postToSlack
// and getSlackWebhookUrl live in lib, so their caching tests re-import lib; the
// rest re-import the entry.
let moduleLoadCount = 0
function freshModule() {
  return import(`./slack_notifier.mjs?case=${moduleLoadCount++}`)
}
function freshLib() {
  return import(`./lib.mjs?case=${moduleLoadCount++}`)
}

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------
describe('formatTimestamp', () => {
  it('formats a valid ISO string to Finnish time with dots', () => {
    const result = formatTimestamp('2024-01-15T14:30:00Z')
    // Helsinki is UTC+2 in January (EET), so 14:30 UTC -> 16:30 local
    assert.equal(result, '16.30.00')
  })

  it('returns the input unchanged for an invalid date string', () => {
    assert.equal(formatTimestamp('not-a-date'), 'not-a-date')
  })

  it('returns the input unchanged for an empty string', () => {
    assert.equal(formatTimestamp(''), '')
  })
})

// ---------------------------------------------------------------------------
// extractThrowSite
// ---------------------------------------------------------------------------
describe('extractThrowSite', () => {
  it('extracts the throw site from a stack trace with an evaka frame', () => {
    const stack = [
      'java.lang.RuntimeException: boom',
      '\tat evaka.core.pis.PersonService.getPerson(PersonService.kt:42)',
      '\tat evaka.core.pis.PersonController.get(PersonController.kt:10)'
    ].join('\n')
    assert.equal(
      extractThrowSite(stack),
      'core.pis.PersonService.getPerson(PersonService.kt:42)'
    )
  })

  it('returns null when only framework frames are present', () => {
    const stack = [
      'java.lang.RuntimeException: boom',
      '\tat org.springframework.web.Foo.bar(Foo.java:1)',
      '\tat org.springframework.web.Baz.qux(Baz.java:2)'
    ].join('\n')
    assert.equal(extractThrowSite(stack), null)
  })

  it('skips ExceptionHandler frames and returns the next evaka frame', () => {
    const stack = [
      'java.lang.RuntimeException: boom',
      '\tat evaka.core.shared.ExceptionHandler.handle(ExceptionHandler.kt:10)',
      '\tat evaka.core.pis.PersonService.getPerson(PersonService.kt:42)'
    ].join('\n')
    assert.equal(
      extractThrowSite(stack),
      'core.pis.PersonService.getPerson(PersonService.kt:42)'
    )
  })

  it('returns null if the only evaka frame is an ExceptionHandler', () => {
    const stack = [
      'java.lang.RuntimeException: boom',
      '\tat evaka.core.shared.ExceptionHandler.handle(ExceptionHandler.kt:10)',
      '\tat org.springframework.web.Foo.bar(Foo.java:1)'
    ].join('\n')
    assert.equal(extractThrowSite(stack), null)
  })

  it('returns null for an empty string', () => {
    assert.equal(extractThrowSite(''), null)
  })

  it('uses a custom package prefix instead of the evaka default', () => {
    const stack = [
      'java.lang.RuntimeException: boom',
      '\tat evaka.core.pis.PersonService.getPerson(PersonService.kt:42)',
      '\tat com.example.app.VoucherService.grant(VoucherService.kt:10)'
    ].join('\n')
    assert.equal(
      extractThrowSite(stack, 'com.example.app'),
      'VoucherService.grant(VoucherService.kt:10)'
    )
  })

  it('treats dots in a custom prefix literally, not as a regex wildcard', () => {
    const stack = '\tat comXexampleXapp.Foo.bar(Foo.kt:1)'
    assert.equal(extractThrowSite(stack, 'com.example.app'), null)
  })
})

// ---------------------------------------------------------------------------
// buildQueryParts
// ---------------------------------------------------------------------------
describe('buildQueryParts', () => {
  const preset = FORMAT_PRESETS['logback-json']

  // The api-gateways log pino's `level` and the older `logLevel` into one log
  // group, so a filter on either field alone loses the other's errors.
  it('filters on the preset error level, with no AsyncJobPool mute by default', () => {
    const parts = buildQueryParts(preset, '', [])
    assert.equal(
      parts[0],
      'filter tolower(coalesce(logLevel, level)) = "error"'
    )
    assert.ok(!parts.some((p) => p.includes('AsyncJobPool')))
  })

  it('derives the AsyncJobPool mute from a throw-site package prefix', () => {
    const parts = buildQueryParts(preset, 'com.example.app', [])
    const muteFilter = parts.find((p) => p.includes('AsyncJobPool'))
    assert.ok(muteFilter)
    assert.ok(
      muteFilter.includes(
        'loggerName like /^com\\.example\\.app\\.shared\\.asyncjob\\.AsyncJobPool\\./'
      )
    )
  })

  it('accepts the other level field for a pino source', () => {
    const parts = buildQueryParts(FORMAT_PRESETS['pino-json'], '', [])
    assert.equal(
      parts[0],
      'filter tolower(coalesce(level, logLevel)) = "error"'
    )
  })

  // nginx has no level field, so a level filter would match nothing at all
  // and the source would look healthy while dropping every error.
  it('filters plain-text nginx logs on the severity tag', () => {
    const parts = buildQueryParts(NGINX_PRESET, '', [])
    assert.equal(
      parts[0],
      'filter @message like /\\[(emerg|alert|crit|error)\\]/'
    )
    assert.equal(
      buildInsightsFields(NGINX_PRESET),
      'fields @timestamp, @message'
    )
  })

  it('appends extra noise filters verbatim', () => {
    const parts = buildQueryParts(preset, '', [
      'filter loggerName not like /^com\\.example\\.app\\.SESEmailClient/'
    ])
    assert.ok(
      parts.includes(
        'filter loggerName not like /^com\\.example\\.app\\.SESEmailClient/'
      )
    )
  })

  it('ends with a sort and a limit', () => {
    const parts = buildQueryParts(preset, '', [])
    assert.deepEqual(parts.slice(-2), ['sort @timestamp asc', 'limit 20'])
  })

  it('derives no AsyncJobPool mute for a format that has no such logger', () => {
    const parts = buildQueryParts(
      FORMAT_PRESETS['pino-json'],
      'com.example.app',
      []
    )
    assert.ok(!parts.some((p) => p.includes('AsyncJobPool')))
  })
})

// ---------------------------------------------------------------------------
// buildInsightsFields
// ---------------------------------------------------------------------------
describe('buildInsightsFields', () => {
  it('uses the logback-json field names', () => {
    const fields = buildInsightsFields(FORMAT_PRESETS['logback-json'])
    assert.ok(fields.includes('appName'))
    assert.ok(fields.includes('httpMethod'))
    assert.ok(fields.includes('logLevel'))
  })

  it('uses the pino-json field names', () => {
    const fields = buildInsightsFields(FORMAT_PRESETS['pino-json'])
    assert.ok(fields.includes('appName'))
    assert.ok(fields.includes('level'))
    assert.ok(!fields.includes('logLevel'))
  })

  // pino error entries carry no request context, so there is nothing to build a
  // "GET /foo" endpoint out of and the logger name has to stand in for it.
  it('falls back to the logger name as endpoint without request fields', () => {
    const fields = buildInsightsFields(FORMAT_PRESETS['pino-json'])
    assert.ok(fields.includes('name as endpoint'))
    assert.ok(!fields.includes('httpMethod'))
    assert.ok(!fields.includes('concat('))
  })
})

// ---------------------------------------------------------------------------
// discoverLogGroupNames
// ---------------------------------------------------------------------------
describe('discoverLogGroupNames', () => {
  beforeEach(() => {
    cloudwatchLogsStub.reset()
  })

  it('collects log group names for a single prefix', async () => {
    cloudwatchLogsStub.describeLogGroupsResponses = [
      { logGroups: [{ logGroupName: '/ecs/example-service' }] }
    ]
    const names = await discoverLogGroupNames(['/ecs/example-'])
    assert.deepEqual([...names], ['/ecs/example-service'])
  })

  it('follows pagination via nextToken', async () => {
    cloudwatchLogsStub.describeLogGroupsResponses = [
      { logGroups: [{ logGroupName: '/ecs/a' }], nextToken: 'page2' },
      { logGroups: [{ logGroupName: '/ecs/b' }] }
    ]
    const names = await discoverLogGroupNames(['/ecs/'])
    assert.deepEqual([...names].sort(), ['/ecs/a', '/ecs/b'])
  })

  it('unions and dedupes results across multiple prefixes', async () => {
    cloudwatchLogsStub.describeLogGroupsResponses = [
      { logGroups: [{ logGroupName: '/ecs/shared' }] },
      {
        logGroups: [
          { logGroupName: '/ecs/shared' },
          { logGroupName: '/ecs/other' }
        ]
      }
    ]
    const names = await discoverLogGroupNames(['/ecs/a-', '/ecs/b-'])
    assert.deepEqual([...names].sort(), ['/ecs/other', '/ecs/shared'])
  })
})

// ---------------------------------------------------------------------------
// resolveSourceLogGroupNames
// ---------------------------------------------------------------------------
describe('resolveSourceLogGroupNames', () => {
  beforeEach(() => {
    cloudwatchLogsStub.reset()
  })

  it('returns static names unchanged when there are no prefixes', async () => {
    const names = await resolveSourceLogGroupNames({
      log_group_names: ['/ecs/fixed'],
      log_group_name_prefixes: []
    })
    assert.deepEqual(names, ['/ecs/fixed'])
    assert.equal(cloudwatchLogsStub.calls.length, 0)
  })

  it('caps the list at what one query accepts, keeping the configured names', async () => {
    const discovered = Array.from({ length: 60 }, (_, i) => ({
      logGroupName: `/ecs/discovered-${i}`
    }))
    cloudwatchLogsStub.describeLogGroupsResponses = [{ logGroups: discovered }]

    const names = await resolveSourceLogGroupNames({
      log_group_names: ['/ecs/configured'],
      log_group_name_prefixes: ['/ecs/']
    })

    assert.equal(names.length, 50)
    assert.equal(names[0], '/ecs/configured')
  })

  it('merges discovered names with static ones, deduped', async () => {
    cloudwatchLogsStub.describeLogGroupsResponses = [
      {
        logGroups: [
          { logGroupName: '/ecs/fixed' },
          { logGroupName: '/ecs/new-service' }
        ]
      }
    ]
    const names = await resolveSourceLogGroupNames({
      log_group_names: ['/ecs/fixed'],
      log_group_name_prefixes: ['/ecs/']
    })
    assert.deepEqual(names.sort(), ['/ecs/fixed', '/ecs/new-service'])
  })
})

// ---------------------------------------------------------------------------
// deriveSourceLabel
// ---------------------------------------------------------------------------
describe('deriveSourceLabel', () => {
  it('prefixes the source name with the app/environment parsed off the log group', () => {
    assert.equal(
      deriveSourceLabel('service', ['/aws/ecs/example-staging/service']),
      'example-staging/service'
    )
  })

  it('falls back to the source name alone for a non-ECS log group name', () => {
    assert.equal(
      deriveSourceLabel('service', ['/ecs/example-service']),
      'service'
    )
  })

  it('falls back to the source name alone when several log groups resolve', () => {
    assert.equal(
      deriveSourceLabel('service', [
        '/aws/ecs/example-dev/service',
        '/aws/ecs/example-staging/service'
      ]),
      'service'
    )
  })

  it('falls back to the source name alone with no resolved log groups', () => {
    assert.equal(deriveSourceLabel('service', []), 'service')
  })
})

// ---------------------------------------------------------------------------
// buildLogInsightsUrl
// ---------------------------------------------------------------------------
describe('buildLogInsightsUrl', () => {
  it('produces a URL containing the encoded group name and query', () => {
    const url = buildLogInsightsUrl(
      'fields @timestamp',
      ['/ecs/my-service'],
      1000,
      2000,
      'eu-west-1'
    )
    assert.ok(
      url.startsWith('https://eu-west-1.console.aws.amazon.com/cloudwatch/home')
    )
    assert.ok(url.includes('logsV2:logs-insights'))
    // The log group should appear somewhere in the URL (encoded)
    assert.ok(url.includes('ecs'))
    assert.ok(url.includes('my-service'))
    // The query text should appear (encoded)
    assert.ok(url.includes('fields'))
    assert.ok(url.includes('timestamp'))
    // Start / end times
    assert.ok(url.includes('1000000'))
    assert.ok(url.includes('2000000'))
  })

  it('includes all log groups when given multiple', () => {
    const url = buildLogInsightsUrl(
      'fields @timestamp',
      ['/ecs/service-a', '/ecs/service-b'],
      1000,
      2000,
      'eu-west-1'
    )
    assert.ok(url.includes('service-a'))
    assert.ok(url.includes('service-b'))
  })

  it('encodes special characters using the *XX hex scheme', () => {
    const url = buildLogInsightsUrl(
      'filter msg = "hello world" | sort',
      ['/ecs/svc'],
      1000,
      2000,
      'eu-west-1'
    )
    // Space (0x20) -> *20
    assert.ok(url.includes('*20'))
    // Double quote (0x22) -> *22
    assert.ok(url.includes('*22'))
    // Pipe (0x7c) -> *7c
    assert.ok(url.includes('*7c'))
  })
})

// ---------------------------------------------------------------------------
// buildAlarmPayload
// ---------------------------------------------------------------------------
describe('buildAlarmPayload', () => {
  it('produces red color and :red_circle: for ALARM state', () => {
    const payload = buildAlarmPayload(
      { AlarmName: 'test-alarm', NewStateValue: 'ALARM' },
      'eu-west-1'
    )
    assert.equal(payload.attachments[0].color, '#d32f2f')
    const sectionText = payload.attachments[0].blocks[0].text.text
    assert.ok(sectionText.includes(':red_circle:'))
  })

  it('produces green color and :large_green_circle: for OK state', () => {
    const payload = buildAlarmPayload(
      { AlarmName: 'test-alarm', NewStateValue: 'OK' },
      'eu-west-1'
    )
    assert.equal(payload.attachments[0].color, '#4caf50')
    const sectionText = payload.attachments[0].blocks[0].text.text
    assert.ok(sectionText.includes(':large_green_circle:'))
  })

  it("truncates reason longer than 300 characters with '...'", () => {
    const longReason = 'x'.repeat(400)
    const payload = buildAlarmPayload(
      {
        AlarmName: 'test-alarm',
        NewStateValue: 'ALARM',
        NewStateReason: longReason
      },
      'eu-west-1'
    )
    // Find the reason field in the fields section
    const fieldsBlock = payload.attachments[0].blocks.find(
      (b) => b.type === 'section' && b.fields
    )
    const reasonField = fieldsBlock.fields.find((f) =>
      f.text.startsWith('*Reason:*')
    )
    assert.ok(reasonField.text.endsWith('...'))
    // 300 chars of reason + "*Reason:*\n" prefix + "..."
    const reasonContent = reasonField.text.replace('*Reason:*\n', '')
    assert.equal(reasonContent.length, 303) // 300 + "..."
  })

  it('omits description, reason, and time fields when they are empty', () => {
    const payload = buildAlarmPayload(
      {
        AlarmName: 'test-alarm',
        NewStateValue: 'ALARM',
        AlarmDescription: '',
        NewStateReason: '',
        StateChangeTime: ''
      },
      'eu-west-1'
    )
    // There should be no section block with fields
    const fieldsBlock = payload.attachments[0].blocks.find(
      (b) => b.type === 'section' && b.fields
    )
    assert.equal(fieldsBlock, undefined)
  })

  it('uses AlarmDescription as the headline and shows reason and time fields', () => {
    const payload = buildAlarmPayload(
      {
        AlarmName: 'test-alarm',
        NewStateValue: 'ALARM',
        AlarmDescription: 'Backup failed in example-staging',
        NewStateReason: 'Threshold exceeded',
        StateChangeTime: '2024-01-15T14:30:00Z'
      },
      'eu-west-1'
    )
    // The description becomes the headline (not the technical "name is now STATE").
    const headline = payload.attachments[0].blocks[0].text.text
    assert.ok(headline.includes('Backup failed in example-staging'))
    assert.ok(!headline.includes('is now'))
    // It is not repeated as a field; only reason and time remain.
    const fieldsBlock = payload.attachments[0].blocks.find(
      (b) => b.type === 'section' && b.fields
    )
    assert.ok(fieldsBlock)
    assert.equal(fieldsBlock.fields.length, 2)
    assert.ok(!fieldsBlock.fields.some((f) => f.text.includes('Description')))
    assert.ok(fieldsBlock.fields[0].text.includes('Reason'))
    assert.ok(fieldsBlock.fields[1].text.includes('Time'))
  })

  it('prefixes "Recovered:" on an OK transition that has a description', () => {
    const payload = buildAlarmPayload(
      {
        AlarmName: 'test-alarm',
        NewStateValue: 'OK',
        AlarmDescription: 'Backup failed in example-staging'
      },
      'eu-west-1'
    )
    const headline = payload.attachments[0].blocks[0].text.text
    assert.ok(headline.includes(':large_green_circle:'))
    assert.ok(headline.includes('Recovered: Backup failed in example-staging'))
  })

  it('falls back to "name is now STATE" headline when description is absent', () => {
    const payload = buildAlarmPayload(
      { AlarmName: 'test-alarm', NewStateValue: 'ALARM' },
      'eu-west-1'
    )
    const headline = payload.attachments[0].blocks[0].text.text
    assert.ok(headline.includes('*test-alarm* is now *ALARM*'))
  })

  it('encodes special characters in alarm name for CloudWatch URL', () => {
    const payload = buildAlarmPayload(
      {
        AlarmName: 'alarm with spaces & special=chars',
        NewStateValue: 'ALARM'
      },
      'eu-west-1'
    )
    const linkBlock = payload.attachments[0].blocks.find(
      (b) =>
        b.type === 'section' && b.text?.text?.includes('View in CloudWatch')
    )
    const url = linkBlock.text.text.match(/<([^|]+)\|/)[1]
    // The alarm name should be URI-encoded
    assert.ok(
      url.includes(encodeURIComponent('alarm with spaces & special=chars'))
    )
    assert.ok(!url.includes('alarm with spaces'))
  })
})

// ---------------------------------------------------------------------------
// postToSlack — webhook URL caching
//
// Regression cover for the production incident where the SSM parameter held a
// placeholder ("changeit"). That value was cached for the lifetime of the warm
// Lambda container, so no Slack message was ever sent. A URL must be cached
// only after a POST through it has actually succeeded.
// ---------------------------------------------------------------------------
describe('postToSlack webhook caching', () => {
  let originalFetch
  let originalLog

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalLog = console.log
    console.log = () => {}
    ssmStub.reset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.log = originalLog
  })

  it('does not cache the URL when fetch rejects', async () => {
    const { postToSlack } = await freshLib()
    ssmStub.parameterValue = 'changeit'
    globalThis.fetch = async () => {
      // An invalid URL makes fetch reject before returning a response — the
      // exact shape of the original incident.
      throw new TypeError('Failed to parse URL from changeit')
    }

    await assert.rejects(postToSlack({ text: 'hi' }))
    await assert.rejects(postToSlack({ text: 'hi' }))

    assert.equal(ssmStub.getParameterCalls, 2)
  })

  it('does not cache the URL on a non-2xx Slack response', async () => {
    const { postToSlack } = await freshLib()
    ssmStub.parameterValue = 'https://hooks.slack.com/services/REVOKED'
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      text: async () => 'not found'
    })

    await assert.rejects(postToSlack({ text: 'hi' }))
    await assert.rejects(postToSlack({ text: 'hi' }))

    assert.equal(ssmStub.getParameterCalls, 2)
  })

  it('caches the URL after a successful POST and reuses it', async () => {
    const { postToSlack } = await freshLib()
    ssmStub.parameterValue = 'https://hooks.slack.com/services/OK'
    globalThis.fetch = async () => ({ ok: true, status: 200 })

    await postToSlack({ text: 'hi' })
    await postToSlack({ text: 'hi' })

    assert.equal(ssmStub.getParameterCalls, 1)
  })

  it('recovers without a restart after the SSM value is fixed', async () => {
    const { postToSlack } = await freshLib()
    ssmStub.parameterValue = 'changeit'
    globalThis.fetch = async (url) => {
      if (url === 'changeit') throw new TypeError('Failed to parse URL')
      return { ok: true, status: 200 }
    }

    await assert.rejects(postToSlack({ text: 'hi' }))

    ssmStub.parameterValue = 'https://hooks.slack.com/services/OK'
    await postToSlack({ text: 'hi' })

    assert.equal(ssmStub.getParameterCalls, 2)
  })
})

// ---------------------------------------------------------------------------
// getSlackWebhookUrl
// ---------------------------------------------------------------------------
describe('getSlackWebhookUrl', () => {
  beforeEach(() => {
    ssmStub.reset()
  })

  it('reads SSM every call and never caches on its own', async () => {
    const { getSlackWebhookUrl } = await freshLib()
    ssmStub.parameterValue = 'https://hooks.slack.com/services/OK'

    assert.equal(
      await getSlackWebhookUrl(),
      'https://hooks.slack.com/services/OK'
    )
    assert.equal(
      await getSlackWebhookUrl(),
      'https://hooks.slack.com/services/OK'
    )

    // Caching is postToSlack's responsibility, and only after a confirmed
    // POST — the getter alone must keep hitting SSM.
    assert.equal(ssmStub.getParameterCalls, 2)
  })
})

// ---------------------------------------------------------------------------
// resolveMatchedCount
// ---------------------------------------------------------------------------
describe('resolveMatchedCount', () => {
  it('returns recordsMatched rounded to an integer', () => {
    assert.equal(resolveMatchedCount({ recordsMatched: 23 }, 10), 23)
    assert.equal(resolveMatchedCount({ recordsMatched: 23.7 }, 10), 24)
  })

  it('falls back to resultsLength when statistics is missing', () => {
    assert.equal(resolveMatchedCount(null, 7), 7)
    assert.equal(resolveMatchedCount(undefined, 7), 7)
  })

  it('falls back to resultsLength when recordsMatched is not a number', () => {
    assert.equal(resolveMatchedCount({}, 5), 5)
  })
})

// ---------------------------------------------------------------------------
// formatErrorCount
// ---------------------------------------------------------------------------
describe('formatErrorCount', () => {
  it('formats the exact count and period', () => {
    assert.equal(formatErrorCount(23, 5), '23 error(s) in the last 5 minutes')
  })

  it('formats a single error the same way', () => {
    assert.equal(formatErrorCount(1, 5), '1 error(s) in the last 5 minutes')
  })
})

// ---------------------------------------------------------------------------
// formatRemainder
// ---------------------------------------------------------------------------
describe('formatRemainder', () => {
  it('reports the exact remainder when more matched than shown', () => {
    assert.equal(formatRemainder(23, 10), '_...and 13 more not shown_')
  })

  it('returns null when the shown count equals the matched count', () => {
    assert.equal(formatRemainder(10, 10), null)
  })

  it('returns null when fewer matched than shown', () => {
    assert.equal(formatRemainder(8, 10), null)
  })
})

// ---------------------------------------------------------------------------
// buildNotificationPayload
// ---------------------------------------------------------------------------
describe('buildSessionDigestPayload', () => {
  const row = (arn, target, sessions) => [
    { field: 'detail.userIdentity.arn', value: arn },
    { field: 'detail.requestParameters.target', value: target },
    { field: 'sessions', value: String(sessions) }
  ]

  it('groups sessions per user and target with a total', () => {
    const payload = buildSessionDigestPayload(
      [
        row(
          'arn:aws:sts::123:assumed-role/AWSReservedSSO_Admin/EXT-test.user@example.com',
          'i-abc',
          3
        ),
        row(
          'arn:aws:sts::123:assumed-role/Reader/reader@example.com',
          'i-def',
          1
        )
      ],
      ''
    )
    const blocks = payload.attachments[0].blocks
    assert.match(blocks[0].text.text, /:bell: \*4 SSM sessions started\*/)
    assert.equal(
      blocks[1].text.text,
      '• EXT-test.user@example.com (3) on i-abc\n• reader@example.com (1) on i-def'
    )
  })

  it('uses the singular form for one session and prefixes a label', () => {
    const payload = buildSessionDigestPayload(
      [row('root', 'i-abc', 1)],
      'example-prod'
    )
    assert.match(
      payload.attachments[0].blocks[0].text.text,
      /:bell: \*\[example-prod\] 1 SSM session started\*/
    )
    assert.equal(
      payload.attachments[0].blocks[1].text.text,
      '• root (1) on i-abc'
    )
  })
})

describe('buildNotificationPayload', () => {
  it('renders a subject as the headline and the text below it', () => {
    const payload = buildNotificationPayload(
      'Session on bastion',
      'SSM session'
    )
    assert.equal(payload.attachments[0].color, '#ff9800')
    const blocks = payload.attachments[0].blocks
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].text.text, ':bell: *SSM session*')
    assert.equal(blocks[1].text.text, 'Session on bastion')
  })

  it('renders a single block when there is no subject', () => {
    const payload = buildNotificationPayload('Virus found in an upload')
    const blocks = payload.attachments[0].blocks
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].text.text, ':bell: Virus found in an upload')
  })

  it('truncates a body Slack would reject', () => {
    const payload = buildNotificationPayload('x'.repeat(5000))
    const text = payload.attachments[0].blocks[0].text.text
    assert.ok(text.endsWith('...'))
    assert.ok(text.length < 3000)
  })

  it('falls back to placeholder text for an empty body', () => {
    const payload = buildNotificationPayload('   ')
    assert.ok(
      payload.attachments[0].blocks[0].text.text.includes(
        'Notification with no message body'
      )
    )
  })
})

// ---------------------------------------------------------------------------
// handleSnsRecord
//
// The alarm topic carries both CloudWatch alarms and EventBridge rules that
// publish to it directly. Before this split, a non-alarm payload was parsed as
// an alarm and rendered as "Unknown alarm is now UNKNOWN".
// ---------------------------------------------------------------------------
describe('handleSnsRecord', () => {
  let originalFetch
  let originalLog
  let posted

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalLog = console.log
    console.log = () => {}
    posted = []
    globalThis.fetch = async (_url, init) => {
      posted.push(JSON.parse(init.body))
      return { ok: true, status: 200 }
    }
    ssmStub.reset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.log = originalLog
  })

  it('formats a CloudWatch alarm message as an alarm', async () => {
    const { handleSnsRecord } = await freshModule()
    await handleSnsRecord({
      Sns: {
        Message: JSON.stringify({
          AlarmName: 'example-prod-rds-free-storage-space-critical',
          AlarmDescription: 'RDS instance is running out of disk space',
          NewStateValue: 'ALARM'
        })
      }
    })

    assert.equal(posted.length, 1)
    const headline = posted[0].attachments[0].blocks[0].text.text
    assert.ok(headline.includes(':red_circle:'))
    assert.ok(headline.includes('running out of disk space'))
  })

  it('renders an input-transformed string as a notification', async () => {
    const { handleSnsRecord } = await freshModule()
    await handleSnsRecord({
      Sns: { Message: JSON.stringify('SSM session started in 123456789012') }
    })

    assert.equal(posted.length, 1)
    const text = posted[0].attachments[0].blocks[0].text.text
    assert.ok(text.includes(':bell:'))
    assert.ok(text.includes('SSM session started'))
  })

  it('renders a non-JSON message as a notification', async () => {
    const { handleSnsRecord } = await freshModule()
    await handleSnsRecord({ Sns: { Message: 'plain text alert' } })

    assert.equal(posted.length, 1)
    assert.ok(
      posted[0].attachments[0].blocks[0].text.text.includes('plain text alert')
    )
  })

  it('renders a JSON object without AlarmName as a notification', async () => {
    const { handleSnsRecord } = await freshModule()
    await handleSnsRecord({
      Sns: { Message: JSON.stringify({ detail: 'some event' }) }
    })

    assert.equal(posted.length, 1)
    assert.ok(posted[0].attachments[0].blocks[0].text.text.includes(':bell:'))
  })
})

// ---------------------------------------------------------------------------
// handleLogCheck
// ---------------------------------------------------------------------------
// The eVaka scan's query is the module's pre-log_sources behaviour, which every
// existing eVaka environment's alerting depends on. Pinning it byte-for-byte is
// what makes it safe to fold this path into the generalized one later.
const EVAKA_INSIGHTS_FIELDS =
  'fields @timestamp, appName, if(not isempty(httpMethod) and not isempty(httpRoute), concat(httpMethod, " ", httpRoute), loggerName) as endpoint, logLevel, message, stackTrace'

const EVAKA_QUERY = [
  'fields @timestamp, @message',
  'filter tolower(logLevel) = "error"',
  'filter not (loggerName like /^evaka\\.core\\.shared\\.async\\.AsyncJobPool\\./ and meta.remainingAttempts > 0)',
  'filter loggerName not like /^evaka\\.core\\.varda\\./',
  'filter not (exception = "UnableToExecuteStatementException" and (message like /staff_attendance_no_overlaps/ or message like /staff_attendance_plan_no_overlaps/))',
  'sort @timestamp asc',
  'limit 20'
].join('\n| ')

describe('handleLogCheck', () => {
  let originalLog

  beforeEach(() => {
    originalLog = console.log
    console.log = () => {}
    ssmStub.reset()
    cloudwatchLogsStub.reset()
  })

  afterEach(() => {
    console.log = originalLog
    delete process.env.LOG_GROUP_NAMES
  })

  it('queries the configured log groups with the eVaka query verbatim', async () => {
    process.env.LOG_GROUP_NAMES =
      '/aws/ecs/example-service,/aws/ecs/example-apigw'
    const { handleLogCheck } = await freshModule()

    await handleLogCheck('aws')

    const startQueryCall = cloudwatchLogsStub.calls.find(
      (c) => c.constructor.name === 'StartQueryCommand'
    )
    assert.equal(startQueryCall.input.queryString, EVAKA_QUERY)
    assert.deepEqual(startQueryCall.input.logGroupNames, [
      '/aws/ecs/example-service',
      '/aws/ecs/example-apigw'
    ])
  })

  // The deep-link query is the other half of the pinned behaviour: it selects
  // httpRoute where the Slack lines use path, and both fields really exist.
  it('builds the eVaka deep-link fields verbatim', () => {
    assert.equal(buildInsightsFields(EVAKA_PRESET), EVAKA_INSIGHTS_FIELDS)
  })

  it('does not query at all without configured log groups', async () => {
    const { handleLogCheck } = await freshModule()

    await handleLogCheck('aws')

    assert.equal(cloudwatchLogsStub.calls.length, 0)
  })
})

// ---------------------------------------------------------------------------
// runInsightsQuery
// ---------------------------------------------------------------------------
describe('runInsightsQuery', () => {
  beforeEach(() => {
    cloudwatchLogsStub.reset()
  })

  // Logs Insights sometimes holds a query in Scheduled for tens of seconds
  // before it runs; that is a slow query, not a failed one.
  it('keeps polling a query that is still Scheduled or Running', async () => {
    const { runInsightsQuery } = await freshLib()
    const rows = [[{ field: '@message', value: 'boom' }]]
    cloudwatchLogsStub.getQueryResultsResponses = [
      { status: 'Scheduled' },
      { status: 'Scheduled' },
      { status: 'Running' },
      { status: 'Complete', results: rows, statistics: null }
    ]

    const outcome = await runInsightsQuery(['/ecs/service'], 'q', 0, 1)

    assert.deepEqual(outcome.results, rows)
    assert.equal(
      cloudwatchLogsStub.calls.filter(
        (c) => c.constructor.name === 'GetQueryResultsCommand'
      ).length,
      4
    )
  })

  it('stops at the deadline and reports how far it got', async () => {
    const { runInsightsQuery } = await freshLib()
    cloudwatchLogsStub.getQueryResultsResponses = Array.from(
      { length: 20 },
      () => ({ status: 'Scheduled' })
    )

    const outcome = await runInsightsQuery(['/ecs/service'], 'q', 0, 1, {
      deadlineMs: 500
    })

    assert.equal(outcome.results, null)
    assert.equal(outcome.lastStatus, 'Scheduled')
    // Polls at about 0, 100 and 300 ms; the next backoff step would end past
    // the deadline, so it is not taken.
    assert.equal(outcome.attempts, 3)
    assert.ok(outcome.elapsedMs <= 500, `elapsed ${outcome.elapsedMs}ms`)
  })
})

// ---------------------------------------------------------------------------
// handleLogSourceCheck
// ---------------------------------------------------------------------------
describe('handleLogSourceCheck', () => {
  let originalFetch
  let originalLog
  let posted

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalLog = console.log
    console.log = () => {}
    posted = []
    globalThis.fetch = async (_url, init) => {
      posted.push(JSON.parse(init.body))
      return { ok: true, status: 200 }
    }
    ssmStub.reset()
    cloudwatchLogsStub.reset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.log = originalLog
  })

  it('parses a logback-json source with its own field names and package prefix', async () => {
    const { handleLogSourceCheck } = await freshModule()
    const logLine = JSON.stringify({
      loggerName: 'com.example.app.SomeService',
      logLevel: 'ERROR',
      message: 'Something broke',
      exception: 'java.lang.RuntimeException',
      stackTrace:
        'java.lang.RuntimeException: boom\n\tat com.example.app.SomeService.doThing(SomeService.kt:10)',
      httpMethod: 'GET',
      path: '/api/foo',
      traceId: 'abc123'
    })
    cloudwatchLogsStub.getQueryResultsResponses = [
      {
        status: 'Complete',
        results: [
          [
            { field: '@timestamp', value: '2024-01-15T14:30:00Z' },
            { field: '@message', value: logLine }
          ]
        ],
        statistics: { recordsMatched: 1 }
      }
    ]

    await handleLogSourceCheck(
      'service',
      {
        log_group_names: ['/ecs/example-service'],
        log_group_name_prefixes: [],
        format: 'logback-json',
        throw_site_package_prefix: 'com.example.app',
        extra_noise_filters: []
      },
      'aws'
    )

    assert.equal(posted.length, 1)
    const text = posted[0].attachments[0].blocks
      .map((b) => b.text.text)
      .join('\n')
    assert.ok(text.includes('[service]'))
    assert.ok(text.includes('GET /api/foo'))
    assert.ok(text.includes('SomeService'))
    assert.ok(text.includes('SomeService.doThing(SomeService.kt:10)'))

    const startQueryCall = cloudwatchLogsStub.calls.find(
      (c) => c.constructor.name === 'StartQueryCommand'
    )
    assert.ok(
      startQueryCall.input.queryString.includes(
        'loggerName like /^com\\.example\\.app\\.shared\\.asyncjob\\.AsyncJobPool\\./'
      )
    )
  })

  it('labels the message with the app/environment when the log group follows the ECS convention', async () => {
    const { handleLogSourceCheck } = await freshModule()
    cloudwatchLogsStub.getQueryResultsResponses = [
      {
        status: 'Complete',
        results: [
          [
            { field: '@timestamp', value: '2024-01-15T14:30:00Z' },
            { field: '@message', value: JSON.stringify({ message: 'boom' }) }
          ]
        ],
        statistics: { recordsMatched: 1 }
      }
    ]

    await handleLogSourceCheck(
      'service',
      {
        log_group_names: ['/aws/ecs/example-staging/service'],
        log_group_name_prefixes: [],
        format: 'logback-json',
        throw_site_package_prefix: 'com.example.app',
        extra_noise_filters: []
      },
      'aws'
    )

    assert.equal(posted.length, 1)
    const header = posted[0].attachments[0].blocks[0].text.text
    assert.ok(header.includes('[example-staging/service]'))
  })

  it('parses a pino-json source using level/name instead of logLevel/loggerName', async () => {
    const { handleLogSourceCheck } = await freshModule()
    // Shaped after a real api-gateway error entry: pino's own `name`/`level`,
    // an appName from the logger's base fields, and no request context.
    const logLine = JSON.stringify({
      name: 'app',
      appName: 'example-api-gateway',
      level: 'error',
      message: 'Boom',
      exception: 'Error',
      stackTrace: 'Error: Boom\n    at handler (index.js:5:3)',
      traceId: 'abcdef'
    })
    cloudwatchLogsStub.getQueryResultsResponses = [
      {
        status: 'Complete',
        results: [
          [
            { field: '@timestamp', value: '2024-01-15T14:30:00Z' },
            { field: '@message', value: logLine }
          ]
        ],
        statistics: { recordsMatched: 1 }
      }
    ]

    await handleLogSourceCheck(
      'api-gateway',
      {
        log_group_names: ['/ecs/api-gateway'],
        log_group_name_prefixes: [],
        format: 'pino-json',
        throw_site_package_prefix: '',
        extra_noise_filters: []
      },
      'aws'
    )

    assert.equal(posted.length, 1)
    const text = posted[0].attachments[0].blocks
      .map((b) => b.text.text)
      .join('\n')
    assert.ok(text.includes('Error: Boom'))
    // No throw-site prefix configured: no stack-frame line is extracted.
    assert.ok(!text.includes('index.js'))

    const startQueryCall = cloudwatchLogsStub.calls.find(
      (c) => c.constructor.name === 'StartQueryCommand'
    )
    assert.ok(
      startQueryCall.input.queryString.includes(
        'tolower(coalesce(level, logLevel))'
      )
    )
    assert.ok(!startQueryCall.input.queryString.includes('AsyncJobPool'))
  })

  it('discovers log groups from a prefix before querying', async () => {
    const { handleLogSourceCheck } = await freshModule()
    cloudwatchLogsStub.describeLogGroupsResponses = [
      { logGroups: [{ logGroupName: '/ecs/example-service' }] }
    ]
    cloudwatchLogsStub.getQueryResultsResponses = [
      { status: 'Complete', results: [], statistics: { recordsMatched: 0 } }
    ]

    await handleLogSourceCheck(
      'service',
      {
        log_group_names: [],
        log_group_name_prefixes: ['/ecs/example-'],
        format: 'logback-json',
        throw_site_package_prefix: '',
        extra_noise_filters: []
      },
      'aws'
    )

    const startQueryCall = cloudwatchLogsStub.calls.find(
      (c) => c.constructor.name === 'StartQueryCommand'
    )
    assert.deepEqual(startQueryCall.input.logGroupNames, [
      '/ecs/example-service'
    ])
  })

  it('skips the scan without querying when no log groups resolve', async () => {
    const { handleLogSourceCheck } = await freshModule()

    await handleLogSourceCheck(
      'service',
      {
        log_group_names: [],
        log_group_name_prefixes: [],
        format: 'logback-json',
        throw_site_package_prefix: '',
        extra_noise_filters: []
      },
      'aws'
    )

    assert.equal(cloudwatchLogsStub.calls.length, 0)
    assert.equal(posted.length, 0)
  })

  // A real nginx line: plain text, no JSON, so the JSON branch must not eat it
  // and the message has to survive into Slack as written.
  it('reports plain-text nginx lines and honours a per-source channel', async () => {
    const { handleLogSourceCheck } = await freshModule()
    const nginxLine =
      '2026/09/30 01:31:15 [error] 29#29: *298345 directory index of "/static/assets/" is forbidden, client: 10.0.0.1'
    cloudwatchLogsStub.getQueryResultsResponses = [
      {
        status: 'Complete',
        results: [
          [
            { field: '@timestamp', value: '2026-09-30 01:31:15.000' },
            { field: '@message', value: nginxLine }
          ]
        ],
        statistics: { recordsMatched: 1 }
      }
    ]

    await handleLogSourceCheck(
      'frontend',
      {
        log_group_names: ['/aws/ecs/example-prod/frontend'],
        log_group_name_prefixes: [],
        format: 'nginx',
        throw_site_package_prefix: '',
        extra_noise_filters: [],
        channel: '#example-alerts'
      },
      'aws'
    )

    const query = cloudwatchLogsStub.calls.find(
      (c) => c.constructor.name === 'StartQueryCommand'
    ).input.queryString
    assert.match(
      query,
      /filter @message like \/\\\[\(emerg\|alert\|crit\|error\)\\\]\//
    )

    assert.equal(posted.length, 1)
    assert.equal(posted[0].channel, '#example-alerts')
    const blocks = posted[0].attachments[0].blocks
    assert.match(blocks[0].text.text, /\[example-prod\/frontend\] 1 error\(s\)/)
    assert.ok(blocks[1].text.text.includes('directory index of'))
  })

  it('warns on Slack when the query never completes', async () => {
    const { handleLogSourceCheck } = await freshModule()
    cloudwatchLogsStub.getQueryResultsResponses = [
      { status: 'Failed', results: null, statistics: null }
    ]

    await handleLogSourceCheck(
      'service',
      {
        log_group_names: ['/ecs/service'],
        log_group_name_prefixes: [],
        format: 'logback-json',
        throw_site_package_prefix: '',
        extra_noise_filters: []
      },
      'aws'
    )

    assert.equal(posted.length, 1)
    const text = posted[0].attachments[0].blocks[0].text.text
    assert.ok(text.includes('log error query for "service" failed'))
  })
})

// ---------------------------------------------------------------------------
// handler (scheduled scan fan-out)
// ---------------------------------------------------------------------------
describe('handler on a scheduled event', () => {
  let originalFetch
  let originalLog
  let originalError
  let posted

  const context = {
    invokedFunctionArn:
      'arn:aws:lambda:eu-west-1:123456789012:function:test-slack-notifier'
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalLog = console.log
    originalError = console.error
    console.log = () => {}
    console.error = () => {}
    posted = []
    globalThis.fetch = async (_url, init) => {
      posted.push(JSON.parse(init.body))
      return { ok: true, status: 200 }
    }
    ssmStub.reset()
    cloudwatchLogsStub.reset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.log = originalLog
    console.error = originalError
    delete process.env.LOG_GROUP_NAMES
    delete process.env.LOG_SOURCES_JSON
  })

  // A source whose log groups cannot even be listed used to be indistinguishable
  // in Slack from one that found no errors.
  it('warns about a log source that cannot be run, without skipping the others', async () => {
    process.env.LOG_GROUP_NAMES = '/aws/ecs/example-service'
    process.env.LOG_SOURCES_JSON = JSON.stringify({
      service: {
        log_group_names: [],
        log_group_name_prefixes: ['/ecs/example-'],
        format: 'logback-json',
        throw_site_package_prefix: '',
        extra_noise_filters: []
      }
    })
    const { handler } = await freshModule()
    // No DescribeLogGroups response queued: the stub rejects, as a denied
    // listing would.
    cloudwatchLogsStub.getQueryResultsResponses = [
      { status: 'Complete', results: [], statistics: null }
    ]

    await handler({ source: 'aws.events' }, context)

    const commands = cloudwatchLogsStub.calls.map((c) => c.constructor.name)
    assert.ok(commands.includes('DescribeLogGroupsCommand'))
    assert.equal(
      commands.filter((n) => n === 'StartQueryCommand').length,
      1,
      'the eVaka scan should still have run its own query'
    )

    assert.equal(posted.length, 1)
    assert.ok(
      posted[0].attachments[0].blocks[0].text.text.includes(
        'log source "service" could not be run:'
      )
    )
  })

  // A query rejected after the log groups resolved (e.g. a bad time range)
  // used to report only the bare source name, indistinguishable in a
  // shared Slack channel from the same source failing in another environment.
  it('warns about a failed query under the environment-qualified label', async () => {
    process.env.LOG_SOURCES_JSON = JSON.stringify({
      service: {
        log_group_names: ['/aws/ecs/example-staging/service'],
        log_group_name_prefixes: [],
        format: 'logback-json',
        throw_site_package_prefix: '',
        extra_noise_filters: []
      }
    })
    cloudwatchLogsStub.startQueryError = new Error(
      "Query's end date and time is either before the log groups creation " +
        'time or exceeds the log groups log retention settings ([0,91])'
    )
    const { handler } = await freshModule()

    await handler({ source: 'aws.events' }, context)

    assert.equal(posted.length, 1)
    assert.ok(
      posted[0].attachments[0].blocks[0].text.text.includes(
        'log source "example-staging/service" could not be run:'
      )
    )
  })

  // The warning used to carry only the last status, so a query AWS kept queued
  // could not be told apart from one abandoned after a single poll.
  it('warns about a failed SSM session audit with how long it polled', async () => {
    process.env.LOG_SOURCES_JSON = JSON.stringify({
      'ssm-sessions': {
        log_group_names: ['/aws/events/example-ssm-sessions'],
        log_group_name_prefixes: [],
        format: 'ssm-session-audit',
        throw_site_package_prefix: '',
        extra_noise_filters: []
      }
    })
    cloudwatchLogsStub.getQueryResultsResponses = [
      { status: 'Failed', results: null, statistics: null }
    ]
    const originalWarn = console.warn
    console.warn = () => {}
    const { handler } = await freshModule()

    try {
      await handler({ source: 'aws.events' }, context)
    } finally {
      console.warn = originalWarn
    }

    assert.equal(posted.length, 1)
    assert.match(
      posted[0].attachments[0].blocks[0].text.text,
      /SSM session audit for "ssm-sessions" failed after 1 attempts in \d+ms \(last status: Failed\)/
    )
  })

  // A log group younger than the query window (just applied) makes StartQuery
  // reject the query outright. That window holds no data, so it must be silent,
  // not a page in every account for the first few minutes after rollout.
  it('stays silent when the log group is too new for the query window', async () => {
    process.env.LOG_SOURCES_JSON = JSON.stringify({
      'ssm-sessions': {
        log_group_names: ['/aws/events/example-ssm-sessions'],
        log_group_name_prefixes: [],
        format: 'ssm-session-audit',
        throw_site_package_prefix: '',
        extra_noise_filters: []
      }
    })
    cloudwatchLogsStub.startQueryError = Object.assign(
      new Error(
        "Query's end date and time is either before the log groups creation " +
          'time or exceeds the log groups log retention settings ([0,93])'
      ),
      { name: 'MalformedQueryException' }
    )
    const { handler } = await freshModule()

    await handler({ source: 'aws.events' }, context)

    assert.equal(posted.length, 0)
  })
})
