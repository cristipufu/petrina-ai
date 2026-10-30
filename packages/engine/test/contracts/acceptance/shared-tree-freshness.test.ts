import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { invalidateAcceptance, versionsOf } from "../../../src/repositories.js";
import * as gitOps from "@petrina/repositories/git";
import { executionFor } from "@petrina/orchestrator";
import { withRepositoryRecords } from "../../fixtures/shared-records.js";

describe.concurrent("one task across products", () => {
  it("invalidates shared evidence when one named version changes while retaining unrelated current checks", async () => {
    await withRepositoryRecords("evidence", { git: ["first", "second"] }, async ({ engine, task, run: ownRun }) => {

      engine.setPoolPaused(false);
      const [first, second] = task.repositories!.map(work => work.productId) as [string, string];
      const checks = [{ name: "Version", argv: ["git", "--version"] }];
      for (const productId of [first, second]) {
        const scope = executionFor(task, productId);
        const product = engine.s.products.find(product => product.id === productId)!;
        product.checks = checks; product.checksBy = "coordinator";
        await ownRun(() => engine["checks"].runProductChecks(scope, checks, engine.stopRequested.signal));
      }
      const versions = await versionsOf(task);
      task.brief = { summary: "Shared behaviour", forUsers: [], areas: [], risks: [], acceptance: [
          { text: "First product works", productIds: [first], versions: { [first]: versions[first]! }, met: true, verification: "passed" },
          { text: "The products work together", productIds: [first, second], versions, met: true, verification: "passed" },
      ] };
      task.acceptancePassed = true;
      const copy = task.repositories![1]!.worktree!;
      writeFileSync(join(copy, "api-repair.txt"), "A repair changes this product\n");
      await gitOps.commitChanges(copy, "Repair API");
      await invalidateAcceptance(task);
      expect(task.brief.acceptance[0]!.verification).toBe("passed");
      expect(task.brief.acceptance[1]!.verification).toBe("stale");
      expect(task.brief.acceptance[1]!.met).toBeUndefined();
      expect(task.acceptancePassed).toBe(false);
      expect(task.repositories![0]!.checks!.current).toBe(true);
      expect(task.repositories![1]!.checks!.current).toBe(false);

    });
  });
});
