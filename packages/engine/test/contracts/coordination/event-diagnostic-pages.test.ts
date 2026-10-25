import { afterAll, describe, expect, it } from "bun:test";
import { createWorkflowEventFixtures } from "../../fixtures/workflow-event-native.js";

const { fixture, close } = createWorkflowEventFixtures();
afterAll(close);

describe("focused monitoring evidence regressions", () => {
it("keeps result finding diagnostics inside their own pages rather than repeating them as metadata", async () => {
    const { e, c } = fixture();
    const taskId = e.addTask({ productId: "product", title: "Large diagnostic" });
    const task = e.task(taskId)!;
    const evidence = "x".repeat(160_000);
    task.journey = [{ id: "j1", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1, agentResults: [{ at: 2, roleId: "code-reviewer", profileId: "opus-high", value: { summary: "Result" }, findings: [{ id: "f1", text: "A failure", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "open", evidence }] }] }];
    e.commit(task);
    let page = await c.call("journey.result", { taskId, nodeId: "j1", index: 0, limit: 1 });
    let result = String(page.text);
    expect(page.findingCopies).toBe(1);
    expect(page.findings).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1500);
    page = await c.call("journey.result", { taskId, nodeId: "j1", index: 0, limit: 100, cursor: page.next });
    result += page.text;
    expect(JSON.parse(result)).toEqual({ summary: "Result" });
    let finding = await c.call("journey.finding", { taskId, nodeId: "j1", result: 0, findingId: "f1", limit: 32000 });
    let text = String(finding.text);
    while (finding.next) { finding = await c.call("journey.finding", { taskId, nodeId: "j1", result: 0, findingId: "f1", limit: 32000, cursor: finding.next }); text += finding.text; }
    expect(JSON.parse(text).evidence).toBe(evidence);
  });
});
