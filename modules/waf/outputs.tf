output "web_acl_arn" {
  description = "ARN of the web ACL."
  value       = aws_wafv2_web_acl.this.arn
}

output "web_acl_name" {
  description = "Name of the web ACL, which is also the WebACL dimension of its CloudWatch metrics."
  value       = aws_wafv2_web_acl.this.name
}

output "web_acl_capacity" {
  description = "Web ACL capacity units consumed by the rules. The default account quota is 1500, and this rule set already uses most of it, so check this before adding another managed rule group."
  value       = aws_wafv2_web_acl.this.capacity
}

output "ip_set_arn" {
  description = "ARN of the rate-limit whitelist IP set, or null when rate_limit_whitelist_ips is empty."
  value       = one(aws_wafv2_ip_set.rate_limit_whitelist[*].arn)
}

output "log_group_name" {
  description = "Name of the WAF log group, for CloudWatch Logs Insights queries."
  value       = aws_cloudwatch_log_group.waf.name
}

output "log_group_arn" {
  description = "ARN of the WAF log group."
  value       = aws_cloudwatch_log_group.waf.arn
}
