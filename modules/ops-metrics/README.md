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
  `cron(1/5 * * * ? *)`). It counts the lines of `service_log_group_name`,
  and of `apigw_log_group_name` and `proxy_log_group_name` when they are set,
  with one Logs Insights query for each log group. It reads the RDS
  `CPUUtilization` of `rds_instance_identifier` with one `GetMetricData` call,
  and writes them to the day file. Its reserved concurrency is 1, so two runs
  cannot write the same file at the same time. It keeps its progress in
  `state/collector.json` in the same bucket.
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
    "service.asyncJob.failed": { "type": "counter" },
    "service.asyncJob.failed{type=SendMessage}": { "type": "counter" },
    "service.responseTime": {
      "type": "histogram",
      "bounds": [
        2.15, 4.64, 10, 21.54, 46.42, 100, 215.44, 464.16, 1000, 2154.43,
        4641.59, 10000
      ]
    },
    "rds.cpu": { "type": "gaugeSummary" }
  },
  "slots": [
    {
      "t": "2026-10-06T00:00:00Z",
      "citizen.login{auth=strong}": 12,
      "service.asyncJob.failed": 2,
      "service.asyncJob.failed{type=SendMessage}": 2,
      "service.responseTime": [0, 0, 41, 120, 88, 30, 9, 3, 1, 0, 0, 0, 0],
      "rds.cpu": { "min": 8, "mean": 12.5, "max": 31, "n": 5 }
    }
  ]
}
```

- `t` is the start of the bucket. Slots are sorted by `t`.
- Labels are part of the series name: `name{k=v}` or `name{k1=v1,k2=v2}`.
- A `counter` is the number of events in the bucket.
- A `histogram` is an array of 13 counts of response times in milliseconds.
  Count `i` holds the values `v` with `bounds[i-1] <= v < bounds[i]`: count 0
  is `v < bounds[0]` and count 12 is `v >= bounds[11]`. There are three bounds
  for each decade.
- A `gaugeSummary` is the minimum, average, maximum and sample count of a
  metric in the bucket.
- A missing slot or key means that the value is not known: the collector has
  not processed the bucket, or it failed. A counter is 0, and a histogram is
  all zeros, when the collector processed the bucket and there were no events.
- A series with a job type label is not zero-filled. A missing key means 0
  when the slot has the series of the same name without the label.

| Series                                                                        | Type         | From (service log group)                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `citizen.login{auth=strong}`                                                  | counter      | Audit `CitizenLogin`                                                                                                                     |
| `citizen.login{auth=weak}`                                                    | counter      | Audit `CitizenWeakLogin`, `CitizenPasskeyLogin`                                                                                          |
| `citizen.loginAttempt{auth=weak}`                                             | counter      | Audit `CitizenWeakLoginAttempt`, `CitizenPasskeyLoginAttempt`                                                                            |
| `employee.login{method=ad\|sfi\|pin}`                                         | counter      | Audit `EmployeeLogin`, `EmployeeSfiLogin`, and `PinLogin` with `meta.status = "SUCCESS"`                                                 |
| `message.sent{by=employee\|citizen\|reply}`                                   | counter      | Audit `MessagingNewMessageWrite`, `MessagingCitizenSendMessage`, `MessagingReplyToThreadWrite`                                           |
| `passkey.registered`                                                          | counter      | Audit `CitizenPasskeyRegister`                                                                                                           |
| `push.subscribed{app=citizen\|employee}`                                      | counter      | Audit `CitizenPushSubscriptionCreate`, `PushSubscriptionUpsert`                                                                          |
| `service.requests{class=2xx\|3xx\|4xx\|5xx}`                                  | counter      | Access log lines (`type = "app-requests-received"`) by `statusCode`                                                                      |
| `service.responseTime`                                                        | histogram    | Same lines, `responseTime`                                                                                                               |
| `service.errors`                                                              | counter      | `logLevel = "ERROR"` in `app-misc` lines                                                                                                 |
| `service.asyncJob.failed`, `service.asyncJob.failed{type=<job type>}`         | counter      | WARN "Failed to run async job", by `meta.jobType`                                                                                        |
| `service.asyncJob.permanentlyFailed`, `...permanentlyFailed{type=<job type>}` | counter      | ERROR "Async job ... permanently failed (remainingAttempts=0)", by `meta.jobType`                                                        |
| `integration.failed{system=email\|webpush\|varda\|dvv}`                       | counter      | ERROR "Couldn't send email", "Web push failed", "Varda update failed", "Failed to update unit", "... DVV modification(s) service failed" |
| `vtj.requests{result=ok\|error}`                                              | counter      | `type = "vtj-audit-events"`: `status` "response received", or "error during request" and "response parsing failure"                      |
| `sanityCheck.failed`                                                          | counter      | ERROR "Sanity check failed"                                                                                                              |
| `rds.cpu`                                                                     | gaugeSummary | `CPUUtilization` of the database. A bucket with no datapoint has no `rds.cpu`.                                                           |

`integration.failed{system=varda}` counts each failed Varda child or unit
update once. The Varda client line "request failed" that comes before it does
not count.

The `app` label of the API gateway series is the path prefix of the request:
`/api/citizen/` is `citizen`, `/api/employee-mobile/` is `mobile`,
`/api/employee/` is `employee`, and all other paths are `other`, for example
the Suomi.fi SAML callback `/api/application/auth/saml/`.

| Series                                                     | Type      | From (API gateway log group)                                                                                                                                                   |
| ---------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apigw.requests{app=<app>,class=2xx\|3xx\|4xx\|5xx}`       | counter   | Access log lines (`type = "app-requests-received"`, not "request aborted") by `statusCode`                                                                                     |
| `apigw.status401{app=<app>}`, `apigw.status429{app=<app>}` | counter   | Same lines with status 401 or 429                                                                                                                                              |
| `apigw.responseTime{app=<app>}`                            | histogram | Same lines, `responseTime`                                                                                                                                                     |
| `login.failed{method=sfi\|ad\|weak\|passkey}`              | counter   | Audit `evaka.saml.suomifi.sign_in_failed` (citizen and employee), `evaka.saml.ead.sign_in_failed`, `evaka.citizen_weak.sign_in_failed`, `evaka.citizen_passkey.sign_in_failed` |
| `login.rateLimited`                                        | counter   | "Login request hit rate limit"                                                                                                                                                 |

| Series                                     | Type    | From (proxy log group)                                                    |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------- |
| `proxy.requests{class=2xx\|3xx\|4xx\|5xx}` | counter | nginx access log lines (`type = "app-requests-received"`) by `statusCode` |
| `proxy.status502`, `proxy.status504`       | counter | Same lines with status 502 or 504                                         |

## Collector

A bucket is closed when its end is at least `ingestion_delay_seconds` (by
default 5 minutes) ago, because log ingestion is not immediate. With the
default schedule, the run at minute 6 processes the bucket that ended at
minute 0.

The collector keeps a watermark for each source in `state/collector.json`: the
end of the last bucket that it stored.

```json
{
  "service": "2026-10-06T12:00:00Z",
  "apigw": "2026-10-06T12:00:00Z",
  "proxy": "2026-10-06T12:00:00Z",
  "metrics": "2026-10-06T12:00:00Z"
}
```

The sources are the log groups `service`, `apigw` and `proxy`, and `metrics`.
A log group without a name in the inputs has no source.

- Each run makes at most one Logs Insights query or `GetMetricData` call for
  each source. A query counts every series of its log group.
- Logs: each run queries Logs Insights from the watermark to the latest closed
  bucket, so each log line is scanned only once. When no bucket closed since
  the last run, there is no query. The first run, with no watermark, processes
  only the latest closed bucket.
- Metrics: each run also reads the 6 buckets (30 minutes) before the latest
  closed bucket again, because CloudWatch can add a datapoint some minutes
  late. `GetMetricData` is cheap.
- A source writes its watermark only after its slots are stored. A source that
  fails keeps its watermark, so the next run retries it, and the other sources
  continue.
- After an outage, the next runs fill the missed buckets automatically: each
  run covers up to 12 hours of the service and API gateway log groups, and 1
  day of the proxy log group and the metrics. These ranges keep a query result
  under 10,000 rows, the most that one `GetQueryResults` call returns. A result
  that reaches 10,000 rows is queried again in two halves, down to one bucket;
  a bucket that still reaches it fails the source, and nothing is stored for
  the range. A run stops before a source when less than 60 s of the 300 s
  timeout is left. Later runs continue from the watermark.

Writing a slot again gives the same result. A scheduled run fails without a
query when `state/collector.json` is not a JSON object, or has a watermark that
is not the start of a bucket. To start again from the latest closed bucket,
delete `state/collector.json`.

### Backfill

Backfill is only for the history before the first scheduled run; the
scheduled runs fill their own gaps. A backfill does not read or move the
watermarks. Invoke the collector with a range. It splits the range into chunks
of 12 hours, runs one Insights query and one `GetMetricData` call for each
chunk, and stops at the last closed bucket.

```sh
aws lambda invoke --function-name <name_prefix>-ops-metrics-collector \
  --cli-read-timeout 310 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"backfill":{"from":"2026-10-01T00:00:00Z","to":"2026-10-15T00:00:00Z"}}' \
  out.json && cat out.json
```

The AWS CLI waits 60 s for a response by default and then sends the
invocation again, so keep `--cli-read-timeout` above the 300 s timeout.

The response lists the `processed` chunks. When less than 60 s of the 300 s
timeout is left, the collector stops before the next chunk and returns `next`,
the range to invoke again with. The reserved
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
  apigw_log_group_name    = "evaka-apigw-${var.environment}"
  proxy_log_group_name    = "evaka-proxy-${var.environment}"
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
| `service_log_group_name`  | `string`       | yes      |                         | Log group of the eVaka service.                                                               |
| `apigw_log_group_name`    | `string`       | no       | `null`                  | Log group of the eVaka API gateway. Null leaves out its series.                               |
| `proxy_log_group_name`    | `string`       | no       | `null`                  | Log group of the eVaka nginx proxy. Null leaves out its series.                               |
| `rds_instance_identifier` | `string`       | yes      |                         | `DBInstanceIdentifier` of the eVaka database.                                                 |
| `token_ssm_name`          | `string`       | yes      |                         | Name of the SecureString SSM parameter that holds the bearer token.                           |
| `token_kms_arn`           | `string`       | no       | `""`                    | KMS key ARN of the token parameter. Leave empty if it uses `aws/ssm`.                         |
| `allowed_origins`         | `list(string)` | yes      |                         | Origins of the tracker page, for the CORS config of the Function URL and the bucket.          |
| `bucket_kms_arn`          | `string`       | no       | `null`                  | Customer-managed KMS key of the bucket. Null uses SSE-S3.                                     |
| `raw_retention_days`      | `number`       | no       | `400`                   | Days to keep the 5-minute files.                                                              |
| `collector_schedule`      | `string`       | no       | `"cron(1/5 * * * ? *)"` | Schedule of the collector. It must run every 5 minutes.                                       |
| `ingestion_delay_seconds` | `number`       | no       | `300`                   | Time after a bucket closes before the collector reads it.                                     |

## Outputs

| Name                      | Description                                 |
| ------------------------- | ------------------------------------------- |
| `function_url`            | Function URL of the read Lambda.            |
| `bucket_name`             | Name of the bucket.                         |
| `collector_function_name` | Name of the collector Lambda, for backfill. |
| `reader_function_name`    | Name of the read Lambda.                    |
