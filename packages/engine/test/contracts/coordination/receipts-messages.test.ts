
import { afterAll, describe, expect, it } from "bun:test";

import { Coordination } from "../../../src/coordination.js";

import { ScriptedAgents } from "../../scripted-agents.js";

import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

describe("focused coordination and durable decisions", () => {
it("saves creation and message outcomes, rejects conflicting references and keeps them after restart", async () => {
  return owners.use(async ({ e, c, owner: lifetime }) => {

    const args = { productId: "product", title: "Once", requestId: "create-once" };
    const created = await c.call("task.add", args);
    expect(await c.call("task.add", args)).toEqual(created);
    expect((await c.call("task.add", { ...args, title: "Different" })).outcome).toBe("conflict");
    const sent = await c.call("task.message", { taskId: created.taskId, text: "Only once", requestId: "message-once" });
    expect(sent.messageId).toBeString();
    await e.shutdown();
    const restarted = await lifetime.restart(e, lifetime.root, { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
    const again = new Coordination(restarted);
    expect(await again.call("task.add", args)).toEqual(created);
    expect(await again.call("task.message", { taskId: created.taskId, text: "Only once", requestId: "message-once" })).toEqual(sent);
    expect(restarted.task(String(created.taskId))!.queued).toHaveLength(1);
  });
});
});

describe("focused coordination and durable decisions", () => {
it("keeps task and message receipts after archival and replacement without restoring finished bodies to active work", async () => {
  return owners.use(async ({ e, c, owner: lifetime }) => {

    const args = { productId: "product", title: "Archived once", backlog: true, requestId: "archived-create" };
    const created = await c.call("task.add", args);
    const sent = await c.call("task.message", { taskId: created.taskId, text: "Keep this instruction", requestId: "archived-message" });
    const task = e.task(String(created.taskId))!;
    task.state = "done";
    task.column = "done";
    task.finishedAt = 1;
    e.save();
    expect(e.activeState().tasks.some((task) => task.id === created.taskId)).toBe(false);
    await e.shutdown();
    const restarted = await lifetime.restart(e, lifetime.root, { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });
    restarted.getState = () => { throw new Error("Do not reconstruct the archive"); };
    const again = new Coordination(restarted);
    expect(await again.call("task.add", args)).toEqual(created);
    expect(await again.call("task.message", { taskId: created.taskId, text: "Keep this instruction", requestId: "archived-message" })).toEqual(sent);
    expect(restarted.activeState().tasks.some((task) => task.id === created.taskId)).toBe(false);
    expect((await again.call("task.inspect", { taskId: created.taskId })).task).toHaveProperty("state", "done");
    expect((await again.call("task.read", { taskId: created.taskId, section: "messages" })).text).toContain("Keep this instruction");
  });
});
});

describe("focused coordination and durable decisions", () => {
it("keeps partially delivered group messages and reports saved review results from before full handoffs were recorded", async () => {
  return owners.use(async ({ e, c, taskId }) => {

    const sent = await c.call("task.message", { taskId, text: "Check both views", requestId: "group-message" });
    const task = e.task(taskId)!;
    task.queued[0]!.recipients = { "review-0": true, "review-1": false };
    const denied = await c.call("task.remove-message", { taskId, messageId: sent.messageId, requestId: "remove-delivered" });
    expect(denied.outcome).toBe("invalid");
    expect(denied.message).toContain("already received");
    expect(task.queued).toHaveLength(1);
    expect(task.queued[0]!.recipients).toEqual({ "review-0": true, "review-1": false });
    task.queued[0]!.recipients = { "review-0": false, "review-1": false };
    expect((await c.call("task.remove-message", { taskId, messageId: sent.messageId, requestId: "remove-unheard" })).outcome).toBe("completed");
    expect(task.queued).toEqual([]);
    task.journey = [{ id: "review", kind: "agent", roleId: "code-reviewer", stageId: "review", round: 1, sub: 0, startedAt: 1, result: { findings: [] } }];
    const node = await c.call("journey.node", { taskId, nodeId: "review" });
    expect(node.result).toBe("recorded");
    expect(JSON.parse(String(node.text)).result).toEqual({ findings: [] });
    expect(node.input).toBe("unavailable");
  });
});
});

it("returns the new interrupting message's identity even when identical wording is already queued", async () => {
  return owners.use(async ({ e, c, home, taskId, task, owner: lifetime }) => {

  let cancelled = 0;
  const agents = new ScriptedAgents(() => { throw new Error("This receipt decision must not start a provider turn"); });
  const session = await agents.start({ profile: e.profile("sol-high")!, cwd: home, signal: new AbortController().signal,
    callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" } }, e.role("builder")!);
  lifetime.check();
  const stopSession = lifetime.onStop(async () => { if (!await session.stop()) throw new Error("The scripted message session did not confirm cleanup"); });
  const cancel = session.cancel.bind(session);
  session.cancel = async () => { cancelled++; await cancel(); };
  e.runs.set(taskId, session);
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
  } finally { e.runs.delete(taskId); await stopSession(); }
  });
});
