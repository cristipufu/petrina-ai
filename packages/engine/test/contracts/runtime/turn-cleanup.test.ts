import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { SandboxUnavailable } from "@petrina/agent-runtime/sandbox-failures";
import { WaitClock } from "@petrina/storage/worklog";
import { SLOW } from "@petrina/test-support/slow";
import { TestResult } from "../../../src/roles.js";
import { turnCleanupFixtures, type Observed } from "../../fixtures/turn-cleanup.js";

const fixtures = turnCleanupFixtures();
afterEach(() => fixtures.close());
const outcome = <T>(work: Promise<T>): Promise<Observed<T>> => work.then(value => ({ kind: "value", value }), error => ({ kind: "error", error }));

// Host-consumer controls: the sessions have no OS actor. Real private Git demonstrates whether
// Turns restores tracked files; original bound ScriptedSession stops independently clean up failures.
for (const stop of ["false", "reject-error", "reject-undefined", "confirmed"] as const) it(`restores a read-only acceptance turn only after its actual stop confirms cleanup: ${stop}`, async () => {
  const f = await fixtures.fixture({ stop });
  try {
    const original = readFileSync(join(f.repo!, "README.md"), "utf8");
    const returned = await f.observe(() => f.engine["turns"].turn(f.scope, "tester", "opus-high", () => [], TestResult, f.abort.signal));
    expect(f.prompts).toBe(1); expect(f.stopCalls).toBe(1);
    expect(f.engine.runs.size).toBe(0); expect(f.engine.helperRuns.size).toBe(0);
    if (stop === "confirmed") {
      expect(returned.kind).toBe("value");
      if (returned.kind !== "value") throw new Error("Confirmed cleanup rejected the actual hand-back");
      expect(returned.value.summary).toBe("The controlled acceptance hand-back is complete");
      expect(readFileSync(join(f.repo!, "README.md"), "utf8")).toBe(original);
      expect(f.task.acceptanceCleanupPending).toBeUndefined();
      expect(f.task.acceptanceRun!.restored!.products).toEqual([{ productId: "p", edits: true, files: ["README.md"] }]);
      expect(f.engine.agentCleanup.has(f.task.id)).toBe(false);
    } else {
      expect(returned.kind).toBe("error");
      if (returned.kind !== "error") throw new Error("Unconfirmed cleanup accepted the hand-back");
      if (stop === "false") expect((returned.error as Error).message).toBe("Agent cleanup was not confirmed");
      else expect(returned.error).toBe(stop === "reject-undefined" ? undefined : f.cleanupFailure);
      expect(readFileSync(join(f.repo!, "README.md"), "utf8")).toBe("Changed by the read-only Tester\n");
      expect(f.task.acceptanceCleanupPending).toBeString();
      expect(f.task.acceptanceRun!.restored).toBeUndefined();
      expect(f.engine.agentCleanup.has(f.task.id)).toBe(true);
      const released = await outcome(f.engine["turns"].releasedStops(f.task.id));
      expect(released.kind).toBe("error");
    }
    const shutdown = await outcome(f.engine.shutdown());
    expect(shutdown.kind).toBe(stop === "confirmed" ? "value" : "error");
    if (stop !== "confirmed" && shutdown.kind === "error" && returned.kind === "error") expect(shutdown.error).toBe(returned.error);
    expect(f.storeClosed).toBe(true);
    const owned = await f.closeSubject();
    expect(owned.kind).toBe(stop === "confirmed" ? "value" : "error");
    expect(existsSync(f.root)).toBe(stop !== "confirmed");
    if (stop !== "confirmed" && returned.kind === "error" && shutdown.kind === "error") f.acknowledgeRetained(owned, returned.error);
  } finally { await f.finish(); }
}, 30_000 * SLOW);

for (const missing of ["body", "cleanup"] as const) it(`keeps both raw turn and cleanup failures when ${missing} rejects with undefined`, async () => {
  const bodyFailure = missing === "body" ? undefined : new Error("The actual hand-back failed");
  const f = await fixtures.fixture({ stop: missing === "cleanup" ? "reject-undefined" : "reject-error", bodyFailure: { error: bodyFailure } });
  try {
    const returned = await f.observe(() => f.engine["turns"].turn(f.scope, "tester", "opus-high", () => [], TestResult, f.abort.signal));
    expect(f.prompts).toBe(1); expect(f.stopCalls).toBe(1);
    expect(returned.kind).toBe("error");
    if (returned.kind !== "error") throw new Error("Both subject failures disappeared");
    expect(returned.error).toBeInstanceOf(AggregateError);
    const expectedCleanup = missing === "cleanup" ? undefined : f.cleanupFailure;
    expect((returned.error as AggregateError).errors).toEqual([bodyFailure, expectedCleanup]);
    expect((returned.error as AggregateError).errors[0]).toBe(bodyFailure);
    expect((returned.error as AggregateError).errors[1]).toBe(expectedCleanup);
    expect(readFileSync(join(f.repo!, "README.md"), "utf8")).toBe("Changed by the read-only Tester\n");
    expect(f.task.acceptanceCleanupPending).toBeString();
    expect(f.engine.runs.size).toBe(0);
    const shutdown = await outcome(f.engine.shutdown());
    expect(shutdown.kind).toBe("error"); expect(f.storeClosed).toBe(true);
    if (shutdown.kind !== "error") throw new Error("A failed stop became successful shutdown");
    expect(shutdown.error).toBe(expectedCleanup);
    const owned = await f.closeSubject(); expect(owned.kind).toBe("error"); expect(existsSync(f.root)).toBe(true);
    f.acknowledgeRetained(owned, expectedCleanup);
  } finally { await f.finish(); }
}, 30_000 * SLOW);

for (const incomplete of [true, false]) it(`allows sandbox fallback only after the actual native opening's cleanup confirms${incomplete ? ": incomplete callback blocks another launch" : ": ordinary confirmed refusal retries"}`, async () => {
  const f = await fixtures.fixture({ nativeOpening: true });
  try {
    const role = f.engine.role("tester", f.task)!, profile = f.engine.profile("opus-high")!;
    const refusal = new SandboxUnavailable("controlled native opening refusal"), launches: boolean[] = [];
    const start = spyOn(AgentRun, "start"); f.restore(() => start.mockRestore());
    start.mockImplementation(async options => {
      launches.push(options.sandbox !== undefined);
      expect(options.command).toEqual([join(f.root, "unconfigured-agent-must-never-launch")]);
      if (launches.length === 1) {
        // This controlled native protocol has no child. A truthful no-child completion is distinct
        // from the simultaneous explicit failure of its overall cleanup authority.
        options.onGone?.(Promise.resolve());
        if (incomplete) options.callbacks?.onCleanupIncomplete?.();
        throw refusal;
      }
      return await f.start(options, role) as unknown as AgentRun;
    });
    const opened = await f.observe(() => f.engine["turns"]["openAgentRun"](f.scope, role, profile, f.root, f.abort.signal,
      { roleId: role.id, profile, waits: new WaitClock(), journeyId: "direct-opening", agentSeat: role.id }, { main: true }));
    expect(launches).toEqual(incomplete ? [true] : [true, false]);
    expect(f.agents.received()).toEqual([]);
    expect(opened.kind).toBe(incomplete ? "error" : "value");
    if (incomplete) {
      if (opened.kind !== "error") throw new Error("An incomplete native opening allowed fallback");
      expect((opened.error as Error).message).toBe("Agent cleanup was not confirmed");
      expect(f.engine.agentCleanup.has(f.task.id)).toBe(true);
    } else {
      if (opened.kind !== "value") throw new Error("Confirmed native refusal blocked ordinary sandbox fallback");
      expect(opened.value.off).toBe(refusal.reason);
      await f.engine.stopAgent(f.task.id, opened.value.run);
      expect(f.stopCalls).toBe(1); expect(f.engine.agentCleanup.has(f.task.id)).toBe(false);
    }
    const shutdown = await outcome(f.engine.shutdown());
    expect(shutdown.kind).toBe(incomplete ? "error" : "value"); expect(f.storeClosed).toBe(true);
    if (incomplete && opened.kind === "error" && shutdown.kind === "error") expect(shutdown.error).toBe(opened.error);
    const owned = await f.closeSubject(); expect(owned.kind).toBe(incomplete ? "error" : "value");
    expect(existsSync(f.root)).toBe(incomplete);
    if (incomplete && opened.kind === "error" && shutdown.kind === "error") f.acknowledgeRetained(owned, opened.error);
  } finally { await f.finish(); }
}, 30_000 * SLOW);

for (const error of [new Error("Opening failed before returning a session"), undefined]) it(`keeps the original opening error when cleanup also fails: ${String(error)}`, async () => {
  const f = await fixtures.fixture({ nativeOpening: true });
  try {
    const role = f.engine.role("tester", f.task)!, profile = f.engine.profile("opus-high")!;
    let launches = 0;
    const start = spyOn(AgentRun, "start"); f.restore(() => start.mockRestore());
    start.mockImplementation(async options => {
      launches++;
      options.callbacks.onCleanupIncomplete?.();
      throw error;
    });
    const opened = await f.observe(() => f.engine["turns"]["openAgentRun"](f.scope, role, profile, f.root, f.abort.signal,
      { roleId: role.id, profile, waits: new WaitClock(), journeyId: "failed-opening", agentSeat: role.id }, { main: true }));
    expect(launches).toBe(1);
    expect(opened.kind).toBe("error");
    if (opened.kind !== "error" || !(opened.error instanceof AggregateError)) throw new Error("The opening or cleanup error disappeared");
    expect(opened.error.errors).toHaveLength(2);
    expect(opened.error.errors[0]).toBe(error);
    const cleanup = opened.error.errors[1];
    expect((cleanup as Error).message).toBe("Agent cleanup was not confirmed");
    expect(f.agents.received()).toEqual([]);
    const shutdown = await outcome(f.engine.shutdown());
    expect(shutdown.kind).toBe("error");
    if (shutdown.kind !== "error") throw new Error("The failed opening's owner was released");
    expect(shutdown.error).toBe(cleanup);
    expect(f.storeClosed).toBe(true);
    const owned = await f.closeSubject();
    expect(owned.kind).toBe("error");
    expect(existsSync(f.root)).toBe(true);
    f.acknowledgeRetained(owned, cleanup);
  } finally { await f.finish(); }
}, 30_000 * SLOW);
