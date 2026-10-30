import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { IdleSleepAssertion } from "../../../src/awake.js";
import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

describe("the macOS idle sleep assertion", () => {
  it("holds through paused work and settling cleanup, releases when drained, and releases immediately on shutdown", async () => {
  return engineCases.use("petrina-awake-", async caseOwner => {
    const root = caseOwner.root;

    const changes: boolean[] = [];
    const engine = caseOwner.open(join(root, "data"), { awakeObserver: (active) => changes.push(active) });
    try {
      engine.drivers.set("task", new AbortController());
      engine.syncIdleSleep();
      expect(changes).toEqual([true]);
      engine.setPoolPaused(true);
      expect(changes.at(-1)).toBe(true);

      // The driver has let go of its agent, but still owns asynchronous result and file handling.
      engine.drivers.delete("task");
      engine.settling.set("task", Promise.resolve());
      engine.syncIdleSleep();
      engine.cleanupJobs.add("task");
      engine.settling.delete("task");
      engine.syncIdleSleep();
      expect(changes.at(-1)).toBe(true);
      engine.cleanupJobs.delete("task");
      engine.syncIdleSleep();
      expect(changes.at(-1)).toBe(false);

      engine.setPoolPaused(false);
      engine.drivers.set("task", new AbortController());
      engine.syncIdleSleep();
      expect(changes.at(-1)).toBe(true);
      const stopping = engine.shutdown();
      expect(changes.at(-1)).toBe(false);
      expect(changes).toEqual([true, false, true, false]);
      await stopping;
    } finally {
      await caseOwner.stop(engine);
    }

  });
});
});

it("retains a method-backed idle observer's original owner", () => {
  const options = { marker: "original owner", seen: [] as string[], observe(active: boolean) { this.seen.push(`${this.marker}:${active}`); } };
  const assertion = new IdleSleepAssertion(options);
  assertion.setActive(true); assertion.setActive(false);
  expect(options.seen).toEqual(["original owner:true", "original owner:false"]);
});
