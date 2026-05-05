variable "name_prefix" {
  description = "Prefix for the lambda function, IAM role, EventBridge rule, and CloudWatch log group ARNs (e.g. \"evakaturku-prod\"). Avoids collisions when multiple stacks land in the same AWS account."
  type        = string
}

variable "account_id" {
  description = "AWS account ID, used for IAM resource ARNs."
  type        = string
}

variable "alarm_sns_topic_arn" {
  description = "SNS topic the lambda subscribes to for alarm-state-change notifications."
  type        = string
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
