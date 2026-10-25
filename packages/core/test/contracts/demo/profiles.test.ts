import { expect, it } from "vitest";
import { createDemo, createPortfolioDemo, createFirstRunDemo } from "../../../src/demo.js";
import { DEFAULT_PROFILES, profileConfiguration } from "../../../src/profiles.js";

it("keeps one launch configuration per profile and every scripted plan on the shared catalog", () => {
  expect(new Set(DEFAULT_PROFILES.map(profileConfiguration)).size).toBe(DEFAULT_PROFILES.length);
  const ids = new Set(DEFAULT_PROFILES.map(profile => profile.id));
  for (const demo of [createDemo(1_000_000_000), createPortfolioDemo(1_000_000_000), createFirstRunDemo(1_000_000_000)]) {
    for (const task of demo.state.tasks) for (const stage of task.plan?.stages ?? []) {
      for (const id of [...stage.profileIds, ...stage.reviewerProfileIds ?? []]) expect(ids.has(id)).toBe(true);
    }
  }
});
