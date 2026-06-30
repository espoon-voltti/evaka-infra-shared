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

variable "slack_webhook_kms_arn" {
  description = "KMS key ARN for SSM decrypt. Empty means the SSM parameter is encrypted with the AWS-managed aws/ssm key, in which case no kms:Decrypt grant is created."
  type        = string
  default     = ""
}

variable "log_group_names" {
  description = "CloudWatch log groups the lambda scans for errors and uses for trace-id deep-links."
  type        = list(string)
}

variable "log_query_seconds" {
  description = "Sliding window length for the log-error scan (seconds). The EventBridge schedule rate(5 minutes) is hardcoded; the lambda's overlap and CloudWatch-indexing-delay constants assume that cadence."
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
  description = "Create a built-in 'backup-failed' metric alarm (AWS/Backup NumberOfBackupJobsFailed, Sum over 1h > 0) routed to Slack. Replaces the central Datadog 'AWS-backup failed' monitor on a per-account basis. Requires alarm_sns_topic_arn."
  type        = bool
  default     = false
}

variable "backup_failed_alarm_dimensions" {
  description = "Dimensions for the built-in backup-failed alarm. Empty watches the account/region-level AWS/Backup metric; set { BackupVaultName = \"...\" } to scope to one vault. NOTE: AWS Backup publishes NumberOfBackupJobsFailed per BackupVaultName — verify the empty-dimension metric reports data in this account/region, otherwise scope to a vault."
  type        = map(string)
  default     = {}
}
