import { afterAll, describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "@petrina/test-support/fixtures";

import { sessionState } from "@petrina/agent-runtime/terminal";
import { takeoverFixtures, takeoverDir } from "../../fixtures/takeover.js";

const fixtures = takeoverFixtures(), start = fixtures.start;
afterAll(() => fixtures.close());
const posix = process.platform !== "win32";

describe.skipIf(!posix)("hand changes after every review chain", () => {
  it("runs the last review chain again once the step is done, before delivery", async () => {
  return fixtures.use(async caseOwner => {
    const run = await start(caseOwner, { planner: "tester-after", builder: "plain", tester: "work" });
    try {
      await waitFor(() => run.fakes.marked("tester-working"), "the tester to start");
      await run.working("tester");
      run.cli({ commit: { "fix.txt": "A fix\n" } });
      const engine = run.engine();
      await engine.takeOver(run.taskId);
      await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "ended", "the app to close");
      await engine.handBack(run.taskId, "One more fix");
      const review = run.task().plan!.stages.find((stage) => stage.kind === "review-chain")!;
      expect(run.task().rereview).toBe(review.id);

      const done = await run.finished();
      const milestones = done.timeline.map((entry) => entry.text);
      const rerun = milestones.indexOf("Reviewing your changes: the review starts again from the first reviewer");
      expect(rerun).toBeGreaterThan(milestones.indexOf("You handed back to the Tester: 1 file changed in 1 commit. Your note: One more fix"));
      // The review ran again after the tester finished, and only then did the work ship.
      expect(milestones.filter((text) => text === "Code reviewer started")).toHaveLength(2);
      expect(milestones.findLastIndex((text) => text.startsWith("Review passed"))).toBeGreaterThan(rerun);
      expect(milestones.findLastIndex((text) => text.startsWith("Review passed"))).toBeLessThan(milestones.findIndex((text) => text.startsWith("Petrina moved main forward to it")));
      expect(done.rounds[review.id]).toBeUndefined();
      expect(readFileSync(join(run.product, "fix.txt"), "utf8").replace(/\r?\n$/, "")).toBe("A fix");

    } finally { await run.close(); }

  });
});
});
