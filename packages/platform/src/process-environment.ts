// Shared process-environment transformations. Native adapters preserve the caller's values and
// apply the same session and credential boundaries before starting child programs. No process starts here.

const CREDENTIAL_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"];
/**
 * What marks a process as part of another coding agent's session: an engine started from inside Claude Code,
 * Codex or Grok would hand them on, and its agents would take themselves for that session's children (Claude Code
 * then links to its messaging socket, and CLAUDE_EFFORT overrides the effort Petrina sets). The user's own
 * settings for the tools (CLAUDE_CODE_USE_BEDROCK, GROK_HOME) are not on this list and pass through.
 */
const SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  "GROK_AGENT",
  "GROK_SESSION_ID",
  // One-shot hints for the engine's replacement launcher, never child engines or tools.
  "PETRINA_LIFECYCLE_REPLACEMENT",
  "PETRINA_RECONNECT_PORT",
];
/** A GitHub token by its look, whatever the variable holding it is called (an npm registry's, say). */
const GITHUB_TOKEN = /^\s*(gh[pousr]_|github_pat_)/;

/** The environment without another coding agent's session in it: what Petrina starts is a session of its own. */
export function ownSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of SESSION_VARS) delete clean[name];
  // Restore the user's executable before any provider is launched. A managed
  // agent may start another engine or connector, including from another clone.
  if (clean.PETRINA_CODEX_WRAPPER && clean.CODEX_PATH === clean.PETRINA_CODEX_WRAPPER) {
    if (clean.PETRINA_CODEX_EXECUTABLE) clean.CODEX_PATH = clean.PETRINA_CODEX_EXECUTABLE;
    else delete clean.CODEX_PATH;
  }
  delete clean.PETRINA_CODEX_WRAPPER;
  delete clean.PETRINA_CODEX_EXECUTABLE;
  return clean;
}

/**
 * The environment for what Petrina runs itself that needs no login (its git steps on working copies, the
 * product's checks and hooks): no tokens, an empty gh config, git credential helpers reset, and no SSH for git.
 */
export function withoutCredentials(env: NodeJS.ProcessEnv, emptyGhConfig: string): NodeJS.ProcessEnv {
  const clean = withGitConfig(ownSession(env), [
    ["credential.helper", ""],
    ["remote.origin.pushurl", "petrina-push-disabled://only-petrina-publishes"],
    ["core.sshCommand", "petrina-ssh-disabled"],
  ]);
  for (const name of CREDENTIAL_VARS) delete clean[name];
  for (const [name, value] of Object.entries(clean)) if (value && GITHUB_TOKEN.test(value)) delete clean[name];
  clean.GIT_SSH_COMMAND = "petrina-ssh-disabled";
  clean.GIT_TERMINAL_PROMPT = "0";
  clean.GH_CONFIG_DIR = emptyGhConfig;
  clean.GH_PROMPT_DISABLED = "1";
  return clean;
}

/** Add git settings through the environment; they outrank every config file. */
export function withGitConfig(env: NodeJS.ProcessEnv, settings: readonly (readonly [string, string])[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const count = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  settings.forEach(([key, value], index) => {
    out[`GIT_CONFIG_KEY_${count + index}`] = key;
    out[`GIT_CONFIG_VALUE_${count + index}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(count + settings.length);
  return out;
}
