variable "name_prefix" {
  description = "Prefix for the web ACL, its rules, the IP set and the log group (e.g. \"evakaoulu-prod\"). The web ACL becomes \"<name_prefix>-waf\" and each rule \"<name_prefix>-<rule>\"; rule names are also the CloudWatch metric names, so changing this resets the metric history and renames the alarms."
  type        = string
}

variable "alb_arn" {
  description = "ARN of the public ALB to associate the web ACL with. One ALB per module call: an internal ALB must not get this ACL, whose CAPTCHA actions only a browser can answer."
  type        = string
}

variable "enforce" {
  description = <<-EOT
    Whether the ACL acts on matches. False (the default) puts every rate-limit,
    geo and managed-rule-group rule in COUNT mode: traffic is evaluated, metered
    and logged, but nothing is captchad or blocked. True gives the rate-limit
    rules CAPTCHA, the geo rule BLOCK, and the managed groups their own actions
    with the per-rule overrides this module bakes in.

    Deploy with false first and read a few days of CountedRequests and WAF logs
    per environment, then flip. The flip is an in-place web ACL update; it also
    retargets the rate-limit alarms from CountedRequests to CaptchaRequests.

    The basic-auth exception rule is an ALLOW either way — it exempts traffic
    rather than acting on it.
  EOT
  type        = bool
  default     = false
}

variable "rate_limit" {
  description = "Requests per IP per 5 minutes before the rate-limit rules match, for everyone outside rate_limit_whitelist_ips."
  type        = number
  default     = 600

  validation {
    condition     = var.rate_limit >= 10
    error_message = "rate_limit must be at least 10 (the WAFv2 minimum)."
  }
}

variable "rate_limit_whitelist" {
  description = "Requests per IP per 5 minutes for addresses in rate_limit_whitelist_ips. Ignored when that list is empty."
  type        = number
  default     = 10000

  validation {
    condition     = var.rate_limit_whitelist >= 10
    error_message = "rate_limit_whitelist must be at least 10 (the WAFv2 minimum)."
  }
}

variable "rate_limit_whitelist_ips" {
  description = <<-EOT
    IPv4 CIDRs that get rate_limit_whitelist instead of rate_limit, and that are
    exempt from the geo rule when allowed_countries is set. Typically the
    municipality's own office networks and any operator that runs load from a
    fixed address.

    Empty (the default) creates no IP set and no whitelist rule, and drops the
    exemption from the other rules' scope-down statements.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.rate_limit_whitelist_ips : can(cidrnetmask(cidr))])
    error_message = "rate_limit_whitelist_ips entries must be IPv4 CIDRs, e.g. \"192.0.2.0/24\" or \"203.0.113.10/32\"."
  }
}

variable "allowed_countries" {
  description = "Two-letter country codes whose traffic is allowed through the geo rule; everything else matches it. Null (the default) creates no geo rule at all, which is what a public environment wants. [\"FI\"] fences an environment off to Finland, as eVaka's staging does."
  type        = list(string)
  default     = null

  validation {
    condition     = var.allowed_countries == null || alltrue([for c in coalesce(var.allowed_countries, []) : can(regex("^[A-Z]{2}$", c))])
    error_message = "allowed_countries entries must be uppercase two-letter ISO 3166-1 alpha-2 codes, e.g. \"FI\"."
  }

  validation {
    condition     = var.allowed_countries == null || length(coalesce(var.allowed_countries, [])) > 0
    error_message = "allowed_countries must be null rather than empty; an empty list would match every request."
  }
}

variable "basic_auth_exception" {
  description = "Base64-encoded \"user:password\" that exempts a request carrying it as an Authorization: Basic header from every rule below priority 50, letting a monitor or a tester past a geo fence. Null (the default) creates no such rule."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = var.basic_auth_exception == null || can(regex("^[A-Za-z0-9+/]+={0,2}$", var.basic_auth_exception))
    error_message = "basic_auth_exception must be the base64 encoding of \"user:password\", not the raw credentials."
  }
}

variable "alarm_sns_topic_arn" {
  description = "SNS topic for the rate-limit alarms, in the same region as this module's provider. Null (the default) creates no alarms."
  type        = string
  default     = null
}

variable "kms_key_id" {
  description = "KMS key ARN encrypting the WAF log group. The key policy must let logs.<region>.amazonaws.com encrypt with it, or the log group fails to create. Null leaves the logs with CloudWatch's own encryption."
  type        = string
  default     = null
}

variable "log_retention_in_days" {
  description = "Retention of the WAF log group. WAF logs every evaluated request, so this is the main cost lever on a busy environment."
  type        = number
  default     = 30
}

variable "enable_sampled_requests" {
  description = "Whether WAF keeps a sample of matched requests for the console's \"Sampled requests\" view. Worth having while enforce is false, since it is the quickest way to see what a rule matched. Samples are NOT redacted — unlike the logs, they show the Authorization and Cookie headers to anyone who can read the ACL."
  type        = bool
  default     = true
}
