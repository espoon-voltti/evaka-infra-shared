// Stub for @aws-sdk/client-cloudwatch. mock-aws-loader.mjs loads this in place
// of the real SDK. `cloudwatchStub` lets tests queue GetMetricData pages and
// inspect what was sent.

export const cloudwatchStub = {
  responses: [],
  error: null,
  calls: [],
  reset() {
    this.responses = []
    this.error = null
    this.calls = []
  }
}

export class CloudWatchClient {
  async send(command) {
    cloudwatchStub.calls.push(command)
    if (command instanceof GetMetricDataCommand) {
      if (cloudwatchStub.error) throw cloudwatchStub.error
      return cloudwatchStub.responses.shift() ?? { MetricDataResults: [] }
    }
    throw new Error(
      `stub-cloudwatch: unsupported command ${command?.constructor?.name}`
    )
  }
}

export class GetMetricDataCommand {
  constructor(params) {
    this.input = params
  }
}
