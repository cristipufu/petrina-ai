import { expect, it } from "bun:test";
import { getEventListeners } from "node:events";
import { terminalOutput, type TerminalOutputOptions } from "../../../src/terminal-output.js";
import { preparedTerminalOutput } from "../../fixtures/terminal-output.js";
import { waitFor, waitForFile } from "@petrina/test-support/fixtures";
import type { ProcessDeadline } from "@petrina/platform/process-capabilities";

for (const kind of ["success", "nonzero"] as const) it(`trusts the prepared real probe only after complete output and its ${kind} exit`, async () => {
  const f = await preparedTerminalOutput(kind), lifetime = new AbortController();
  try {
    const command = ["private-probe", "--help"], original = [...command];
    let actual: readonly string[] | undefined, env: NodeJS.ProcessEnv | undefined;
    expect(await terminalOutput(command, { signal: lifetime.signal, start(argv, environment) { actual = argv; env = environment; return f.start(); } })).toBe(kind === "success" ? 'choices: "manual"\n' : undefined);
    expect(actual).toEqual(command); expect(command).toEqual(original); expect(env?.LC_ALL).toBe("C");
    expect(f.handle.exitCode).toBe(kind === "success" ? 0 : 7);
    expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(0);
  } finally { await f.close(); }
});

it.skipIf(process.platform === "win32")("does not trust early EOF and owns TERM/KILL cleanup of its actual resistant probe", async () => {
  const f = await preparedTerminalOutput("closed-stubborn"), lifetime = new AbortController();
  const timers = new Map<number, { ms: number; expire(): void }>(); let next = 0;
  const arm: ProcessDeadline = (expire, ms) => { const id = ++next; timers.set(id, { ms, expire }); return () => { timers.delete(id); }; };
  let output: ReturnType<typeof terminalOutput> | undefined;
  try {
    let settled = false;
    output = terminalOutput(["private-probe", "--help"], { start: f.start, signal: lifetime.signal, arm }).then(value => { settled = true; return value; });
    await waitForFile(f.closed, { during: f.handle.exited });
    expect(settled).toBe(false); expect(f.signals).toEqual([]);
    const read = [...timers.values()].find(timer => timer.ms === 10_000);
    expect(read).toBeDefined(); read!.expire();
    await waitFor(() => f.signals.includes("SIGTERM") && [...timers.values()].find(timer => timer.ms === 1_000), "the declared native cleanup grace", undefined, { during: output });
    expect(f.handle.exitCode).toBeNull();
    [...timers.values()].find(timer => timer.ms === 1_000)!.expire();
    expect(await output).toBeUndefined();
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(f.handle.exitCode != null || f.handle.signalCode != null).toBe(true);
    expect(timers.size).toBe(0); expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(0);
  } finally {
    lifetime.abort();
    try { await f.close(); } finally { await output; }
  }
});

it("preserves the terminal adapter's original starter and deadline method owners", async () => {
  class Ports implements TerminalOutputOptions {
    readonly started: { command: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    readonly armed: number[] = [];
      readonly cancelled: number[] = [];
    start(command: readonly string[], env: NodeJS.ProcessEnv) {
      this.started.push({ command, env });
      return { stdout: new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode("manual\n")); controller.close();
      } }), exited: Promise.resolve(0), exitCode: 0,
      kill() { throw new Error("The completed helper needs no stop request"); } };
    }
    arm(_expire: () => void, ms: number) {
      this.armed.push(ms); return () => { this.cancelled.push(ms); };
    }
  }
  const ports = new Ports();
  expect(await terminalOutput(["private-probe", "--help"], ports)).toBe("manual\n");
  expect(ports.started.map(start => start.command)).toEqual([["private-probe", "--help"]]);
  expect(ports.started[0]!.env.LC_ALL).toBe("C");
  expect(ports.armed).toEqual([10_000, 2_000]);
  expect(ports.cancelled).toEqual([10_000, 2_000]);
});
