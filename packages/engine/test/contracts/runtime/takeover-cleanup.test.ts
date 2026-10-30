import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeAll, takeOverBlock } from "@petrina/core";
import { repositoryView } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { SLOW } from "@petrina/test-support/slow";
import type { LaunchInput } from "@petrina/agent-runtime/terminal";
import { TestResult } from "../../../src/roles.js";
import { turnCleanupFixtures, type Observed } from "../../fixtures/turn-cleanup.js";

const fixtures = turnCleanupFixtures();
afterEach(() => fixtures.close());

for (const mode of ["false", "confirmed", "driver-error", "driver-undefined"] as const) it(`hands an actual read-only conversation to the coordinator only with confirmed cleanup: ${mode}`, async () => {
  const stop = mode === "false" ? "false" : "confirmed";
  const f = await fixtures.fixture({ stop });
  const driverFailure = mode === "driver-error" ? { error: new Error("The original driver's finalizer rejected") }
    : mode === "driver-undefined" ? { error: undefined } : undefined;
  const finalizer = driverFailure ? Promise.withResolvers<void>() : undefined;
  let observedFinalizer: Promise<Observed<void>> | undefined;
  try {
    const file = join(f.repo!, "README.md"), original = readFileSync(file, "utf8"), head = await f.observe(async () => (await gitOps.head(f.repo!))!);
    expect(head.kind).toBe("value");
    if (head.kind !== "value") throw head.error;
    const turn = await f.observe(() => f.engine["turns"].turn(f.scope, "tester", "opus-high", () => [], TestResult, f.abort.signal));
    expect(turn.kind).toBe(stop === "confirmed" ? "value" : "error");
    expect(f.prompts).toBe(1); expect(f.stopCalls).toBe(1);
    expect(f.scope.work.conversation?.briefed).toBe(true);
    expect(f.task.agent?.roleId).toBe("tester");
    expect(takeOverBlock(repositoryView(f.scope), f.engine.activeState())).toBeUndefined();
    // This state belongs to the actual direct turn, whose running-session map has already
    // released its entry. The current conversation/agent is never fabricated for the test.
    expect(f.engine.runs.size).toBe(0);
    const conversation = f.scope.work.conversation!.sessionId;
    const discovery = f.engine["takeover"] as unknown as { takeOverTool(toolId: string): Promise<LaunchInput["tool"]> };
    const tool = spyOn(discovery, "takeOverTool"); f.restore(() => tool.mockRestore());
    tool.mockResolvedValue({ id: "claude-code", name: "Controlled Claude Code", path: join(f.root, "tool-must-never-execute"), mode: "default" });
    await f.observe(async () => { writeFileSync(file, "Tracked edit awaiting the coordinator handoff\n"); });
    const launcher = join(f.engine.dataDir, "takeover", f.task.id);
    if (finalizer) {
      // The actual session already confirmed its cleanup. This controlled promise represents
      // only an original driver's finalizer failure, never a failed native process observation.
      f.engine.settling.set(f.task.id, finalizer.promise);
      observedFinalizer = f.observe(() => finalizer.promise);
    }
    const takingOver = f.observe(() => f.engine.takeOver(f.task.id, "copy"));
    finalizer?.reject(driverFailure!.error);
    const handoff = await takingOver;
    const finalizerResult = await observedFinalizer;
    if (driverFailure) {
      expect(finalizerResult?.kind).toBe("error");
      if (finalizerResult?.kind !== "error") throw new Error("The controlled driver finalizer unexpectedly succeeded");
      expect(finalizerResult.error).toBe(driverFailure.error);
    }
    if (finalizer && f.engine.settling.get(f.task.id) === finalizer.promise) f.engine.settling.delete(f.task.id);
    expect(tool).toHaveBeenCalledTimes(1);
    expect(f.stopCalls).toBe(1); // No raw second stop bypasses the canonical receipt.
    expect(f.engine.switching.has(f.task.id)).toBe(false);
    const after = await f.observe(async () => (await gitOps.head(f.repo!))!);
    expect(after.kind).toBe("value");
    if (after.kind !== "value") throw after.error;
    expect(after.value).toBe(head.value);
    if (stop === "false") {
      expect(turn.kind).toBe("error"); expect(handoff.kind).toBe("error");
      if (turn.kind !== "error" || handoff.kind !== "error") throw new Error("Unconfirmed cleanup authorized takeover");
      expect((turn.error as Error).message).toBe("Agent cleanup was not confirmed");
      expect(handoff.error).toBe(turn.error);
      expect(f.task.state).toBe("failed"); expect(f.task.agent).toBeUndefined(); expect(f.task.holdsSlot).toBe(false);
      expect(f.scope.work.conversation).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe("Tracked edit awaiting the coordinator handoff\n");
      expect(f.task.driving).toBeUndefined(); expect(existsSync(launcher)).toBe(false);
      expect(f.task.acceptanceCleanupPending).toBeString();
      expect(f.engine.agentCleanup.has(f.task.id)).toBe(true);
      const shutdown = await f.observe(() => f.engine.shutdown());
      expect(shutdown.kind).toBe("error");
      if (shutdown.kind !== "error") throw new Error("Unconfirmed takeover cleanup became successful shutdown");
      expect(shutdown.error).toBe(turn.error); expect(f.storeClosed).toBe(true);
      const owned = await f.closeSubject(); expect(owned.kind).toBe("error"); expect(existsSync(f.root)).toBe(true);
      f.acknowledgeRetained(owned, turn.error);
    } else if (driverFailure) {
      expect(turn.kind).toBe("value"); expect(handoff.kind).toBe("error");
      if (handoff.kind !== "error") throw new Error("The driver's failed finalizer authorized handoff");
      expect(handoff.error).toBe(driverFailure.error);
      expect(f.task.state).toBe("failed"); expect(f.task.agent).toBeUndefined(); expect(f.task.holdsSlot).toBe(false);
      expect(f.scope.work.conversation).toBeUndefined(); expect(f.task.driving).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe("Tracked edit awaiting the coordinator handoff\n");
      expect(existsSync(launcher)).toBe(false);
      expect(f.task.acceptanceCleanupPending).toBeUndefined();
      expect(f.engine.agentCleanup.has(f.task.id)).toBe(false);
      // A logical driver failure must not invent native cleanup uncertainty.
      const shutdown = await f.observe(() => f.engine.shutdown()); expect(shutdown.kind).toBe("value"); expect(f.storeClosed).toBe(true);
      const owned = await f.closeSubject(); expect(owned.kind).toBe("value"); expect(existsSync(f.root)).toBe(false);
    } else {
      expect(handoff.kind).toBe("value");
      if (handoff.kind !== "value") throw new Error("Confirmed cleanup blocked ordinary copy handoff");
      expect(f.scope.work.conversation!.sessionId).toBe(conversation);
      expect(handoff.value.command).toBeString(); expect(handoff.value.terminal).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(f.task.driving).toMatchObject({ roleId: "tester", profileId: "opus-high", toolId: "claude-code" });
      expect(f.engine.s.inbox.some(item => item.taskId === f.task.id && item.kind === "driving")).toBe(true);
      expect(existsSync(launcher)).toBe(true);
      const files = readdirSync(launcher); expect(files).toHaveLength(1);
      const script = readFileSync(join(launcher, files[0]!), "utf8");
      expect(script).toContain(conversation); expect(script).toContain("tool-must-never-execute");
      expect(f.task.acceptanceCleanupPending).toBeUndefined();
      expect(f.engine.agentCleanup.has(f.task.id)).toBe(false);
      const shutdown = await f.observe(() => f.engine.shutdown()); expect(shutdown.kind).toBe("value"); expect(f.storeClosed).toBe(true);
      const owned = await f.closeSubject(); expect(owned.kind).toBe("value"); expect(existsSync(f.root)).toBe(false);
    }
  } finally {
    finalizer?.reject(driverFailure!.error);
    if (finalizer && f.engine.settling.get(f.task.id) === finalizer.promise) f.engine.settling.delete(f.task.id);
    await completeAll<unknown>([...(observedFinalizer ? [observedFinalizer] : []), f.finish()]);
  }
}, 30_000 * SLOW);
