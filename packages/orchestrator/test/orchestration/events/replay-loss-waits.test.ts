import { expect, it, describe } from "vitest";
import { eventFixture, all } from "../../fixtures/workflow-events.js";

describe("the bounded event log", () => {
it("reports replay loss during an open wait, including unrelated bursts, and releases every watcher", async () => {
    const f = eventFixture({ events: 2 }); const events = f.query;
    const taskId = f.newTask({ productId: "product", title: "Fast transitions" }).id;
    const task = f.task(taskId)!;
    const start = await events({ taskIds: [taskId], timeoutMs: 0 });
    const matching = events({ taskIds: [taskId], cursor: start.cursor, timeoutMs: 1000 });
    const filtered = events({ taskIds: [taskId], kinds: ["node.started"], cursor: start.cursor, timeoutMs: 1000 });
    expect(f.events.waiting).toBe(2);
    // No reader can run between these changes. Both cursors lose events, even though one filter has no match.
    for (const state of ["waiting", "running", "paused", "running"] as const) { task.state = state; f.observe(task); }
    for (const result of await Promise.all([matching, filtered])) {
      expect(result).toMatchObject({ outcome: "continuity-lost", reason: "replay-expired", events: [], more: false });
      expect(result.boundary).toMatchObject({ oldest: 4, newest: 5, evictedThrough: 3 });
    }
    expect(f.events.waiting).toBe(0);
    expect(f.events.log.waiting).toBe(0);
    // Explicitly starting again remains possible at the available boundary.
    expect(all(await events({ taskIds: [taskId], from: "oldest", timeoutMs: 0 })).map(event => event.seq)).toEqual([4, 5]);
  });
});
