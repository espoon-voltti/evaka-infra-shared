// Scheduled check: list the alarms still in ALARM state, so one that fired days
// ago and was never fixed does not stay buried in the channel history.
// CloudWatch has no re-notify for an alarm that stays red, so this polls instead.
// Only alarms whose alarm actions include the notifier's own SNS topic count: an
// account's other alarms (autoscaling triggers, for one) are red by design.
// Dispatched by the event's `action`, not by a log source's format.

import {
  CloudWatchClient,
  DescribeAlarmsCommand
} from '@aws-sdk/client-cloudwatch'
import {
  REGION,
  postToSlack,
  buildAlarmConsoleUrl,
  formatDateTime,
  formatDuration,
  formatRemainder
} from '../lib.mjs'

// Keeps the section under Slack's 3000-character limit at typical name lengths.
const MAX_LISTED = 25

const cloudwatchClient = new CloudWatchClient({ region: REGION })

function stateSince(alarm) {
  return alarm.StateTransitionedTimestamp ?? alarm.StateUpdatedTimestamp ?? null
}

export async function listActiveAlarms(topicArn) {
  const alarms = []
  let nextToken
  do {
    const response = await cloudwatchClient.send(
      new DescribeAlarmsCommand({
        StateValue: 'ALARM',
        ActionPrefix: topicArn,
        AlarmTypes: ['CompositeAlarm', 'MetricAlarm'],
        NextToken: nextToken
      })
    )
    for (const alarm of [
      ...(response.MetricAlarms ?? []),
      ...(response.CompositeAlarms ?? [])
    ]) {
      // ActionPrefix is a prefix match, so it also passes a topic whose name
      // merely begins with this one's.
      if ((alarm.AlarmActions ?? []).includes(topicArn)) alarms.push(alarm)
    }
    nextToken = response.NextToken
  } while (nextToken)

  const sinceMs = (alarm) => stateSince(alarm)?.getTime?.() ?? Infinity
  return alarms.sort((a, b) => sinceMs(a) - sinceMs(b))
}

export function buildAlarmReminderPayload(
  alarms,
  region,
  partition = 'aws',
  now = new Date()
) {
  const lines = alarms.slice(0, MAX_LISTED).map((alarm) => {
    const url = buildAlarmConsoleUrl(alarm.AlarmName, region, partition)
    const description = alarm.AlarmDescription
      ? ` — ${alarm.AlarmDescription}`
      : ''
    const since = stateSince(alarm)
    const sinceText = since
      ? ` _(since ${formatDateTime(since)}, ${formatDuration(now - since)})_`
      : ''
    return `• <${url}|${alarm.AlarmName}>${description}${sinceText}`
  })
  const remainder = formatRemainder(alarms.length, lines.length)
  if (remainder) lines.push(remainder)

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:red_circle: *${alarms.length} alarm${
          alarms.length === 1 ? '' : 's'
        } still in ALARM state*`
      }
    },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Daily reminder of alarms that fired and have not recovered. Each one needs fixing, or its threshold needs changing.'
        }
      ]
    }
  ]

  return { attachments: [{ color: '#d32f2f', blocks }] }
}

// Returns a summary rather than posting one: a clear account is the normal
// case and a daily "all clear" would be noise, but the result shows in the
// output of a manual invocation.
async function run(partition) {
  const topicArn = process.env.ALARM_SNS_TOPIC_ARN
  if (!topicArn) {
    console.log('No alarm topic configured, no alarms route to Slack')
    return { alarmCount: 0, posted: false }
  }

  const alarms = await listActiveAlarms(topicArn)
  console.log(
    `${alarms.length} alarm(s) in ALARM state with ${topicArn} as an action`
  )
  if (alarms.length === 0) return { alarmCount: 0, posted: false }

  await postToSlack(buildAlarmReminderPayload(alarms, REGION, partition))
  return { alarmCount: alarms.length, posted: true }
}

export default {
  name: 'alarm-reminder',
  action: 'alarm-reminder',
  run
}
