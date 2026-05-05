output "lambda_function_arn" {
  description = "ARN of the slack-notifier lambda function."
  value       = aws_lambda_function.slack_notifier.arn
}

output "lambda_function_name" {
  description = "Name of the slack-notifier lambda function."
  value       = aws_lambda_function.slack_notifier.function_name
}
