// Log subscription handler: CloudTrail records, as an organization trail delivers
// them to CloudWatch Logs, matched against RULES and posted one message per batch.

import {
  REGION,
  postToSlack,
  formatTimestamp,
  buildLogInsightsUrl
} from '../lib.mjs'

const MAX_GROUPS_SHOWN = 10
// Event ids in the Logs Insights link; enough to cover a typical batch while
// keeping the URL a reasonable length.
const MAX_LINKED_EVENT_IDS = 50

const bySource = (eventsBySource) => (event) =>
  eventsBySource[event.eventSource]?.includes(event.eventName) ?? false

const ADMINISTRATOR_ATTACH_EVENTS = [
  'AttachUserPolicy',
  'AttachRolePolicy',
  'AttachGroupPolicy'
]

// An event is reported under the first rule it matches, so the order sets which
// title a root user creating an access key, say, is shown with.
export const RULES = [
  {
    key: 'root-usage',
    title: 'Root user used',
    matches: (event) =>
      event.userIdentity?.type === 'Root' &&
      !event.userIdentity?.invokedBy &&
      event.eventType !== 'AwsServiceEvent'
  },
  {
    key: 'console-login-without-mfa',
    title: 'Console sign-in without MFA',
    // IAM users only: an Identity Center sign-in is logged as AssumedRole with
    // MFAUsed unset, whether or not MFA was used.
    matches: (event) =>
      event.eventName === 'ConsoleLogin' &&
      event.userIdentity?.type === 'IAMUser' &&
      event.additionalEventData?.MFAUsed !== 'Yes' &&
      event.responseElements?.ConsoleLogin === 'Success'
  },
  {
    key: 'iam-user-or-access-key-created',
    title: 'IAM user, access key or console password created',
    // No errorCode condition: an attempt an SCP denies is as much a reason to
    // alert as one that succeeds.
    matches: bySource({
      'iam.amazonaws.com': [
        'CreateUser',
        'CreateAccessKey',
        'CreateLoginProfile'
      ]
    })
  },
  {
    key: 'administrator-access-attached',
    title: 'AdministratorAccess attached',
    matches: (event) =>
      event.eventSource === 'iam.amazonaws.com' &&
      ADMINISTRATOR_ATTACH_EVENTS.includes(event.eventName) &&
      (event.requestParameters?.policyArn ?? '').endsWith(
        ':policy/AdministratorAccess'
      )
  },
  {
    key: 'security-service-disabled',
    title: 'Security logging or detection turned off',
    matches: bySource({
      'cloudtrail.amazonaws.com': [
        'StopLogging',
        'DeleteTrail',
        'UpdateTrail',
        'PutEventSelectors'
      ],
      'guardduty.amazonaws.com': [
        'DeleteDetector',
        'UpdateDetector',
        'DisassociateFromAdministratorAccount',
        'DisassociateMembers',
        'DeleteMembers',
        'DisableOrganizationAdminAccount'
      ],
      'securityhub.amazonaws.com': [
        'DisableSecurityHub',
        'DisassociateFromAdministratorAccount',
        'DisassociateMembers',
        'DeleteMembers',
        'BatchDisableStandards',
        'DisableOrganizationAdminAccount',
        'DeleteConfigurationPolicy',
        'StartConfigurationPolicyDisassociation'
      ],
      'config.amazonaws.com': [
        'StopConfigurationRecorder',
        'DeleteConfigurationRecorder',
        'DeleteDeliveryChannel',
        'PutConfigurationRecorder'
      ],
      // Detaches a service from the organization without touching it in any
      // member account.
      'organizations.amazonaws.com': [
        'DisableAWSServiceAccess',
        'RegisterDelegatedAdministrator',
        'DeregisterDelegatedAdministrator'
      ]
    })
  },
  {
    key: 'kms-key-deletion-scheduled',
    title: 'KMS key scheduled for deletion or disabled',
    matches: bySource({
      'kms.amazonaws.com': ['ScheduleKeyDeletion', 'DisableKey']
    })
  },
  {
    key: 'organizations-changed',
    title: 'Organization accounts, OUs or policies changed',
    matches: bySource({
      'organizations.amazonaws.com': [
        'AcceptHandshake',
        'AttachPolicy',
        'CreateAccount',
        'CloseAccount',
        'CreateOrganizationalUnit',
        'CreatePolicy',
        'DeleteOrganization',
        'DeleteOrganizationalUnit',
        'DeletePolicy',
        'DetachPolicy',
        'DisablePolicyType',
        'EnablePolicyType',
        'InviteAccountToOrganization',
        'LeaveOrganization',
        'MoveAccount',
        'RemoveAccountFromOrganization',
        'UpdatePolicy',
        'UpdateOrganizationalUnit'
      ]
    })
  },
  {
    key: 'identity-center-changed',
    title: 'Identity Center access changed',
    // Changes made through the API log under identitystore, the same changes
    // made in the console under sso-directory.
    matches: bySource({
      'sso.amazonaws.com': [
        'CreatePermissionSet',
        'DeletePermissionSet',
        'UpdatePermissionSet',
        'AttachManagedPolicyToPermissionSet',
        'DetachManagedPolicyFromPermissionSet',
        'PutInlinePolicyToPermissionSet',
        'AttachCustomerManagedPolicyReferenceToPermissionSet',
        'PutPermissionsBoundaryToPermissionSet',
        'CreateAccountAssignment',
        'DeleteAccountAssignment',
        'UpdateInstance',
        'DeleteInstance'
      ],
      'identitystore.amazonaws.com': [
        'CreateUser',
        'UpdateUser',
        'DeleteUser',
        'CreateGroup',
        'UpdateGroup',
        'DeleteGroup',
        'CreateGroupMembership',
        'DeleteGroupMembership'
      ],
      'sso-directory.amazonaws.com': [
        'CreateUser',
        'UpdateUser',
        'DeleteUser',
        'EnableUser',
        'DisableUser',
        'UpdatePassword',
        'CreateGroup',
        'UpdateGroup',
        'DeleteGroup',
        'AddMemberToGroup',
        'RemoveMemberFromGroup',
        'DeleteMfaDeviceForUser',
        'UpdateMfaDeviceForUser',
        'PutMfaDeviceManagementForDirectory',
        'CreateExternalIdPConfigurationForDirectory',
        'UpdateExternalIdPConfigurationForDirectory',
        'DeleteExternalIdPConfigurationForDirectory',
        'EnableExternalIdPConfigurationForDirectory',
        'DisableExternalIdPConfigurationForDirectory'
      ]
    })
  }
]

export function matchRule(event) {
  return RULES.find((rule) => rule.matches(event)) ?? null
}

export function formatPrincipal(identity) {
  switch (identity?.type) {
    case 'Root':
      return 'root'
    case 'IAMUser':
      return `IAM user ${identity.userName}`
    case 'AssumedRole': {
      const arn = identity.arn ?? ''
      const assumed = arn.match(/:assumed-role\/([^/]+)\/(.+)$/)
      if (!assumed) return arn || 'unknown role'
      const [, role, session] = assumed
      const permissionSet = role.match(/^AWSReservedSSO_(.+)_[0-9a-f]{16}$/)
      return permissionSet
        ? `${session} (${permissionSet[1]})`
        : `${role}/${session}`
    }
    case 'AWSService':
      return identity.invokedBy ?? 'AWS service'
    default:
      return (
        identity?.userName ??
        identity?.arn ??
        identity?.principalId ??
        identity?.type ??
        'unknown'
      )
  }
}

// One group per rule, account and principal, so an apply's dozens of calls read
// as one line with counts.
export function groupMatches(records, accountNames = {}) {
  const groups = new Map()
  for (const { record, timestamp } of records) {
    const rule = matchRule(record)
    if (!rule) continue

    const accountId =
      record.recipientAccountId ?? record.userIdentity?.accountId ?? 'unknown'
    const principal = formatPrincipal(record.userIdentity)
    const key = `${rule.key}|${accountId}|${principal}`

    let group = groups.get(key)
    if (!group) {
      group = {
        rule,
        account: accountNames[accountId] ?? accountId,
        principal,
        eventNames: new Map(),
        errorCodes: new Map(),
        eventIds: [],
        firstTimestamp: timestamp
      }
      groups.set(key, group)
    }
    group.eventNames.set(
      record.eventName,
      (group.eventNames.get(record.eventName) ?? 0) + 1
    )
    if (record.errorCode) {
      group.errorCodes.set(
        record.errorCode,
        (group.errorCodes.get(record.errorCode) ?? 0) + 1
      )
    }
    if (record.eventID) group.eventIds.push(record.eventID)
    group.firstTimestamp = Math.min(group.firstTimestamp, timestamp)
  }
  return [...groups.values()]
}

function formatCounts(counts) {
  return [...counts]
    .map(([name, count]) =>
      count > 1 ? `\`${name}\` ×${count}` : `\`${name}\``
    )
    .join(', ')
}

function formatGroup(group) {
  const time = formatTimestamp(new Date(group.firstTimestamp).toISOString())
  const failed =
    group.errorCodes.size > 0
      ? ` · failed: ${formatCounts(group.errorCodes)}`
      : ''
  return (
    `:rotating_light: *${group.rule.title}* in *${group.account}*\n` +
    `${formatCounts(group.eventNames)} by \`${group.principal}\` at ${time}${failed}`
  )
}

export function buildEventsQuery(eventIds) {
  const ids = eventIds.map((id) => JSON.stringify(id)).join(', ')
  return [
    'fields @timestamp, recipientAccountId, userIdentity.arn, eventSource, eventName, errorCode, sourceIPAddress',
    `filter eventID in [${ids}]`,
    'sort @timestamp asc'
  ].join('\n| ')
}

export function buildCloudTrailPayload(
  groups,
  { logGroup, region = REGION, partition = 'aws' }
) {
  const shown = groups.slice(0, MAX_GROUPS_SHOWN)
  const blocks = shown.map((group) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: formatGroup(group) }
  }))

  if (groups.length > shown.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_...and ${groups.length - shown.length} more not shown_`
      }
    })
  }

  const eventIds = groups
    .flatMap((group) => group.eventIds)
    .slice(0, MAX_LINKED_EVENT_IDS)
  if (logGroup && eventIds.length > 0) {
    const timestamps = groups.map((group) => group.firstTimestamp)
    const startTime = Math.floor(Math.min(...timestamps) / 1000) - 60
    // An hour past the earliest event covers the rest of a batch, whose events
    // all arrived in the same delivery.
    const endTime = startTime + 3600
    const url = buildLogInsightsUrl(
      buildEventsQuery(eventIds),
      [logGroup],
      startTime,
      endTime,
      region,
      partition
    )
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${url}|:mag: View in CloudWatch Logs>` }
    })
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Expected when it was you or your Terraform apply. Otherwise, investigate.'
      }
    ]
  })

  return { attachments: [{ color: '#d32f2f', blocks }] }
}

function parseRecords(logEvents) {
  return logEvents.flatMap((logEvent) => {
    try {
      return [
        { record: JSON.parse(logEvent.message), timestamp: logEvent.timestamp }
      ]
    } catch {
      console.warn(`Skipping a log event that is not JSON: ${logEvent.id}`)
      return []
    }
  })
}

// Errors propagate on purpose: a failed invocation is retried by Lambda's async
// retry, which a caught error would cancel.
async function handle(batch, subscription, partition) {
  const groups = groupMatches(
    parseRecords(batch.logEvents ?? []),
    subscription.account_names
  )
  if (groups.length === 0) return

  const payload = buildCloudTrailPayload(groups, {
    logGroup: batch.logGroup,
    region: REGION,
    partition
  })
  await postToSlack(payload, subscription.channel)
}

export default {
  name: 'cloudtrail',
  formats: ['cloudtrail'],
  handle
}
