locals {
  function_name = "${var.name_prefix}-slack-notifier"
  rule_name     = "${var.name_prefix}-slack-notifier-log-error-check"

  # No log groups to scan means the scheduled scan has nothing to do: skip the
  # schedule and the Insights grants, leaving an alarm-forwarder-only deployment.
  log_scan_enabled = length(var.log_group_names) > 0

  base_iam_statements = [
    {
      Effect   = "Allow"
      Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "arn:aws:logs:*:${var.account_id}:log-group:/aws/lambda/${local.function_name}:*"
    },
    {
      Effect   = "Allow"
      Action   = ["ssm:GetParameter"]
      Resource = "arn:aws:ssm:*:${var.account_id}:parameter${var.slack_webhook_ssm_name}"
    },
  ]

  # concat() of two separately gated single-statement lists, not one conditional
  # returning both: the two statements have different object types (Resource is a
  # list in one and a string in the other), so Terraform cannot unify them into a
  # list and compares them as a 2-tuple against the empty one, which fails with
  # "Inconsistent conditional result types".
  log_scan_iam_statements = concat(
    local.log_scan_enabled ? [{
      Effect   = "Allow"
      Action   = ["logs:StartQuery"]
      Resource = [for n in var.log_group_names : "arn:aws:logs:*:${var.account_id}:log-group:${n}:*"]
    }] : [],
    local.log_scan_enabled ? [{
      Effect   = "Allow"
      Action   = ["logs:GetQueryResults"]
      Resource = "*"
    }] : [],
  )

  kms_iam_statements = var.slack_webhook_kms_arn != "" ? [
    {
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = var.slack_webhook_kms_arn
    }
  ] : []

  # Built-in backup-failed alarm, merged into the user-supplied metric alarms.
  # Attribute set matches var.metric_alarms (with optionals resolved) so merge()
  # yields a single uniform map. User entries win on key collision.
  # Self-gating: enabled by default, but skipped without an SNS topic so a
  # default-on alarm never breaks a log-scan-only (topic-less) consumer.
  backup_failed_alarm = var.backup_failed_alarm_enabled && var.alarm_sns_topic_arn != null ? {
    backup-failed = {
      namespace           = "AWS/Backup"
      metric_name         = "NumberOfBackupJobsFailed"
      comparison_operator = "GreaterThanThreshold"
      threshold           = 0
      statistic           = "Sum"
      period              = 3600
      evaluation_periods  = 1
      datapoints_to_alarm = null
      treat_missing_data  = "notBreaching"
      dimensions          = var.backup_failed_alarm_dimensions
      alarm_description   = "Backup failed in ${var.name_prefix}"
      notify_on_ok        = false
    }
  } : {}

  metric_alarms = merge(local.backup_failed_alarm, var.metric_alarms)
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
    Version = "2012-10-17"
    Statement = concat(
      local.base_iam_statements,
      local.log_scan_iam_statements,
      local.kms_iam_statements,
    )
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
  count     = var.alarm_sns_topic_arn != null ? 1 : 0
  topic_arn = var.alarm_sns_topic_arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.slack_notifier.arn
}

resource "aws_lambda_permission" "sns_invoke" {
  count         = var.alarm_sns_topic_arn != null ? 1 : 0
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_notifier.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = var.alarm_sns_topic_arn
}

# Metric alarms -> SNS topic -> lambda -> Slack.
# The lambda's buildAlarmPayload formats any standard CloudWatch alarm message,
# so no lambda change is needed to support these.
resource "aws_cloudwatch_metric_alarm" "metric_alarm" {
  for_each = local.metric_alarms

  alarm_name          = "${var.name_prefix}-${each.key}"
  namespace           = each.value.namespace
  metric_name         = each.value.metric_name
  comparison_operator = each.value.comparison_operator
  threshold           = each.value.threshold
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  datapoints_to_alarm = each.value.datapoints_to_alarm
  treat_missing_data  = each.value.treat_missing_data
  dimensions          = each.value.dimensions
  alarm_description   = each.value.alarm_description

  alarm_actions = [var.alarm_sns_topic_arn]
  ok_actions    = each.value.notify_on_ok ? [var.alarm_sns_topic_arn] : []

  lifecycle {
    precondition {
      condition     = var.alarm_sns_topic_arn != null
      error_message = "slack-notifier metric alarms require alarm_sns_topic_arn to be set so alarms can route to the lambda."
    }
  }
}

# EventBridge schedule: check logs every 5 minutes
resource "aws_cloudwatch_event_rule" "log_error_check" {
  count = local.log_scan_enabled ? 1 : 0

  name                = local.rule_name
  description         = "Check for service errors in logs every 5 minutes"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "log_error_check" {
  count = local.log_scan_enabled ? 1 : 0

  rule = aws_cloudwatch_event_rule.log_error_check[0].name
  arn  = aws_lambda_function.slack_notifier.arn
}

resource "aws_lambda_permission" "eventbridge_invoke" {
  count = local.log_scan_enabled ? 1 : 0

  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_notifier.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.log_error_check[0].arn
}
