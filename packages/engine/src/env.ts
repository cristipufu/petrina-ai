// The environment Petrina's processes run in. Credentials: what keeps "only the shipper
// publishes" true whatever an agent runs. Everything else about safety is each tool's own
// checker (Claude Code's Auto mode, Codex's Auto review): Petrina does not read commands.
// And the PATH: an app opened from the Dock still finds the user's tools.

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

const MARK = "__petrina_env__";

/**
 * Apps opened from the Dock or an app menu get a bare PATH, so Claude Code, Codex and node
 * would look missing. Ask the user's login shell for the PATH their terminal has. Undefined on
 * Windows (apps get the user's PATH there), and when the shell is slow or prints no PATH.
 */
export async function loginShellPath(env: NodeJS.ProcessEnv = process.env, timeoutMs = 4000): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const shell = env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  try {
    const proc = Bun.spawn([shell, "-ilc", `echo ${MARK}; /usr/bin/env; echo ${MARK}`], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env, windowsHide: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Something the shell's setup started may hold its output open: never wait past the limit.
    const output = await Promise.race([new Response(proc.stdout).text(), new Promise<string>((resolve) => (timer = setTimeout(() => resolve(""), timeoutMs)))]);
    clearTimeout(timer);
    proc.kill();
    return pathFromEnv(output);
  } catch {
    return undefined;
  }
}

/** The PATH line between the markers of `env` output. */
export function pathFromEnv(output: string): string | undefined {
  const [, inside] = output.split(MARK);
  const line = inside?.split("\n").find((entry) => entry.startsWith("PATH="));
  const value = line?.slice("PATH=".length).trim();
  return value ? value : undefined;
}

/** The shell's PATH first, then anything only the current one has. */
export function mergePath(preferred: string | undefined, current: string | undefined, separator = process.platform === "win32" ? ";" : ":"): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...(preferred ?? "").split(separator), ...(current ?? "").split(separator)]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(separator);
}
