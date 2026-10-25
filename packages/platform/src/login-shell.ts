import { pathFromEnv } from "./environment-values.js";
import { readOwnedProcessOutput, ProcessOutputCleanupError, type OutputProcess } from "./process-output.js";
import type { ProcessDeadline } from "./process-capabilities.js";

const MARK = "__petrina_env__";
const GRACE_MS = 100, FORCE_MS = 400;
const arm: ProcessDeadline = (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); };

export interface LoginShellProcess extends OutputProcess {}
export interface LoginShellOptions {
  signal?: AbortSignal;
  /** A private native starter for login-shell boundary contracts. Ownership transfers to this call. */
  start?: (shell: string, command: string, env: NodeJS.ProcessEnv) => LoginShellProcess;
  /** Private deadline effects for deterministic ownership/uncertainty contracts. */
  arm?: ProcessDeadline;
}

export class LoginShellCleanupError extends Error {
  readonly cleanup = "unconfirmed";
  constructor(readonly processStopped: boolean, readonly outputClosed: boolean) {
    super(processStopped ? "Petrina couldn't finish closing its login-shell output." : "Petrina couldn't confirm that its login-shell helper stopped.");
    this.name = "LoginShellCleanupError";
  }
}

/**
 * Apps opened from the Dock or an app menu get a bare PATH, so Claude Code, Codex and node
 * would look missing. Ask the user's login shell for the PATH their terminal has. Undefined on
 * Windows (apps get the user's PATH there), and when the shell is slow or prints no PATH.
 * The read keeps its own deadline; stopping the owned helper has a separate bounded allowance.
 */
export async function loginShellPath(env: NodeJS.ProcessEnv = process.env, timeoutMs = 4000, options: LoginShellOptions = {}): Promise<string | undefined> {
  if (process.platform === "win32" || options.signal?.aborted) return undefined;
  const shell = env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  let output: string | undefined;
  try {
    output = await readOwnedProcessOutput({
      start: () => {
        const command = `echo ${MARK}; /usr/bin/env; echo ${MARK}`;
        return options.start ? options.start(shell, command, env)
          : Bun.spawn([shell, "-ilc", command], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env, windowsHide: true });
      },
      arm: options.arm ? (expired, ms) => options.arm!(expired, ms) : arm, signal: options.signal, timeoutMs,
      graceMs: GRACE_MS, forceMs: FORCE_MS, completion: "output",
    });
  } catch (error) {
    if (error instanceof ProcessOutputCleanupError) throw new LoginShellCleanupError(error.processStopped, error.outputClosed);
    throw error;
  }
  return options.signal?.aborted ? undefined : pathFromEnv(output ?? "");
}
