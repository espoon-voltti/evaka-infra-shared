output "lambda_function_arn" {
  description = "ARN of the slack-notifier lambda function."
  value       = aws_lambda_function.slack_notifier.arn
}

output "lambda_function_name" {
  description = "Name of the slack-notifier lambda function."
  value       = aws_lambda_function.slack_notifier.function_name
}

output "metric_alarm_arns" {
  description = "Map of metric-alarm key to created CloudWatch alarm ARN."
  value       = { for k, a in aws_cloudwatch_metric_alarm.metric_alarm : k => a.arn }
}
