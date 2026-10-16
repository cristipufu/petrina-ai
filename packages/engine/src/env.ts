// What keeps "only the shipper publishes" true whatever an agent runs. Everything else about
// safety is each tool's own checker (Claude Code's Auto mode, Codex's Auto review): Petrina
// does not read commands.

const CREDENTIAL_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"];

/**
 * The environment for agents that must not publish anything. They get no GitHub credentials
 * at all: no tokens, an empty gh config, git credential helpers reset, and no SSH for git.
 */
export function agentEnv(env: NodeJS.ProcessEnv, emptyGhConfig: string): NodeJS.ProcessEnv {
  const clean = withGitConfig(env, [
    ["credential.helper", ""],
    ["remote.origin.pushurl", "petrina-push-disabled://only-the-shipper-pushes"],
    ["core.sshCommand", "petrina-ssh-disabled"],
  ]);
  for (const name of CREDENTIAL_VARS) delete clean[name];
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
