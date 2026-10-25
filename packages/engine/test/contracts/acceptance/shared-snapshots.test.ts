import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { beginAgentStep } from "@petrina/core";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { versionsOf, invalidateAcceptance, acceptanceVersion } from "../../../src/repositories.js";
import { executionFor } from "@petrina/orchestrator";
import { removeDir, type World } from "../../support.js";
import { repositoryRecords, type RepositoryRecordOptions } from "../../fixtures/shared-records.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const fixture = (name: string, options: RepositoryRecordOptions = {}) => repositoryRecords(name, recordRoots, options);

describe("explicit repository execution contexts", () => {
  for (const proof of [false, true]) for (const canEdit of [false, true]) it(`uses one acceptance snapshot per product${canEdit ? " after saving tester edits once" : " for a read-only tester"}${proof ? " with required proof" : ""}`, async () => {
    const { engine, task } = await fixture(`tester-versions-${canEdit}-${proof}`, { git: ["first","second"] });
    const role = { ...engine.role("tester")!, id: "acceptance-specialist", name: "Acceptance specialist", canEdit };
    engine.s.roles.push(role);
    const stage = { id: "test", title: "Acceptance", kind: "do" as const, roleId: role.id, profileIds: ["sol-high"] };
    task.plan = { rationale: "Verify both products", plannerProfileId: "sol-high", stages: [stage] };
    task.stageIndex = 0;
    task.brief = { summary: "Together", forUsers: [], areas: [], risks: [], acceptance: [{ text: "Both products work" }] };
    const scope = executionFor(task);
    const before = await versionsOf(task);
    if (proof) task.proofRequests = [{ id: "required-proof", source: "review:1:0:0", text: "Prove both products on the final code", reason: "Both versions must match", productIds: task.repositories!.map(work => work.productId), requestedBy: { stageId: "review", round: 1, seat: "0", roleId: "code-reviewer", profileId: "sol-high" }, reviewedVersions: before, ownerStageId: stage.id, status: "pending" }];
    const paired = spyOn(gitOps, "commitVersion"), tree = spyOn(gitOps, "treeOf"), save = spyOn(engine, "saveRoleEdits");
    let preparation: { paths: string[]; trees: number } | undefined;
    const turn = spyOn(engine["turns"], "turn").mockImplementation(async (_scope, _role, _profile, _given, schema, _signal, options) => {
      preparation = { paths: paired.mock.calls.map(([path]) => path), trees: tree.mock.calls.length };
      options?.used?.("opus-high");
      if (canEdit) writeFileSync(join(scope.work.worktree!, "tester-fix.txt"), "A focused tester repair\n");
      const value = schema.parse({ summary: "Verified", checks: [{ text: "Both products work", result: "pass", productIds: task.repositories!.map(work => work.productId), evidence: "Exercised both products" }], proofAnswers: proof ? [{ id: "required-proof", result: "pass", evidence: "Exercised both prepared product versions" }] : [], learnings: [] });
      const step = beginAgentStep(task, role.id, "opus-high", Date.now(), engine.s.roles, undefined, scope.work);
      step.agentResults = [{ roleId: role.id, profileId: "opus-high", at: Date.now(), value }];
      return value;
    });
    try {
      expect(await engine["work"].runDo(scope, stage, new AbortController().signal)).toBe("continue");
      expect(preparation).toEqual({ paths: task.repositories!.map(work => work.worktree!), trees: 0 });
      // Preparation observes each head/tree pair once. Editors also save their new version;
      // only editors or explicit proof require a fresh finishing tree for every product.
      expect(paired).toHaveBeenCalledTimes(canEdit ? 3 : 2);
      expect(tree).toHaveBeenCalledTimes(canEdit || proof ? 2 : 0);
      for (const work of task.repositories!) expect(tree.mock.calls.filter(([path]) => path === work.worktree)).toHaveLength(canEdit || proof ? 1 : 0);
      expect(save).toHaveBeenCalledTimes(canEdit ? 1 : 0);
      if (canEdit) expect(save).toHaveBeenCalledWith(scope, role.id, "opus-high");
      expect(task.acceptancePassed).toBe(!(proof && canEdit));
      expect(task.testedPatch).toBe(JSON.stringify(task.testedVersions));
      expect(task.brief.acceptance[0]!.versions).toEqual(task.testedVersions);
      expect(task.brief.acceptance[0]!.verification).toBe("passed");
      if (canEdit) expect(task.testedVersions![scope.work.productId]).not.toBe(before[scope.work.productId]);
      else expect(task.testedVersions).toEqual(before);
      if (proof) {
        expect(task.proofRequests![0]!.proof!.versions).toEqual(before);
        expect(task.proofRequests![0]!.proof!.result).toBe("pass");
        expect(task.proofRequests![0]!.status).toBe(canEdit ? "stale" : "proved");
        expect(task.acceptanceUnverified).toBe(false);
      }
      const reads = { tree: tree.mock.calls.length, paired: paired.mock.calls.length };
      expect(await invalidateAcceptance(task, task.testedVersions)).toEqual(task.testedVersions);
      expect(await acceptanceVersion(task, task.testedVersions)).toBe(task.testedPatch);
      expect(tree).toHaveBeenCalledTimes(reads.tree);
      expect(paired).toHaveBeenCalledTimes(reads.paired);
    } finally { turn.mockRestore(); paired.mockRestore(); tree.mockRestore(); save.mockRestore(); await engine.shutdown(); }
  });
});
