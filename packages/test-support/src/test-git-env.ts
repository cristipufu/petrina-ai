/** Git config injected into Petrina's processes must not leak into test-owned repositories. */
export function testGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of Object.keys(clean)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(name)
    || [
      "GIT_SSH_COMMAND",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES"
    ].includes(name)) delete clean[name];
  return clean;
}
