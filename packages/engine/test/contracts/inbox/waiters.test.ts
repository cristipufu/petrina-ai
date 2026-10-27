import { rejectionOf } from "@petrina/test-support/rejections";
import { afterAll, expect, it, spyOn } from "bun:test";
import { coordinatorRecordFixtures } from "../../fixtures/coordinator-records.js";
import { Aborted } from "../../../src/kernel.js";
import { Connections, CONFIRM_ADDRESS } from "../../../src/connection.js";
import { executionFor } from "@petrina/orchestrator";
import { waitFor } from "../../fixtures.js";
const owners = coordinatorRecordFixtures({ prefix: "petrina-inbox-waits-", title: "Wait safely", productPath: true, repo: "acme/product", paused: false });
afterAll(() => owners.close());

it("does not ask for an address after pause during the Git lookup, and releases the product's confirmation lock", async () => {
  return owners.use(async ({ engine, task, scope, owner: lifetime }) => {

  let resolve!: (address: string) => void;
  const queries = { remoteAddress: (_path: string): Promise<string | undefined> => new Promise(done => { resolve = done; }) };
  const connections = new Connections(engine, queries), controller = new AbortController();
  lifetime.onStop(() => controller.abort());
  lifetime.check();
    const remote = spyOn(queries, "remoteAddress");
    lifetime.onStop(() => remote.mockRestore());
  try {
    task.state = "waiting"; engine.drivers.set(task.id, controller);
    const rejection = lifetime.prepare(() => connections.connection(scope, controller.signal).then(() => undefined, error => error));
    engine.pause(task.id); resolve("https://github.com/acme/product.git");
    expect(await rejection).toBeInstanceOf(Aborted);
    expect(engine.taskDetails(task.id)!.state).toBe("paused"); expect(engine.s.inbox).toEqual([]); expect(engine.waiting.size).toBe(0);
    expect(connections["confirming"].size).toBe(0);
    expect(await rejectionOf(connections.connection(scope, controller.signal))).toBeInstanceOf(Aborted);
    expect(remote).toHaveBeenCalledTimes(1);
  } finally { remote.mockRestore(); await engine.shutdown(); }
  });
});

it("aborts a peer waiting on another task's confirmation without disrupting the original question", async () => {
  return owners.use(async ({ engine, scope, owner: lifetime }) => {

  const queries = { remoteAddress: async (_path: string) => "https://github.com/acme/product.git" };
  const connections = new Connections(engine, queries), owner = new AbortController(), peer = new AbortController();
  lifetime.onStop(() => { owner.abort(); peer.abort(); });
  lifetime.check();
    const remote = spyOn(queries, "remoteAddress");
    lifetime.onStop(() => remote.mockRestore());
  lifetime.check();
    const ownerListener = spyOn(owner.signal, "removeEventListener");
    lifetime.onStop(() => ownerListener.mockRestore());
  try {
    const pending = lifetime.prepare(() => connections.connection(scope, owner.signal));
    await waitFor(() => engine.waiting.size === 1, "the address question");
    const id = engine.s.inbox[0]!.id;
    const other = engine.task(engine.addTask({ productId: "p", title: "Peer", backlog: true }))!;
    const rejected = lifetime.prepare(() => connections.connection(executionFor(other), peer.signal).then(() => undefined, error => error));
    peer.abort(); expect(await rejected).toBeInstanceOf(Aborted);
    expect(engine.waiting.has(id)).toBe(true);
    engine.answer(id, CONFIRM_ADDRESS);
    expect(await pending).toMatchObject({ ok: true });
    expect(engine.waiting.size).toBe(0); expect(connections["confirming"].size).toBe(0);
    expect(ownerListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(engine.s.products[0]!.remote).toBe("https://github.com/acme/product.git");
  } finally { remote.mockRestore(); ownerListener.mockRestore(); await engine.shutdown(); }
  });
});

it("cleans question waiters on cancellation, on an answer and when already aborted", async () => {
  return owners.use(async ({ engine, task, scope, owner: lifetime }) => {

  const by = { roleId: "builder", profileId: "sol-high" };
  try {
    const already = new AbortController(); already.abort();
    expect(await rejectionOf(engine["turns"]["wait"](scope, "question", "No orphan", true, {}, already.signal, "Waiting", by, false))).toBeInstanceOf(Aborted);
    expect(engine.s.inbox).toEqual([]); expect(engine.waiting.size).toBe(0);
    const controller = new AbortController();
    lifetime.onStop(() => controller.abort());
    lifetime.check();
    const remove = spyOn(controller.signal, "removeEventListener");
    lifetime.onStop(() => remove.mockRestore());
    engine.drivers.set(task.id, controller);
    const rejection = lifetime.prepare(() => engine["turns"]["wait"](scope, "question", "A live question", true, {}, controller.signal, "Waiting", by, false).then(() => undefined, error => error));
    engine.pause(task.id); expect(await rejection).toBeInstanceOf(Aborted);
    expect(engine.waiting.size).toBe(0); expect(engine.s.inbox).toEqual([]);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function)); remove.mockRestore();
    const answerController = new AbortController();
    lifetime.onStop(() => answerController.abort());
    const answer = lifetime.prepare(() => engine["turns"]["wait"](scope, "question", "Another question", true, {}, answerController.signal, "Waiting", by, false));
    engine.answer(engine.s.inbox[0]!.id, "Continue");
    expect(await answer).toBe("Continue"); expect(engine.waiting.size).toBe(0);
  } finally { await engine.shutdown(); }
  });
});

it("keeps preparation room for lesson and guide offers, but gives it back for a real question", async () => {
  return owners.use(async ({ engine, task, scope, owner: lifetime }) => {

  lifetime.check();
    const scheduled = spyOn(engine, "schedule");
    lifetime.onStop(() => scheduled.mockRestore());
    scheduled.mockImplementation(() => {});
  const controller = new AbortController();
  lifetime.onStop(() => controller.abort());
  let question: Promise<string> | undefined;
  try {
    engine.draining = false; engine.s.pool.limit = 1; task.state = "running";
    const checks = engine["checks"];
    const peer = engine.task(engine.addTask({ productId: "p", title: "Waiting for preparation room", backlog: true }))!;
    scheduled.mockClear();
    expect(checks.claimPreparation(task.id)).toBe(true);
    scope.work.lessons = [{ text: "Use the focused checks before a full run.", roleId: "builder", profileId: "sol-high", at: 0 }];
    await engine["learnings"].offer(scope);
    expect(engine.s.inbox.find(item => item.taskId === task.id && item.kind === "learnings")).toMatchObject({ blocking: false, body: "- Use the focused checks before a full run." });
    expect(task.state).toBe("running");
    expect(checks.preparingCount).toBe(1);
    expect(checks.claimPreparation(peer.id)).toBe(false);

    // The Guide keeper's offer also lets its caller carry on in the same step.
    engine.raise(scope, "guide", "Add a review point?", false);
    task.state = "running";
    await Promise.resolve();
    expect(checks.preparingCount).toBe(1);
    expect(checks.claimPreparation(peer.id)).toBe(false);
    expect(checks.claimPreparation(task.id)).toBe(true);
    expect(scheduled).not.toHaveBeenCalled();

    question = lifetime.prepare(() => engine["turns"]["wait"](scope, "question", "A decision that really waits", true, {}, controller.signal, "Waiting", { roleId: "builder", profileId: "sol-high" }, false));
    await Promise.resolve();
    expect(checks.preparingCount).toBe(0);
    expect(checks.claimPreparation(peer.id)).toBe(true);
    expect(scheduled).toHaveBeenCalledTimes(1);
    engine.answer(engine.s.inbox.find(item => item.kind === "question")!.id, "Continue");
    expect(await question).toBe("Continue");
  } finally { controller.abort(); await Promise.allSettled(question ? [question] : []); scheduled.mockRestore(); await engine.shutdown(); }
  });
});

it("rejects answer and denial actions for other inbox kinds without consuming their identity or resolving a waiter", async () => {
  return owners.use(async ({ engine, task, owner: lifetime }) => {

  try {
    for (const kind of ["plan", "design", "delivery", "question", "permission", "stuck"] as const) {
      const id = engine.raise(task, kind, "Keep this decision", true);
      let resolved = false;
      engine.waiting.set(id, { resolve: () => { resolved = true; }, reject: () => {} });
      const before = JSON.stringify(task);
      if (kind !== "question") expect(() => engine.answer(id, "yes", { clientId: "reusable-answer" })).toThrow("Use Answer only");
      if (kind !== "permission") expect(() => engine.deny(id, "no", { clientId: "reusable-denial" })).toThrow("Use Deny only");
      expect(resolved).toBe(false); expect(JSON.stringify(task)).toBe(before);
      expect(engine.s.inbox.some(item => item.id === id)).toBe(true);
      engine.waiting.delete(id); engine.takeItem(id);
    }
    const id = engine.raise(task, "permission", "Allowed action?", true);
    const permissionController = new AbortController();
    lifetime.onStop(() => permissionController.abort());
    const permission = lifetime.prepare(() => engine.waitForReply(id, permissionController.signal));
    engine.deny(id, "Please investigate first", { clientId: "reusable-denial" });
    expect(await permission).toBe("deny");
    expect(task.received).toContain("reusable-denial");
  } finally { await engine.shutdown(); }
  });
});
