import { afterAll, describe, expect, it } from "bun:test";
import { createWorkflowEventFixtures } from "../../fixtures/workflow-event-native.js";

const { fixture, close } = createWorkflowEventFixtures();
afterAll(close);

describe("the bounded event log", () => {
it("reads a bounded health view and immutable finding copies, and refuses to substitute newer records", async () => {
    const { e, c } = fixture();
    const taskId = e.addTask({ productId: "product", title: "Health" });
    const task = e.task(taskId)!;
    const now = Date.now();
    task.state = "running";
    task.stepClock = { roleId: "code-reviewer", repeat: false, worked: 60_000, since: now - 5_000 };
    task.todo = "Checking the nearby cases";
    task.toolActivity = { actionCount: 4, lastActivity: "Ran the tests", runningTool: { id: "t1", description: "Ran the tests", startedAt: now - 1_000 } };
    task.journey = [{ id: "j1", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: now - 70_000, agentResults: [{ roleId: "code-reviewer", profileId: "opus-high", at: now, value: { verdict: "fail" }, findings: [{ id: "f1", text: "As this seat saw it", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "open" }] }], result: { findings: [{ id: "f1", text: "As the node saw it", severity: "blocking", raisedBy: "opus-high", confirmedBy: ["sol-high"], status: "open" }] } }];
    task.findings = [{ id: "f1", text: "Newer record", severity: "blocking", raisedBy: "opus-high", confirmedBy: ["sol-high"], status: "fixed" }];
    e.commit(task);
    const health = await c.call("task.health", { taskId });
    expect(health).toMatchObject({ outcome: "completed", state: "running", working: true, todo: "Checking the nearby cases", lastActivity: "Ran the tests", estimate: null, node: { id: "j1", roleId: "code-reviewer" } });
    expect(health.workedMs as number).toBeGreaterThanOrEqual(65_000);
    expect(health.lastObservedAt).toBe(now - 1_000);
    expect(JSON.stringify(health)).not.toContain("retry");
    const nodeCopy = await c.call("journey.finding", { taskId, nodeId: "j1", findingId: "f1" });
    expect(JSON.parse(String(nodeCopy.text))).toMatchObject({ text: "As the node saw it", status: "open" });
    expect(nodeCopy.copy).toMatchObject({ basis: "hand-back", label: "Hand-back copy; no settled decision was saved" });
    const seatCopy = await c.call("journey.finding", { taskId, nodeId: "j1", findingId: "f1", result: 0 });
    expect(JSON.parse(String(seatCopy.text))).toMatchObject({ text: "As this seat saw it" });
    expect(seatCopy.copy).toEqual({ kind: "seat-result", result: 0, seat: "code-reviewer", basis: "hand-back", label: "Participant’s report before the round’s decision" });
    expect((await c.call("journey.finding", { taskId, nodeId: "j1", findingId: "f2" })).outcome).toBe("missing");
    expect((await c.call("journey.finding", { taskId, nodeId: "j1", findingId: "f1", result: 3 })).outcome).toBe("missing");
    const result = await c.call("journey.result", { taskId, nodeId: "j1", seat: "code-reviewer" });
    expect(result).toMatchObject({ outcome: "completed", seat: "code-reviewer", index: 0, findingCopies: 1, label: "Participant’s report before the round’s decision" });
    expect(JSON.parse(String(result.text))).toEqual({ verdict: "fail" });
    expect((await c.call("journey.input", { taskId, nodeId: "j1" })).outcome).toBe("unavailable");
  });
});
