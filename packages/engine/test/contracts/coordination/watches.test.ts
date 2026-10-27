import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";


import { EngineClient } from "../../client.js";

import { serve } from "../../../src/server.js";
import { writeConnection } from "../../../src/instance.js";

import { SLOW, waitFor } from "../../support.js";

import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

describe("focused coordination and durable decisions", () => {
it("supports quiet deadlines, already satisfied conditions, filtered inbox changes and lost continuity", async () => {
  return owners.use(async ({ e, c, taskId, offer , owner: lifetime}) => {

    expect((await c.call("watch.wait", { target: "pool", condition: "drained", timeoutMs: 1000 * SLOW })).outcome).toBe("completed");
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "state", states: ["queued"], timeoutMs: 0 })).outcome).toBe("completed");
    const quiet = await c.call("watch.wait", { target: "task", taskId, timeoutMs: 5 });
    expect(quiet.outcome).toBe("timed-out");
    const watching = lifetime.prepare(() => c.call("watch.wait", { target: "inbox", kinds: ["question"], timeoutMs: 1000 * SLOW }));
    offer("question");
    e.commit();
    expect((await watching).outcome).toBe("completed");
    expect((await c.call("watch.wait", { target: "task", taskId, marker: "another-boot.123", timeoutMs: 0 })).outcome).toBe("continuity-lost");
    const drained = lifetime.prepare(() => c.call("watch.wait", { target: "pool", condition: "drained", timeoutMs: 5 }));
    expect((await drained).outcome).toBe("completed");
  });
});
});

describe("the shared terminal and MCP connection", () => {
it("reconnects a focused watch and reports lost continuity after engine replacement", async () => {
  return owners.use(async ({ e, home, taskId, owner: lifetime }) => {

    const token = "watch-key-01234567890123456789012";
    lifetime.check();
    const first = serve(e, { port: 0, token });
    lifetime.onStop(() => first.stop(true));
    let replacement: ReturnType<typeof serve> | undefined;
    lifetime.onStop(() => replacement?.stop(true));
    const connect = (server: ReturnType<typeof serve>) =>
      writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, token, pid: process.pid });
    connect(first);
    const client = new EngineClient(home, () => {
      throw new Error("A watch must never launch an engine");
    });
    try {
      const initial = await client.call("watch.wait", { target: "task", taskId, timeoutMs: 0 });
      const listeners = e.listeners.size;
      const watching = lifetime.prepare(() => client.call("watch.wait", { target: "task", taskId, marker: initial.marker, timeoutMs: 3000 * SLOW }));
      await waitFor(() => e.listeners.size > listeners, "the focused watch connection", undefined, { during: watching });
      await first.stop(true);
      await e.shutdown();
      const next = await lifetime.restart(e, lifetime.root, { admissionsClosed: true, usageCommands: { codex: null, grok: null }, terminals: () => [] });
      lifetime.check();
      replacement = serve(next, { port: 0, token });
      connect(replacement);
      const result = await watching;
      expect(result.outcome).toBe("continuity-lost");
      expect(result.reconnected).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThan(3000);
    } finally {
      await first.stop(true);
      await replacement?.stop(true);
    }
  });
});
});

for (const count of [2, 26, 100]) {
it(`checks all ${count} selected tasks for completion and decisions, independently of the reply page`, async () => {
  return owners.use(async ({ e, c, taskId }) => {

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
});
}
