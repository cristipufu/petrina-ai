import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";

import { EngineClient } from "../../client.js";

import { serve } from "../../../src/server.js";
import { writeConnection } from "../../../src/instance.js";
import { mcpRequest } from "../../../src/mcp.js";

import { SLOW, waitFor } from "../../support.js";
import { spyOn } from "bun:test";

import { type Result } from "../../../src/coordination.js";
import { coordinationCli } from "../../../src/coordination-cli.js";

import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

describe("focused coordination and durable decisions", () => {
it("distinguishes confirmed delivery, awaiting merge, landing, cancellation and unconfirmed mark done", async () => {
  return owners.use(async ({ e, c, taskId }) => {

    const task = e.task(taskId)!;
    task.state = "done";
    expect((await c.call("task.inspect", { taskId })).task).toHaveProperty("landing", "marked-done");
    expect((await c.call("task.inspect", { taskId })).task).toHaveProperty("deliveryConfirmed", false);
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "delivered", timeoutMs: 0 })).outcome).toBe("timed-out");
    task.state = "pr-open";
    executionFor(task).work.pr = { number: 1, url: "https://github.com/example/product/pull/1", state: "open", openedAt: 1 };
    expect((await c.call("task.inspect", { taskId })).task).toHaveProperty("deliveryConfirmed", true);
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "delivered", timeoutMs: 0 })).outcome).toBe("completed");
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "landed", timeoutMs: 0 })).outcome).toBe("timed-out");
    task.state = "done";
    executionFor(task).work.pr!.state = "merged";
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "landed", timeoutMs: 0 })).outcome).toBe("completed");
    task.state = "cancelled";
    expect((await c.call("task.inspect", { taskId })).task).toHaveProperty("landing", "cancelled");
    expect((await c.call("watch.wait", { target: "task", taskId, condition: "delivered", timeoutMs: 0 })).outcome).toBe("timed-out");
  });
});
});

it("cancels an awaiting-merge task using the existing cancellation behavior", async () => {
  return owners.use(async ({ e, c, taskId, task }) => {

  task.state = "pr-open";
  executionFor(task).work.pr = { number: 1, state: "open", url: "https://github.com/example/product/pull/1", openedAt: 1 };
  const args = { taskId, requestId: "cancel-awaiting-merge" };
  expect((await c.call("task.cancel", args)).outcome).toBe("completed");
  expect(e.task(taskId)!.state as string).toBe("cancelled");
  expect(executionFor(task).work.pr!.state).toBe("open");
  expect((await c.call("task.cancel", args)).outcome).toBe("completed");
  });
});

it("keeps closed, unmerged pull requests unconfirmed in inspection, history and waits", async () => {
  return owners.use(async ({ e, c, taskId, task }) => {

  task.state = "done";
  executionFor(task).work.pr = { number: 1, state: "closed", url: "https://github.com/example/product/pull/1", openedAt: 1 };
  expect((await c.call("task.inspect", { taskId })).task).toHaveProperty("deliveryConfirmed", false);
  e.save();
  expect((await c.call("task.history", { taskId })).items).toEqual([expect.objectContaining({ landing: "closed", deliveryConfirmed: false })]);
  for (const condition of ["delivered", "landed"]) expect((await c.call("watch.wait", { target: "task", taskId, condition, timeoutMs: 0 })).outcome).toBe("timed-out");
  });
});

it("keeps a one-product task you marked done unconfirmed after a later lookup finds its pull request merged", async () => {
  return owners.use(async ({ e, c, taskId, task }) => {

  const confirmed = e.task(e.addTask({ productId: "product", title: "Published by Petrina" }))!;
  const merged = { number: 1, state: "merged" as const, url: "https://github.com/example/product/pull/1", openedAt: 1 };
  for (const [entry, cleanup] of [[task, { markedDone: true, pullRequest: "none" as const }], [confirmed, undefined]] as const) {
    Object.assign(entry, { state: "done", column: "done", finishedAt: entry === task ? 200 : 100 });
    Object.assign(executionFor(entry).work, { delivery: "pull-request", pr: merged, cleanup });
  }
  const delivery = async (id: string) => {
    const { landing, deliveryConfirmed } = (await c.call("task.inspect", { taskId: id })).task as Record<string, unknown>;
    const waits = await Promise.all(["delivered", "landed"].map(async (condition): Promise<string> => (await c.call("watch.wait", { target: "task", taskId: id, condition, timeoutMs: 0 })).outcome));
    return { landing, deliveryConfirmed, waits };
  };
  const unconfirmed = { landing: "marked-done", deliveryConfirmed: false, waits: ["timed-out", "timed-out"] };
  expect(await delivery(taskId)).toEqual(unconfirmed);
  expect(await delivery(confirmed.id)).toEqual({ landing: "landed", deliveryConfirmed: true, waits: ["completed", "completed"] });
  e.save();
  const readBody = e.store.history.get.bind(e.store.history);
  try {
    e.store.history.get = () => { throw new Error("History pages must only read saved summaries"); };
    for (const name of ["task.history", "task.list"]) expect((await c.call(name, { states: ["done"] })).items).toEqual([
      expect.objectContaining({ id: taskId, landing: "marked-done", deliveryConfirmed: false }),
      expect.objectContaining({ id: confirmed.id, landing: "landed", deliveryConfirmed: true }),
    ]);
  } finally { e.store.history.get = readBody; }
  // Archived, the full record still answers inspection and waits the same way.
  expect(e.activeState().tasks.map((entry) => entry.id)).not.toContain(taskId);
  expect(await delivery(taskId)).toEqual(unconfirmed);
  expect((await c.call("watch.wait", { target: "task", taskIds: [confirmed.id, taskId], condition: "landed", timeoutMs: 0 })).outcome).toBe("timed-out");
  });
});

it("judges shared delivery across every product in CLI and MCP summaries, waits and History", async () => {
  return owners.use(async ({ e, home, owner: lifetime }) => {

  e.s.products.push({ id: "other", name: "Other", repo: "local/other", tone: "green" });
  const worksOn = ["product", "other"].map((productId) => ({ productId, startFrom: { kind: "default" as const }, delivery: "pull-request" as const }));
  const work = (productId: string, state: "open" | "merged" | "closed") => ({
    productId, delivery: "pull-request" as const, completedStages: [], companion: { text: "Part of a change across: Example, Other.", state: "done" as const },
    pr: { number: productId === "product" ? 1 : 2, url: `https://github.com/example/${productId}/pull/1`, state, openedAt: 1 },
  });
  const shared = (title: string, repositories: ReturnType<typeof work>[], more: Record<string, unknown>) => Object.assign(e.task(e.addTask({ productId: "product", title, worksOn }))!, { repositories, leadProductId: "product", activeProductId: "product", ...more });
  // The lead merged first; its companion pull request is still open.
  const awaiting = shared("Shared change", [work("product", "merged"), work("other", "open")], { state: "pr-open", column: "ready", statusLine: "Waiting for every pull request to merge" });
  const token = "shared-landing-connection-key-1234";
  lifetime.check();
    const server = serve(e, { port: 0, token });
    lifetime.onStop(() => server.stop(true));
  writeConnection(home, { api: `http://127.0.0.1:${server.port}`, url: `ws://127.0.0.1:${server.port}/ws`, pid: process.pid, token });
  const client = new EngineClient(home, () => { throw new Error("coordination cannot launch"); });
  const interfaces: Record<string, (name: string, args: Record<string, unknown>) => Promise<Result>> = {
    mcp: async (name, args) => ((await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `petrina_${name.replaceAll(".", "_")}`, arguments: args } }, client))!.result as { structuredContent: Result }).structuredContent,
    cli: async (name, args) => {
      const argv = [...name.split("."), "--json"];
      for (const [key, value] of Object.entries(args)) argv.push(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, typeof value === "string" ? value : JSON.stringify(value));
      lifetime.check();
    const output = spyOn(console, "log");
    lifetime.onStop(() => output.mockRestore());
    output.mockImplementation(() => {});
      try { await coordinationCli(argv, client); return JSON.parse(String(output.mock.calls.at(-1)![0])); } finally { output.mockRestore(); }
    },
  };
  const wait = (call: (name: string, args: Record<string, unknown>) => Promise<Result>, condition: string, taskIds: string[], more: Record<string, unknown> = {}) => call("watch.wait", { target: "task", taskIds, condition, limit: 1, timeoutMs: 0, ...more });
  try {
    for (const call of Object.values(interfaces)) for (const shown of ["product", "other"]) for (const lead of ["product", "other"]) {
      Object.assign(awaiting, { activeProductId: shown, leadProductId: lead });
      expect((await call("task.inspect", { taskId: awaiting.id })).task).toMatchObject({ productId: shown, landing: "awaiting-merge", deliveryConfirmed: true });
      for (const productId of ["product", "other"]) expect(((await call("task.list", { productId, taskId: awaiting.id })).items as Result[])[0]).toMatchObject({ landing: "awaiting-merge", deliveryConfirmed: true });
      expect((await wait(call, "delivered", [awaiting.id])).outcome).toBe("completed");
      expect((await wait(call, "landed", [awaiting.id])).outcome).toBe("timed-out");
    }
    // A pending landed wait finishes only once the companion lands too.
    const before = await wait(interfaces.mcp!, "landed", [awaiting.id]);
    const listeners = e.listeners.size;
    const waits = Object.values(interfaces).map((call) => lifetime.prepare(() => wait(call, "landed", [awaiting.id], { marker: before.marker, timeoutMs: 5000 * SLOW })));
    await waitFor(() => e.listeners.size >= listeners + 2, "both landed waits", undefined, { during: Promise.all(waits) });
    Object.assign(awaiting, { repositories: [work("product", "merged"), work("other", "merged")], state: "done", column: "done", statusLine: "All products have landed", finishedAt: 200 });
    e.commit();
    for (const landed of await Promise.all(waits)) {
      expect(landed.outcome).toBe("completed");
      expect((landed.result as { items: Result[] }).items[0]).toMatchObject({ landing: "landed", deliveryConfirmed: true });
    }
    // You accepted the closed companion, which released dependents without landing it.
    const accepted = { ...work("other", "closed"), landingAccepted: { at: 1 } };
    const mixed = shared("Shared mixed change", [work("product", "merged"), accepted], { state: "done", column: "done", statusLine: "All products have landed", finishedAt: 100, activeProductId: "product" });
    e.save();
    expect(e.activeState().tasks.map((task) => task.id)).not.toContain(mixed.id);
    const readBody = e.store.history.get.bind(e.store.history);
    try {
      e.store.history.get = () => { throw new Error("History pages must only read saved summaries"); };
      for (const call of Object.values(interfaces)) for (const productId of ["product", "other"]) for (const name of ["task.history", "task.list"]) {
        const first = await call(name, { productId, states: ["done"], limit: 1 });
        expect(first.items).toEqual([expect.objectContaining({ id: awaiting.id, landing: "landed", deliveryConfirmed: true })]);
        expect((await call(name, { productId, states: ["done"], limit: 1, cursor: first.next })).items).toEqual([expect.objectContaining({ id: mixed.id, landing: "closed", deliveryConfirmed: false })]);
      }
    } finally { e.store.history.get = readBody; }
    for (const call of Object.values(interfaces)) {
      expect((await call("task.inspect", { taskId: mixed.id })).task).toMatchObject({ landing: "closed", deliveryConfirmed: false });
      for (const condition of ["delivered", "landed"]) {
        expect((await wait(call, condition, [awaiting.id])).outcome).toBe("completed");
        // The reply page shows only the landed task, but the mixed one keeps the selection unsatisfied.
        expect((await wait(call, condition, [awaiting.id, mixed.id])).outcome).toBe("timed-out");
      }
    }
  } finally { await server.stop(true); }
  });
});
