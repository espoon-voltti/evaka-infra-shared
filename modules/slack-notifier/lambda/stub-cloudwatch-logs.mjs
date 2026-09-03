// Stub for @aws-sdk/client-cloudwatch-logs. mock-aws-loader.mjs loads this in
// place of the real SDK. `cloudwatchLogsStub` lets tests script responses per
// command and inspect what was sent.

export const cloudwatchLogsStub = {
  describeLogGroupsResponses: [],
  startQueryResponse: { queryId: 'stub-query-id' },
  startQueryError: null,
  getQueryResultsResponses: [
    { status: 'Complete', results: [], statistics: null }
  ],
  calls: [],
  reset() {
    this.describeLogGroupsResponses = []
    this.startQueryResponse = { queryId: 'stub-query-id' }
    this.startQueryError = null
    this.getQueryResultsResponses = [
      { status: 'Complete', results: [], statistics: null }
    ]
    this.calls = []
  }
}

export class CloudWatchLogsClient {
  constructor() {}

  async send(command) {
    cloudwatchLogsStub.calls.push(command)

    if (command instanceof DescribeLogGroupsCommand) {
      const response = cloudwatchLogsStub.describeLogGroupsResponses.shift()
      if (!response) {
        throw new Error(
          'stub-cloudwatch-logs: no more DescribeLogGroups responses queued'
        )
      }
      return response
    }

    if (command instanceof StartQueryCommand) {
      if (cloudwatchLogsStub.startQueryError) {
        throw cloudwatchLogsStub.startQueryError
      }
      return cloudwatchLogsStub.startQueryResponse
    }

    if (command instanceof GetQueryResultsCommand) {
      const response = cloudwatchLogsStub.getQueryResultsResponses.shift()
      if (!response) {
        throw new Error(
          'stub-cloudwatch-logs: no more GetQueryResults responses queued'
        )
      }
      return response
    }

    throw new Error(
      `stub-cloudwatch-logs: unsupported command ${command?.constructor?.name}`
    )
  }
}

export class StartQueryCommand {
  constructor(params) {
    this.input = params
  }
}

export class GetQueryResultsCommand {
  constructor(params) {
    this.input = params
  }
}

export class DescribeLogGroupsCommand {
  constructor(params) {
    this.input = params
  }
}
