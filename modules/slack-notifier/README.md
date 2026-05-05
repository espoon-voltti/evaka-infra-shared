# slack-notifier

Forwards CloudWatch alarm state changes and application log errors to Slack.

## What it creates

- An AWS Lambda function (`<name_prefix>-slack-notifier`, Node.js 24).
- An IAM role for the lambda with least-privilege access to the configured
  log groups, the Slack-webhook SSM parameter, and (optionally) the KMS key
  that encrypts it.
- An SNS subscription from `var.alarm_sns_topic_arn` to the lambda, so alarm
  state changes are formatted and posted to Slack.
- An EventBridge schedule (`rate(5 minutes)`) that triggers the lambda to
  scan recent log entries and post any errors found.

The Slack webhook URL itself is not in Terraform state, environment
variables, or the lambda zip — only the **name** of the SSM parameter holding
it is. The consumer creates and populates the parameter out-of-band.

## Usage

```hcl
module "slack_notifier" {
  count  = var.slack_notifier_enabled ? 1 : 0
  source = "git::https://github.com/espoon-voltti/evaka-infra-shared.git//modules/slack-notifier?ref=v1&depth=1"

  name_prefix            = "${var.project}-${var.environment}"
  account_id             = var.account_id
  alarm_sns_topic_arn    = aws_sns_topic.alarm_topic.arn
  slack_webhook_ssm_name = aws_ssm_parameter.slack_webhook_url.name
  slack_webhook_kms_arn  = aws_kms_key.encryption.arn
  log_group_names = [
    "${var.project}-service-${var.environment}",
    "${var.project}-apigw-${var.environment}",
    "${var.project}-proxy-${var.environment}",
  ]
}
```

## Inputs

| Name                     | Type           | Required | Default | Description                                                                                                    |
| ------------------------ | -------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `name_prefix`            | `string`       | yes      | —       | Prefix for the lambda function, IAM role, and EventBridge rule. Example: `"evakaturku-prod"`.                  |
| `account_id`             | `string`       | yes      | —       | AWS account ID, used for IAM resource ARNs.                                                                    |
| `alarm_sns_topic_arn`    | `string`       | yes      | —       | SNS topic the lambda subscribes to for alarm state changes.                                                    |
| `slack_webhook_ssm_name` | `string`       | yes      | —       | Name of the SecureString SSM parameter holding the Slack webhook URL.                                          |
| `slack_webhook_kms_arn`  | `string`       | no       | `""`    | KMS key ARN. Leave empty if the SSM parameter is encrypted with `aws/ssm`.                                     |
| `log_group_names`        | `list(string)` | yes      | —       | CloudWatch log groups to scan and to use for trace-id deep-links.                                              |
| `log_query_seconds`      | `number`       | no       | `300`   | Sliding window for the log-error scan. The schedule (`rate(5 minutes)`) is hardcoded and assumes this cadence. |

## Outputs

| Name                   | Description                       |
| ---------------------- | --------------------------------- |
| `lambda_function_arn`  | ARN of the slack-notifier lambda. |
| `lambda_function_name` | Name of the lambda.               |
