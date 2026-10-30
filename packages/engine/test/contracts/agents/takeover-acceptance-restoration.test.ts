import { afterAll, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_RESTORED } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { Fakes, tempDir, waitFor } from "../../fixtures.js";
import { changesOf, versionsOf } from "../../../src/repositories.js";
import { stepKey } from "../../../src/kernel.js";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { roots, fixture, passes, testerSteps, restoredLine, close } = proofRequestFixtures();
afterAll(close);
it("saves a take-over's undone tracked edit with the acceptance run, while new output alone stays harmless", async () => {
  const f = await fixture();
  try {
    const worktree = f.scope.work.worktree!;
    f.task.stageIndex = 1; f.task.acceptanceRun = { versions: await versionsOf(f.task), changes: await changesOf(f.task), requestIds: [] };
    f.scope.work.conversation = { step: stepKey(f.task), roleId: "tester", profileId: "opus-high", toolId: "claude-code", model: "opus", sessionId: "tester", startedAt: 1, access: { canEdit: false } };
    writeFileSync(join(worktree, "output.log"), "New output\n");
    await f.engine.undoReadOnly(f.task, "tester", worktree);
    expect(f.task.acceptanceRun.restored).toBeUndefined(); expect(await gitOps.isClean(worktree)).toBe(true);
    writeFileSync(join(worktree, "feature.txt"), "Edited before the take-over\n"); writeFileSync(join(worktree, "output.log"), "New output\n");
    await f.engine.undoReadOnly(f.task, "tester", worktree);
    expect(f.task.acceptanceRun.restored!.products).toEqual([{ productId: f.task.productId, edits: true, files: ["feature.txt"] }]);
    expect(await gitOps.isClean(worktree)).toBe(true); expect(readFileSync(join(worktree, "feature.txt"), "utf8")).toBe("the task's change\n");
    expect(f.task.timeline.some(entry => entry.text === restoredLine("changes to project files", "Product 1", "feature.txt"))).toBe(true);
  } finally { await f.close(); }
});

it("keeps an undone change with its acceptance run through the coordinator's take-over and hand back", async () => {
  const fakeRoot = tempDir("petrina-acceptance-takeover-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  // The take-over only writes its launcher: the tool's path answers its help check, and no terminal opens.
  const f = await fixture(false, false, fakes, { toolPath: () => process.execPath });
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await gitOps.commitChanges(worktree, "Save a project file");
    f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ tester: "work", testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited before the take-over\n" }], testerProofAnswers: passes([request.id]) });
    const driving = f.drive();
    await waitFor(() => fakes.marked("tester-worked") && f.scope.work.conversation?.briefed, "the Tester to be at work", undefined, { during: driving });
    await f.engine.takeOver(f.task.id, "copy"); await driving;
    const restored = [{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }];
    expect(f.task.driving).toBeDefined(); expect(f.task.acceptanceRun!.restored!.products).toEqual(restored);
    expect(readFileSync(join(worktree, "tester-edit.txt"), "utf8")).toBe("Saved before acceptance\n");
    expect(f.task.timeline.some(entry => entry.text === restoredLine("changes to project files", "Product 1", "tester-edit.txt"))).toBe(true);
    // After the hand back the same run continues, without editing again, and answers with a pass.
    fakes.scenario({ tester: "work", testerProofAnswers: passes([request.id]) });
    await f.engine.handBack(f.task.id, "", true);
    await waitFor(() => f.engine.s.inbox.find(item => item.kind === "delivery"), "the delivery check after the hand back");
    expect(request.status).toBe("unverified"); expect(request.proof).toMatchObject({ result: "blocked", reason: ACCEPTANCE_RESTORED });
    expect(testerSteps(f).at(-1)!.proofRun!.restored!.products).toEqual(restored);
    expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined();
    expect(fakes.openings("tester")).toHaveLength(2);
  } finally { await f.close(); }
});
