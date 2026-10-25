import { expect, it, describe } from "vitest";
import { EVENT_BYTES } from "../../../src/workflow-events.js";
import { eventFixture, all } from "../../fixtures/workflow-events.js";

describe("the bounded event log", () => {
it("keeps batches under 64 KB and events under 8 KB with explicit shortening", async () => {
    const f = eventFixture(); const events = f.query;
    const taskId = f.newTask({ productId: "product", title: "Big" }).id;
    const task = f.task(taskId)!;
    const start = await events({ taskIds: [taskId], timeoutMs: 0 });
    const manifest = Array.from({ length: 12 }, (_, index) => ({ name: `Section ${index} ${"long name ".repeat(80)}`, size: index, digest: `d${index}`, kind: "text" as const }));
    task.journey = Array.from({ length: 40 }, (_, index) => ({ id: `j${index + 1}`, kind: "agent" as const, roleId: "builder", profileId: "sol-xhigh", round: 1, sub: 0, startedAt: index, endedAt: index + 1, end: "done" as const, outcome: "Change ready", reason: "ready for review", agentInputs: [{ at: index, roleId: "builder", profileId: "sol-xhigh", taskTitle: "Big", sections: [], mode: "fresh" as const, manifest }] }));
    f.observe(task);
    const page = await events({ taskIds: [taskId], cursor: start.cursor, limit: 100, timeoutMs: 0 });
    expect(f.codec.encodedBytes(page)).toBeLessThanOrEqual(64 * 1024);
    expect(page.more).toBe(true);
    expect(page.shortened).toBe(true);
    for (const event of all(page)) expect(f.codec.encodedBytes(event)).toBeLessThanOrEqual(EVENT_BYTES);
    const seat = all(page).find((event) => event.kind === "seat.started")!;
    expect(seat.shortened).toBe(true);
    expect(seat.shortenedFields).toContain("manifest");
    expect((seat.manifest as unknown[]).length).toBeLessThan(12);
    expect(seat.manifestTotal).toBe(12);
    const huge = f.bound({ id: "x", seq: 1, run: "r", at: 1, kind: "node.started", taskId, productIds: [], summary: "s", detail: "x".repeat(9000) });
    expect(f.codec.encodedBytes(huge)).toBeLessThanOrEqual(EVENT_BYTES);
    expect(huge.shortenedFields).toContain("detail");
  });
});
