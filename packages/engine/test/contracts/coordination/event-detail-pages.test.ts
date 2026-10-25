import { afterAll, describe, expect, it } from "bun:test";
import { EVENT_BYTES } from "../../../src/workflow-events.js";
import { createWorkflowEventFixtures, all } from "../../fixtures/workflow-event-native.js";

const { fixture, close } = createWorkflowEventFixtures();
afterAll(close);

describe("focused monitoring evidence regressions", () => {
it("bounds nested causes and complete replies and pages every omitted finding and product", async () => {
    const { e, c, events } = fixture();
    const taskId = e.addTask({ productId: "product", title: "Complete compact pages" });
    const task = e.task(taskId)!;
    task.journey = [{ id: "j1", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1, trigger: { reason: "Diagnostic ".repeat(9000) } }];
    e.commit(task);
    task.findings = Array.from({ length: 35 }, (_, index) => ({ id: `f-${index}`, text: `Finding ${index}`, status: "open" as const, severity: "blocking" as const, raisedBy: "opus-high", confirmedBy: [] }));
    // The reviewer handed back before its step ended: that accepted result is what makes the review complete.
    task.journey[0]!.agentResults = [{ at: 2, roleId: "code-reviewer", profileId: "opus-high", value: { findings: [], verdict: "pass" } }];
    task.journey[0]!.endedAt = 2;
    e.commit(task);
    const page = await events({ taskIds: [taskId], from: "oldest", timeoutMs: 0, limit: 100 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
    for (const event of all(page)) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(EVENT_BYTES);
    const start = all(page).find(event => event.kind === "node.started")!;
    expect(start.shortenedFields).toContain("cause.reason");
    const review = all(page).find(event => event.kind === "review.finished")!;
    expect(review.raised).toHaveLength(20);
    expect(review.totals).toMatchObject({ raised: 35, stillOpen: 35 });
    const readAll = async (eventId: string) => {
      let part = await c.call("watch.event", { eventId, limit: 300 });
      let text = String(part.text);
      while (part.next) { part = await c.call("watch.event", { eventId, limit: 300, cursor: part.next }); text += part.text; }
      return JSON.parse(text);
    };
    expect((await readAll(review.id)).raised).toEqual(task.findings.map(finding => finding.id));
    expect((await readAll(start.id)).cause.reason).toBe(task.journey[0]!.trigger!.reason);
    task.repositories = Array.from({ length: 30 }, (_, index) => ({ productId: `product-${index}`, delivery: "release", completedStages: [], release: { tag: "v1", url: `https://example.com/${index}` } }));
    delete task.repository;
    task.activeProductId = task.repositories[0]!.productId;
    task.state = "done";
    e.commit(task);
    const finish = all(await events({ taskIds: [taskId], kinds: ["task.finished"], from: "oldest", timeoutMs: 0 }))[0]!;
    expect((finish.products as unknown[]).length).toBeLessThan(30);
    expect((await readAll(finish.id)).products).toHaveLength(30);
    // Retained detail pages keep the original revision even as the task changes.
    task.findings[0]!.text = "Later wording";
    e.commit(task);
    expect((await readAll(review.id)).raised).toHaveLength(35);
  });
});
