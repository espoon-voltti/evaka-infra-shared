variable "name_prefix" {
  description = "Prefix for the bucket, the lambda functions, their IAM roles, and the EventBridge rule (e.g. \"evaka-staging\")."
  type        = string
}

variable "account_id" {
  description = "AWS account ID, used for IAM resource ARNs."
  type        = string
}

variable "service_log_group_name" {
  description = "Log group of the eVaka service. The collector counts its lines with Logs Insights."
  type        = string
}

variable "apigw_log_group_name" {
  description = "Log group of the eVaka API gateway. Null leaves out its series."
  type        = string
  default     = null
}

variable "proxy_log_group_name" {
  description = "Log group of the eVaka nginx proxy. Null leaves out its series."
  type        = string
  default     = null
}

variable "rds_instance_identifier" {
  description = "DBInstanceIdentifier of the eVaka database, for the AWS/RDS metrics."
  type        = string
}

variable "token_ssm_name" {
  description = "Name of the SecureString SSM parameter that holds the bearer token of the read lambda. The consumer creates and populates it."
  type        = string
}

variable "token_kms_arn" {
  description = "KMS key ARN for SSM decrypt. Empty means the SSM parameter is encrypted with the AWS-managed aws/ssm key, in which case no kms:Decrypt grant is created."
  type        = string
  default     = ""
}

variable "allowed_origins" {
  description = "Origins of the tracker page, for the CORS config of the Function URL and of the bucket (e.g. [\"https://espoon-voltti.github.io\"])."
  type        = list(string)
}

variable "bucket_kms_arn" {
  description = "Customer-managed KMS key ARN for the bucket. Null encrypts the bucket with SSE-S3 instead."
  type        = string
  default     = null
}

variable "raw_retention_days" {
  description = "Days to keep the 5-minute files."
  type        = number
  default     = 400
}

variable "collector_schedule" {
  description = "EventBridge schedule of the collector. The collector processes the 5-minute buckets that closed at least ingestion_delay_seconds ago, so the schedule must run every 5 minutes, just after that delay."
  type        = string
  default     = "cron(1/5 * * * ? *)"
}

variable "ingestion_delay_seconds" {
  description = "Time to wait after a 5-minute bucket closes before the collector reads it, because log ingestion is not immediate."
  type        = number
  default     = 300
}
