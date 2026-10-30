import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { Fakes, tempDir, waitFor } from "../../fixtures.js";
import { versionsOf } from "../../../src/repositories.js";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { roots, fixture, passes, testerSteps, close } = proofRequestFixtures();
afterAll(close);
it("starts a genuinely fresh acceptance run after a pause, keeping the paused attempt's undone change as history", async () => {
  const fakeRoot = tempDir("petrina-acceptance-pause-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await gitOps.commitChanges(worktree, "Save a project file");
    f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ tester: "work", testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited before the pause\n" }], testerProofAnswers: passes([request.id]) });
    const driving = f.drive();
    await waitFor(() => fakes.marked("tester-worked") && f.scope.work.conversation?.briefed, "the Tester to be at work", undefined, { during: driving });
    f.engine.pause(f.task.id); await driving;
    const paused = testerSteps(f).at(-1)!;
    expect(paused.proofRun!.restored!.products).toEqual([{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }]);
    expect(request.proof).toBeUndefined();
    // The paused attempt settled nothing. A fresh conversation tests the restored code on its own versions.
    fakes.scenario({ tester: "work", testerProofAnswers: passes([request.id]) });
    f.engine.resume(f.task.id); await f.drive();
    const fresh = testerSteps(f).at(-1)!;
    expect(fresh.id).not.toBe(paused.id); expect(fresh.proofRun!.restored).toBeUndefined();
    expect(request.status).toBe("proved"); expect(request.proof!.stepId).toBe(fresh.id); expect(request.proof!.versions).toEqual(await versionsOf(f.task));
    expect(paused).toMatchObject({ outcome: "Stopped before a result", reason: "Petrina undid changes during this attempt; the next run starts fresh" });
    expect(paused.proofRun!.restored).toBeDefined(); expect(paused.acceptanceChecks).toBeUndefined();
    expect(f.task.acceptanceUnverified).toBe(false); expect(f.task.acceptancePassed).toBe(true);
  } finally { await f.close(); }
});
