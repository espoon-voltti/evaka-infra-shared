# slack-notifier

Forwards CloudWatch alarm state changes and application log errors to Slack.

## What it creates

- An AWS Lambda function (`<name_prefix>-slack-notifier`, Node.js 24).
- An IAM role for the lambda with least-privilege access to the configured
  log groups, the Slack-webhook SSM parameter, and (optionally) the KMS key
  that encrypts it.
- An SNS subscription from `var.alarm_sns_topic_arn` to the lambda, so alarm
  state changes are formatted and posted to Slack. The alarm's
  `alarm_description` becomes the Slack **headline** (prefixed with `Recovered:`
  on the OK transition); alarms without a description fall back to
  `<alarm-name> is now <STATE>`. Console deep-links resolve in both the standard
  `aws` partition and AWS European Sovereign Cloud (`aws-eusc`).
- An EventBridge schedule (`cron(2/5 * * * ? *)`) that triggers the lambda to
  scan recent log entries and post any errors found — **only when
  `log_group_names` or `log_sources` is non-empty**. Each configured source
  (the fixed `log_group_names` scan, plus one per `log_sources` entry) runs
  its own Insights query and posts its own Slack message. The scans run
  concurrently, and a scan that fails outright — a denied query, more log
  groups than one query accepts — posts a warning rather than staying quiet,
  so a broken source is not mistaken for a clean one.
- Optional CloudWatch **metric alarms** (`var.metric_alarms`, plus a built-in
  backup-failed alarm via `var.backup_failed_alarm_enabled`) wired to
  `var.alarm_sns_topic_arn`, so metric breaches are forwarded to Slack through
  the same alarm path. No lambda change is needed — the lambda formats any
  standard CloudWatch alarm message.

The Slack webhook URL itself is not in Terraform state, environment
variables, or the lambda zip — only the **name** of the SSM parameter holding
it is. The consumer creates and populates the parameter out-of-band.

## What lands on the topic

Anything published to `alarm_sns_topic_arn` is forwarded, and the lambda picks
its format from the payload:

- A **CloudWatch alarm** notification (a JSON object with `AlarmName`) is
  rendered with its state colour, reason, time and a console deep-link.
- **Anything else** — a plain string or a JSON object without `AlarmName` — is
  rendered as a neutral notification. This is what lets an EventBridge rule
  publish straight to the topic for things that have no metric to alarm on
  (an SSM session starting, a GuardDuty malware finding), using an input
  transformer to turn the event into a readable sentence.

## Usage

```hcl
module "slack_notifier" {
  count  = var.slack_notifier_enabled ? 1 : 0
  source = "git::https://github.com/espoon-voltti/evaka-infra-shared.git//modules/slack-notifier?ref=v1&depth=1"

  name_prefix            = "${var.project}-${var.environment}"
  account_id             = var.account_id
  alarm_sns_topic_arn    = aws_sns_topic.alarm_topic.arn
  slack_webhook_ssm_name = aws_ssm_parameter.slack_webhook_url.name
  slack_webhook_kms_arn  = aws_kms_key.encryption.arn
  log_group_names = [
    "${var.project}-service-${var.environment}",
    "${var.project}-apigw-${var.environment}",
    "${var.project}-proxy-${var.environment}",
  ]

  # The built-in backup-failed alarm is enabled by default (set
  # backup_failed_alarm_enabled = false to opt out).

  # Additional custom metric alarms
  metric_alarms = {
    apigw-5xx = {
      namespace   = "AWS/ApiGateway"
      metric_name = "5XXError"
      dimensions  = { ApiName = "${var.project}-${var.environment}" }
    }
  }
}
```

### Generalized log scanning (`log_sources`)

`log_group_names` runs a fixed query written for eVaka's own Logback field
names (`loggerName`, `logLevel`, `at evaka.` stack frames). `log_sources`
scans other applications' log groups with their own field names, one Insights
query per source, independent of and additive to `log_group_names`:

```hcl
log_sources = {
  service = {
    log_group_name_prefixes   = ["/aws/ecs/${var.name_prefix}/service"]
    format                    = "logback-json"
    throw_site_package_prefix = "fi.espoo.oppivelvollisuus"
  }
  api-gateway = {
    log_group_name_prefixes = ["/aws/ecs/${var.name_prefix}/api-gateway"]
    format                  = "pino-json"
  }
}
```

- `format` selects a built-in field mapping: `"logback-json"` for a
  Logback/`logstash-logback-encoder` service (the same convention eVaka
  itself uses, just not hardcoded to eVaka's own field values), `"pino-json"`
  for a pino-based Node service. `"pino-json"` expects the Voltti api-gateway
  logger setup (`messageKey: 'message'`, a string `level` label, `appName` in
  the logger's base fields); its error entries carry no request context, so
  their Slack lines and the `endpoint` column show the logger name rather than
  a `METHOD /path`.
- `log_group_name_prefixes` grants `logs:StartQuery` on a prefix-wildcarded ARN
  and has the lambda resolve actual log group names via `DescribeLogGroups` at
  invocation time, so a source can be wired up before the log groups it will
  match exist, and it picks up new ones with no redeploy. `log_group_names`
  grants on exact ARNs, for log groups already known at apply time. At least one
  of the two is required per source. Note that using any prefix also grants
  `logs:DescribeLogGroups` account-wide, because that call authorizes against an
  empty log-group name and cannot be scoped by prefix; it exposes log group
  metadata only, not log content.
- Scope each prefix to **one component**, not to the whole deployment. A source
  applies its single `format` to every log group it resolves, and the ECS
  convention `/aws/ecs/<name_prefix>/<container>` puts a Kotlin service, a pino
  api-gateway and an nginx frontend under one shared prefix. A log group whose
  entries don't match the source's `format` fails the error-level filter
  silently, so over-broad prefixes lose errors rather than reporting bogus ones.
- `throw_site_package_prefix` (e.g. `"fi.espoo.vakaseteli"`) replaces eVaka's
  hardcoded `at evaka.` stack-frame matching for both the throw-site deep-link
  line and the `AsyncJobPool` retry-in-progress noise mute, which is derived
  automatically from it. Omit it to skip both. The derived mute assumes the
  app's pool logs under `<prefix>.shared.asyncjob.AsyncJobPool.<pool id>` with
  a `meta.remainingAttempts` field — check the app's `AsyncJobPool` before
  relying on it, since a mute that matches nothing is invisible. Only
  `"logback-json"` derives it.
- `extra_noise_filters` is a list of raw Insights `filter` lines, appended to
  the query verbatim, for noise rules specific to one app that don't fit the
  shared pattern above.
- Each source's Slack messages are labelled `[<source name>]`, e.g. `[service]`
  — except when the source resolves to exactly one log group matching the
  `/aws/ecs/<name>/<component>` convention, where the label becomes
  `[<name>/<source name>]` (e.g. `[oppivelvollisuus-esc-staging/service]`).
  This distinguishes projects/environments sharing one Lambda and Slack
  channel (an account can host several — see "One channel per account" in
  `modules/baseline`) using the log group's own name rather than
  `name_prefix`, which is this Lambda's own account-level name and can differ
  from the environment that actually owns the log group.

### Metric alarms and region

`metric_alarms` and the built-in backup alarm are created in the **provider
region** of the module call, and the alarm/SNS topic must be in that same
region. CloudWatch metrics are per-region: e.g. AWS Backup publishes
`NumberOfBackupJobsFailed` in each region where a backup (or copy) job runs, so
an alarm only covers jobs in its own region. Scope to a vault with
`backup_failed_alarm_dimensions = { BackupVaultName = "..." }` if the
account-level (empty-dimension) metric does not report data.

## Inputs

| Name                             | Type           | Required | Default | Description                                                                                                                                                                                                                                                        |
| -------------------------------- | -------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name_prefix`                    | `string`       | yes      | —       | Prefix for the lambda function, IAM role, and EventBridge rule. Example: `"evakaturku-prod"`.                                                                                                                                                                      |
| `account_id`                     | `string`       | yes      | —       | AWS account ID, used for IAM resource ARNs.                                                                                                                                                                                                                        |
| `alarm_sns_topic_arn`            | `string`       | yes      | —       | SNS topic the lambda subscribes to for alarm state changes.                                                                                                                                                                                                        |
| `slack_webhook_ssm_name`         | `string`       | yes      | —       | Name of the SecureString SSM parameter holding the Slack webhook URL.                                                                                                                                                                                              |
| `slack_channel`                  | `string`       | no       | `null`  | Slack channel to post to (e.g. `"#alerts"`), overriding the webhook's own default channel. Needed only where the webhook is shared with other channels rather than dedicated to this deployment.                                                                   |
| `slack_webhook_kms_arn`          | `string`       | no       | `""`    | KMS key ARN. Leave empty if the SSM parameter is encrypted with `aws/ssm`.                                                                                                                                                                                         |
| `log_group_names`                | `list(string)` | no       | `[]`    | CloudWatch log groups to scan and to use for trace-id deep-links. Empty turns the scheduled scan off entirely (no schedule, no Insights grants), leaving an alarm-forwarder-only deployment. The query is eVaka-specific, so other consumers normally want it off. |
| `log_sources`                    | `map(object)`  | no       | `{}`    | Additional, per-source log scans for other applications' field-name conventions. See [Generalized log scanning](#generalized-log-scanning-log_sources).                                                                                                            |
| `log_query_seconds`              | `number`       | no       | `300`   | Sliding window for the log-error scan (`log_group_names` and every `log_sources` entry). The 5-minute schedule is hardcoded and assumes this cadence.                                                                                                              |
| `metric_alarms`                  | `map(object)`  | no       | `{}`    | CloudWatch metric alarms to create, keyed by alarm-name suffix. Routed to `alarm_sns_topic_arn`. Per-alarm `notify_on_ok` (default `true`) controls whether the green "recovered" message is sent. See variable for fields/defaults.                               |
| `backup_failed_alarm_enabled`    | `bool`         | no       | `true`  | Create a built-in `backup-failed` alarm (AWS/Backup `NumberOfBackupJobsFailed`, Sum over 1h > 0). On by default; auto-skipped when `alarm_sns_topic_arn` is null. Set `false` to opt out.                                                                          |
| `backup_failed_alarm_dimensions` | `map(string)`  | no       | `{}`    | Dimensions for the built-in backup alarm. Empty = account/region-level; set `{ BackupVaultName = "..." }` to scope to a vault.                                                                                                                                     |

When `metric_alarms` is non-empty, `alarm_sns_topic_arn` must be set (enforced
by a precondition). The built-in backup alarm instead self-skips when the topic
is null, so a default-on alarm never breaks a topic-less (log-scan-only)
consumer.

## Outputs

| Name                   | Description                                   |
| ---------------------- | --------------------------------------------- |
| `lambda_function_arn`  | ARN of the slack-notifier lambda.             |
| `lambda_function_name` | Name of the lambda.                           |
| `metric_alarm_arns`    | Map of metric-alarm key to created alarm ARN. |
