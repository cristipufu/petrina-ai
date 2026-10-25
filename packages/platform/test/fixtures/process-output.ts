import { readOwnedProcessOutput, type OutputProcess, type ProcessOutputOptions } from "../../src/process-output.js";
import type { ProcessDeadline } from "../../src/process-capabilities.js";

export const flushOutput = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

/** Scripted process records and WHATWG stream events; no native child, clock or file. */
export function outputFixture(options: { stops?: boolean; cancellation?: "pending" | "rejected" } = {}) {
  const completion = Promise.withResolvers<number>(), signals: string[] = [];
  let exitCode: number | null = null, signalCode: string | null = null;
  let controller!: ReadableStreamDefaultController<Uint8Array>, starts = 0, cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() {
    cancellations++;
    if (options.cancellation === "rejected") throw new Error("Output cancellation failed");
    if (options.cancellation === "pending") return new Promise<void>(() => {});
  } });
  const child: OutputProcess = {
    stdout: stream, exited: completion.promise,
    get exitCode() { return exitCode; }, get signalCode() { return signalCode; },
    kill(signal) { signals.push(signal); if (options.stops !== false) { signalCode = signal; exitCode = 0; completion.resolve(0); } },
  };
  const timers = new Map<number, { ms: number; expire: () => void }>(); let next = 0;
  const arm: ProcessDeadline = (expire, ms) => { const id = ++next; timers.set(id, { ms, expire }); return () => { timers.delete(id); }; };
  return { child, stream, signals, timers, arm,
    get starts() { return starts; }, get cancellations() { return cancellations; },
    read(overrides: Partial<ProcessOutputOptions> = {}) {
      return readOwnedProcessOutput({ start: () => { starts++; return child; }, arm, timeoutMs: 10_000, graceMs: 100, forceMs: 400, completion: "successful-exit", ...overrides });
    },
    write(text: string) { controller.enqueue(new TextEncoder().encode(text)); },
    bytes(value: Uint8Array) { controller.enqueue(value); },
    end() { controller.close(); }, error(error: Error) { controller.error(error); },
    exit(code: number) { exitCode = code; completion.resolve(code); },
    loseExit(error: unknown) { completion.reject(error); },
    async expire(ms: number) {
      await flushOutput();
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      if (!entry) throw new Error(`No ${ms}ms output deadline is armed`);
      timers.delete(entry[0]); entry[1].expire(); await flushOutput();
    },
  };
}
