// What keeps "only the shipper publishes" true whatever an agent runs. Everything else about
// safety is each tool's own checker (Claude Code's Auto mode, Codex's Auto review): Petrina
// does not read commands.

const CREDENTIAL_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"];

/**
 * The environment for agents that must not publish anything. They get no GitHub credentials
 * at all: no tokens, an empty gh config, git credential helpers reset, and no SSH for git.
 */
export function agentEnv(env: NodeJS.ProcessEnv, emptyGhConfig: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of CREDENTIAL_VARS) delete clean[name];
  const count = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  const settings: [string, string][] = [
    ["credential.helper", ""],
    ["remote.origin.pushurl", "petrina-push-disabled://only-the-shipper-pushes"],
    ["core.sshCommand", "petrina-ssh-disabled"],
  ];
  settings.forEach(([key, value], index) => {
    clean[`GIT_CONFIG_KEY_${count + index}`] = key;
    clean[`GIT_CONFIG_VALUE_${count + index}`] = value;
  });
  clean.GIT_CONFIG_COUNT = String(count + settings.length);
  clean.GIT_SSH_COMMAND = "petrina-ssh-disabled";
  clean.GIT_TERMINAL_PROMPT = "0";
  clean.GH_CONFIG_DIR = emptyGhConfig;
  clean.GH_PROMPT_DISABLED = "1";
  return clean;
}
