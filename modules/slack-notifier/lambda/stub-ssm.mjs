// Stub for @aws-sdk/client-ssm. mock-aws-loader.mjs loads this in place of the
// real SDK. `ssmStub` lets tests control the returned parameter value and
// inspect how many GetParameter calls were issued.

const DEFAULT_VALUE = 'https://hooks.slack.com/services/STUB'

export const ssmStub = {
  parameterValue: DEFAULT_VALUE,
  getParameterCalls: 0,
  reset() {
    this.parameterValue = DEFAULT_VALUE
    this.getParameterCalls = 0
  }
}

export class SSMClient {
  async send(command) {
    if (command instanceof GetParameterCommand) {
      ssmStub.getParameterCalls++
      return { Parameter: { Value: ssmStub.parameterValue } }
    }
    throw new Error(
      `stub-ssm: unsupported command ${command?.constructor?.name}`
    )
  }
}

export class GetParameterCommand {
  constructor(params) {
    this.input = params
  }
}
