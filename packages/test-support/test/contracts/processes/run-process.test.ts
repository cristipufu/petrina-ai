import { expect, it } from "bun:test";
import { runCommand, type Started } from "../../../src/commands.js";
import { runProcess } from "../../../src/run-process.js";
import { failureOf } from "../../fixtures/command-failure.js";

/** A controlled process protocol. No OS program exists; a forced stop cannot claim confirmed native cleanup. */
function peer(soft: "finish" | "ignore" | "throw" = "finish") {
  const exit = Promise.withResolvers<number>(), signals: string[] = [];
  let output!: ReadableStreamDefaultController<Uint8Array>, ended = false, code: number | null = null;
  const stop = (signal: NodeJS.Signals = "SIGTERM") => {
    signals.push(signal);
    if (signal !== "SIGKILL" && soft === "throw") throw new Error("The signal was unavailable");
    if (!ended && (soft === "finish" || signal === "SIGKILL")) { ended = true; code = signal === "SIGKILL" ? 137 : 0; output.close(); exit.resolve(code); }
  };
  const child: Started = {
    stdout: new ReadableStream({ start(controller) { output = controller; controller.enqueue(new TextEncoder().encode("ready\n")); } }),
    stderr: new Response("").body!, exited: exit.promise, signalCode: null,
    get exitCode() { return code; },
    interrupt: stop, kill: stop,
  };
  return { child, signals };
}

it("retains a genuine reported nonzero exit and complete captured output", async () => {
  const outcome = await runProcess([process.execPath, "-e", "console.log('out'); console.error('err'); process.exit(3)"], { timeoutMs: 30_000 });
  expect(outcome).toEqual({ kind: "exited", result: { code: 3, stdout: "out\n", stderr: "err\n" } });
});

it("uses owned force cleanup when a handle offers no graceful interrupt capability", async () => {
  const controlled = peer("ignore"), stop = new AbortController();
  const { interrupt: _interrupt, ...child } = controlled.child;
  const failure = await failureOf(runProcess(["controlled"], { start: () => child, signal: stop.signal, timeoutMs: 30_000,
    onOutput: () => { stop.abort("SIGTERM"); },
  }));
  expect(failure.reason).toBe("cancelled"); expect(failure.cleanup).toBe("unconfirmed"); expect(controlled.signals).toEqual(["SIGKILL"]);
});

it("inherits both descriptors without a second in-memory log or pretend captured pipes", async () => {
  const module = new URL("../../../src/run-process.ts", import.meta.url).href;
  const result = await runCommand([process.execPath, "-e", `const { runProcess } = await import(${JSON.stringify(module)});
const outcome = await runProcess([process.execPath, "-e", "console.log('direct-out'); console.error('direct-err')"], { timeoutMs: 30000, output: "inherit" });
console.log(JSON.stringify(outcome));`], { timeoutMs: 30_000 });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('direct-out\n{"kind":"exited","result":{"code":0,"stdout":"","stderr":""}}\n');
  expect(result.stderr).toBe("direct-err\n");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) it(`forwards ${signal} and keeps interruption explicit even when the process exits zero`, async () => {
  const controlled = peer(), stop = new AbortController();
  const outcome = await runProcess(["controlled"], { start: () => controlled.child, signal: stop.signal, timeoutMs: 30_000,
    onOutput: () => { stop.abort(signal); },
  });
  expect(controlled.signals).toEqual([signal]);
  expect(outcome).toEqual({ kind: "interrupted", signal, result: { code: 0, stdout: "ready\n", stderr: "" } });
});

for (const soft of ["ignore", "throw"] as const) it(`forces bounded cleanup when a process's interrupt behavior is ${soft}`, async () => {
  const controlled = peer(soft), stop = new AbortController();
  const failure = await failureOf(runProcess(["controlled"], { start: () => controlled.child, signal: stop.signal, interruptGraceMs: 10, timeoutMs: 30_000,
    onOutput: () => { stop.abort("SIGTERM"); },
  }));
  expect(controlled.signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(failure.reason).toBe("cancelled");
  expect(failure.cleanup).toBe("unconfirmed");
});

it("does not launch for an already requested interruption", async () => {
  const stop = new AbortController(); stop.abort("SIGINT"); let starts = 0;
  const failure = await failureOf(runProcess(["controlled"], { signal: stop.signal, timeoutMs: 30_000, start: () => { starts++; return peer().child; } }));
  expect(starts).toBe(0); expect(failure.reason).toBe("cancelled");
});

it("cannot accept a completed result after an interrupt inside the starter", async () => {
  const stop = new AbortController();
  const failure = await failureOf(runProcess(["controlled"], { signal: stop.signal, timeoutMs: 30_000,
    start: () => { stop.abort("SIGTERM"); return { exited: Promise.resolve(0), signalCode: null, exitCode: 0, kill() {} }; },
  }));
  expect(failure.reason).toBe("cancelled");
});

it("retains a deadline for a process whose inherited output needs no draining but whose exit is never reported", async () => {
  const signals: string[] = [];
  const failure = await failureOf(runProcess(["controlled"], { timeoutMs: 20, output: "inherit",
    start: () => ({ exited: new Promise<number>(() => {}), signalCode: null, kill: signal => { signals.push(signal!); } }),
  }));
  expect(failure.reason).toBe("timeout"); expect(failure.cleanup).toBe("unconfirmed"); expect(signals).toEqual(["SIGKILL"]);
  expect(failure.message).toContain("Its exit was never reported.");
  expect(failure.message).not.toContain("Its output closed");
});

it("does not touch a released process handle or turn its end record into a passing result", async () => {
  const signals: string[] = [];
  const failure = await failureOf(runProcess(["controlled"], { timeoutMs: 20,
    start: () => ({ exited: new Promise<number>(() => {}), exitCode: 0, signalCode: null, kill: signal => { signals.push(signal!); } }),
  }));
  expect(failure.reason).toBe("timeout"); expect(failure.cleanup).toBe("unconfirmed"); expect(signals).toEqual([]);
});

for (const end of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: "SIGTERM" }] as const) it(`does not forward an interrupt after the native end record ${JSON.stringify(end)}`, async () => {
  const signals: string[] = [], stop = new AbortController();
  const failure = await failureOf(runProcess(["controlled"], { signal: stop.signal, timeoutMs: 30_000,
    start: () => ({ ...end, exited: new Promise<number>(() => {}), stdout: new Response("last output").body!,
      interrupt: signal => { signals.push(signal); }, kill: signal => { signals.push(signal!); },
    }), onOutput: () => { stop.abort("SIGTERM"); },
  }));
  expect(failure.reason).toBe("cancelled"); expect(failure.cleanup).toBe("unconfirmed"); expect(signals).toEqual([]);
});

it("refuses an output observer on inherited descriptors before starting anything", async () => {
  let starts = 0, error: unknown;
  try { await runProcess(["controlled"], { output: "inherit", onOutput: () => undefined, start: () => { starts++; return peer().child; } }); }
  catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(RangeError); expect(starts).toBe(0);
});

it("rejects an unknown output mode from an untyped caller before starting", async () => {
  let starts = 0, error: unknown;
  const options = JSON.parse('{"output":"discard"}');
  try { await runProcess(["controlled"], { ...options, start: () => { starts++; return peer().child; } }); }
  catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(RangeError); expect(starts).toBe(0);
});

for (const interruptGraceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) it(`rejects invalid grace ${interruptGraceMs} before launching`, async () => {
  let starts = 0, error: unknown;
  try { await runProcess(["controlled"], { interruptGraceMs, start: () => { starts++; return peer().child; } }); } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(RangeError); expect(starts).toBe(0);
});
