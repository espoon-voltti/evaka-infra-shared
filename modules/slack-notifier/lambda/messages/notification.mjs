// SNS message handler: anything on the alarm topic that is not a CloudWatch
// alarm — an EventBridge rule can publish directly (e.g. a malware finding),
// usually an input-transformed sentence rather than an object. The fallback, so
// it must be last in the registry and match everything.

// Slack rejects a section over 3000 characters, and an unbounded event payload
// would otherwise silently fail the whole post.
const MAX_SECTION_LENGTH = 2900

export function buildNotificationPayload(text, subject) {
  const body = (text ?? '').trim() || 'Notification with no message body'
  const truncated =
    body.length > MAX_SECTION_LENGTH
      ? body.slice(0, MAX_SECTION_LENGTH) + '...'
      : body

  const blocks = []
  if (subject) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:bell: *${subject}*` }
    })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncated } })
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:bell: ${truncated}` }
    })
  }

  return { attachments: [{ color: '#ff9800', blocks }] }
}

export default {
  name: 'notification',
  matches: () => true,
  build: ({ parsed, raw, subject }) =>
    buildNotificationPayload(typeof parsed === 'string' ? parsed : raw, subject)
}
