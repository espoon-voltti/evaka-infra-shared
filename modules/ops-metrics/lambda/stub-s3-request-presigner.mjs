// Stub for @aws-sdk/s3-request-presigner. mock-aws-loader.mjs loads this in
// place of the real SDK.

export async function getSignedUrl(client, command, { expiresIn }) {
  const { Bucket, Key } = command.input
  return `https://${Bucket}.s3.stub/${Key}?X-Amz-Expires=${expiresIn}`
}
