# ops-metrics

Collects operational metrics of an eVaka environment in 5-minute buckets into
an S3 bucket, and gives the
[evaka-update-tracker](https://github.com/espoon-voltti/evaka-update-tracker)
page presigned URLs to the files.

## What it creates

- An S3 bucket (`<name_prefix>-ops-metrics`) with all public access blocked,
  server-side encryption (SSE-KMS with `bucket_kms_arn`, otherwise SSE-S3),
  CORS that allows `GET` from `allowed_origins`, and a lifecycle rule that
  deletes the 5-minute files after `raw_retention_days`.
- A collector Lambda (`<name_prefix>-ops-metrics-collector`, Node.js 24, ARM64)
  and an EventBridge schedule (`collector_schedule`, by default
  `cron(3/5 * * * ? *)`). It reads the citizen login audit events from
  `service_log_group_name` with one Logs Insights query, and the RDS
  `CPUUtilization` of `rds_instance_identifier` with one `GetMetricData` call,
  and writes them to the day file. Its reserved concurrency is 1, so two runs
  cannot write the same file at the same time.
- A read Lambda (`<name_prefix>-ops-metrics-reader`) with a public Function URL.
  It checks the bearer token against the SSM parameter `token_ssm_name` and
  returns presigned URLs to the day files of the requested range.
- An IAM role for each Lambda with least-privilege access.

The token itself is not in Terraform state, environment variables, or the
Lambda zip; only the **name** of the SSM parameter that holds it is. The
consumer creates and populates the parameter.

## Files

One file for each UTC day, `5min/YYYY/MM/DD.json`, stored with gzip and
`Content-Encoding: gzip`. A browser decompresses it automatically; to look at a
file, use `aws s3 cp s3://<bucket>/5min/2026/10/06.json - | gunzip | jq`.

```json
{
  "series": {
    "citizen.login{auth=strong}": { "type": "counter" },
    "citizen.login{auth=weak}": { "type": "counter" },
    "rds.cpu": { "type": "gaugeSummary" }
  },
  "slots": [
    {
      "t": "2026-10-06T00:00:00Z",
      "citizen.login{auth=strong}": 12,
      "citizen.login{auth=weak}": 3,
      "rds.cpu": { "min": 8, "mean": 12.5, "max": 31, "n": 5 }
    }
  ]
}
```

- `t` is the start of the bucket. Slots are sorted by `t`.
- A missing slot or key means that the value is not known: the collector has
  not processed the bucket, or it failed. A counter is 0 when the collector
  processed the bucket and there were no events.
- `citizen.login{auth=strong}` counts `CitizenLogin` audit events, and
  `citizen.login{auth=weak}` counts `CitizenWeakLogin` and
  `CitizenPasskeyLogin`.
- `rds.cpu` is the minimum, average, maximum and sample count of
  `CPUUtilization` in the bucket. A bucket with no datapoint has no `rds.cpu`.

## Collector

Each scheduled run processes the last 6 closed buckets (30 minutes), whose end
is at least 3 minutes ago because log ingestion is not immediate. It writes
each of them again, so a missed run or a late log line is fixed by the next
runs. Writing a slot again gives the same result.

### Backfill

Invoke the collector with a range. It runs one Insights query and one
`GetMetricData` call for each UTC day, and stops at the last closed bucket.

```sh
aws lambda invoke --function-name <name_prefix>-ops-metrics-collector \
  --cli-read-timeout 310 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"backfill":{"from":"2026-10-01T00:00:00Z","to":"2026-10-15T00:00:00Z"}}' \
  out.json && cat out.json
```

The AWS CLI waits 60 s for a response by default and then sends the
invocation again, so keep `--cli-read-timeout` above the 300 s timeout.

When less than 60 s of the 300 s timeout is left, the collector stops before
the next day and returns `next`, the range to invoke again with. The reserved
concurrency is 1, so an invocation can be throttled while a scheduled run is
in progress; invoke again.

## Read API

`GET <function_url>/files?from=<ISO>&to=<ISO>` with the header
`Authorization: Bearer <token>`.

```json
{
  "resolution": "5min",
  "files": [
    { "key": "5min/2026/10/05.json", "url": "https://..." },
    { "key": "5min/2026/10/06.json", "url": "https://..." }
  ],
  "expiresAt": "2026-10-06T12:15:00Z"
}
```

- One URL for each UTC day that the range overlaps. The Lambda does not check
  that the files exist; a missing file gives 404 from S3.
- 401 `{ "error": "unauthorized" }` for a missing or wrong token. 400 for a
  missing or malformed range, or a range longer than 31 days.
- The Lambda keeps the token in memory for at most 5 minutes, so a new value
  in SSM is in use after that.
- A presigned URL also stops working when the temporary credentials of the
  Lambda expire, which can be before `expiresAt`. The page gets new URLs when S3
  answers 403.

## Usage

```hcl
resource "aws_ssm_parameter" "ops_metrics_token" {
  name  = "/${var.environment}/evaka/ops-metrics-token"
  type  = "SecureString"
  value = "changeit"

  lifecycle {
    ignore_changes = [value]
  }
}

module "ops_metrics" {
  source = "git::https://github.com/espoon-voltti/evaka-infra-shared.git//modules/ops-metrics?ref=v1&depth=1"

  name_prefix             = "evaka-${var.environment}"
  account_id              = var.account_id
  service_log_group_name  = "evaka-srv-${var.environment}"
  rds_instance_identifier = "evaka-${var.environment}"
  token_ssm_name          = aws_ssm_parameter.ops_metrics_token.name
  bucket_kms_arn          = aws_kms_key.logs.arn
  allowed_origins         = ["https://espoon-voltti.github.io"]
}
```

With `bucket_kms_arn`, the key policy must let IAM policies in the account
grant access to the key.

### Token

Terraform writes the placeholder `changeit` and then ignores the value. Set
the real token by hand:

```sh
TOKEN=$(openssl rand -hex 32)
aws ssm put-parameter --overwrite --type SecureString \
  --name /<environment>/evaka/ops-metrics-token --value "$TOKEN"
```

Give the same token to the tracker page in its settings. The read Lambda uses
the new value within 5 minutes.

### Check

```sh
curl -sS -H "Authorization: Bearer $TOKEN" \
  "${FUNCTION_URL}files?from=2026-10-05T00:00:00Z&to=2026-10-06T00:00:00Z" | jq
```

`FUNCTION_URL` is the `function_url` output, which ends with `/`. The
response has one URL, for 2026-10-05. Without the header, the response is 401.

## Inputs

| Name                      | Type           | Required | Default                 | Description                                                                                   |
| ------------------------- | -------------- | -------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `name_prefix`             | `string`       | yes      |                         | Prefix for the bucket, the Lambdas, their roles and the schedule. Example: `"evaka-staging"`. |
| `account_id`              | `string`       | yes      |                         | AWS account ID, used for IAM resource ARNs.                                                   |
| `service_log_group_name`  | `string`       | yes      |                         | Log group of the eVaka service, for the audit events.                                         |
| `rds_instance_identifier` | `string`       | yes      |                         | `DBInstanceIdentifier` of the eVaka database.                                                 |
| `token_ssm_name`          | `string`       | yes      |                         | Name of the SecureString SSM parameter that holds the bearer token.                           |
| `token_kms_arn`           | `string`       | no       | `""`                    | KMS key ARN of the token parameter. Leave empty if it uses `aws/ssm`.                         |
| `allowed_origins`         | `list(string)` | yes      |                         | Origins of the tracker page, for the CORS config of the Function URL and the bucket.          |
| `bucket_kms_arn`          | `string`       | no       | `null`                  | Customer-managed KMS key of the bucket. Null uses SSE-S3.                                     |
| `raw_retention_days`      | `number`       | no       | `400`                   | Days to keep the 5-minute files.                                                              |
| `collector_schedule`      | `string`       | no       | `"cron(3/5 * * * ? *)"` | Schedule of the collector. It must run every 5 minutes.                                       |

## Outputs

| Name                      | Description                                 |
| ------------------------- | ------------------------------------------- |
| `function_url`            | Function URL of the read Lambda.            |
| `bucket_name`             | Name of the bucket.                         |
| `collector_function_name` | Name of the collector Lambda, for backfill. |
| `reader_function_name`    | Name of the read Lambda.                    |
