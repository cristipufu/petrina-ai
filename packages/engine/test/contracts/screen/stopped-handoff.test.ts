import { timerObservation } from "../../fixtures/timer-observations.js";
import { afterAll, expect, it } from "bun:test";
import { removeDir, tempDir } from "../../fixtures.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("cancels screen handoff timers and ignores scheduling after shutdown during startup", async () => {
  const root = tempDir("petrina-screen-timers-"); roots.push(root);
  const observation = await timerObservation(root, "stopped-screen");
  expect(observation.releaseSeen).toBe(true);
  expect(observation.schedulesAfterRelease).toBe(0);
  expect(observation.screens).toBe(0);
  expect(observation.commits).toBe(0);
});
