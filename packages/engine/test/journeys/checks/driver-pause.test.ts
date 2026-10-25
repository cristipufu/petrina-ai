import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import type { Engine } from "../../engine.js";
import { removeDir, waitFor } from "../../fixtures.js";
import { checkAdmissionFixture } from "../../fixtures/check-admission.js";
import { EngineLifecycle } from "../../../src/lifecycle.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";

const roots: string[] = [], engines: Engine[] = [];
afterAll(async () => { for (const engine of engines) await engine.shutdown(); roots.forEach(removeDir); });

it("completes a real pool pause with a quiet task driver waiting for checks, then resumes that same pending run", async () => {
  const f = await checkAdmissionFixture(roots, engines);
  let driving: Promise<void> | undefined, releasePlace: (() => void) | undefined;
  let store: LifecycleStore | undefined, lifecycle: EngineLifecycle | undefined;
  try {
    const entry = await f.add("paused-driver");
    entry.task.plan!.stages[1] = { id: "approval", title: "Delivery check", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] };
    releasePlace = await f.engine.checkQueue.acquire(new AbortController().signal);
    f.engine.startDriver(entry.task.id, true);
    driving = f.engine.settling.get(entry.task.id)!;
    let ended = false;
    void driving.then(() => { ended = true; }, () => { ended = true; });
    await waitFor(() => f.engine.checkQueue.waiting === 1 && f.engine.waitingChecks.has(entry.task.id), "the actual task driver to queue its checks", undefined, { during: driving });
    expect(f.engine.settling.get(entry.task.id)).toBe(driving);
    expect(f.engine.inFlight()).toBe(1);
    expect(f.engine.backgroundWork.size).toBe(0);
    expect(f.evidence()).toEqual([]);
    store = new LifecycleStore(join(f.root, "pool-lifecycle"));
    lifecycle = new EngineLifecycle(f.engine, store, async () => { throw new Error("A pool pause must not stop its engine"); });
    const paused = await lifecycle.request("pause", { requestId: "quiet-driver-pause" });
    expect(paused.outcome).toBe("completed");
    expect(lifecycle.status()).toMatchObject({ status: "paused", activeCount: 0, drained: true });
    expect(f.engine.isPausedCheck(entry.task.id)).toBe(true);
    expect(f.engine.inFlight()).toBe(0);
    expect(f.engine.backgroundWork.size).toBe(0);
    expect(f.engine.settling.get(entry.task.id)).toBe(driving);
    expect(ended).toBe(false);
    releasePlace(); releasePlace = undefined;
    expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(1);
    expect(f.evidence()).toEqual([]);
    expect(entry.task.journey!.flatMap(step => step.productChecks ?? []).at(-1)?.result).toBe("pending");
    expect((await lifecycle.request("resume", { requestId: "quiet-driver-resume" })).outcome).toBe("completed");
    await driving;
    await Promise.all([...f.engine.backgroundWork]);
    expect(f.evidence().map(run => run.name)).toEqual(["paused-driver"]);
    const run = f.evidence()[0]!;
    expect(entry.scope.work.checks).toMatchObject({ sha: run.sha, tree: run.tree, current: true });
    expect(entry.task.state).toBe("needs-you");
    expect(f.engine.s.inbox.some(item => item.taskId === entry.task.id && item.kind === "delivery")).toBe(true);
    expect(f.engine.waitingChecks.size).toBe(0); expect(f.engine.settling.has(entry.task.id)).toBe(false);
    expect(f.engine.inFlight()).toBe(0);
  } finally {
    lifecycle?.close(); store?.close(); releasePlace?.();
    try { await f.engine.shutdown(); } finally { await driving; }
  }
});
