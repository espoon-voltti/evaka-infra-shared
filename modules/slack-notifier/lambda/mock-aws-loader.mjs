// Custom ESM resolve hook that redirects AWS SDK imports to local stub files.

const STUBS = {
  '@aws-sdk/client-cloudwatch-logs': new URL(
    './stub-cloudwatch-logs.mjs',
    import.meta.url
  ).href,
  '@aws-sdk/client-ssm': new URL('./stub-ssm.mjs', import.meta.url).href
}

export function resolve(specifier, context, nextResolve) {
  if (specifier in STUBS) {
    return { shortCircuit: true, url: STUBS[specifier] }
  }
  return nextResolve(specifier, context)
}
