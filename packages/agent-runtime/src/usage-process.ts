import type { ChildProcess } from "node:child_process";
import { stopOwnedProcess } from "@petrina/platform/owned-process";
import type { ProcessDeadline } from "@petrina/platform/process-capabilities";

export interface UsageReadContext {
  readonly signal: AbortSignal;
  onGone(cleanup: Promise<void>): void;
}
export interface UsageProcessOptions {
  signal?: AbortSignal;
  onGone?: (cleanup: Promise<void>) => void;
  onProcess?: (child: ChildProcess) => void;
}
const arm: ProcessDeadline = (expire, ms) => {
  const timer = setTimeout(expire, ms);
  return () => clearTimeout(timer);
};
const stoppedRead = () => new Error("The account usage read was stopped");

/** Join an actual handle's native termination and its owned descriptors, independently of exit notifications. */
export function usageChild(child: ChildProcess) {
  let spawned = child.pid !== undefined;
  let failedStart = false;
  let closed = false;
  const birth = Promise.withResolvers<void>();
  if (spawned) birth.resolve();
  const exited = new Promise<number>((resolve, reject) => {
    child.once("spawn", () => {
      spawned = true;
      birth.resolve();
    });
    child.once("exit", code => Number.isInteger(code) ? resolve(code!) : reject(new Error("The account reader ended by signal")));
    child.once("error", error => {
      failedStart = !spawned;
      reject(error);
    });
    if (child.exitCode !== null) resolve(child.exitCode);
    else if (child.signalCode !== null) reject(new Error("The account reader ended by signal"));
  });
  void exited.catch(() => undefined);
  const close = new Promise<void>(resolve => { child.once("close", () => {
    closed = true;
    birth.resolve();
    resolve();
  }); });
  const streams = [child.stdin, child.stdout, child.stderr].filter(stream => stream !== null);
  for (const stream of streams) stream.on("error", () => undefined);
  const output = Promise.all(streams.map(stream => stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream.once("close", resolve))));
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    const done = Promise.withResolvers<void>();
    stopping = done.promise;
    void (async () => {
      // A missing executable can report its error before close. Wait for the actual
      // birth/close boundary within the existing graceful-stop phase.
      let graceMs = 2_000;
      if (!spawned && !closed) {
        const started = performance.now();
        let cancel = () => {};
        try { await Promise.race([birth.promise, new Promise<void>(resolve => { cancel = arm(resolve, 2_000); })]); }
        finally { cancel(); }
        graceMs = Math.max(1, 2_000 - Math.max(0, performance.now() - started));
      }
      // A reported failed spawn plus its actual close is positive no-child evidence; missing PID alone is not.
      const ended = failedStart && !spawned && closed ? "confirmed" : !spawned ? "unconfirmed" : await stopOwnedProcess({
        exited, get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
        kill: signal => child.kill(signal),
      }, { graceMs, forceMs: 2_000 }, arm);
      // Keep the old SIGTERM/force sequence. Closing stdin earlier would let a stubborn fixture escape it.
      for (const stream of streams) if (!stream.closed) stream.destroy();
      let cancel = () => {};
      let pipes = false;
      try { pipes = await Promise.race([
        output.then(() => true),
        close.then(() => true),
        new Promise<false>(resolve => { cancel = arm(
        () => resolve(false),
        2_000
      ); })
      ]); }
      finally { cancel(); }
      if (ended !== "confirmed" || !pipes) throw new Error("Account usage cleanup was not confirmed");
    })().then(done.resolve, done.reject);
    void stopping.catch(() => undefined);
    return stopping;
  };
  return { stop };
}

/** Preserve a logical failure independently from cleanup authority, including a rejection with undefined. */
export async function usageResult<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let value!: T;
  let failure: { error: unknown } | undefined;
  try { value = await work(); } catch (error) { failure = { error }; }
  try { await cleanup(); }
  catch (error) {
    if (failure) throw new AggregateError([failure.error, error], "Account usage and cleanup both failed");
    throw error;
  }
  if (failure) throw failure.error;
  return value;
}

/** One duplex protocol's owned child. Observers run only inside its cleanup scope. */
export async function withUsageProcess<T>(options: UsageProcessOptions, start: () => ChildProcess, read: (child: ChildProcess, signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const gone = Promise.withResolvers<void>();
  void gone.promise.catch(() => undefined);
  let owned: ReturnType<typeof usageChild> | undefined;
  let reading: Promise<T> | undefined;
  const abort = () => {
    controller.abort(stoppedRead());
    void owned?.stop().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return usageResult(async () => {
    options.onGone?.(gone.promise);
    if (controller.signal.aborted) throw controller.signal.reason;
    const child = start();
    owned = usageChild(child);
    options.onProcess?.(child);
    if (controller.signal.aborted) throw controller.signal.reason;
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    reading = read(child, controller.signal);
    return await Promise.race([reading, cancelled]);
  }, async () => {
    options.signal?.removeEventListener("abort", abort);
    try {
      controller.abort(stoppedRead());
      await owned?.stop();
      await Promise.allSettled(reading ? [reading] : []);
      gone.resolve();
    }
    catch (error) {
      gone.reject(error);
      throw error;
    }
  });
}
