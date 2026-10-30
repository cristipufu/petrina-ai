import { engineProcessCases } from "../../support.js";
import { timerObservation } from "../../fixtures/timer-observations.js";
import { afterAll, expect, it } from "bun:test";
import { tempDir } from "../../fixtures.js";
const cases = engineProcessCases();
afterAll(() => cases.close());

it("cancels screen handoff timers and ignores scheduling after shutdown during startup", async () => {
  const root = tempDir("petrina-screen-timers-");
  return cases.use(root, async owner => {
  const observation = await timerObservation(root, "stopped-screen", argv => owner.nativeCommand(root, argv).completion);
  expect(observation.releaseSeen).toBe(true);
  expect(observation.schedulesAfterRelease).toBe(0);
  expect(observation.screens).toBe(0);
  expect(observation.commits).toBe(0);
  });
});
