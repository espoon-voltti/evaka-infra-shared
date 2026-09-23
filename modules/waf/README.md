# waf

An AWS WAFv2 web ACL for an eVaka public ALB: rate limiting, an optional geo
fence, and the AWS managed rule groups with the per-rule downgrades eVaka has
needed to keep attachment uploads working.

The rule set, its priorities and its names are eVaka's own, as run in Espoo
since 2021. Everything that was configurable there but unused is baked in here
instead, leaving the rate limits, the whitelist and the geo fence as the only
things a municipality actually decides.

## What it creates

- A **REGIONAL web ACL** `<name_prefix>-waf` with a default action of ALLOW, and
  an association to `var.alb_arn`.
- An **IP set** `<name_prefix>-ip-rate-allow`, only when
  `rate_limit_whitelist_ips` is non-empty. Those addresses get the raised rate
  limit and skip the geo rule.
- A **log group** `aws-waf-logs-<name_prefix>` receiving every evaluated
  request, with the `authorization`, `cookie` and `cookiehub` headers redacted.
- **CloudWatch alarms** on the Finnish and whitelisted rate-limit rules, when
  `alarm_sns_topic_arn` is set. The non-Finnish rule has no alarm.

### Rules

| Priority | Rule                     | Created when                   | `enforce = false` | `enforce = true` |
| -------- | ------------------------ | ------------------------------ | ----------------- | ---------------- |
| 50       | `-basic-auth-exception`  | `basic_auth_exception` set     | ALLOW             | ALLOW            |
| 200      | `-rate-limit-fi`         | always                         | COUNT             | CAPTCHA          |
| 201      | `-rate-limit-notfi`      | always                         | COUNT             | CAPTCHA          |
| 300      | `-rate-limit-whitelist`  | `rate_limit_whitelist_ips` set | COUNT             | CAPTCHA          |
| 400      | `-geo`                   | `allowed_countries` set        | COUNT             | BLOCK            |
| 500      | `-managed-common-set`    | always                         | count override    | group actions    |
| 600      | `-managed-ip-reputation` | always                         | count override    | group actions    |
| 700      | `-managed-bad-input`     | always                         | count override    | group actions    |
| 810      | `-managed-sqli`          | always                         | count override    | group actions    |
| 820      | `-managed-posix`         | always                         | count override    | group actions    |
| 830      | `-managed-linux`         | always                         | count override    | group actions    |

Rule names are prefixed with `name_prefix`, and each rule's name is also its
CloudWatch metric name.

The two rate-limit rules split Finnish from non-Finnish traffic so that a surge
in one is visible on its own metric. Both use the same `rate_limit`; only the
whitelist rule gets a different one.

Under `enforce = true` the managed groups run with these downgrades, which are
what eVaka needs to accept attachment uploads and to avoid blocking outright on
reputation data:

| Group         | Rule                                                                                                                                                                                   | Action  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| common-set    | `SizeRestrictions_QUERYSTRING`, `SizeRestrictions_Cookie_HEADER`, `SizeRestrictions_BODY`, `SizeRestrictions_URIPATH`, `CrossSiteScripting_BODY`, `GenericLFI_BODY`, `GenericRFI_BODY` | COUNT   |
| ip-reputation | `AWSManagedIPReputationList`, `AWSManagedReconnaissanceList`, `AWSManagedIPDDoSList`                                                                                                   | CAPTCHA |
| sqli          | `SQLi_BODY`                                                                                                                                                                            | COUNT   |

## Rolling out in COUNT mode

`enforce` defaults to `false`, which is how a new environment should be
deployed. Every rule is evaluated, metered and logged, but no request is
captchad or blocked, so the limits and downgrades — chosen against Espoo's
traffic — can be checked against this environment's own before they bite.

While counting:

- **CloudWatch**, namespace `AWS/WAFV2`, dimensions `Region`, `WebACL` and
  `Rule`: `CountedRequests` per rule. The rate-limit rules only produce data
  points when the limit would have been exceeded, so any data point there is
  worth reading.
- **Logs Insights** on `aws-waf-logs-<name_prefix>`: `nonTerminatingMatchingRules`
  names the module's own rules that matched, and `ruleGroupList` the managed
  sub-rules. A managed sub-rule matching legitimate municipality traffic — an
  attachment upload, a long form POST — needs a downgrade in this module before
  the environment is enforced.

Then set `enforce = true`, test environments first. It is an in-place web ACL
update, and it retargets the alarms from `CountedRequests` to `CaptchaRequests`
in the same apply.

Before enforcing a production environment, check what talks to the public ALB
besides browsers. CAPTCHA answers with a challenge page that only a browser can
solve, so an integration client hitting the rate limit gets a failure it cannot
recover from.

## Usage

```hcl
module "waf" {
  count  = var.alb_enabled && var.waf_enabled ? 1 : 0
  source = "git::https://github.com/espoon-voltti/evaka-infra-shared.git//modules/waf?ref=v12&depth=1"

  name_prefix = "${var.project}-${var.environment}"
  alb_arn     = module.ecs.public_alb_arn
  kms_key_id  = aws_kms_key.encryption.arn

  alarm_sns_topic_arn = module.alarms.alarm_sns_topic_arn

  # Start counting; flip to true once the metrics and logs have been read.
  # enforce = true
}
```

## Inputs

| Name                       | Type           | Required | Default | Description                                                                                                                                                                                             |
| -------------------------- | -------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name_prefix`              | `string`       | yes      | —       | Prefix for the web ACL, its rules, the IP set and the log group. Example: `"evakaoulu-prod"`. Rule names are CloudWatch metric names, so changing it resets metric history.                             |
| `alb_arn`                  | `string`       | yes      | —       | Public ALB to associate the web ACL with. Never an internal ALB — its CAPTCHA actions only a browser can answer.                                                                                        |
| `enforce`                  | `bool`         | no       | `false` | `false` counts every rate-limit, geo and managed-group match without acting on it. `true` gives them CAPTCHA, BLOCK and the group actions. See [Rolling out in COUNT mode](#rolling-out-in-count-mode). |
| `rate_limit`               | `number`       | no       | `600`   | Requests per IP per 5 minutes, for everyone outside the whitelist.                                                                                                                                      |
| `rate_limit_whitelist`     | `number`       | no       | `10000` | Requests per IP per 5 minutes for whitelisted addresses.                                                                                                                                                |
| `rate_limit_whitelist_ips` | `list(string)` | no       | `[]`    | IPv4 CIDRs getting the raised limit and exemption from the geo rule. Empty creates no IP set and no whitelist rule.                                                                                     |
| `allowed_countries`        | `list(string)` | no       | `null`  | Country codes allowed through the geo rule. `null` creates no geo rule; `["FI"]` fences the environment off to Finland.                                                                                 |
| `basic_auth_exception`     | `string`       | no       | `null`  | Base64 `user:password` that exempts a request from every rule below priority 50. Sensitive.                                                                                                             |
| `alarm_sns_topic_arn`      | `string`       | no       | `null`  | SNS topic for the rate-limit alarms, in this module's region. `null` creates no alarms.                                                                                                                 |
| `kms_key_id`               | `string`       | no       | `null`  | KMS key encrypting the log group. Its policy must allow `logs.<region>.amazonaws.com`.                                                                                                                  |
| `log_retention_in_days`    | `number`       | no       | `30`    | Retention of the WAF log group.                                                                                                                                                                         |
| `enable_sampled_requests`  | `bool`         | no       | `true`  | Keep a sample of matched requests for the console. **Samples are not redacted** — see below.                                                                                                            |

## Outputs

| Name               | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `web_acl_arn`      | ARN of the web ACL.                                                |
| `web_acl_name`     | Name of the web ACL, also the `WebACL` metric dimension.           |
| `web_acl_capacity` | WCUs the rule set consumes.                                        |
| `ip_set_arn`       | ARN of the whitelist IP set, or `null` when no whitelist is given. |
| `log_group_name`   | Name of the WAF log group.                                         |
| `log_group_arn`    | ARN of the WAF log group.                                          |

## Things to know

- **Sampled requests are not redacted.** The log redaction covers the log group
  only; the console's sampled-requests view shows the `Authorization` and
  `Cookie` headers of matched requests to anyone who can read the ACL. Set
  `enable_sampled_requests = false` where that matters more than the
  convenience.
- **The KMS key policy gates log group creation.** `kms_key_id` needs a key
  whose policy lets `logs.<region>.amazonaws.com` encrypt with it, or the log
  group fails to create.
- **Capacity.** This rule set uses most of the default 1500 WCU per web ACL.
  Check `web_acl_capacity` before adding another managed rule group; more than
  that needs a quota increase.
- **Log volume.** Every evaluated request is logged, so CloudWatch Logs
  ingestion scales with traffic. `log_retention_in_days` caps the storage, not
  the ingestion.
- **The log group name cannot change.** WAFv2 only accepts a destination whose
  name starts with `aws-waf-logs-`, and renaming the group replaces it.
- **Avoid parallel applies against one environment.** Concurrent web ACL
  updates can fail with `WAFOptimisticLockException`.
