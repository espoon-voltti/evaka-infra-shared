// Custom ESM resolve hook that redirects AWS SDK imports to local stub files.

const STUBS = {
  '@aws-sdk/client-cloudwatch': './stub-cloudwatch.mjs',
  '@aws-sdk/client-cloudwatch-logs': './stub-cloudwatch-logs.mjs',
  '@aws-sdk/client-s3': './stub-s3.mjs',
  '@aws-sdk/client-ssm': './stub-ssm.mjs',
  '@aws-sdk/s3-request-presigner': './stub-s3-request-presigner.mjs'
}

export function resolve(specifier, context, nextResolve) {
  if (specifier in STUBS) {
    return {
      shortCircuit: true,
      url: new URL(STUBS[specifier], import.meta.url).href
    }
  }
  return nextResolve(specifier, context)
}
