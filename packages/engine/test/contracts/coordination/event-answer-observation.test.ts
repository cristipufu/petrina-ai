import { afterAll, expect, it } from "bun:test";
import { createWorkflowEventFixtures, kinds, all } from "../../fixtures/workflow-event-native.js";

const { fixture, close } = createWorkflowEventFixtures();
afterAll(close);

it("observes the actual Engine question answer once after its recorded request", async () => {
  const { e, events } = fixture();
  const taskId = e.addTask({ productId: "product", title: "Actual answer" }), task = e.task(taskId)!;
  const start = await events({ taskIds: [taskId], timeoutMs: 0 });
  task.journey = [{ id: "question-step", kind: "agent", roleId: "builder", profileId: "sol-xhigh", round: 1, sub: 0, startedAt: 1,
    asks: [{ id: "actual-question", kind: "question", title: "Which greeting?", at: 2 }] }];
  e.s.inbox.push({ id: "actual-question", taskId, kind: "question", title: "Which greeting?", at: 2, blocking: true, roleId: "builder", profileId: "sol-xhigh" });
  task.state = "needs-you"; e.commit(task);
  const asked = await events({ taskIds: [taskId], cursor: start.cursor, timeoutMs: 0 });
  expect(kinds(asked)).toEqual(["node.started", "coordinator.request", "task.state"]);
  e.answer("actual-question", "Hello");
  const answered = await events({ taskIds: [taskId], cursor: asked.cursor, timeoutMs: 0 });
  expect(kinds(answered)).toEqual(["coordinator.decision", "task.state"]);
  expect(all(answered)[0]).toMatchObject({ itemId: "actual-question", how: "answered", answer: "Hello", requestKind: "question" });
  expect(e.s.inbox).toHaveLength(0);
  expect((await events({ taskIds: [taskId], cursor: answered.cursor, timeoutMs: 0 })).events).toEqual([]);
});
