// SNS message handler: a standard CloudWatch alarm state change. Formats the
// alarm into a Slack card with a deep link. Matched by the presence of
// AlarmName in the parsed message.

import { buildAlarmConsoleUrl, formatTimestamp } from '../lib.mjs'

export function buildAlarmPayload(message, region, partition = 'aws') {
  const alarmName = message.AlarmName ?? 'Unknown alarm'
  const newState = message.NewStateValue ?? 'UNKNOWN'
  const reason = message.NewStateReason ?? ''
  const description = message.AlarmDescription ?? ''
  const timestamp = message.StateChangeTime ?? ''

  const color = newState === 'ALARM' ? '#d32f2f' : '#4caf50'
  const emoji = newState === 'ALARM' ? ':red_circle:' : ':large_green_circle:'

  const consoleUrl = buildAlarmConsoleUrl(alarmName, region, partition)

  // Headline: prefer a human-readable AlarmDescription (e.g. "Backup failed in
  // evaka-staging"); otherwise fall back to the technical alarm name and state.
  // When a description is shown as the headline it is not repeated as a field.
  // An OK transition prefixes "Recovered:" so the description still reads right
  // with a green circle; an unexpected state keeps the state in parentheses.
  let headline
  if (!description) {
    headline = `${emoji} *${alarmName}* is now *${newState}*`
  } else if (newState === 'ALARM') {
    headline = `${emoji} *${description}*`
  } else if (newState === 'OK') {
    headline = `${emoji} *Recovered: ${description}*`
  } else {
    headline = `${emoji} *${description}* (${newState})`
  }

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: headline
      }
    }
  ]

  const fields = []
  if (reason) {
    const shortReason =
      reason.length > 300 ? reason.slice(0, 300) + '...' : reason
    fields.push({ type: 'mrkdwn', text: `*Reason:*\n${shortReason}` })
  }
  if (timestamp) {
    fields.push({
      type: 'mrkdwn',
      text: `*Time:*\n${formatTimestamp(timestamp)}`
    })
  }

  if (fields.length > 0) {
    blocks.push({ type: 'section', fields })
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `<${consoleUrl}|:mag: View in CloudWatch>`
    }
  })

  return { attachments: [{ color, blocks }] }
}

export default {
  name: 'alarm',
  matches: (parsed) =>
    parsed !== null && typeof parsed === 'object' && Boolean(parsed.AlarmName),
  build: ({ parsed }, { region, partition }) =>
    buildAlarmPayload(parsed, region, partition)
}
