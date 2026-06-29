import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { ssmStub } from './stub-ssm.mjs'

// Set AWS_REGION before importing the module to avoid side-effect issues
// and to get deterministic URLs in buildLogInsightsUrl tests.
process.env.AWS_REGION = 'eu-west-1'

const {
  formatTimestamp,
  extractThrowSite,
  buildLogInsightsUrl,
  buildAlarmPayload,
  resolveMatchedCount,
  formatErrorCount,
  formatRemainder
} = await import('./slack_notifier.mjs')

// The webhook cache is module-scope state. Each caching test needs a pristine
// module instance; a unique query string forces a fresh evaluation.
let moduleLoadCount = 0
function freshModule() {
  return import(`./slack_notifier.mjs?case=${moduleLoadCount++}`)
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
        AlarmDescription: 'Backup failed in evaka-staging',
        NewStateReason: 'Threshold exceeded',
        StateChangeTime: '2024-01-15T14:30:00Z'
      },
      'eu-west-1'
    )
    // The description becomes the headline (not the technical "name is now STATE").
    const headline = payload.attachments[0].blocks[0].text.text
    assert.ok(headline.includes('Backup failed in evaka-staging'))
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
        AlarmDescription: 'Backup failed in evaka-staging'
      },
      'eu-west-1'
    )
    const headline = payload.attachments[0].blocks[0].text.text
    assert.ok(headline.includes(':large_green_circle:'))
    assert.ok(headline.includes('Recovered: Backup failed in evaka-staging'))
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
    const { postToSlack } = await freshModule()
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
    const { postToSlack } = await freshModule()
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
    const { postToSlack } = await freshModule()
    ssmStub.parameterValue = 'https://hooks.slack.com/services/OK'
    globalThis.fetch = async () => ({ ok: true, status: 200 })

    await postToSlack({ text: 'hi' })
    await postToSlack({ text: 'hi' })

    assert.equal(ssmStub.getParameterCalls, 1)
  })

  it('recovers without a restart after the SSM value is fixed', async () => {
    const { postToSlack } = await freshModule()
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
    const { getSlackWebhookUrl } = await freshModule()
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
