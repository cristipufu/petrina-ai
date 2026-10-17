// The environment Petrina's processes run in. Agents act with the coordinator's own logins (GitHub,
// git credential helpers, SSH, AWS, Azure): they read freely, and their instructions say never to
// publish or change shared things, which rests on each tool's own checker (Claude Code's Auto mode,
// Codex's Auto review): Petrina does not read commands. Petrina's own git steps on working copies, and
// the product's checks and hooks it runs, get no login at all.
// And the PATH: an app opened from the Dock still finds the user's tools.

const CREDENTIAL_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"];
/**
 * What marks a process as part of another coding agent's session: an engine started from inside Claude Code
 * or Codex would hand them on, and its agents would take themselves for that session's children (Claude Code
 * then links to its messaging socket, and CLAUDE_EFFORT overrides the effort Petrina sets). The user's own
 * settings for the tools (CLAUDE_CODE_USE_BEDROCK, say) are not on this list and pass through.
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
];
/** A GitHub token by its look, whatever the variable holding it is called (an npm registry's, say). */
const GITHUB_TOKEN = /^\s*(gh[pousr]_|github_pat_)/;

/**
 * The environment every agent runs in: the coordinator's own, logins included, with nothing that waits
 * for a typed answer, and in the background (tools that would open a browser stay quiet, and Petrina's
 * own `open` refuses).
 */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...ownSession(env), GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", BROWSER: "none", PETRINA_AGENT: "1" };
}

/** The environment without another coding agent's session in it: what Petrina starts is a session of its own. */
export function ownSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of SESSION_VARS) delete clean[name];
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
  // Whole marker lines only: an interactive dash exports `_=__petrina_env__`, which must not count.
  const lines = output.split("\n").map((entry) => entry.replace(/\r$/, ""));
  const start = lines.indexOf(MARK);
  const end = lines.lastIndexOf(MARK);
  if (start < 0 || end <= start) return undefined;
  const line = lines.slice(start + 1, end).find((entry) => entry.startsWith("PATH="));
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
