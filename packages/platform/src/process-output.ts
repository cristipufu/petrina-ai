import type { ReadableStreamDefaultReader } from "node:stream/web";
import { stopOwnedProcess, type OwnedProcess } from "./owned-process.js";
import type { ProcessDeadline } from "./process-capabilities.js";

/** The caller transfers one actual handle and its output, never signal authority from a saved PID. */
export interface OutputProcess extends OwnedProcess { readonly stdout: ReadableStream<Uint8Array> }
export interface ProcessOutputOptions {
  start(): OutputProcess;
  arm: ProcessDeadline;
  timeoutMs: number;
  graceMs: number;
  forceMs: number;
  /** Login-shell discovery accepts complete output before exit; command probes need both output and success. */
  completion: "output" | "successful-exit";
  signal?: AbortSignal;
}

export class ProcessOutputCleanupError extends Error {
  readonly cleanup = "unconfirmed";
  /** Process completion describes this owned helper only, not its descendants. */
  constructor(readonly processStopped: boolean, readonly outputClosed: boolean) {
    super(processStopped ? "Petrina couldn't finish closing its helper's output." : "Petrina couldn't confirm that its helper stopped.");
    this.name = "ProcessOutputCleanupError";
  }
}

async function within<T>(work: Promise<T>, ms: number, unavailable: T, arm: ProcessDeadline): Promise<T> {
  let cancel = () => {};
  try { return await Promise.race([work, new Promise<T>(resolve => { cancel = arm(() => resolve(unavailable), ms); })]); }
  finally { cancel(); }
}

/** Read and dispose one helper. Unavailable output is distinct from unconfirmed native/output cleanup. */
export async function readOwnedProcessOutput(options: ProcessOutputOptions): Promise<string | undefined> {
  if (options.signal?.aborted) return undefined;
  for (const [name, ms] of [["read", options.timeoutMs], ["grace", options.graceMs], ["force", options.forceMs]] as const) {
    if (!(Number.isFinite(ms) && ms >= (name === "read" ? 0 : 1) && ms <= 2_147_483_647))
      throw new RangeError("Process output needs bounded read and positive cleanup deadlines.");
  }
  if (options.graceMs + options.forceMs > 2_147_483_647) throw new RangeError("Process output cancellation needs a bounded deadline.");
  const deadline: ProcessDeadline = (expired, ms) => options.arm(expired, ms);
  let child: OutputProcess | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let output: string | undefined, cancelRead = () => {};
  let errored = Promise.resolve(false), abort: (() => void) | undefined;
  try {
    child = options.start();
    const exited = child.exited;
    // Output-first callers still own a completion which may reject before their read finishes.
    void exited.catch(() => undefined);
    const reading = child.stdout.getReader();
    reader = reading;
    // A reader already in its errored state is closed. Rejected/pending underlying cancellation is not.
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
    const complete = options.completion === "output" ? text : Promise.all([text, exited.then(code => {
      if (code !== 0) throw new Error("The helper did not report a successful exit.");
    })]).then(([value]) => value);
    output = await Promise.race([complete,
      new Promise<undefined>(resolve => { cancelRead = deadline(() => resolve(undefined), options.timeoutMs); }),
      new Promise<undefined>(resolve => {
        abort = () => resolve(undefined);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      }),
    ]);
  } catch {
    // Startup, read and command failures establish no output; finally still owns a started helper.
  } finally {
    cancelRead();
    if (abort) options.signal?.removeEventListener("abort", abort);
    let closing = Promise.resolve(true);
    try {
      if (reader) closing = within(reader.cancel().then(() => true, () => errored), options.graceMs + options.forceMs, false, deadline);
      else if (child) {
        // In particular, a pipe locked by another reader cannot be claimed closed.
        closing = within(child.stdout.cancel().then(() => true, () => false), options.graceMs + options.forceMs, false, deadline);
      }
    } catch { closing = Promise.resolve(false); }
    const [stopped, closed] = await Promise.allSettled([
      child ? stopOwnedProcess(child, { graceMs: options.graceMs, forceMs: options.forceMs }, deadline) : Promise.resolve("confirmed"), closing,
    ]);
    try { reader?.releaseLock(); } catch { /* A pending cancellation remains explicitly unconfirmed. */ }
    const processStopped = stopped.status === "fulfilled" && stopped.value === "confirmed";
    const outputClosed = closed.status === "fulfilled" && closed.value;
    if (!processStopped || !outputClosed) throw new ProcessOutputCleanupError(processStopped, outputClosed);
  }
  return options.signal?.aborted ? undefined : output;
}
