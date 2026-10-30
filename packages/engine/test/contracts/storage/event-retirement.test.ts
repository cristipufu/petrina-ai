import { afterAll, describe, expect, it } from "bun:test";
import { executionFor } from "@petrina/orchestrator";
import { createWorkflowEventFixtures, kinds, all } from "../../fixtures/workflow-event-native.js";
const { fixture, close, use } = createWorkflowEventFixtures();
afterAll(close);
describe("the bounded event log", () => {
it("follows a product's newly admitted tasks, keeps terminal and later delivery events readable after retirement, and never touches execution", async () => {
  return use("petrina-events-", async caseOwner => {
    const { e, c, events } = fixture(caseOwner);
    const start = await events({ productId: "product", timeoutMs: 0 });
    const taskId = e.addTask({ productId: "product", title: "Shipped" });
    const task = e.task(taskId)!;
    task.state = "pr-open";
    executionFor(task).work.pr = { number: 3, url: "https://github.com/example/product/pull/3", state: "open", openedAt: 1 };
    e.commit(task);
    const first = await events({ productId: "product", cursor: start.cursor, timeoutMs: 0 });
    expect(kinds(first)).toEqual(["task.created", "publishing.result", "task.state"]);
    expect(all(first)[1]).toMatchObject({ productId: "product", result: { kind: "pull-request-open", landed: false }, landing: "awaiting-merge" });
    // Merged on GitHub: the task finishes and retires to the archive on the next save.
    executionFor(task).work.pr!.state = "merged";
    Object.assign(task, { state: "done", column: "done", finishedAt: Date.now() });
    e.commit(task);
    e.save();
    expect(e.s.tasks.some((entry) => entry.id === taskId)).toBe(false);
    const finished = await events({ productId: "product", cursor: first.cursor, timeoutMs: 0 });
    expect(kinds(finished)).toEqual(["publishing.result", "task.state", "task.finished"]);
    expect(all(finished)[2]).toMatchObject({ state: "done", landing: "landed", history: "merged", products: [{ productId: "product", result: { kind: "merged", landed: true } }] });
    // An archived task edited later (a cleanup result, a pull request lookup) still produces its event.
    const archived = e.task(taskId)!;
    expect(e.s.tasks.includes(archived)).toBe(false);
    executionFor(archived).work.cleanup = { removedAt: Date.now() };
    executionFor(archived).work.pr!.state = "closed";
    e.commit(archived);
    const later = await events({ productId: "product", cursor: finished.cursor, timeoutMs: 0 });
    expect(later.outcome).toBe("completed");
    expect(kinds(later)).toEqual(["publishing.result"]);
    expect(all(later)[0]).toMatchObject({ result: { kind: "pull-request-closed", decision: "none" } });
    // Another product's task is outside this scope but inside "all current work".
    e.s.products.push({ id: "other", name: "Other", repo: "local/other", tone: "green", delivery: "local" });
    const otherId = e.addTask({ productId: "other", title: "Elsewhere" });
    expect((await events({ productId: "product", cursor: later.cursor, timeoutMs: 0 })).events).toEqual([]);
    // A product cursor cannot widen to all work, nor narrow to a task outside the product.
    expect((await events({ cursor: later.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ taskIds: [otherId], cursor: later.cursor, timeoutMs: 0 })).outcome).toBe("invalid");
    expect((await events({ taskIds: [taskId], cursor: later.cursor, timeoutMs: 0 })).outcome).toBe("completed");
    expect(kinds(await events({ timeoutMs: 0, from: "oldest" })).filter((kind) => kind === "task.created")).toHaveLength(2);
    expect((await c.call("task.inspect", { taskId: otherId })).outcome).toBe("completed");
    expect((await events({ taskIds: ["missing"], timeoutMs: 0 })).outcome).toBe("missing");
    expect((await events({ productId: "nope", timeoutMs: 0 })).outcome).toBe("missing");
    expect(e.drivers.size).toBe(0);
    expect(e.s.inbox).toEqual([]);
  });
});
});
