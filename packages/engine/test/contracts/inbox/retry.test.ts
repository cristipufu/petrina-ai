import { expectRejection } from "@petrina/test-support/rejections";
import { dispatch } from "../../../src/server.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import { coordinatorRecords } from "../../fixtures/coordinator-records.js";
import { removeDir } from "../../fixtures.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const fixture = () => coordinatorRecords(roots);

it("does not retry checkpoints or questions, and handles concurrent retries and replacement inbox items", async () => {
  const { engine, task } = await fixture();
  const check = spyOn(engine["tools"], "stillNotReady");
  const scheduled = spyOn(engine, "schedule");
  try {
    for (const kind of ["plan", "design", "delivery", "question", "permission", "screen"] as const) {
      const id = engine.raise(task, kind, "Keep this request", true);
      const item = engine.s.inbox.find(item => item.id === id)!;
      await engine.retry(id);
      expect(engine.s.inbox.find(entry => entry.id === id)).toBe(item);
      expect(task.state).toBe("needs-you");
      engine.s.inbox = engine.s.inbox.filter(entry => entry.id !== id);
    }
    expect(check).not.toHaveBeenCalled();
    // Ordinary requests release no check or delivery resource; raising them adds no scheduling pass.
    expect(scheduled).not.toHaveBeenCalled();
    const id = engine.raise(task, "stuck", "A tool stopped", false, { toolId: "codex" });
    let release!: (value: boolean) => void;
    check.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = engine.retry(id);
    const firstRelease = release;
    const second = engine.retry(id);
    firstRelease(false); release(false);
    await Promise.all([first, second]);
    expect(task.timeline.filter(entry => entry.text === "You asked to try again")).toHaveLength(1);
    const next = engine.raise(task, "stuck", "Check again", false, { toolId: "codex" });
    const pending = engine.retry(next);
    const index = engine.s.inbox.findIndex(entry => entry.id === next);
    engine.s.inbox[index] = { ...engine.s.inbox[index]!, kind: "delivery" };
    release(false); await pending;
    expect(engine.s.inbox.find(entry => entry.id === next)?.kind).toBe("delivery");
    expect(task.timeline.filter(entry => entry.text === "You asked to try again")).toHaveLength(1);
  } finally { check.mockRestore(); scheduled.mockRestore(); await engine.shutdown(); }
});

it("returns Retry failures to the command caller when approving a stuck request", async () => {
  const { engine, task } = await fixture();
  const id = engine.raise(task, "stuck", "Check the tool", false, { toolId: "codex" });
  const check = spyOn(engine["tools"], "stillNotReady").mockRejectedValue(new Error("Readiness failed"));
  try {
    await expectRejection(dispatch(engine, { name: "approve", args: [id] }), "Readiness failed");
    expect(engine.s.inbox.some(item => item.id === id)).toBe(true);
  } finally { check.mockRestore(); await engine.shutdown(); }
});
