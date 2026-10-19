import { executionFor } from "../src/repository-context.js";
import { afterAll, expect, it } from "bun:test";
import { z } from "zod";
import type { AgentRun } from "../src/acp-run.js";
import { Engine } from "../src/engine.js";
import { Coordination } from "../src/coordination.js";
import { EngineLifecycle, LifecycleStore } from "../src/lifecycle.js";
import { EngineClient } from "../src/engine-client.js";
import { exitCode } from "../src/coordination-cli.js";
import { serve } from "../src/server.js";
import { writeConnection } from "../src/instance.js";
import { removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
const engines: Engine[] = [];
afterAll(async () => {
  await Promise.all(engines.map((engine) => engine.shutdown()));
  roots.forEach(removeDir);
});
function fixture() {
  const home = tempDir("petrina-coordination-regression-");
  roots.push(home);
  const e = new Engine(home, { agentCommand: () => undefined, codexCommand: null, grokCommand: null, terminals: () => [] });
  engines.push(e);
  e.setPoolPaused(true);
  e.schedule = () => {};
  e.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
  const taskId = e.addTask({ productId: "product", title: "First task" });
  const c = new Coordination(e);
  return { e, c, home, taskId, task: e.task(taskId)! };
}

for (const count of [2, 26, 100]) it(`checks all ${count} selected tasks for completion and decisions, independently of the reply page`, async () => {
  const { e, c, taskId } = fixture();
  const ids = [taskId, ...Array.from({ length: count - 1 }, (_, index) => e.addTask({ productId: "product", title: `Selected ${index}` }))];
  const tasks = ids.map((id) => e.task(id)!);
  for (const task of tasks.slice(0, -1)) { task.state = "done"; executionFor(task).work.landed = { branch: "main", sha: "saved" }; }
  const limit = count === 2 ? 1 : 25;
  for (const condition of ["state", "delivered", "landed"]) {
    const args = { target: "task", taskIds: ids, condition, states: ["done"], limit, timeoutMs: 0 };
    const pending = await c.call("watch.wait", args);
    expect(pending.outcome).toBe("timed-out");
    expect((pending.result as { items: unknown[] }).items).toHaveLength(limit);
    // Even an empty continuation page cannot make the unfinished selection pass.
    const next = (pending.result as { next: string }).next;
    const decoded = JSON.parse(Buffer.from(next, "base64url").toString());
    const beyond = Buffer.from(JSON.stringify({ ...decoded, at: count })).toString("base64url");
    expect((await c.call("watch.wait", { ...args, cursor: beyond })).outcome).toBe("timed-out");
  }
  const last = tasks.at(-1)!;
  e.s.inbox.push({ id: "last-question", taskId: last.id, kind: "question", title: "A question on the last task", at: 1, blocking: true });
  const decision = await c.call("watch.wait", { target: "task", taskIds: ids, condition: "decision", limit, timeoutMs: 0 });
  expect(decision.outcome).toBe("completed");
  expect((decision.result as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([last.id]);
  last.state = "done";
  executionFor(last).work.landed = { branch: "main", sha: "saved" };
  for (const condition of ["state", "delivered", "landed"]) expect((await c.call("watch.wait", { target: "task", taskIds: ids, condition, states: ["done"], limit, timeoutMs: 0 })).outcome).toBe("completed");
});

it("exposes every saved disagreement objection and its answer through paged inspection and design reads", async () => {
  const { e, c, taskId, task } = fixture();
  task.brief = { summary: "Proposed design", forUsers: [], areas: [], acceptance: [], risks: [] };
  task.objections = [{ id: "objection", round: 1, text: "Blocking objection\n" + "Full available evidence\n".repeat(1000), blocking: true, raisedBy: "sol-xhigh", status: "open", answer: "Recorded answer" }];
  e.s.inbox.push({ id: "disagreement", taskId, kind: "disagreement", title: "Decide the disagreement", body: "Choose how to proceed", at: 1, blocking: false });
  let page = await c.call("inbox.inspect", { itemId: "disagreement" });
  expect(page.shortened).toBe(true);
  const revision = page.revision;
  let full = String(page.text);
  while (page.next) { page = await c.call("inbox.inspect", { itemId: "disagreement", cursor: page.next }); full += page.text; }
  expect(JSON.parse(full).objections).toEqual(task.objections);
  page = await c.call("task.read", { taskId, section: "design" });
  full = String(page.text);
  while (page.next) { page = await c.call("task.read", { taskId, section: "design", cursor: page.next }); full += page.text; }
  expect(JSON.parse(full).objections).toEqual(task.objections);
  task.objections[0]!.answer = "A changed answer";
  expect((await c.call("inbox.approve", { itemId: "disagreement", revision, requestId: "old-evidence" })).outcome).toBe("changed");
  expect(e.s.inbox).toHaveLength(1);
});

it("returns the new interrupting message's identity even when identical wording is already queued", async () => {
  const { e, c, taskId, task } = fixture();
  let cancelled = 0;
  e.runs.set(taskId, { cancel: async () => { cancelled++; } } as unknown as AgentRun);
  try {
    const first = await c.call("task.message", { taskId, text: "Check this case", requestId: "first-message" });
    const args = { taskId, text: "Check this case", mode: "interrupt", requestId: "interrupt-message" };
    const second = await c.call("task.message", args);
    expect(second.messageId).not.toBe(first.messageId);
    expect(task.queued.map((message) => message.id)).toEqual([String(second.messageId), String(first.messageId)]);
    expect(await c.call("task.message", args)).toEqual(second);
    expect(cancelled).toBe(1);
    expect((await c.call("task.remove-message", { taskId, messageId: second.messageId, requestId: "remove-interruption" })).outcome).toBe("completed");
    expect(task.queued.map((message) => message.id)).toEqual([String(first.messageId)]);
  } finally { e.runs.delete(taskId); }
});

it("cancels an awaiting-merge task using the existing cancellation behavior", async () => {
  const { e, c, taskId, task } = fixture();
  task.state = "pr-open";
  executionFor(task).work.pr = { number: 1, state: "open", url: "https://github.com/example/product/pull/1", openedAt: 1 };
  const args = { taskId, requestId: "cancel-awaiting-merge" };
  expect((await c.call("task.cancel", args)).outcome).toBe("completed");
  expect(e.task(taskId)!.state as string).toBe("cancelled");
  expect(executionFor(task).work.pr!.state).toBe("open");
  expect((await c.call("task.cancel", args)).outcome).toBe("completed");
});

it("keeps closed, unmerged pull requests unconfirmed in inspection, history and waits", async () => {
  const { e, c, taskId, task } = fixture();
  task.state = "done";
  executionFor(task).work.pr = { number: 1, state: "closed", url: "https://github.com/example/product/pull/1", openedAt: 1 };
  expect((await c.call("task.inspect", { taskId })).task).toHaveProperty("deliveryConfirmed", false);
  e.save();
  expect((await c.call("task.history", { taskId })).items).toEqual([expect.objectContaining({ landing: "closed", deliveryConfirmed: false })]);
  for (const condition of ["delivered", "landed"]) expect((await c.call("watch.wait", { target: "task", taskId, condition, timeoutMs: 0 })).outcome).toBe("timed-out");
});

for (const next of ["resume", "stop", "restart"]) it(`allows ${next} to replace a draining pause while retaining stop/restart admission rules`, async () => {
  const { e, home, taskId, task } = fixture();
  const store = new LifecycleStore(home);
  let stops = 0;
  const lifecycle = new EngineLifecycle(e, store, async () => { stops++; store.finish("completed"); });
  const server = serve(e, { port: 0, token: "regression-connection-key-12345678", lifecycle });
  writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token: "regression-connection-key-12345678" });
  const client = new EngineClient(home);
  let settle!: () => void;
  e.settling.set(taskId, new Promise<void>((resolve) => { settle = resolve; }));
  task.state = "running";
  task.holdsSlot = true;
  e.s.inbox.push({ id: "permission", taskId, kind: "permission", title: "Still needs permission", blocking: true, at: 1 });
  try {
    const pauseWait = client.call("engine.pause", { requestId: "pause", wait: true, timeoutMs: 3000 });
    await waitFor(() => store.current?.kind === "pause", "the accepted pause");
    expect((await client.call("engine.pause", { requestId: "follow-pause" })).outcome).toBe("pending");
    expect((await client.call("engine.start", { requestId: "find-engine" })).outcome).toBe("completed");
    const changed = await client.call(`engine.${next}`, { requestId: "next-operation" });
    expect(changed.outcome).toBe(next === "resume" ? "completed" : "pending");
    expect((await pauseWait).outcome).toBe("superseded");
    expect(store.receipt("follow-pause")!.outcome).toBe("superseded");
    expect(exitCode("superseded")).toBe(5);
    expect(e.s.pool.paused).toBe(next !== "resume");
    expect(e.draining).toBe(next !== "resume");
    if (next !== "resume") expect((await client.call("engine.resume", { requestId: "cannot-bypass" })).outcome).toBe("conflict");
    e.s.inbox = [];
    task.holdsSlot = false;
    task.state = "waiting";
    settle();
    e.settling.delete(taskId);
    if (next !== "resume") await waitFor(() => store.current?.phase === "completed", "the replacement drain to finish");
    expect(stops).toBe(next === "resume" ? 0 : 1);
  } finally {
    settle(); e.settling.delete(taskId); lifecycle.close(); server.stop(true); store.close();
  }
});

for (const ending of ["completed", "failed"] as const) it(`persists ${ending} for restart followers through a lost reply and reopening the receipt store`, () => {
  const home = tempDir("petrina-lifecycle-followers-");
  roots.push(home);
  let store = new LifecycleStore(home);
  try {
    store.begin("restart", { requestId: "original" }, "paused");
    store.begin("restart", { requestId: "following" }, "paused");
    store.finish("starting");
    store.finish(ending, ending === "failed" ? "Startup failed" : undefined);
    store.close(); store = new LifecycleStore(home);
    const followed = store.begin("restart", { requestId: "following" }, "paused");
    expect(followed.outcome).toBe(ending);
    expect(followed.requestId).toBe("following");
    expect(followed.operation).toHaveProperty("phase", ending);
    expect(followed.operation).toHaveProperty("id", "original");
  } finally { store.close(); }
});

for (const step of ["delivery", "checks", "agent"]) it(`releases a ${step} reservation when pause arrives during preparation, and resumes it exactly once`, async () => {
  const { e, home, taskId, task, c } = fixture();
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
        if (step === "checks") { const done = await e["checks"]["turnToRun"](current, signal); done(); }
        else await e["turns"].turn(current, "builder", "opus-high", async () => [], z.object({}), signal);
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
