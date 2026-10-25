import { expect, it, describe } from "vitest";
import { eventFixture, kinds, all } from "../../fixtures/workflow-events.js";

describe("the bounded event log", () => {
it("evicts the oldest events within the retention bound and reports an expired replay window explicitly", async () => {
    const f = eventFixture({ events: 6 }); const events = f.query;
    const taskId = f.newTask({ productId: "product", title: "Evict" }).id;
    const task = f.task(taskId)!;
    const start = await events({ taskIds: [taskId], timeoutMs: 0 });
    for (const state of ["waiting", "running", "needs-you", "running", "waiting", "running", "paused", "running"] as const) { task.state = state; f.observe(task); }
    expect(f.events.log.size).toBe(6);
    const expired = await events({ taskIds: [taskId], cursor: start.cursor, timeoutMs: 0 });
    expect(expired).toMatchObject({ outcome: "continuity-lost", reason: "replay-expired", events: [] });
    expect(expired.boundary).toMatchObject({ oldest: 4, newest: 9, evictedThrough: 3 });
    const oldest = await events({ taskIds: [taskId], from: "oldest", timeoutMs: 0 });
    expect(all(oldest).map((event) => event.seq)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(oldest.continuity).toBe("fresh");
    const fresh = await events({ taskIds: [taskId], timeoutMs: 0 });
    expect(fresh.events).toEqual([]);
    task.state = "needs-you";
    f.observe(task);
    expect(kinds(await events({ taskIds: [taskId], cursor: fresh.cursor, timeoutMs: 0 }))).toEqual(["task.state"]);
  });
});
