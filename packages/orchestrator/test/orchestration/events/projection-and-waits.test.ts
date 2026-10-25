import { expect, it, describe } from "vitest";
import { queueBacklogTask, settleAsk } from "@petrina/core";
import { eventFixture, kinds, all } from "../../fixtures/workflow-events.js";

describe("the bounded event log", () => {
it("records creation, transitions, requests and decisions in order, and stays quiet through activity and text churn", async () => {
    const f = eventFixture(); const events = f.query;
    const start = await events({ timeoutMs: 0 });
    expect(start).toMatchObject({ outcome: "completed", continuity: "fresh", events: [], more: false });
    const taskId = f.newTask({ productId: "product", title: "Watch me", backlog: true }).id;
    const task = f.task(taskId)!;
    const first = await events({ cursor: start.cursor, timeoutMs: 0 });
    expect(kinds(first)).toEqual(["task.created"]);
    expect(first.events).toEqual([expect.objectContaining({ taskId, state: "backlog", productIds: ["product"], seq: 1, run: f.host.boot })]);
    queueBacklogTask(task, f.state.tasks.length);
    // Churn: streamed text, tool activity, to-do items and clocks change nothing in the log.
    task.session.push({ id: "line", from: "agent", at: f.clock.now(), text: "Working" });
    f.observe(task);
    task.toolActivity = { actionCount: 3, lastActivity: "Read a file" };
    task.todo = "Reading the code";
    task.statusLine = "Still working";
    f.observe(task);
    f.observe(task);
    f.observe();
    const second = await events({ cursor: first.cursor, timeoutMs: 0 });
    expect(kinds(second)).toEqual(["task.state"]);
    expect(all(second)[0]).toMatchObject({ from: "backlog", to: "queued" });
    const quietWork = events({ cursor: second.cursor, timeoutMs: 30 });
    f.clock.advance(30);
    const quiet = await quietWork;
    expect(quiet).toMatchObject({ outcome: "timed-out", events: [], cursor: second.cursor, continuity: "continuous" });
    // Narrowing all work to a task reuses the cursor; widening it again is refused.
    const waiting = events({ taskIds: [taskId], cursor: quiet.cursor, timeoutMs: 5000 });
    expect(f.events.waiting).toBe(1);
    // A quiet wait subscribes; it does not poll or clone the task.
    const details = f.host.taskDetails;
    let reads = 0;
    f.host.taskDetails = (id) => { reads++; return details(id); };
    f.clock.advance(1200);
    await Promise.resolve();
    f.host.taskDetails = details;
    expect(reads).toBe(0);
    // A question asked by an agent hangs under its step, as the engine records it.
    const askedAt = f.clock.now();
    task.journey = [{ id: "j1", kind: "agent", roleId: "builder", profileId: "sol-xhigh", round: 1, sub: 0, startedAt: askedAt - 10, asks: [{ id: "q1", kind: "question", title: "Which greeting?", at: askedAt }] }];
    f.state.inbox.push({ id: "q1", taskId, kind: "question", title: "Which greeting?", at: askedAt, blocking: true, roleId: "builder", profileId: "sol-xhigh" });
    task.state = "needs-you";
    f.observe(task);
    const asked = await waiting;
    expect(kinds(asked)).toEqual(["node.started", "coordinator.request", "task.state"]);
    expect(all(asked)[1]).toMatchObject({ requestKind: "question", itemId: "q1", nodeId: "j1", refs: { request: { itemId: "q1" } } });
    f.state.inbox = [];
    f.observe(task);
    settleAsk(task, "q1", "answered", f.clock.now(), "Hello");
    task.state = "waiting";
    f.observe(task);
    // The item leaves the inbox one change before its answer is recorded on the journey: one decision, with the answer.
    const answered = await events({ taskIds: [taskId], cursor: asked.cursor, timeoutMs: 0 });
    expect(kinds(answered)).toEqual(["coordinator.decision", "task.state"]);
    expect(all(answered)[0]).toMatchObject({ requestKind: "question", itemId: "q1", how: "answered", answer: "Hello" });
    expect((await events({ cursor: answered.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ productId: "product", cursor: answered.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    expect(f.events.waiting).toBe(0);
  });
});
