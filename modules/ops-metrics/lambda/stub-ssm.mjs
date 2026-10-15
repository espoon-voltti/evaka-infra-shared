// Stub for @aws-sdk/client-ssm. mock-aws-loader.mjs loads this in place of the
// real SDK. `ssmStub` lets tests set the parameter value and count the calls.

export const ssmStub = {
  parameterValue: 'stub-token',
  error: null,
  calls: [],
  reset() {
    this.parameterValue = 'stub-token'
    this.error = null
    this.calls = []
  }
}

export class SSMClient {
  async send(command) {
    if (command instanceof GetParameterCommand) {
      ssmStub.calls.push(command)
      if (ssmStub.error) throw ssmStub.error
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
