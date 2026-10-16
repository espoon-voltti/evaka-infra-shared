output "function_url" {
  description = "Function URL of the read lambda."
  value       = aws_lambda_function_url.reader.function_url
}

output "bucket_name" {
  description = "Name of the bucket that holds the metrics files."
  value       = aws_s3_bucket.ops_metrics.bucket
}

output "collector_function_name" {
  description = "Name of the collector lambda, for backfill invocations."
  value       = aws_lambda_function.collector.function_name
}

output "reader_function_name" {
  description = "Name of the read lambda."
  value       = aws_lambda_function.reader.function_name
}
