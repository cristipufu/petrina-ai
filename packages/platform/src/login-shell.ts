import { pathFromEnv } from "./environment-values.js";

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
