import { expect, it } from "vitest";
import { EVENT_BYTES } from "../../../src/workflow-events.js";
import { eventFixture, all } from "../../fixtures/workflow-events.js";

for (const count of [12, 20]) it(`keeps ${count} mixed report identities before shortening supplemental descriptions`, async () => {
  const f = eventFixture(); const events = f.query;
  const taskId = f.newTask({ productId: "product", title: "Prioritize remaining reports" }).id;
  const task = f.task(taskId)!;
  task.journey = [{ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1 }];
  f.observe(task);
  task.findings = Array.from({ length: count }, (_, index) => ({ id: `report-${index}`, text: `Report ${index}: `.padEnd(160, "x"), severity: (["blocking", "suggestion", "pre-existing"] as const)[index % 3]!, status: "open", raisedBy: "opus-high", confirmedBy: [], tracking: { taskId: `follow-up-${index}` } }));
  task.journey[0]!.result = { findings: structuredClone(task.findings) };
  task.journey[0]!.agentResults = [{ at: 2, roleId: "code-reviewer", profileId: "opus-high", value: { findings: [], verdict: "pass" }, findings: structuredClone(task.findings) }];
  task.journey[0]!.endedAt = 2;
  f.observe(task);
  const page = await events({ taskIds: [taskId], from: "oldest", kinds: ["review.finished"], timeoutMs: 0 });
  const event = all(page)[0]!;
  expect(f.codec.encodedBytes(event)).toBeLessThanOrEqual(EVENT_BYTES);
  expect(f.codec.encodedBytes(page)).toBeLessThanOrEqual(65536);
  expect(event.raised).toEqual(task.findings.map((finding) => finding.id));
  expect(event.stillOpen).toEqual(task.findings.filter((finding) => finding.severity === "blocking").map((finding) => finding.id));
  expect(event.openImportant).toEqual(event.stillOpen);
  expect(event.openNits).toEqual(task.findings.filter((finding) => finding.severity === "suggestion").map((finding) => finding.id));
  expect(event.openPreExisting).toEqual(task.findings.filter((finding) => finding.severity === "pre-existing").map((finding) => finding.id));
  if (count === 12) {
    expect(event.reports).toHaveLength(count);
    expect(event.shortened).toBeUndefined();
  } else {
    expect((event.reports as unknown[]).length).toBeLessThan(count);
    expect(event.totals).toEqual({ reports: count });
    expect(event.shortenedFields).toEqual(["reports"]);
    let part = await f.events.log.read(event.id, { limit: 400 });
    let text = String(part.text);
    while (part.next) { part = await f.events.log.read(event.id, { limit: 400, cursor: String(part.next) }); text += part.text; }
    expect(JSON.parse(text).reports).toHaveLength(count);
  }
});
