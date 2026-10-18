/** Git config injected into Petrina's processes must not leak into test-owned repositories. */
export function testGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of Object.keys(clean)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name) || name === "GIT_SSH_COMMAND") delete clean[name];
  return clean;
}
