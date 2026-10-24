import { describe, expect, it } from "vitest";
import type { NewTaskInput } from "../../../src/commands.js";
import { combineBacklogTasks, queueBacklogTask, returnQueuedTaskToBacklog } from "../../../src/task-transitions.js";
import { products, request } from "../../fixtures/task-request.js";

describe("shared task request and queue rules", () => {
  it("retains independent source choices and applies approval defaults across the complete scope", () => {
    const choices: NonNullable<NewTaskInput["worksOn"]>[number][] = products.map(({ id, delivery }) => ({ productId: id, delivery: delivery!, startFrom: { kind: "default" } }));
    const task = request({ worksOn: choices, approvePlan: false });
    expect(task.title).toBe("Tidy the footer");
    expect(task.approvePlan).toBe(true);
    expect(task.approveDelivery).toBe(true);
    expect(task.explicitStart).toBe(true);
    choices[0]!.startFrom = { kind: "branch", name: "other" };
    task.selectedProducts![0]!.startFrom.kind = "default";
    expect(task.workChoice?.startFrom).toEqual({ kind: "default" });
    expect(request().approveDelivery).toBe(false);
    expect(request({ productId: "", approvePlan: false }).approvePlan).toBe(false);
    expect(request({ productId: "" }).approvePlan).toBe(true);
    expect(request({ worksOn: [], productId: "" }).selectedProducts).toEqual([]);
  });

  it("rejects invalid complete requests before producing a task", () => {
    expect(() => request({ title: "  " })).toThrow("title");
    expect(() => request({ productId: "missing" })).toThrow("registered products");
    const choice = { productId: "a", startFrom: { kind: "default" as const }, delivery: "local" as const };
    expect(() => request({ worksOn: [choice, choice] })).toThrow("once");
  });

  it("only moves untouched requests back and keeps combined request provenance", () => {
    const source = request({ backlog: true }, "source");
    const other = request({ backlog: true }, "other");
    const combined = request({ backlog: true }, "combined");
    expect(queueBacklogTask(source, 2)).toBe(true);
    source.startedAt = 101;
    expect(returnQueuedTaskToBacklog(source)).toBe(false);
    delete source.startedAt;
    expect(returnQueuedTaskToBacklog(source)).toBe(true);
    combineBacklogTasks(combined, [source, other], 200, 8);
    expect(combined.state).toBe("queued");
    expect(combined.priority).toBe(8);
    expect(combined.combinedFrom?.map(({ id }) => id)).toEqual(["source", "other"]);
    expect([source, other].map(({ state, combinedInto, holdsSlot }) => [state, combinedInto, holdsSlot])).toEqual([["cancelled", "combined", false], ["cancelled", "combined", false]]);
    expect(source.finishedAt).toBe(200);
  });
});
