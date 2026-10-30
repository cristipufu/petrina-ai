import { afterAll, describe, expect, it } from "bun:test";
import { slotUses } from "@petrina/core";
import { waitFor } from "../../fixtures.js";
import { independentReviewFixtures } from "../../fixtures/independence.js";

const { voting, checkedFinding, verifierSteps, close } = independentReviewFixtures();
afterAll(close);
describe.concurrent("bounded verifier panels", () => {
it("stops owned verifier work when the task is cancelled mid-vote, and admits no third answer", async () => {
    const f = await voting({ verifier: "not-a-bug" }, 3, [], false, { acceptedBuild: true });
    try {
      await f.run(async () => {
      await f.advance(() => f.fakes.received("verifier").length === 2, (role) => role !== "verifier");
      f.engine.cancel(f.task().id);
      await waitFor(() => f.task().state === "cancelled" && !f.engine.drivers.has(f.task().id) && !f.engine.settling.has(f.task().id), "the cancelled vote to stop");
      expect(slotUses(f.engine.getState()).filter((use) => use.taskId === f.task().id)).toEqual([]);
      f.engine.schedule();
      expect(f.fakes.received("verifier")).toHaveLength(2);
      expect(checkedFinding(f).verification).toBeUndefined();
      expect(verifierSteps(f).every((step) => step.endedAt !== undefined)).toBe(true);
      });
    } finally { await f.close(); }
  });

});
