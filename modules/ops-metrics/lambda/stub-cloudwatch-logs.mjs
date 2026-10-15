// Stub for @aws-sdk/client-cloudwatch-logs. mock-aws-loader.mjs loads this in
// place of the real SDK. `cloudwatchLogsStub` lets tests script the query
// results for each StartQuery and inspect what was sent.

export const cloudwatchLogsStub = {
  queryResults: [],
  calls: [],
  reset() {
    this.queryResults = []
    this.calls = []
  }
}

let queryCount = 0

export class CloudWatchLogsClient {
  async send(command) {
    cloudwatchLogsStub.calls.push(command)

    if (command instanceof StartQueryCommand) {
      return { queryId: `stub-query-${queryCount++}` }
    }

    if (command instanceof GetQueryResultsCommand) {
      const response = cloudwatchLogsStub.queryResults.shift()
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
