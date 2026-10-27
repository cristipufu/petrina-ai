
import { afterAll, describe, expect, it } from "bun:test";

import { createToolActivity } from "@petrina/agent-runtime/tool-activity";
import { ToolInvocations } from "@petrina/agent-runtime/tool-invocations";
import { recordToolActivity } from "../../../src/record-tool-activity.js";

import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

describe("focused coordination and durable decisions", () => {
it("inspects per-seat tool evidence without putting commands or invocation lists in live updates", async () => {
  return owners.use(async ({ e, c, taskId }) => {

    const task = e.task(taskId)!;
    task.state = "running";
    task.journey = [{ id: "activity", kind: "agent", startedAt: 1, round: 1, sub: 0 }];
    task.agent = { roleId: "reviewer", profileId: "sol-high", reviewKey: "reviewer:0", since: 1, step: 0 };
    task.helpers = [{ ...task.agent, reviewKey: "reviewer:1" }];
    task.hunt = { stageId: "review", round: 1, reported: {}, work: { "reviewer:0": { attempts: 1 }, "reviewer:1": { attempts: 1 } } };
    const track = (seat: string) => new ToolInvocations(event => {
      const summary = recordToolActivity(task, "activity", { seat, roleId: "reviewer", profileId: "sol-high", productId: "product" }, event)!;
      task.hunt!.work![seat]!.toolActivity = summary;
      e.showReviewWork(task);
    }, { now: Date.now, id: () => crypto.randomUUID(), activity: createToolActivity(() => undefined) });
    const a = track("reviewer:0"), b = track("reviewer:1");
    a.update({ toolCallId: "first", kind: "execute", status: "in_progress", rawInput: { cmd: "private-command-one" } }, true);
    b.update({ toolCallId: "first", kind: "execute", status: "pending", rawInput: { command: "private-command-two" } }, true);
    a.update({ toolCallId: "first", status: "completed" }, false);
    a.update({ toolCallId: "second", kind: "execute" }, true);
    e.commitNow(task);
    const inspection = (await c.call("task.inspect", { taskId })).task as any;
    expect(inspection.activity.actionCount).toBe(2);
    expect(inspection.workers.map((worker: any) => worker.activity.actionCount)).toEqual([2, 1]);
    const first = await c.call("task.activity", { taskId, limit: 1 });
    expect(first.actionCount).toBe(3);
    expect(first.total).toBe(3);
    expect(first.items).toEqual([expect.objectContaining({ command: "private-command-one", status: "completed", seat: "reviewer:0" })]);
    expect((await c.call("task.activity", { taskId, limit: 1, cursor: first.next })).items).toEqual([expect.objectContaining({ command: "private-command-two", status: "pending", seat: "reviewer:1" })]);
    const worker = await c.call("task.activity", { taskId, nodeId: "activity", seat: "reviewer:1" });
    expect(worker.actionCount).toBe(1);
    expect(Object.keys(worker.workers as object)).toEqual(["reviewer:1"]);
    expect(JSON.stringify(e.windowState())).not.toContain("private-command");
    expect(e.windowState().tasks[0]!.journey).toBeUndefined();
    expect(JSON.stringify(e.taskDetails(taskId))).toContain("private-command-one");
    expect((await c.call("journey.node", { taskId, nodeId: "activity" })).text).toContain("private-command-one");
    expect((await c.call("task.activity", { taskId, nodeId: "missing" })).outcome).toBe("unavailable");
    a.endTurn();
    e.commitNow(task);
    expect((await c.call("task.activity", { taskId, limit: 1, cursor: first.next })).outcome).toBe("changed");
    const records = task.journey[0]!.toolInvocations!;
    expect(records[2]!.status).toBeUndefined();
    expect(records[2]!.endedAt).toBeUndefined();
    expect(records[2]!.turnEndedAt).toBeNumber();
    expect(task.hunt.work!["reviewer:1"]!.toolActivity!.runningTool).toBeDefined();
    expect(e.store.load()!.tasks.find(task => task.id === taskId)!.journey![0]!.toolInvocations).toEqual(records);
  });
});
});
