# evaka-infra-shared

Shared Terraform modules for [eVaka](https://github.com/espoon-voltti/evaka)
deployments.

## Modules

- [`modules/slack-notifier`](modules/slack-notifier/README.md) — Lambda that
  forwards CloudWatch alarm state changes and application log errors to Slack.

## Development

Run `npm test` and `terraform fmt -check -recursive modules/`.
