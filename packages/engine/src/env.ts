// The environment Petrina's processes run in. Agents act with the coordinator's own logins (GitHub,
// git credential helpers, SSH, AWS, Azure): they read freely, and their instructions say never to
// publish or change shared things, which rests on each tool's own checker (Claude Code's Auto mode,
// Codex's Auto review, Grok's auto mode): Petrina does not read commands. Petrina's own git steps on working copies, and
// the product's checks and hooks it runs, get no login at all.
// And the PATH: an app opened from the Dock still finds the user's tools.

import { ownSession, withGitConfig } from "@petrina/platform/process-environment";

/** Programs that ask for a password or passphrase in a window: git and ssh fall back to them when a login is missing. */
const ASKPASS_VARS = ["GIT_ASKPASS", "SSH_ASKPASS"];

/**
 * The environment every agent runs in: the coordinator's own, logins included, with nothing that waits
 * for a typed answer or opens a sign-in window, and in the background (tools that would open a browser
 * stay quiet, and Petrina's own `open` refuses). Saved logins keep working: git's credential helpers stay
 * as configured, and only the programs that would ask are off (git's askpass, also from core.askPass;
 * ssh's; Git Credential Manager's windows, the Azure DevOps helper). A missing or expired login fails
 * instead, and the coordinator renews it in their own terminal.
 */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const own = ownSession(env);
  for (const name of ASKPASS_VARS) delete own[name];
  return {
    ...withGitConfig(own, [["core.askPass", ""]]),
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS_REQUIRE: "never",
    BROWSER: "none",
    PETRINA_AGENT: "1",
  };
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
