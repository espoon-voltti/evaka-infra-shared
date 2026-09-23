variable "name_prefix" {
  description = "Prefix for the lambda function, IAM role, EventBridge rule, and CloudWatch log group ARNs (e.g. \"evakaturku-prod\"). Avoids collisions when multiple stacks land in the same AWS account."
  type        = string
}

variable "account_id" {
  description = "AWS account ID, used for IAM resource ARNs."
  type        = string
}

variable "alarm_sns_topic_arn" {
  description = "SNS topic the lambda subscribes to for alarm-state-change notifications. Omit to disable SNS-triggered alarm forwarding."
  type        = string
  default     = null
}

variable "slack_webhook_ssm_name" {
  description = "Name of the SecureString SSM parameter holding the Slack webhook URL. Consumer creates and populates it."
  type        = string
}

variable "slack_channel" {
  description = "Slack channel to post to (e.g. \"#alerts\"), overriding the webhook's own default channel. Needed only where slack_webhook_ssm_name points at a webhook shared with other channels rather than one dedicated to this deployment."
  type        = string
  default     = null
}

variable "slack_username" {
  description = "Sender name shown on the Slack messages, overriding the webhook's own default. Set to null to keep the webhook's own name instead. Honored only by legacy incoming webhooks (the same ones slack_channel needs)."
  type        = string
  default     = "Alert System"
}

variable "slack_webhook_kms_arn" {
  description = "KMS key ARN for SSM decrypt. Empty means the SSM parameter is encrypted with the AWS-managed aws/ssm key, in which case no kms:Decrypt grant is created."
  type        = string
  default     = ""
}

variable "log_group_names" {
  description = <<-EOT
    CloudWatch log groups the lambda scans for errors and uses for trace-id deep-links.
    Empty turns the scheduled log scan off entirely — no EventBridge schedule and no
    logs:StartQuery grant — leaving an alarm-forwarder-only deployment. The query
    itself is eVaka-specific (loggerName filters, `at evaka.` stack frames), so other
    consumers normally want it off.
  EOT
  type        = list(string)
  default     = []
}

variable "log_sources" {
  description = <<-EOT
    Additional log sources for the scheduled error scan, keyed by an arbitrary
    short name used to label its Slack messages (e.g. "service", "api-gateway").
    Independent of and additive to log_group_names: each source runs its own
    Insights query, since `format` selects a different field mapping per source
    rather than the fixed eVaka one log_group_names uses.

    log_group_name_prefixes grants logs:StartQuery/DescribeLogGroups on a
    wildcarded ARN and has the lambda call DescribeLogGroups at invocation time
    to resolve actual log group names, so a source can be wired up before the
    log groups it will match exist, and picks up new ones with no redeploy.
    log_group_names grants on exact ARNs, for log groups known at apply time.
    At least one of the two must be set.
  EOT
  type = map(object({
    log_group_names           = optional(list(string), [])
    log_group_name_prefixes   = optional(list(string), [])
    format                    = string
    throw_site_package_prefix = optional(string, "")
    extra_noise_filters       = optional(list(string), [])
  }))
  default = {}

  validation {
    condition     = alltrue([for s in var.log_sources : contains(["logback-json", "pino-json", "ssm-session-audit"], s.format)])
    error_message = "log_sources[*].format must be \"logback-json\", \"pino-json\" or \"ssm-session-audit\"."
  }

  validation {
    condition     = alltrue([for s in var.log_sources : length(s.log_group_names) > 0 || length(s.log_group_name_prefixes) > 0])
    error_message = "Each log_sources entry needs at least one of log_group_names or log_group_name_prefixes."
  }
}

variable "log_query_seconds" {
  description = "Sliding window length for the log-error scan (seconds). The 5-minute EventBridge schedule is hardcoded; the lambda's overlap and CloudWatch-indexing-delay constants assume that cadence."
  type        = number
  default     = 300
}

variable "metric_alarms" {
  description = <<-EOT
    CloudWatch metric alarms to create, keyed by a short name (used as the alarm-name suffix after name_prefix). Each alarm routes its ALARM/OK transitions to alarm_sns_topic_arn, which the lambda forwards to Slack — so alarm_sns_topic_arn must be set when this is non-empty. Mirrors the relevant aws_cloudwatch_metric_alarm arguments; defaults suit a "Sum over 1h > 0" failure-count alarm. Set notify_on_ok = false to suppress the green "recovered" Slack message (the alarm still transitions OK internally and re-fires on the next breach) — appropriate for one-off "something failed" alarms.
  EOT
  type = map(object({
    namespace           = string
    metric_name         = string
    comparison_operator = optional(string, "GreaterThanThreshold")
    threshold           = optional(number, 0)
    statistic           = optional(string, "Sum")
    period              = optional(number, 3600)
    evaluation_periods  = optional(number, 1)
    datapoints_to_alarm = optional(number, null)
    treat_missing_data  = optional(string, "notBreaching")
    dimensions          = optional(map(string), {})
    alarm_description   = optional(string, "")
    notify_on_ok        = optional(bool, true)
  }))
  default = {}
}

variable "backup_failed_alarm_enabled" {
  description = "Create the built-in 'backup-failed' metric alarm (AWS/Backup NumberOfBackupJobsFailed, Sum over 1h > 0) and route it to Slack, replacing the central Datadog 'AWS-backup failed' monitor per account. Enabled by default; automatically skipped when alarm_sns_topic_arn is null (no destination to route to). Set to false to opt out."
  type        = bool
  default     = true
}

variable "backup_failed_alarm_dimensions" {
  description = "Dimensions for the built-in backup-failed alarm. Empty watches the account/region-level AWS/Backup metric; set { BackupVaultName = \"...\" } to scope to one vault. NOTE: AWS Backup publishes NumberOfBackupJobsFailed per BackupVaultName — verify the empty-dimension metric reports data in this account/region, otherwise scope to a vault."
  type        = map(string)
  default     = {}
}
