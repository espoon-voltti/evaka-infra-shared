locals {
  function_name = "${var.name_prefix}-slack-notifier"
  rule_name     = "${var.name_prefix}-slack-notifier-log-error-check"

  base_iam_statements = [
    {
      Effect   = "Allow"
      Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "arn:aws:logs:*:${var.account_id}:log-group:/aws/lambda/${local.function_name}:*"
    },
    {
      Effect   = "Allow"
      Action   = ["logs:StartQuery"]
      Resource = [for n in var.log_group_names : "arn:aws:logs:*:${var.account_id}:log-group:${n}:*"]
    },
    {
      Effect   = "Allow"
      Action   = ["logs:GetQueryResults"]
      Resource = "*"
    },
    {
      Effect   = "Allow"
      Action   = ["ssm:GetParameter"]
      Resource = "arn:aws:ssm:*:${var.account_id}:parameter${var.slack_webhook_ssm_name}"
    },
  ]

  kms_iam_statements = var.slack_webhook_kms_arn != "" ? [
    {
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = var.slack_webhook_kms_arn
    }
  ] : []
}

data "archive_file" "slack_notifier" {
  type        = "zip"
  source_file = "${path.module}/lambda/slack_notifier.mjs"
  output_path = "${path.module}/lambda/slack_notifier.zip"
}

resource "aws_iam_role" "slack_notifier" {
  name_prefix = "${var.name_prefix}-slack-notifier-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "slack_notifier" {
  name_prefix = "${var.name_prefix}-slack-notifier-"
  role        = aws_iam_role.slack_notifier.name

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = concat(local.base_iam_statements, local.kms_iam_statements)
  })
}

#tfsec:ignore:aws-lambda-enable-tracing
resource "aws_lambda_function" "slack_notifier" {
  function_name    = local.function_name
  description      = "Forwards CloudWatch alarms and log errors to Slack"
  role             = aws_iam_role.slack_notifier.arn
  handler          = "slack_notifier.handler"
  runtime          = "nodejs24.x"
  timeout          = 30
  filename         = data.archive_file.slack_notifier.output_path
  source_code_hash = data.archive_file.slack_notifier.output_base64sha256

  environment {
    variables = {
      SLACK_WEBHOOK_SSM_NAME = var.slack_webhook_ssm_name
      LOG_GROUP_NAMES        = join(",", var.log_group_names)
      LOG_QUERY_SECONDS      = tostring(var.log_query_seconds)
    }
  }
}

# SNS subscription: alarm state changes -> Lambda
resource "aws_sns_topic_subscription" "slack_notifier" {
  topic_arn = var.alarm_sns_topic_arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.slack_notifier.arn
}

resource "aws_lambda_permission" "sns_invoke" {
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_notifier.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = var.alarm_sns_topic_arn
}

# EventBridge schedule: check logs every 5 minutes
resource "aws_cloudwatch_event_rule" "log_error_check" {
  name                = local.rule_name
  description         = "Check for service errors in logs every 5 minutes"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "log_error_check" {
  rule = aws_cloudwatch_event_rule.log_error_check.name
  arn  = aws_lambda_function.slack_notifier.arn
}

resource "aws_lambda_permission" "eventbridge_invoke" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_notifier.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.log_error_check.arn
}
