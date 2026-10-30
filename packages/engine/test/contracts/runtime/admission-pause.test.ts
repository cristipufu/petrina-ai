import { executionFor } from "@petrina/orchestrator";
import { afterAll, expect, it } from "bun:test";
import { z } from "zod";

import { makeProduct, waitFor } from "../../fixtures.js";
import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

for (const step of ["delivery", "agent"]) {
it(`releases a ${step} reservation when pause arrives during preparation, and resumes it exactly once`, async () => {
  return owners.use(async ({ e, home, taskId, task, c, owner: lifetime }) => {

  // Startup cleanup also belongs to a drain. Finish it before isolating the admitted step's reservation.
  await e.waitUntilReady(); await Promise.all([...e.backgroundWork]);
  e.schedule = () => e["driver"].schedule();
  e["driver"]["prepare"] = async () => {};
  e.tidy = () => {};
  executionFor(task).work.worktree = home;
  task.plan = { stages: [{ id: "step", title: "Work", kind: "do", roleId: step === "delivery" ? "release-manager" : "builder", profileIds: ["opus-high"] }], rationale: "Do the work", plannerProfileId: "opus-high" };
  task.stageIndex = 0;
  task.state = "running";
  task.holdsSlot = step !== "delivery";
  if (step !== "delivery") task.agent = { roleId: "builder", profileId: "opus-high", since: 1, step: 1 };
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  lifetime.onStop(() => release());
  let attempts = 0, published = 0;
  const finish = () => { task.state = "done"; task.holdsSlot = false; delete task.agent; e.commit(); return "stop" as const; };
  if (step === "delivery") {
    e["shipping"]["readyToShip"] = async () => "ready";
    e["shipping"]["prepare"] = async () => { attempts++; if (attempts === 1) await hold; return "ready"; };
    e["shipping"]["checkDelivery"] = async () => "continue";
    e["shipping"]["publish"] = async () => { published++; finish(); return "done"; };
  } else {
    e["work"].runDo = async (current, _stage, signal) => {
      attempts++;
      if (attempts === 1) {
        await hold;
        await e["turns"].turn(current, "builder", "opus-high", async () => [], z.object({}), signal);
      }
      return finish();
    };
  }
  try {
    // This step was admitted before the pause; its asynchronous preparation is still under way.
    e.s.pool.paused = false;
    e.startDriver(taskId, true);
    await waitFor(() => attempts === 1, "the admitted preparation to start");
    e.setPoolPaused(true);
    release();
    await waitFor(() => !e.drivers.has(taskId) && !e.settling.has(taskId), "the preparation to yield");
    expect(e.task(taskId)!.state as string).toBe("waiting");
    expect(e.task(taskId)!.holdsSlot).toBe(false);
    expect(e.task(taskId)!.agent).toBeUndefined();
    expect((await c.call("pool.inspect", {})).drained).toBe(true);
    expect(published).toBe(0);
    e.setPoolPaused(false);
    await waitFor(() => e.task(taskId)?.state === "done", "the waiting step to resume");
    expect(attempts).toBe(2);
    expect(published).toBe(step === "delivery" ? 1 : 0);
  } finally { release(); }
  });
});
}

it("releases the agent reservation when pause arrives during check preparation, retaining one pending attempt for resume", async () => {
  return owners.use(async ({ e, home, taskId, task, c, owner: lifetime }) => {

  await e.waitUntilReady(); await Promise.all([...e.backgroundWork]);
  e.schedule = () => { e.checkQueue.pump(); e["driver"].schedule(); };
  e["driver"]["prepare"] = async () => {};
  e.tidy = () => {};
  const product = await makeProduct(home);
  lifetime.check();
  e.s.products[0]!.path = product;
  executionFor(task).work.worktree = product;
  task.plan = { stages: [{ id: "step", title: "Work", kind: "do", roleId: "builder", profileIds: ["opus-high"] }], rationale: "Do the work", plannerProfileId: "opus-high" };
  task.stageIndex = 0;
  task.state = "running";
  task.holdsSlot = true;
  task.agent = { roleId: "builder", profileId: "opus-high", since: 1, step: 1 };
  let release!: () => void, preparing!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const prepared = new Promise<void>(resolve => { preparing = resolve; });
  lifetime.onStop(() => release());
  const checks = e["checks"];
  const captureState = checks["captureState"].bind(checks);
  lifetime.onStop(() => { checks["captureState"] = captureState; });
  let captures = 0, attempts = 0;
  checks["captureState"] = async (...args: Parameters<typeof captureState>) => {
    const state = await captureState(...args);
    if (++captures === 1) { preparing(); await hold; }
    return state;
  };
  e.options.runCheckCommand = async req =>
    req.argv[0] === process.execPath && req.argv[1] === "-e" ? { code: 0, stdout: "prepared check passed\n" } : undefined;
  e["work"].runDo = async (scope, _stage, signal) => {
    attempts++;
    await checks.runProductChecks(scope, [{ name: "Prepared check", argv: [process.execPath, "-e", "console.log('prepared check passed')"] }], signal);
    task.state = "done"; task.holdsSlot = false; delete task.agent; e.commit();
    return "stop";
  };
  try {
    e.s.pool.paused = false;
    e.startDriver(taskId, true);
    let ended = false;
    const driving = e.settling.get(taskId)!.finally(() => { ended = true; });
    await Promise.race([prepared, driving.then(() => { throw new Error(`The step ended before preparing its checks: ${task.statusLine}`); })]);
    e.setPoolPaused(true);
    release();
    await waitFor(() => {
      if (ended) throw new Error(`The paused attempt ended instead of queueing: ${task.statusLine}`);
      return e.waitingChecks.has(taskId);
    }, "prepared checks to keep their queue entry during the pause");
    expect(task.holdsSlot).toBe(false);
    expect(task.agent).toBeUndefined();
    expect(e.drivers.has(taskId)).toBe(true);
    expect(e.checkQueue.waiting).toBe(1);
    expect(e.checkQueue.running).toBe(0);
    expect((await c.call("pool.inspect", {})).drained).toBe(true);
    const step = task.journey!.at(-1)!;
    expect(step.productChecks).toHaveLength(1);
    expect(step.productChecks![0]!.result).toBe("pending");
    expect(step.productChecks![0]!.startedAt).toBeUndefined();
    expect(step.checkAttempts).toBeUndefined();
    e.setPoolPaused(false);
    expect(e.checkQueue.waiting).toBe(0);
    expect(e.checkQueue.running).toBe(1);
    await driving;
    expect(e.task(taskId)?.state).toBe("done");
    expect(attempts).toBe(1);
    expect(step.productChecks).toHaveLength(1);
    expect(step.productChecks![0]!.result).toBe("pass");
    expect(step.checkAttempts).toHaveLength(1);
    expect(e.checkQueue.running).toBe(0);
    expect(e.waitingChecks.size).toBe(0);
  } finally { release(); checks["captureState"] = captureState; }
  });
});
