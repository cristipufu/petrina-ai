import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { continuedReviewFixtures } from "../../fixtures/continued-review.js";
const { signal, important, rounds, passedCovered, close } = continuedReviewFixtures();
afterAll(close);

it("judges cover by the task's own change: main moving alone keeps it, a change or an unreadable version ends it", async () => {
  for (const what of ["main", "edit", "unreadable"] as const) {
    const f = await rounds();
    try {
      f.task.findings = [important("accepted")];
      await f.exhaust();
      const scope = executionFor(f.task);
      if (what === "main") {
        await f.run(async () => {
          writeFileSync(join(f.owners[0]!.repo, "incoming.txt"), "main moved\n");
          await gitOps.commitChanges(f.owners[0]!.repo, "Main advances");
        });
        expect(await f.run(() => f.engine["updates"].upToDate(scope, signal()))).toBe("moved");
      } else if (what === "edit") await f.commit();
      else delete scope.work.baseSha;
      expect(await f.review()).toBe("continue");
      if (what === "main") expect(passedCovered(f.task)).toBe(true);
      else { expect(f.task.fixing).toBe(true); expect(f.step().reason).toBe("sent back: 1 important"); }
    } finally { await f.close(); }
  }
});
