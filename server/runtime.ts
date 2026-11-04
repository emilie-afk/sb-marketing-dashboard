/** True on Netlify or any production runtime; local-only tools refuse to start there. */
export const isDeployedRuntime = () =>
  !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY_LOCAL === "false" || process.env.NODE_ENV === "production");
