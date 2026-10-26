import { expect, it } from "bun:test";
import { CommandFailure, type CommandResult } from "../../../src/commands.js";
import { observeRun, runSettlements } from "../../../src/run-settlement.js";
import { rejectionOf } from "../../../src/rejections.js";

/** Controlled canonical-run boundary data; none of these effects launches an OS program. */
const completed = (code = 0): CommandResult => ({ code, stdout: "recorded output", stderr: "" });
class PrivateRun {
  closes = 0;
  async close() { this.closes++; }
}

for (const code of [0, 7]) it(`allows disposal after fully drained canonical completion with exit ${code}`, async () => {
  class Effects {
    calls = 0;
    readonly result = completed(code);
    async run() { this.calls++; return this.result; }
  }
  const effects = new Effects(), record = runSettlements(), owned = new PrivateRun();
  const result = await record.observe(effects);
  expect(effects.calls).toBe(1);
  expect(result).toEqual({ kind: "completed", result: effects.result, safeToDispose: true });
  expect(result.kind === "completed" && result.result).toBe(effects.result);
  expect(record.safeToDispose).toBe(true);
  expect(await record.dispose(owned)).toBe(true);
  expect(owned.closes).toBe(1);
});

it("retains interruption as a completed process outcome independently of disposal authority", async () => {
  const record = runSettlements(), owned = new PrivateRun();
  const outcome = { kind: "interrupted" as const, signal: "SIGINT" as const, result: completed() };
  expect(await record.observe({ run: async () => outcome })).toEqual({ kind: "completed", result: outcome, safeToDispose: true });
  expect(await record.dispose(owned)).toBe(true);
  expect(owned.closes).toBe(1);
});

for (const reason of ["cancelled", "timeout"] as const) it(`keeps confirmed ${reason} failure and allows disposal`, async () => {
  const error = new CommandFailure("The actual owner confirmed its stop", reason, "partial", "diagnostic", "confirmed", 7);
  const record = runSettlements(), owned = new PrivateRun();
  const observation = await record.observe({ async run(): Promise<CommandResult> { throw error; } });
  expect(observation.kind).toBe("rejected");
  if (observation.kind !== "rejected") throw new Error("The failed command was reported completed");
  expect(observation.error).toBe(error);
  expect(observation.safeToDispose).toBe(true);
  expect(await record.dispose(owned)).toBe(true);
  expect(owned.closes).toBe(1);
});

for (const error of [
  new CommandFailure("Cleanup unconfirmed", "unreadable", "", "", "unconfirmed"),
  new CommandFailure("Entered starter threw without a handle", "start", "", "", "none"),
  new Error("Unknown reader acquisition failure"), undefined,
]) for (const synchronous of [false, true]) it(`retains exact unsafe rejection and its environment (${synchronous ? "synchronous" : "asynchronous"} ${String(error)})`, async () => {
  class Effects {
    calls = 0;
    failure = error;
    run(): Promise<CommandResult> {
      this.calls++;
      if (synchronous) throw this.failure;
      return Promise.reject(this.failure);
    }
  }
  const effects = new Effects(), record = runSettlements(), owned = new PrivateRun();
  const observation = await record.observe(effects);
  expect(effects.calls).toBe(1);
  expect(observation.kind).toBe("rejected");
  if (observation.kind !== "rejected") throw new Error("The unsafe command was reported completed");
  expect(observation.error).toBe(error);
  expect(observation.safeToDispose).toBe(false);
  expect(record.safeToDispose).toBe(false);
  expect(await record.dispose(owned)).toBe(false);
  expect(owned.closes).toBe(0);
});

it("publishes pending ownership before a reentrant run effect tries disposal", async () => {
  const record = runSettlements(), owned = new PrivateRun(), gate = Promise.withResolvers<CommandResult>();
  let attempted: Promise<boolean> | undefined;
  const pending = record.observe({ run() { attempted = record.dispose(owned); return gate.promise; } });
  try {
    expect(await attempted).toBe(false);
    expect(record.safeToDispose).toBe(false);
    expect(owned.closes).toBe(0);
  } finally { gate.resolve(completed()); await pending; }
  expect(record.safeToDispose).toBe(true);
  expect(await record.dispose(owned)).toBe(true);
  expect(owned.closes).toBe(1);
});

it("cannot erase uncertainty when another already admitted command later completes", async () => {
  const record = runSettlements(), owned = new PrivateRun(), gate = Promise.withResolvers<CommandResult>();
  const pending = record.observe({ run: () => gate.promise });
  const error = new Error("An actual command's settlement was not reported");
  try {
    const failed = await record.observe({ async run(): Promise<CommandResult> { throw error; } });
    expect(failed.kind === "rejected" && failed.error).toBe(error);
    expect(await record.dispose(owned)).toBe(false);
  } finally { gate.resolve(completed(7)); await pending; }
  expect(record.safeToDispose).toBe(false);
  expect(await record.dispose(owned)).toBe(false);
  expect(owned.closes).toBe(0);
});

it("can close a private environment when validation failed before any command observation", async () => {
  const record = runSettlements(), owned = new PrivateRun();
  expect(record.safeToDispose).toBe(true);
  expect(await record.dispose(owned)).toBe(true);
  expect(owned.closes).toBe(1);
});

for (const error of [new Error("Private folder removal failed"), undefined]) it(`preserves the actual disposer rejection ${String(error)}`, async () => {
  const record = runSettlements();
  expect(await rejectionOf(record.dispose({ close() { throw error; } }))).toBe(error);
});

it("keeps the standalone observation policy identical to the shared record", async () => {
  const error = new CommandFailure("No child settlement authority", "start");
  expect(await observeRun({ async run(): Promise<CommandResult> { throw error; } })).toEqual({ kind: "rejected", error, safeToDispose: false });
});
