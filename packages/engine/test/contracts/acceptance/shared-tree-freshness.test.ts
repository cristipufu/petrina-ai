import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { invalidateAcceptance, versionsOf } from "../../../src/repositories.js";
import { git, removeDir } from "../../support.js";
import { executionFor } from "@petrina/orchestrator";
import { repositoryRecords } from "../../fixtures/shared-records.js";
const recordRoots: string[] = [];
afterAll(() => recordRoots.forEach(removeDir));

describe.concurrent("one task across products", () => {
  it("invalidates shared evidence when one named version changes while retaining unrelated current checks", async () => {
    const { engine, task } = await repositoryRecords("evidence", recordRoots, { git: ["first", "second"] });
    try {
      engine.setPoolPaused(false);
      const [first, second] = task.repositories!.map(work => work.productId) as [string, string];
      const checks = [{ name: "Version", argv: ["git", "--version"] }];
      for (const productId of [first, second]) {
        const scope = executionFor(task, productId);
        await engine["checks"].runProductChecks(scope, checks, new AbortController().signal);
      }
      const versions = await versionsOf(task);
      task.brief = { summary: "Shared behaviour", forUsers: [], areas: [], risks: [], acceptance: [
        { text: "First product works", productIds: [first], versions: { [first]: versions[first]! }, met: true, verification: "passed" },
        { text: "The products work together", productIds: [first, second], versions, met: true, verification: "passed" },
      ] };
      task.acceptancePassed = true;
      const copy = task.repositories![1]!.worktree!;
      writeFileSync(join(copy, "api-repair.txt"), "A repair changes this product\n");
      await git(copy, "add", "."); await git(copy, "commit", "-qm", "Repair API");
      await invalidateAcceptance(task);
      expect(task.brief.acceptance[0]!.verification).toBe("passed");
      expect(task.brief.acceptance[1]!.verification).toBe("stale");
      expect(task.brief.acceptance[1]!.met).toBeUndefined();
      expect(task.acceptancePassed).toBe(false);
      expect(task.repositories![0]!.checks!.current).toBe(true);
      expect(task.repositories![1]!.checks!.current).toBe(false);
    } finally { await engine.shutdown(); }
  });
});
