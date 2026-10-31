import { expect, it } from "vitest";
import { appendSessionLine, MAX_SESSION_LINES } from "../../../src/session-log.js";
import type { DeepMutable, Task } from "../../../src/index.js";
type Line = DeepMutable<Task["session"][number]>;
function session(id: string, images: boolean): Line[] {
  return Array.from({ length: MAX_SESSION_LINES }, (_, index) => ({
    id: `earlier-${id}-${index}`, at: 1, from: "agent", text: "An earlier report", roleId: "code-reviewer", profileId: "opus-high",
    ...(images ? { images: [{ id: "old-picture", caption: "An earlier page" }] } : {}),
  }));
}
const line = (id: string, from: Line["from"], roleId?: string, profileId?: string, productId?: string): Line => ({ id, at: 1, from, text: id, roleId, profileId, productId });
it("keeps each agent's latest report when another update arrives before its pictures are attached", () => {
  const pictured = session("pictured", true);
  appendSessionLine(pictured, line("The builder checked the page", "agent", "builder", "sol-high"), new Set());
  const report = pictured.at(-1)!;
  appendSessionLine(pictured, line("Another reviewer is checking", "activity", "code-reviewer", "opus-high"), new Set());
  expect(pictured).toContain(report);
  report.images = [{ id: "builder-picture", caption: "The checked page" }];
  appendSessionLine(pictured, line("Still checking", "activity"), new Set());
  expect(pictured.find(entry => entry.id === report.id)?.images?.[0]?.id).toBe("builder-picture");
  const busy = session("busy", false);
  appendSessionLine(busy, line("The builder checked the page", "agent", "builder", "sol-high"), new Set());
  const builder = busy.at(-1)!;
  appendSessionLine(busy, line("The reviewer checked the page", "agent", "code-reviewer", "opus-low"), new Set());
  const reviewer = busy.at(-1)!;
  appendSessionLine(busy, line("Another reviewer is checking", "activity", "code-reviewer", "opus-high"), new Set());
  expect(busy).toContain(builder);
  expect(busy).toContain(reviewer);
  expect(busy).toHaveLength(MAX_SESSION_LINES);
  expect(busy.at(-1)?.from).toBe("activity");
});
it("keeps the latest report for each product when the same builder works across products", () => {
  const shared = session("shared", false);
  appendSessionLine(shared, line("First product checked", "agent", "builder", "sol-high", "first"), new Set());
  const first = shared.at(-1)!;
  appendSessionLine(shared, line("Second product checked", "agent", "builder", "sol-high", "second"), new Set());
  const second = shared.at(-1)!;
  for (let index = 0; index < MAX_SESSION_LINES; index++) appendSessionLine(shared, line(`Checking the shared work ${index}`, "activity"), new Set());
  expect(shared).toContain(first);
  expect(shared).toContain(second);
  expect(shared).toHaveLength(MAX_SESSION_LINES);
});
it("retains a pending report even after newer words and permits pruning only when its owner releases it", () => {
  const lines = [line("pending", "agent", "builder"), line("replacement", "agent", "builder")];
  const pending = new Set(["pending"]);
  appendSessionLine(lines, line("activity", "activity"), pending, 2);
  expect(lines.map(line => line.id)).toEqual(["pending", "replacement", "activity"]);
  pending.clear();
  appendSessionLine(lines, line("latest", "activity"), pending, 2);
  expect(lines.map(line => line.id)).toEqual(["replacement", "latest"]);
});

it("keeps an earlier active bubble while a parallel seat with the same role and profile speaks", () => {
  const busy = session("parallel", false);
  const removedIds: string[] = [];
  appendSessionLine(busy, line("Earlier active public update", "agent", "code-reviewer", "opus-high"), new Set());
  const active = busy.at(-1)!;
  Object.assign(active, {
    step: "parallel-step",
    inputIndex: 0,
    recording: {
      recordedLength: active.text.length,
      originalLength: active.text.length,
      complete: true,
      state: "streaming" as const,
      revision: 1,
    },
  });
  appendSessionLine(busy, line("A later peer's public update", "agent", "code-reviewer", "opus-high"), new Set());
  Object.assign(busy.at(-1)!, { step: "parallel-step", inputIndex: 1 });
  for (let index = 0; index < MAX_SESSION_LINES; index++) {
    appendSessionLine(busy, line(`Working ${index}`, "activity"), new Set(), MAX_SESSION_LINES, (removed) => {
      removedIds.push(removed.id);
    });
  }
  expect(busy).toContain(active);
  expect(busy).toHaveLength(MAX_SESSION_LINES);
  active.recording!.state = "finished";
  appendSessionLine(busy, line("The earlier message is finished", "activity"), new Set(), MAX_SESSION_LINES, (removed) => {
    removedIds.push(removed.id);
  });
  expect(busy).not.toContain(active);
  expect(removedIds).toContain(active.id);
});
