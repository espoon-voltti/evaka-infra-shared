// Stub for @aws-sdk/client-cloudwatch. mock-aws-loader.mjs loads this in place
// of the real SDK. `cloudwatchStub` lets tests queue DescribeAlarms responses
// and inspect what was sent.

export const cloudwatchStub = {
  describeAlarmsResponses: [],
  describeAlarmsError: null,
  calls: [],
  reset() {
    this.describeAlarmsResponses = []
    this.describeAlarmsError = null
    this.calls = []
  }
}

export class CloudWatchClient {
  constructor() {}

  async send(command) {
    cloudwatchStub.calls.push(command)

    if (command instanceof DescribeAlarmsCommand) {
      if (cloudwatchStub.describeAlarmsError) {
        throw cloudwatchStub.describeAlarmsError
      }
      const response = cloudwatchStub.describeAlarmsResponses.shift()
      if (!response) {
        throw new Error(
          'stub-cloudwatch: no more DescribeAlarms responses queued'
        )
      }
      return response
    }

    throw new Error(
      `stub-cloudwatch: unsupported command ${command?.constructor?.name}`
    )
  }
}

export class DescribeAlarmsCommand {
  constructor(params) {
    this.input = params
  }
}
