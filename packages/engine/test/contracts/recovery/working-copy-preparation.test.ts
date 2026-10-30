import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { writeGitProgram } from "@petrina/test-support/git-program";
import { Aborted } from "../../../src/kernel.js";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { driverPreparation } from "../../fixtures/driver-preparation.js";
import { readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { git } from "../../support.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());

describe("working-copy preparation observations", () => {
  for (const objectFormat of ["sha1", "sha256"] as const) it(`pins a fresh ${objectFormat} copy with one paired version and no separate HEAD read`, async () => {
    await cases.use(`petrina-prepare-${objectFormat}-`, async owner => {
      const f = await driverPreparation(owner, objectFormat);
      const head = (await gitOps.head(f.path))!, tree = (await gitOps.treeOf(f.path))!;
      const versions = spyOn(gitOps, "commitVersion"), heads = spyOn(gitOps, "head"), hooks = spyOn(gitOps, "commitHooks");
      try {
        await f.prepare();
        expect(versions).toHaveBeenCalledTimes(1);
        expect(heads).not.toHaveBeenCalled();
        expect(hooks).toHaveBeenCalledTimes(1);
        expect(f.scope.work.baseSha).toBe(head);
        expect(f.scope.work.source?.initialSha).toBe(head);
        expect(f.scope.work.savedVersion).toEqual({ commit: head, tree });
        expect(f.scope.work.preparingCopy).toBeUndefined();
      } finally { hooks.mockRestore(); heads.mockRestore(); versions.mockRestore(); }
      expect(await gitOps.head(f.scope.work.worktree!)).toBe(head);
    });
  });

  it("keeps saved metadata, observes hooks again, and rereads only missing preparation metadata", async () => {
    await cases.use("petrina-prepare-reuse-", async owner => {
      const f = await driverPreparation(owner);
      await f.prepare();
      const first = { ...f.scope.work.savedVersion! }, initial = f.scope.work.source!.initialSha;
      const hooks = join(owner.root, "custom-hooks");
      mkdirSync(hooks);
      writeGitProgram(join(hooks, "pre-commit"), "exit 0");
      await git(f.path, "config", "core.hooksPath", hooks);
      writeFileSync(join(f.path, "incoming.txt"), "The shared source moved after the task copy was made\n");
      await gitOps.commitChanges(f.path, "Move main");
      const main = (await gitOps.head(f.path))!;
      const versions = spyOn(gitOps, "commitVersion"), heads = spyOn(gitOps, "head"), hookReads = spyOn(gitOps, "commitHooks");
      try {
        await f.prepare();
        expect(versions).not.toHaveBeenCalled(); expect(heads).not.toHaveBeenCalled();
        expect(hookReads).toHaveBeenCalledTimes(1);
        expect(f.product.hooks).toEqual(["pre-commit"]);
        expect(f.scope.work.baseSha).toBe(first.commit);
        expect(f.scope.work.source!.initialSha).toBe(initial);
        expect(f.scope.work.savedVersion).toEqual(first);
        delete f.scope.work.baseSha;
        await f.prepare();
        expect(versions).toHaveBeenCalledTimes(1); expect(heads).not.toHaveBeenCalled();
        expect({ ...f.scope.work }).toMatchObject({ baseSha: first.commit });
        expect(first.commit).not.toBe(main);
        expect(f.scope.work.savedVersion).toEqual(first);
        const copy = f.scope.work.worktree!;
        writeFileSync(join(copy, "task.txt"), "A later task commit\n");
        await gitOps.commitChanges(copy, "Move task HEAD");
        const moved = readWorktreeCommit(copy)!;
        const later = moved.commit, tree = moved.tree;
        delete f.scope.work.savedVersion;
        await f.prepare();
        expect(versions).toHaveBeenCalledTimes(2); expect(heads).not.toHaveBeenCalled();
        expect({ ...f.scope.work }).toMatchObject({ baseSha: first.commit });
        expect(f.scope.work.source!.initialSha).toBe(initial);
        expect({ ...f.scope.work }).toMatchObject({ savedVersion: { commit: later, tree } });
      } finally { hookReads.mockRestore(); heads.mockRestore(); versions.mockRestore(); }
    });
  });

  it("reattaches an interrupted hook before observing the branch's actual version", async () => {
    await cases.use("petrina-prepare-hook-recovery-", async owner => {
      const f = await driverPreparation(owner);
      await f.prepare();
      const copy = f.scope.work.worktree!, initial = f.scope.work.baseSha!;
      writeFileSync(join(copy, "branch.txt"), "The branch version survives hook recovery\n");
      await gitOps.commitChanges(copy, "Task branch version");
      const head = (await gitOps.head(copy))!, tree = (await gitOps.treeOf(copy))!;
      await gitOps.detachAt(copy, initial);
      f.scope.work.hooking = true;
      delete f.scope.work.baseSha; delete f.scope.work.savedVersion;
      await f.prepare();
      expect(f.scope.work.hooking).toBeUndefined();
      expect(await gitOps.currentBranch(copy)).toBe(f.scope.work.branch);
      expect({ ...f.scope.work }).toMatchObject({ baseSha: head, savedVersion: { commit: head, tree } });
      expect((await gitOps.fileAt(copy, "HEAD", "branch.txt"))?.trim()).toBe("The branch version survives hook recovery");
    });
  });

  it("uses native HEAD as the unavailable-version fallback without retrying saved evidence", async () => {
    await cases.use("petrina-prepare-unavailable-", async owner => {
      const f = await driverPreparation(owner);
      const head = (await gitOps.head(f.path))!;
      const versions = spyOn(gitOps, "commitVersion").mockResolvedValue({}), heads = spyOn(gitOps, "head");
      try {
        await f.prepare();
        expect(versions).toHaveBeenCalledTimes(1); expect(heads).toHaveBeenCalledTimes(1);
        expect(f.scope.work.baseSha).toBe(head);
        expect(f.scope.work.source?.initialSha).toBe(head);
        expect(f.scope.work.savedVersion).toBeUndefined();
      } finally { heads.mockRestore(); versions.mockRestore(); }
    });
  });

  it("retains HEAD failure and saved history when the actual working copy has no readable HEAD", async () => {
    await cases.use("petrina-prepare-missing-head-", async owner => {
      const f = await driverPreparation(owner);
      await f.prepare();
      const copy = f.scope.work.worktree!, branch = f.scope.work.branch!, saved = { ...f.scope.work.savedVersion! };
      delete f.scope.work.baseSha;
      await git(copy, "symbolic-ref", "HEAD", "refs/heads/missing-preparation-head");
      try {
        const failure = await f.prepareFailure();
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain("HEAD");
        expect(f.scope.work.baseSha).toBeUndefined();
        expect(f.scope.work.savedVersion).toEqual(saved);
        expect(f.scope.work.preparingCopy).toBeDefined();
      } finally { await git(copy, "symbolic-ref", "HEAD", `refs/heads/${branch}`); }
    });
  });

  for (const boundary of ["hooks", "version", "fallback"] as const) it(`rejects a stop received during the ${boundary} observation before saving preparation`, async () => {
    await cases.use(`petrina-prepare-stop-${boundary}-`, async owner => {
      const f = await driverPreparation(owner), controller = new AbortController();
      const hooks = f.engine["checks"].noteHooks.bind(f.engine["checks"]), version = gitOps.commitVersion, head = gitOps.head;
      const hookRead = spyOn(f.engine["checks"], "noteHooks"), versionRead = spyOn(gitOps, "commitVersion"), headRead = spyOn(gitOps, "head");
      try {
        hookRead.mockImplementation(async (...args) => { const value = await hooks(...args); if (boundary === "hooks") controller.abort(); return value; });
        versionRead.mockImplementation(async path => { const value = await version(path); if (boundary === "version") controller.abort(); return boundary === "fallback" ? {} : value; });
        headRead.mockImplementation(async path => { const value = await head(path); if (boundary === "fallback") controller.abort(); return value; });
        expect(await f.prepareFailure(controller.signal)).toBeInstanceOf(Aborted);
        expect(f.scope.work.baseSha).toBeUndefined();
        expect(f.scope.work.source?.initialSha).toBeUndefined();
        expect(f.scope.work.savedVersion).toBeUndefined();
        expect(f.scope.work.preparingCopy).toBeDefined();
        expect(versionRead).toHaveBeenCalledTimes(boundary === "hooks" ? 0 : 1);
        expect(headRead).toHaveBeenCalledTimes(boundary === "fallback" ? 1 : 0);
      } finally { headRead.mockRestore(); versionRead.mockRestore(); hookRead.mockRestore(); }
    });
  });
});
