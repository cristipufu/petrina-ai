import { expect, it } from "vitest";
import { applyAcceptanceVersions } from "../../../src/acceptance-versions.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

function accepted() {
  const state = stateFixture(), [first, second] = state.products.map(product => product.id);
  const versions = { [first!]: "first-tree", [second!]: "second-tree" };
  const task = taskFixture(state, { acceptancePassed: true,
    repositories: [first!, second!].map(productId => ({ productId, delivery: "local", completedStages: [], checks: { at: 1, current: true, tree: versions[productId], results: [] } })),
    brief: { summary: "Together", forUsers: [], areas: [], risks: [], acceptance: [
      { text: "The first product works", met: true, verification: "passed", versions: { [first!]: versions[first!]! } },
      { text: "The products work together", met: true, verification: "passed", versions: { ...versions } },
      { text: "A recorded failure remains a failure", met: false, verification: "failed", versions: { ...versions }, reason: "Observed failure" },
    ] },
  });
  return { task, first: first!, second: second!, versions };
}

it("invalidates only passing acceptance that names a changed product, preserving unrelated checks and failures", () => {
  const { task, first, second, versions } = accepted();
  applyAcceptanceVersions(task, { ...versions, [second]: "changed-tree" });
  expect(task.repositories!.map(work => [work.productId, work.checks!.current])).toEqual([[first, true], [second, false]]);
  expect(task.brief!.acceptance[0]).toMatchObject({ met: true, verification: "passed" });
  expect(task.brief!.acceptance[1]).toMatchObject({ verification: "stale", reason: "An affected product changed after this acceptance check. Combined verification is required again." });
  expect(task.brief!.acceptance[1]!.met).toBeUndefined();
  expect(task.brief!.acceptance[2]).toMatchObject({ met: false, verification: "failed", reason: "Observed failure" });
  expect(task.acceptancePassed).toBe(false);
});

it("retains completed acceptance on unchanged trees and leaves the caller's version map intact", () => {
  const { task, versions } = accepted(), before = JSON.parse(JSON.stringify(task)) as typeof task, observed = { ...versions };
  applyAcceptanceVersions(task, observed);
  expect(task).toEqual(before);
  expect(observed).toEqual(versions);
});

it("treats an unavailable observed version as unverified code rather than a prior tree", () => {
  const { task, second, versions } = accepted();
  applyAcceptanceVersions(task, { ...versions, [second]: "unavailable" });
  expect(task.repositories![1]!.checks!.current).toBe(false);
  expect(task.brief!.acceptance[1]!.verification).toBe("stale");
  expect(task.acceptancePassed).toBe(false);
  delete task.brief;
  applyAcceptanceVersions(task, versions);
  expect(task.repositories!.every(work => work.checks!.current)).toBe(true);
});
