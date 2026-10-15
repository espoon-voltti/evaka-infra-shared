data "aws_partition" "current" {}

locals {
  function_name      = "${var.name_prefix}-slack-notifier"
  rule_name          = "${var.name_prefix}-slack-notifier-log-error-check"
  reminder_rule_name = "${var.name_prefix}-slack-notifier-alarm-reminder"

  # Without a topic no alarm routes to Slack, so there is nothing to remind about.
  alarm_reminder_enabled = var.alarm_reminder_enabled && var.alarm_sns_topic_arn != null

  # No log groups to scan means the scheduled scan has nothing to do: skip the
  # schedule and the Insights grants, leaving an alarm-forwarder-only deployment.
  log_scan_enabled = length(var.log_group_names) > 0 || length(var.log_sources) > 0

  log_source_prefixes    = distinct(flatten([for s in var.log_sources : s.log_group_name_prefixes]))
  log_source_exact_names = distinct(flatten([for s in var.log_sources : s.log_group_names]))

  base_iam_statements = [
    {
      Effect   = "Allow"
      Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "arn:${data.aws_partition.current.partition}:logs:*:${var.account_id}:log-group:/aws/lambda/${local.function_name}:*"
    },
    {
      Effect   = "Allow"
      Action   = ["ssm:GetParameter"]
      Resource = "arn:${data.aws_partition.current.partition}:ssm:*:${var.account_id}:parameter${var.slack_webhook_ssm_name}"
    },
  ]

  # concat() of two separately gated single-statement lists, not one conditional
  # returning both: the two statements have different object types (Resource is a
  # list in one and a string in the other), so Terraform cannot unify them into a
  # list and compares them as a 2-tuple against the empty one, which fails with
  # "Inconsistent conditional result types".
  log_scan_iam_statements = concat(
    length(var.log_group_names) > 0 ? [{
      Effect   = "Allow"
      Action   = ["logs:StartQuery"]
      Resource = [for n in var.log_group_names : "arn:${data.aws_partition.current.partition}:logs:*:${var.account_id}:log-group:${n}:*"]
    }] : [],
    length(local.log_source_exact_names) > 0 || length(local.log_source_prefixes) > 0 ? [{
      Effect = "Allow"
      Action = ["logs:StartQuery"]
      Resource = concat(
        [for n in local.log_source_exact_names : "arn:${data.aws_partition.current.partition}:logs:*:${var.account_id}:log-group:${n}:*"],
        [for p in local.log_source_prefixes : "arn:${data.aws_partition.current.partition}:logs:*:${var.account_id}:log-group:${p}*:*"],
      )
    }] : [],
    # DescribeLogGroups cannot be scoped to log groups by name: being a list
    # operation it authorizes against an ARN with an empty log-group name
    # (`log-group::log-stream:`, per an ESC AccessDenied), which no prefixed
    # resource matches. Only this metadata listing is account-wide — reading log
    # content still requires the prefix-scoped StartQuery grant above, and the
    # lambda asks for one prefix at a time regardless.
    length(local.log_source_prefixes) > 0 ? [{
      Effect   = "Allow"
      Action   = ["logs:DescribeLogGroups"]
      Resource = "arn:${data.aws_partition.current.partition}:logs:*:${var.account_id}:log-group:*"
    }] : [],
    local.log_scan_enabled ? [{
      Effect   = "Allow"
      Action   = ["logs:GetQueryResults"]
      Resource = "*"
    }] : [],
  )

  # Granted whenever there is a topic, not only with the schedule on, so a manual
  # alarm-reminder invocation works in an account that has the schedule off.
  alarm_reminder_iam_statements = var.alarm_sns_topic_arn != null ? [
    {
      Effect   = "Allow"
      Action   = ["cloudwatch:DescribeAlarms"]
      Resource = "arn:${data.aws_partition.current.partition}:cloudwatch:*:${var.account_id}:alarm:*"
    }
  ] : []

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

# The lambda is split into an entry point, shared lib, and one file per check /
# message handler, so zip the whole dir. Tests, stubs and the build artifact
# itself are excluded; the zip is written outside the source dir to avoid
# packaging its own output.
data "archive_file" "slack_notifier" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/slack_notifier.zip"
  excludes = [
    "slack_notifier.test.mjs",
    "stub-ssm.mjs",
    "stub-cloudwatch-logs.mjs",
    "stub-cloudwatch.mjs",
    "mock-aws-loader.mjs",
    "slack_notifier.zip"
  ]
}

resource "aws_iam_role" "slack_notifier" {
  name = "${var.name_prefix}-slack-notifier"

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
      local.alarm_reminder_iam_statements,
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
  timeout          = 60 # Must exceed QUERY_DEADLINE_MS in lambda/lib.mjs.
  filename         = data.archive_file.slack_notifier.output_path
  source_code_hash = data.archive_file.slack_notifier.output_base64sha256

  environment {
    variables = {
      SLACK_WEBHOOK_SSM_NAME = var.slack_webhook_ssm_name
      SLACK_CHANNEL          = var.slack_channel != null ? var.slack_channel : ""
      SLACK_USERNAME         = var.slack_username != null ? var.slack_username : ""
      LOG_GROUP_NAMES        = join(",", var.log_group_names)
      LOG_QUERY_SECONDS      = tostring(var.log_query_seconds)
      LOG_SOURCES_JSON       = jsonencode(var.log_sources)
      ALARM_SNS_TOPIC_ARN    = var.alarm_sns_topic_arn != null ? var.alarm_sns_topic_arn : ""
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

# EventBridge schedule: check logs every 5 minutes, at minutes 2, 7, ... 57. No
# run starts in an hour's first two minutes, when Logs Insights sometimes keeps a
# query Scheduled for longer than the lambda polls it.
resource "aws_cloudwatch_event_rule" "log_error_check" {
  count = local.log_scan_enabled ? 1 : 0

  name                = local.rule_name
  description         = "Check for service errors in logs every 5 minutes"
  schedule_expression = "cron(2/5 * * * ? *)"
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

# EventBridge schedule: once a day, list the alarms still in ALARM state. The
# constant input is the same event a manual `aws lambda invoke` sends to run the
# reminder on demand.
resource "aws_cloudwatch_event_rule" "alarm_reminder" {
  count = local.alarm_reminder_enabled ? 1 : 0

  name                = local.reminder_rule_name
  description         = "Remind Slack of alarms still in ALARM state"
  schedule_expression = var.alarm_reminder_schedule_expression
}

resource "aws_cloudwatch_event_target" "alarm_reminder" {
  count = local.alarm_reminder_enabled ? 1 : 0

  rule  = aws_cloudwatch_event_rule.alarm_reminder[0].name
  arn   = aws_lambda_function.slack_notifier.arn
  input = jsonencode({ action = "alarm-reminder" })
}

resource "aws_lambda_permission" "eventbridge_invoke_alarm_reminder" {
  count = local.alarm_reminder_enabled ? 1 : 0

  statement_id  = "AllowEventBridgeInvokeAlarmReminder"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_notifier.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.alarm_reminder[0].arn
}
