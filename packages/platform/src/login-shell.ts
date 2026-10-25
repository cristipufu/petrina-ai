import type { ReadableStreamDefaultReader } from "node:stream/web";
import { pathFromEnv } from "./environment-values.js";
import { stopOwnedProcess, type OwnedProcess } from "./owned-process.js";
import type { ProcessDeadline } from "./process-capabilities.js";

const MARK = "__petrina_env__";
const GRACE_MS = 100, FORCE_MS = 400;
const arm: ProcessDeadline = (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); };

export interface LoginShellProcess extends OwnedProcess { readonly stdout: ReadableStream<Uint8Array> }
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

async function within<T>(work: Promise<T>, ms: number, unavailable: T, arm: ProcessDeadline): Promise<T> {
  let cancel = () => {};
  try { return await Promise.race([work, new Promise<T>(resolve => { cancel = arm(() => resolve(unavailable), ms); })]); }
  finally { cancel(); }
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
  let child: LoginShellProcess | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let output: string | undefined, cancelRead = () => {};
  let errored = Promise.resolve(false);
  const deadline = options.arm ?? arm;
  let abort: (() => void) | undefined;
  try {
    const command = `echo ${MARK}; /usr/bin/env; echo ${MARK}`;
    child = options.start ? options.start(shell, command, env)
      : Bun.spawn([shell, "-ilc", command], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env, windowsHide: true });
    const reading = child.stdout.getReader();
    reader = reading;
    // cancel() rejects for an already-errored stream; that closed reader is distinct from
    // an underlying cancellation that rejects or never completes.
    errored = reading.closed.then(() => false, () => true);
    const text = (async () => {
      const decoder = new TextDecoder();
      let value = "";
      for (;;) {
        const next = await reading.read();
        if (next.done) return value + decoder.decode();
        value += decoder.decode(next.value, { stream: true });
      }
    })();
    // A descendant can retain stdout after this helper exits; the read never waits past its limit.
    output = await Promise.race([text,
      new Promise<undefined>(resolve => { cancelRead = deadline(() => resolve(undefined), timeoutMs); }),
      new Promise<undefined>(resolve => {
        abort = () => resolve(undefined);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      }),
    ]);
  } catch {
    // Startup/read failures cannot establish a PATH; cleanup below still owns a started helper.
  } finally {
    cancelRead();
    if (abort) options.signal?.removeEventListener("abort", abort);
    let closing = Promise.resolve(true);
    try { if (reader) closing = within(reader.cancel().then(() => true, () => errored), GRACE_MS + FORCE_MS, false, deadline); }
    catch { closing = Promise.resolve(false); }
    const [stopped, closed] = await Promise.all([
      child ? stopOwnedProcess(child, { graceMs: GRACE_MS, forceMs: FORCE_MS }, deadline) : Promise.resolve("confirmed"), closing,
    ]);
    try { reader?.releaseLock(); } catch { /* A timed-out cancellation leaves cleanup explicitly unconfirmed. */ }
    if (stopped !== "confirmed" || !closed) throw new LoginShellCleanupError(stopped === "confirmed", closed);
  }
  return options.signal?.aborted ? undefined : pathFromEnv(output ?? "");
}
