import { expectRejection } from "@petrina/test-support/rejections";
import { describe, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { executionFor } from "@petrina/orchestrator";
import { withRepositoryRecords } from "../../fixtures/shared-records.js";

describe("explicit repository execution contexts", () => {
  it("clears temporary release preparation after version, history or notes failures", async () => {
    await withRepositoryRecords("release-preview-interruption", { git: ["first"] }, async ({ engine, task, run: ownRun }) => {
      const scope = executionFor(task), releases = engine["shipping"]["releases"];
      scope.work.delivery = "release"; scope.work.baseSha = (await gitOps.head(scope.work.worktree!))!;
      const stage = { id: "delivery", title: "Delivery", kind: "gate" as const, gate: "delivery" as const, roleId: "release-manager", profileIds: ["sol-high"] };
      const choose = spyOn(releases, "chooseVersion");
      try {
        choose.mockImplementation(async () => { Object.assign(scope.work.shipping!, { version: "1.0.0", tag: "v1.0.0", after: "" }); return []; });

        const history = spyOn(releases, "sincePreviousRelease");
        try {
          history.mockResolvedValue({ title: "History", body: "A change" });

          const turn = spyOn(engine["turns"], "turn");
          try {
            turn.mockResolvedValue({ notes: "Notes", summary: "Summary" });

            for (const fail of [choose, history, turn]) {
              fail.mockRejectedValueOnce(new Error("Interrupted preview"));
              await ownRun(() => expectRejection(releases.previewRelease(scope, stage, engine.stopRequested.signal), "Interrupted preview"));
              expect(scope.work.shipping).toBeUndefined();
              expect(scope.work.releasePreview).toBeUndefined();
              engine.commitNow();
              expect(engine.store.load()!.tasks.find(entry => entry.id === task.id)!.repositories![0]!.shipping).toBeUndefined();
            }
            await ownRun(() => releases.previewRelease(scope, stage, engine.stopRequested.signal));
            expect(scope.work.shipping).toBeUndefined();
            expect(scope.work.releasePreview).toMatchObject({ version: "1.0.0", notes: "Notes" });

          } finally { turn.mockRestore(); }
        } finally { history.mockRestore(); }
      } finally { choose.mockRestore(); }
    });
  });

  it("reuses original version contents and reads each committed target once while validating a release", async () => {
    await withRepositoryRecords("release-version-reads", { git: ["first"] }, async ({ engine, task, run: ownRun }) => {
      const scope = executionFor(task, "first"), path = scope.work.worktree!;
      const files = [
        { file: "package.json", text: '{"name":"demo","version":"1.0.0"}\n', version: "1.0.0" },
        { file: "Cargo.toml", text: '[package]\nname = "demo"\nversion = "1.0.0"\n', version: "1.0.0" },
      ];
      const lock = 'version = 3\n\n[[package]]\nname = "demo"\nversion = "1.0.0"\n';
      for (const file of files) writeFileSync(join(path, file.file), file.text);
      writeFileSync(join(path, "Cargo.lock"), lock);
      await gitOps.commitChanges(path, "Record version files");
      const start = (await gitOps.head(path))!;
      scope.work.shipping = { start, version: "1.0.1", tag: "v1.0.1", moves: 0, failures: 0 };
      const read = spyOn(gitOps, "fileAt");
      try {
        const tested = await ownRun(() => engine["shipping"]["releases"]["setVersion"](scope, files));
        expect(tested).not.toBe(start);
        expect(scope.work.savedVersion).toEqual({ commit: tested, tree: (await gitOps.treeOf(path))! });
        for (const file of files) {
          expect(read.mock.calls.filter(([, sha, name]) => sha === start && name === file.file)).toHaveLength(0);
          expect(read.mock.calls.filter(([, sha, name]) => sha === tested && name === file.file)).toHaveLength(1);
        }
        expect(read.mock.calls.filter(([, sha, name]) => sha === start && name === "Cargo.lock")).toHaveLength(1);
        expect(read.mock.calls.filter(([, sha, name]) => sha === tested && name === "Cargo.lock")).toHaveLength(1);
        read.mockRestore();
        for (const file of files) {
          expect(await gitOps.fileAt(path, tested, file.file)).toContain("1.0.1");
        }
        expect(await gitOps.fileAt(path, tested, "Cargo.lock")).toContain('version = "1.0.1"');
        expect((await gitOps.changedFiles(path, start, tested)).sort()).toEqual(["Cargo.lock", "Cargo.toml", "package.json"]);
      } finally { read.mockRestore(); }
    });
  });
});
