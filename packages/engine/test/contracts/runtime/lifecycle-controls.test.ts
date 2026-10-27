
import { afterAll, describe, expect, it } from "bun:test";

import { Coordination } from "../../../src/coordination.js";
import { EngineClient } from "../../client.js";
import { EngineLifecycle } from "../../../src/lifecycle.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { serve } from "../../../src/server.js";
import { writeConnection } from "../../../src/instance.js";

import { SLOW, waitFor } from "../../support.js";
import { serial, type Result } from "../../../src/coordination.js";
import { FolderLock } from "../../../src/instance.js";

import { exitCode } from "../../../src/coordination-cli.js";

import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

describe("focused coordination and durable decisions", () => {
it("uses one drain definition for admitted steps, questions, permissions and cleanup, while saved screen work waits separately", async () => {
  return owners.use(async ({ e, home, taskId, offer, owner: lifetime }) => {

    await Promise.all([...e.backgroundWork]);
    let release!: () => void;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    e.settling.set(taskId, work);
    const t = e.task(taskId)!;
    t.state = "running";
    t.holdsSlot = true;
    t.agent = { roleId: "builder", profileId: "opus-high", since: Date.now(), step: 0 };
    offer("question");
    offer("permission");
    offer("screen");
    let cleaned!: () => void;
    const cleanup = e.trackWork(
      new Promise<void>((resolve) => {
        cleaned = resolve;
      }),
    );
    lifetime.onStop(() => { release(); cleaned(); e.settling.delete(taskId); });
    lifetime.check();
    const store = new LifecycleStore(home);
    const closeStore = lifetime.afterBody(() => store.close());
    let stops = 0;
    lifetime.check();
    const life = new EngineLifecycle(e, store, async () => {
      stops++;
      store.finish("completed");
    });
    lifetime.onStop(() => life.close());
    try {
      expect((life.status().blockers as { kind: string }[]).map((item) => item.kind)).toEqual(["question", "permission", "screen"]);
      expect((await life.request("stop", { requestId: "drain-everything" })).outcome).toBe("pending");
      expect(stops).toBe(0);
      expect(await e.drain(0)).toBeGreaterThan(0);
      e.s.inbox = [];
      t.holdsSlot = false;
      delete t.agent;
      e.settling.delete(taskId);
      release();
      expect(life.status().drained).toBe(false);
      cleaned();
      await cleanup;
      t.screen = { reason: "A saved screen check", roleId: "builder", profileId: "opus-high", at: Date.now() };
      t.state = "waiting";
      expect(life.status().screenWaiting).toHaveLength(1);
      expect(await e.drain(0)).toBe(0);
      expect(life.status().drained).toBe(true);
      await waitFor(() => stops === 1, "one fully drained stop");
    } finally {
      release();
      cleaned();
      life.close();
      await closeStore();
      e.settling.delete(taskId);
    }
  });
});
});

for (const kind of ["stop", "restart"] as const) {
it(`signals only accepted desktop ${kind} handoffs, and clears a failed handoff`, async () => {
  return owners.useEngine(async ({ e, home, owner: lifetime }) => {
  e.schedule = () => {};
  new Coordination(e);
  lifetime.check();
    const store = new LifecycleStore(home);
    const closeStore = lifetime.afterBody(() => store.close());
  const signals: boolean[] = [];
  lifetime.check();
    const lifecycle = new EngineLifecycle(e, store, async () => { throw new Error("controlled handoff failure"); }, (active) => signals.push(active));
    lifetime.onStop(() => lifecycle.close());
  let unblock!: () => void;
  const hold = new Promise<void>((resolve) => { unblock = resolve; });
  lifetime.onStop(() => { unblock(); e.settling.delete("admitted"); });
  e.settling.set("admitted", hold);
  try {
    expect((await lifecycle.request(kind, { requestId: `accepted-${kind}` })).outcome).toBe("pending");
    expect(signals).toEqual([true]);
    expect((await lifecycle.request(kind, { requestId: `accepted-${kind}` })).outcome).toBe("pending");
    expect(signals).toEqual([true, true]);
    unblock();
    e.settling.delete("admitted");
    await waitFor(() => store.current?.phase === "failed", "the controlled restart handoff failure");
    expect(signals).toEqual([true, true, false]);
    expect((await lifecycle.request(kind, { requestId: `accepted-${kind}` })).outcome).toBe("failed");
    expect(signals).toEqual([true, true, false]);
  } finally {
    unblock(); e.settling.delete("admitted"); lifecycle.close(); await closeStore(); await e.shutdown();
  }

  }, { prefix: "petrina-desktop-handoff-signal-", options: { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] } });
});
}

for (const next of ["resume", "stop", "restart"]) {
it(`a lost ${next} reply during a pause cannot reserve a receipt without applying its live engine effects`, async () => {
  return owners.useEngine(async ({ e, home, owner: lifetime }) => {
  e.schedule = () => {};
  const ownership = FolderLock.take(home)!;
  const releaseOwnership = lifetime.afterBody(() => ownership.release());
  lifetime.check();
    const store = new LifecycleStore(home);
    const closeStore = lifetime.afterBody(() => store.close());
  let stops = 0;
  lifetime.check();
    const lifecycle = new EngineLifecycle(e, store, async () => { stops++; store.finish("completed"); });
    lifetime.onStop(() => lifecycle.close());
  const token = "lost-reply-connection-key-12345678";
  lifetime.check();
    const server = serve(e, { port: 0, token, lifecycle });
    lifetime.onStop(() => server.stop(true));
  writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
  let unblock!: () => void;
  let queued: Promise<Result> | undefined;
  lifetime.onStop(() => { unblock?.(); e.settling.clear(); });
  e.settling.set("admitted-work", new Promise(() => {}));
  try {
    expect((await lifecycle.request("pause", { requestId: "pause" })).outcome).toBe("pending");
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const held = lifetime.prepare(() => serial(e, () => gate));
    // Stand-in transport: submit behind another app action, then lose the reply. Offline
    // recovery runs before the serialized engine request has had a chance to apply itself.
    const dropped = new EngineClient(home, () => { throw new Error("must not launch"); });
    (dropped as unknown as { request: (name: string, args: Record<string, unknown>) => Promise<Result> }).request = async (name, args) => {
      queued = lifetime.prepare(() => lifecycle.request(name.slice(7), args));
      return { outcome: "disconnected" };
    };
    const args = { requestId: "lost-control" };
    const unknown = await dropped.call(`engine.${next}`, args);
    expect(unknown.outcome).toBe("disconnected");
    expect(store.receipt(args.requestId)).toBeUndefined();
    expect(store.current?.kind).toBe("pause");
    unblock();
    await held;
    expect((await queued)!.outcome).toBe(next === "resume" ? "completed" : "pending");
    expect(e.s.pool.paused).toBe(next !== "resume");
    expect(e.draining).toBe(next !== "resume");
    const client = new EngineClient(home);
    expect((await client.call(`engine.${next}`, args)).outcome).toBe(next === "resume" ? "completed" : "pending");
    if (next !== "resume") {
      expect(() => e.setPoolPaused(false)).toThrow("stopping or restarting");
      expect((await client.call("engine.resume", { requestId: "cannot-reopen-admissions" })).outcome).toBe("conflict");
    }
    e.settling.clear();
    if (next !== "resume") await waitFor(() => store.current?.phase === "completed", "the recovered drain to finish");
    const finished = await client.call(`engine.${next}`, { ...args, wait: true, timeoutMs: 1000 * SLOW });
    expect(finished.outcome).toBe("completed");
    expect(finished.operation).toHaveProperty("kind", next);
    expect(stops).toBe(next === "resume" ? 0 : 1);
    expect(store.receipt("pause")!.outcome).toBe("superseded");
  } finally {
    unblock?.();
    await queued;
    e.settling.clear(); lifecycle.close(); await server.stop(true); await releaseOwnership(); await closeStore();
    await e.shutdown();
  }

  }, { prefix: "petrina-lost-lifecycle-", options: { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] } });
});
}

for (const next of ["resume", "stop", "restart"]) {
it(`allows ${next} to replace a draining pause while retaining stop/restart admission rules`, async () => {
  return owners.use(async ({ e, home, taskId, task, owner: lifetime }) => {

  lifetime.check();
    const store = new LifecycleStore(home);
    const closeStore = lifetime.afterBody(() => store.close());
  let stops = 0;
  lifetime.check();
    const lifecycle = new EngineLifecycle(e, store, async () => { stops++; store.finish("completed"); });
    lifetime.onStop(() => lifecycle.close());
  lifetime.check();
    const server = serve(e, { port: 0, token: "regression-connection-key-12345678", lifecycle });
    lifetime.onStop(() => server.stop(true));
  writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token: "regression-connection-key-12345678" });
  const client = new EngineClient(home);
  let settle!: () => void;
  e.settling.set(taskId, new Promise<void>((resolve) => { settle = resolve; }));
  lifetime.onStop(() => { settle(); e.settling.delete(taskId); });
  task.state = "running";
  task.holdsSlot = true;
  e.s.inbox.push({ id: "permission", taskId, kind: "permission", title: "Still needs permission", blocking: true, at: 1 });
  try {
    const pauseWait = lifetime.prepare(() => client.call("engine.pause", { requestId: "pause", wait: true, timeoutMs: 3000 }));
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
    settle(); e.settling.delete(taskId); lifecycle.close(); await server.stop(true); await closeStore();
  }
  });
});
}
