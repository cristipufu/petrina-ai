import { expect, it } from "vitest";
import { eventFixture, all } from "../../fixtures/workflow-events.js";

it("keeps new open descriptions ahead of a long settled report history", async () => {
  const f = eventFixture(); const events = f.query;
  const taskId = f.newTask({ productId: "product", title: "Keep open work visible" }).id;
  const task = f.task(taskId)!;
  task.findings = Array.from({ length: 22 }, (_, index) => ({ id: `old-${index}`, text: `Settled report ${index}`.padEnd(160, "x"), severity: "blocking", status: "fixed", raisedBy: "opus-high", confirmedBy: [] }));
  task.journey = [{ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1 }];
  f.observe(task);
  task.findings.push({ id: "new-important", text: "The Important work that remains", severity: "blocking", status: "open", raisedBy: "opus-high", confirmedBy: [] }, { id: "new-nit", text: "The small improvement that remains", severity: "suggestion", status: "open", raisedBy: "opus-high", confirmedBy: [] });
  task.journey[0]!.result = { findings: structuredClone(task.findings) };
  task.journey[0]!.agentResults = [{ at: 2, roleId: "code-reviewer", profileId: "opus-high", value: { findings: [], verdict: "pass" } }];
  task.journey[0]!.endedAt = 2;
  f.observe(task);
  const event = all(await events({ taskIds: [taskId], from: "oldest", kinds: ["review.finished"], timeoutMs: 0 }))[0]!;
  expect((event.reports as { id: string }[]).slice(0, 2).map((report) => report.id)).toEqual(["new-important", "new-nit"]);
  expect(event.reportCounts).toEqual({ opening: { total: 22, open: { total: 0, important: 0, nits: 0, preExisting: 0 }, fixed: 22, dismissed: 0, unverified: 0 }, closing: { total: 24, open: { total: 2, important: 1, nits: 1, preExisting: 0 }, fixed: 22, dismissed: 0, unverified: 0 } });
  expect(event.raised).toEqual(["new-important", "new-nit"]);
  let part = await f.events.log.read(event.id, { limit: 300 });
  let text = String(part.text);
  while (part.next) { part = await f.events.log.read(event.id, { limit: 300, cursor: String(part.next) }); text += part.text; }
  expect(JSON.parse(text).reports).toHaveLength(24);
  expect(JSON.parse(text).reports.at(-1).id).toBe("old-21");
});
