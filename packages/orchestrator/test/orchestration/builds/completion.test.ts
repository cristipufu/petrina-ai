import { describe, expect, it } from "vitest";
import { isGitObjectId } from "@petrina/core";
import { buildCompletionFixture, oldTree, newTree, buildHead } from "../../fixtures/build-completion.js";

describe("accepted Builder completion", () => {
  it("keeps the previous description, records the observed version and closes the actual journey step", async () => {
    const f = buildCompletionFixture();
    f.scope.work.report = { summary: "Previous", changes: [], description: "Keep the requested description" };
    const turn = f.begin({ summary: "Built", description: "  ", tests: "Declared tests", title: "Greeting" });
    f.saved(); await turn.run(); f.consumed();
    expect(f.scope.work.report).toEqual({ summary: "Built", changes: [], tests: "Declared tests", title: "Greeting", description: "Keep the requested description" });
    expect(turn.step.buildVersions).toEqual({ a: newTree });
    expect(turn.step.agentResults![0]!.versions).toEqual({ a: newTree });
    expect(turn.step).toMatchObject({ outcome: "Change ready", end: "done", builderReturn: { changed: true, claimedFixes: 0 } });
    expect(f.calls).toEqual(["learnings", "saveChanges", "fold", "tree"]);
  });

  for (const length of [40, 64]) it(`uses the exact folded ${length}-digit version without a second read`, async () => {
    const f = buildCompletionFixture(), tree = "B".repeat(length), head = "C".repeat(length), turn = f.begin();
    f.observe({ kind: "saveChanges", value: undefined }, { kind: "fold", value: { fork: oldTree, version: { head, tree } } });
    await turn.run(); f.consumed();
    expect(turn.step.buildVersions).toEqual({ a: tree });
    expect(f.calls).toEqual(["learnings", "saveChanges", "fold"]);
    expect(isGitObjectId(head)).toBe(true);
  });

  for (const [head, tree] of [["", newTree], [buildHead, ""], ["c".repeat(39), newTree], [buildHead, "b".repeat(63)], [buildHead, "g".repeat(40)], [buildHead, ` ${newTree}`]] as const) {
    it(`fails closed on malformed folded identifiers ${JSON.stringify({ head, tree })}`, async () => {
      const f = buildCompletionFixture(), turn = f.begin();
      f.scope.work.checks = { at: 1, results: [], current: true };
      f.observe({ kind: "saveChanges", value: undefined }, { kind: "fold", value: { fork: oldTree, version: { head, tree } } });
      await expect(turn.run()).rejects.toThrow("could not read the folded product version"); f.consumed();
      expect(f.scope.work.checks.current).toBe(false);
      expect(turn.step.buildVersions).toBeUndefined();
      expect(turn.step.agentResults![0]!.versions).toBeUndefined();
      expect(turn.step.endedAt).toBeUndefined();
      expect(f.calls).toEqual(["learnings", "saveChanges", "fold"]);
    });
  }

  it("saves an incomplete maintenance report before refusing all repository and learning effects", async () => {
    const f = buildCompletionFixture(), turn = f.begin({ summary: "Need the missing input", complete: false }, { maintenance: true });
    await expect(turn.run()).rejects.toThrow("Maintenance investigation is incomplete");
    expect(f.checkpoints).toHaveLength(1);
    expect(f.checkpoints[0]!.repository!.report!.summary).toBe("Need the missing input");
    expect(f.calls).toEqual([]);
    expect(turn.step.endedAt).toBeUndefined();
  });

  it("retains the actual completed conversation identity and source-port outcome", async () => {
    const f = buildCompletionFixture(), updating = { from: "main", onto: buildHead, files: [] };
    f.scope.work.conversation = { roleId: "builder", toolId: "codex", model: "actual-model", sessionId: "actual-session", briefed: true, step: "build", profileId: "actual-builder", startedAt: 1 };
    const turn = f.begin({}, { updating, rethought: true });
    f.observe({ kind: "saveChanges", value: undefined }, { kind: "finishPort", value: undefined }, { kind: "fold", value: undefined }, { kind: "tree", value: oldTree });
    await turn.run(); f.consumed();
    expect(f.scope.work.builderSession).toMatchObject({ stageId: "build", profileId: "actual-builder", plannedProfileId: "builder", sessionId: "actual-session", rethought: true });
    expect(turn.step.outcome).toBe("Brought it up to date");
    expect(f.notes).toEqual(["Brought up to date with main: Returned the declared work"]);
    expect(f.calls).toEqual(["learnings", "saveChanges", "finishPort", "fold", "tree"]);
  });

  it("does not record a completed session from an unbriefed or different role's conversation", async () => {
    for (const conversation of [{ roleId: "builder", briefed: false }, { roleId: "tester", briefed: true }]) {
      const f = buildCompletionFixture();
      f.scope.work.conversation = { ...conversation, toolId: "codex", model: "supplied", sessionId: "other-session", step: "build", profileId: "actual-builder", startedAt: 1 };
      const turn = f.begin(); f.saved(); await turn.run(); f.consumed();
      expect(f.scope.work.builderSession).toBeUndefined();
    }
  });

  it("does not turn a missing no-fold tree into recorded build evidence", async () => {
    const f = buildCompletionFixture(), turn = f.begin();
    f.saved(undefined); // Supply an absent observation explicitly rather than the helper's default.
    f.observations[f.observations.length - 1] = { kind: "tree", value: undefined };
    await turn.run(); f.consumed();
    expect(turn.step.buildVersions).toBeUndefined();
    expect(turn.step.builderReturn!.changed).toBeUndefined();
  });
});
