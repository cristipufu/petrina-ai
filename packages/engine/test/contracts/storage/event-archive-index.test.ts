import { afterAll, describe, expect, it } from "bun:test";
import { executionFor } from "@petrina/orchestrator";
import { createWorkflowEventFixtures, kinds } from "../../fixtures/workflow-event-native.js";

const { fixture, close } = createWorkflowEventFixtures();
afterAll(close);

describe("the bounded event log", () => {
it("validates selected archived tasks without reading their bodies, so quiet renewals over more tasks than the archive cache holds read no archive", async () => {
    const { e, events } = fixture();
    const taskIds: string[] = [];
    for (let index = 0; index < 17; index++) {
      const taskId = e.addTask({ productId: "product", title: `Archived ${index}` });
      const task = e.task(taskId)!;
      executionFor(task).work.pr = { number: index + 1, url: `https://github.com/example/product/pull/${index + 1}`, state: "merged", openedAt: 1 };
      Object.assign(task, { state: "done", column: "done", finishedAt: Date.now() });
      e.commit(task);
      taskIds.push(taskId);
    }
    e.save();
    expect(e.s.tasks.filter((task) => taskIds.includes(task.id))).toHaveLength(0);
    const history = e.store.history;
    const bodies = history.get.bind(history);
    let reads = 0;
    history.get = (id) => { reads++; return bodies(id); };
    try {
      const start = await events({ taskIds, timeoutMs: 0 });
      expect(start).toMatchObject({ outcome: "completed", continuity: "fresh", events: [] });
      for (let renewal = 0; renewal < 3; renewal++) {
        expect(await events({ taskIds, cursor: start.cursor, timeoutMs: 20 })).toMatchObject({ outcome: "timed-out", events: [], continuity: "continuous", cursor: start.cursor });
      }
      expect(reads).toBe(0);
      // Validation still refuses a task that never existed, and the retained terminal events stay readable.
      expect((await events({ taskIds: [...taskIds, "missing"], timeoutMs: 0 })).outcome).toBe("missing");
      const replay = await events({ taskIds, kinds: ["task.finished"], from: "oldest", timeoutMs: 0, limit: 100 });
      expect(kinds(replay)).toEqual(Array.from({ length: 17 }, () => "task.finished" as const));
      expect(reads).toBe(0);
    } finally {
      history.get = bodies;
    }
  });
});
