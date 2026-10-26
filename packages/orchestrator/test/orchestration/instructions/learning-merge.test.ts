import { describe, expect, it, vi } from "vitest";
import { withLearnings } from "@petrina/core";
import { keptLearningsMessage } from "../../../src/learning-merge.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { ReleaseEvents } from "../../fixtures/release-events.js";
import { learningMergeFixture, BASE, INTRO, X1, X2, X3, Y1, Y2, Y3 } from "../../fixtures/learning-merge.js";

// Scripted values are file/approval observations; actual native tree/index/fallback proof stays in the24 contracts.
describe.concurrent("an update where main and the task only added approved learnings", () => {
  const orders: readonly (readonly [string, string])[] = [[Y1, X1]];
  for (const [first, then] of orders) it(`puts main's lesson first and the task's after it, delivered in either order (${first === X1 ? "X then Y" : "Y then X"})`, async () => {
    const f = learningMergeFixture(); f.main([first]); f.own([then]); const before = structuredClone(f.product);
    const kept = await f.run();
    expect(kept).toEqual({ tree: "effect:written-instructions-tree", added: [then], present: [] });
    expect(keptLearningsMessage(kept!, "main", "1 new commit")).toBe(`Brought up to date with main (1 new commit there): main and this work only added approved learnings to AGENTS.md, so Petrina kept main's and added this work's: ${then}`);
    expect(f.writes).toEqual([{ tree: f.request.merged.tree, mode: "100644", text: `${BASE}- ${first}\n- ${then}\n` }]);
    expect(f.product).toEqual(before);
  });
  it("keeps several lessons from each side in order, each once, before the next section", async () => {
    const f = learningMergeFixture(`${BASE}\n## Checks\n\nRun them all.\n`); f.main([X1, X2]); f.main([X3]); f.own([Y1, Y2, Y3]);
    const kept = await f.run();
    expect(kept).toEqual({ tree: "effect:written-instructions-tree", added: [Y1, Y2, Y3], present: [] });
    expect(keptLearningsMessage(kept!, "main", "2 new commits")).toBe(`Brought up to date with main (2 new commits there): main and this work only added approved learnings to AGENTS.md, so Petrina kept main's and added this work's: ${Y1}; ${Y2}; ${Y3}`);
    expect(f.writes).toEqual([{ tree: f.request.merged.tree, mode: "100644", text: `${BASE}- ${X1}\n- ${X2}\n- ${X3}\n- ${Y1}\n- ${Y2}\n- ${Y3}\n\n## Checks\n\nRun them all.\n` }]);
  });
  for (const ours of [[Y1, Y2], [Y1]]) it(`keeps a lesson main already has word for word once${ours.length === 1 ? ", when it has all of the task's" : ""}`, async () => {
    const f = learningMergeFixture(); f.main([Y1, X1]);
    // Prior tidy-up records are explicit input; the native sweep/restart remains in its own contract.
    f.product.learnings = []; f.receipt(Y1); f.receipt(X1); f.own(ours); const before = structuredClone(f.product);
    const kept = await f.run();
    expect(kept).toEqual({ tree: "effect:written-instructions-tree", added: ours.length > 1 ? [Y2] : [], present: [Y1] });
    expect(keptLearningsMessage(kept!, "main", "1 new commit")).toBe(`Brought up to date with main (1 new commit there): main and this work only added approved learnings to AGENTS.md, so Petrina ${ours.length > 1 ? `kept main's and added this work's: ${Y2}; already on main, kept once` : "kept main's, which already has this work's"}: ${Y1}`);
    expect(f.writes).toEqual([{ tree: f.request.merged.tree, mode: "100644", text: `${BASE}- ${Y1}\n- ${X1}\n${ours.length > 1 ? `- ${Y2}\n` : ""}` }]);
    expect(f.product).toEqual(before);
  });
});

type Fixture = ReturnType<typeof learningMergeFixture>;
describe.concurrent("an update that still goes to the Builder", () => {
  const cases: [string, (f: Fixture) => void][] = [
    ["a task lesson nobody approved", f => { f.main([X1]); f.ownEdit(text => withLearnings(text, [Y1])); }],
    // Declining creates no accepted record; LearningOffers owns remembering that separate declined list.
    ["a task lesson the coordinator declined", f => { f.main([X1]); f.ownEdit(text => withLearnings(text, [Y1])); }],
    ["an approved task lesson with changed punctuation", f => { f.main([X1]); f.own([Y1]); f.ownEdit(text => text.replace(Y1, Y1.replace(/\.$/, "!"))); }],
    ["a task lesson written for another task", f => { f.main([X1]); f.record(Y1, f.other); f.ownEdit(text => withLearnings(text, [Y1])); }],
    ["a task lesson approved but never written by Petrina", f => { f.main([X1]); f.record(Y1); f.ownEdit(text => withLearnings(text, [Y1])); }],
    ["a main lesson with no record", f => { f.main([X1]); f.product.learnings = []; f.own([Y1]); }],
    ["a main lesson whose record says this task wrote it", f => { f.main([X1], f.taskId); f.own([Y1]); }],
    ["a main lesson whose receipt was dropped", f => { f.main([X1]); f.product.learnings = []; f.receipt(X1); f.product.learningReceipts = []; f.own([Y1]); }],
    ["a task lesson that is a differently written main lesson", f => { f.main([`${Y1.slice(0, -1)}!`]); f.own([Y1]); }],
    ["a task lesson that matches a line of the starting version", f => { f.main([X1]); f.record("Run the package tests before delivering!", f.taskId); f.ownEdit(text => withLearnings(text, ["Run the package tests before delivering!"])); }],
    ["two task lessons that are the same lesson", f => { f.main([X1]); f.own([Y1]); f.record(Y1.slice(0, -1), f.taskId); f.ownEdit(text => withLearnings(text, [Y1.slice(0, -1)])); }],
    ["an edit to an existing instruction on the task's branch", f => { f.main([X1]); f.own([Y1]); f.ownEdit(text => text.replace("Keep changes small.", "Keep changes tiny.")); }],
    ["a Builder's edit to the task's own lesson line", f => { f.main([X1]); f.own([Y1]); f.ownEdit(text => text.replace(`- ${Y1}`, `* ${Y1}`)); }],
    ["an edit to an existing instruction on main", f => { f.main([X1]); f.mainEdit(text => text.replace("Keep changes small.", "Keep changes tiny.")); f.own([Y1]); }],
    ["an existing lesson removed on main", f => { f.main([X1]); f.mainEdit(text => text.replace("- Run the package tests before delivering.\n", "")); f.own([Y1]); }],
    ["a changed intro on main", f => { f.main([X1]); f.mainEdit(text => text.replace(INTRO, "Lessons, added with the coordinator's OK.")); f.own([Y1]); }],
    ["a renamed heading on main", f => { f.main([X1]); f.mainEdit(text => text.replace("## Learnings", "## Lessons")); f.own([Y1]); }],
    ["a new section on main", f => { f.main([X1]); f.mainEdit(text => `${text}\n## Review guide\n\nRead REVIEW.md.\n`); f.own([Y1]); }],
    ["a lesson main added and removed between tidy-ups", f => { f.mainEdit(text => `${text}- ${Y1}\n`); f.mainEdit(text => text.replace(`- ${Y1}\n`, "")); f.main([X1]); f.own([Y1]); }],
  ];
  for (const [name, setup] of cases) it(`for ${name}`, async () => {
    const f = learningMergeFixture(); setup(f); const before = structuredClone(f.product);
    expect(await f.run()).toBeUndefined(); expect(f.writes).toEqual([]); expect(f.product).toEqual(before);
  });
  it("for a Learnings section that did not exist at the starting point", async () => {
    const f = learningMergeFixture("# Working on the demo\n\nKeep changes small.\n"); f.main([X1]); f.own([Y1]);
    expect(await f.run()).toBeUndefined(); expect(f.writes).toEqual([]);
  });
  it("for any other file conflicting too, with AGENTS.md left as Git merged it", async () => {
    const f = learningMergeFixture(BASE, ["AGENTS.md", "greeting.txt"]); f.main([X1]); f.own([Y1]);
    expect(await f.run()).toBeUndefined(); expect(f.calls).toEqual([]); expect(f.writes).toEqual([]);
  });
});

it("reads the captured product's live approval queue after the history answer, not before it", async () => {
  const f = learningMergeFixture(); f.main([X1]); f.own([Y1]); f.product.learnings = f.product.learnings.filter(line => line.text !== X1);
  const releases = new ReleaseEvents(), signal = new AbortController().signal;
  f.effects.instructionVersionsBetween = async () => { f.calls.push("history"); releases.release("history"); await releases.wait("continue", signal); f.calls.push("history-finished"); return f.history; };
  let running: ReturnType<typeof f.run> | undefined;
  const cleanup = async () => { releases.release("continue"); await running; };
  await setupWithCleanup(async () => {
    running = f.run(); await releases.wait("history", signal); expect(f.calls).not.toContain("records");
    f.record(X1, f.other); releases.release("continue");
    expect(await running).toEqual({ tree: "effect:written-instructions-tree", added: [Y1], present: [] });
    expect(f.calls.indexOf("records")).toBeGreaterThan(f.calls.indexOf("history-finished"));
  }, cleanup);
  await cleanup();
});

for (const [failure, synchronous] of [[new Error("Controlled instruction read failed"), false], [undefined, true]] as const) it(`joins the other instruction reads before returning an unavailable merge (${synchronous ? "synchronous undefined" : "rejected Error"})`, async () => {
  const f = learningMergeFixture(); f.main([X1]); f.own([Y1]); const releases = new ReleaseEvents(), signal = new AbortController().signal;
  let peerCompleted = false, reported = false, peerCompletedAtReport: boolean | undefined, running: ReturnType<typeof f.run> | undefined;
  const cleanup = async () => {
    releases.release("peer");
    const settled = await Promise.allSettled([running, Promise.resolve().then(() => vi.useRealTimers())]);
    const failed = settled.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Controlled read or clock cleanup failed");
  };
  await setupWithCleanup(async () => {
    vi.useFakeTimers();
    f.effects.instructionsAt = function (ref) {
      f.calls.push(`file:${ref}`);
      if (ref === f.request.fork) { if (synchronous) throw failure; return Promise.reject(failure); }
      if (ref === f.request.onto) return releases.wait("peer", signal).then(() => { peerCompleted = true; return f.files.get(ref); });
      return Promise.resolve(f.files.get(ref));
    };
    running = f.run(); void running.then(() => { reported = true; peerCompletedAtReport = peerCompleted; });
    // A private virtual-clock turn drains rejection continuations, without elapsed waiting or a microtask budget.
    let phaseObserved = false; setTimeout(() => { phaseObserved = true; }, 0); await vi.runAllTimersAsync();
    expect(phaseObserved).toBe(true); expect(f.calls).toEqual([`file:${f.request.fork}`, `file:${f.request.onto}`, `file:${f.request.ref}`]);
    expect(reported).toBe(false); expect(peerCompleted).toBe(false);
    releases.release("peer"); expect(await running).toBeUndefined(); expect(peerCompletedAtReport).toBe(true); expect(f.writes).toEqual([]);
  }, cleanup);
  await cleanup();
});
