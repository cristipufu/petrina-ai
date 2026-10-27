import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { type Task } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Fakes, makeProduct, waitFor } from "../../fixtures.js";
import { reviewJourneyFixtures } from "../../fixtures/review.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const {} = reviewJourneyFixtures();
describe.concurrent("reviewers at once, then a vote", () => {
  it("after a restart, runs again only the reviewer that had not reported", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const root = mkdtempSync(join(owner.root, "petrina-review-restart-"));

      const fakes = new Fakes(join(root, "fake"));
      fakes.scenario({ reviewer: "work" });
      const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir] };
      let engine = owner.open(join(root, "data"), options);
      const productId = await engine.addProduct(await makeProduct(root));
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
      const coordinate = (current: Engine) => {
        for (const item of current.getState().inbox) {
          if (item.kind === "plan") current.approve(item.id);
          else if (item.kind === "permission") current.allow(item.id, "once");
          else if (item.kind === "question") current.answer(item.id, item.options?.[0] ?? "Yes");
        }
        return current.getState().tasks.find((entry) => entry.id === taskId) as Task | undefined;
      };
      // One reviewer reported; the other is still at work when Petrina stops.
      await waitFor(() => {
        const task = coordinate(engine);
        return fakes.marked("reviewer-working") && Object.keys(task?.hunt?.reported ?? {}).length === 1 && task;
      }, "one reviewer to report while the other works", 60_000);
      await owner.stop(engine);

      engine = owner.open(join(root, "data"), options);
      try {
        await owner.run(engine, async () => {
          const task = await waitFor(() => {
            const found = coordinate(engine);
            if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
            return engine.getState().inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
          }, "the delivery check", 60_000);
          // Two reviewers at first, then only the one that had not reported.
          expect(fakes.openings("code reviewer")).toHaveLength(3);
          expect(task.findings.filter((finding) => finding.text === "Consider a friendlier greeting.")).toHaveLength(2);
          expect(task.hunt).toBeUndefined();

        });
      } finally {
        await owner.stop(engine);
      }

    });
  });

});
