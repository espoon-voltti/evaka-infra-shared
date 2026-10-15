// Stub for @aws-sdk/client-s3. mock-aws-loader.mjs loads this in place of the
// real SDK. `s3Stub.objects` is an in-memory bucket keyed by object key.

export const s3Stub = {
  objects: new Map(),
  calls: [],
  reset() {
    this.objects = new Map()
    this.calls = []
  }
}

export class NoSuchKey extends Error {
  constructor(message) {
    super(message)
    this.name = 'NoSuchKey'
  }
}

export class S3Client {
  async send(command) {
    s3Stub.calls.push(command)

    if (command instanceof GetObjectCommand) {
      const object = s3Stub.objects.get(command.input.Key)
      if (!object) throw new NoSuchKey('The specified key does not exist.')
      return {
        Body: { transformToByteArray: async () => new Uint8Array(object.Body) }
      }
    }

    if (command instanceof PutObjectCommand) {
      s3Stub.objects.set(command.input.Key, command.input)
      return {}
    }

    throw new Error(
      `stub-s3: unsupported command ${command?.constructor?.name}`
    )
  }
}

export class GetObjectCommand {
  constructor(params) {
    this.input = params
  }
}

export class PutObjectCommand {
  constructor(params) {
    this.input = params
  }
}
