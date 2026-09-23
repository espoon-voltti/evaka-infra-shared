# evaka-infra-shared

Shared Terraform modules for [eVaka](https://github.com/espoon-voltti/evaka)
deployments.

## Modules

- [`modules/slack-notifier`](modules/slack-notifier/README.md) — Lambda that
  forwards CloudWatch alarm state changes and application log errors to Slack.
- [`modules/waf`](modules/waf/README.md) — AWS WAFv2 web ACL for a public ALB:
  rate limiting, geo fence and the AWS managed rule groups, with eVaka's own
  rule set and priorities.

## Development

Run `npm test` and `terraform fmt -check -recursive modules/`.
