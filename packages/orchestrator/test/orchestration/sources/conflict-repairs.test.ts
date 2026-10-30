import { describe, expect, it } from "vitest";
import { finishSourcePort } from "../../../src/source-conflicts.js";
import { sourceConflictFixture } from "../../fixtures/source-conflicts.js";
import { deferred } from "../../fixtures/tool-checks.js";

describe("post-wait source updates across products", () => {
  it("examines the companion after a new conflict and retains the conflict until its Builder finishes", async () => {
    const f = sourceConflictFixture();
    try {
      f.outcomes.set("shop", "conflict"); f.outcomes.set("api", "moved"); f.hold(); f.release();
      expect(await f.refresh.run(f.task, f.signal)).toBe(true);
      expect(f.scopes()[0]!.work.updating?.onto).toBe(f.observations.get("shop")!.onto);
      expect(f.scopes()[1]!.work.baseSha).toBe(f.observations.get("api")!.onto);
      expect(f.calls.filter(call => call.startsWith("update:"))).toEqual(["update:shop", "update:api"]);
      expect(f.task.repair).toEqual({ products: ["shop"], index: 0, returnStage: 1, kind: "review", portProducts: ["shop"] });
      expect(f.task.runtimeWait?.refreshPending).toBe(true);
      expect(await f.refresh.run(f.task, f.signal)).toBe(false);
    } finally { await f.close(); }
  });

  it("keeps every newly conflicted owner in the ordinary repair order and preserves its return step", async () => {
    const f = sourceConflictFixture();
    try {
      f.outcomes.set("shop", "conflict"); f.outcomes.set("api", "conflict"); f.hold(); f.release();
      expect(await f.refresh.run(f.task, f.signal)).toBe(true);
      expect(f.scopes().every(scope => !!scope.work.updating)).toBe(true);
      expect(f.task.repair).toEqual({ products: ["shop", "api"], index: 0, returnStage: 1, kind: "review", portProducts: ["shop", "api"] });
      expect(await f.refresh.run(f.task, f.signal)).toBe(false);
      expect(f.calls.filter(call => call.startsWith("open:"))).toEqual(["open:shop", "open:api"]);
    } finally { await f.close(); }
  });

  it("preserves an admitted publication's candidate while its remaining companion gets the source update", async () => {
    const f = sourceConflictFixture();
    try {
      const first = f.scope.work, head = "scripted:admitted-head";
      first.shipping = { moves: 1, failures: 1, start: head, step: "push", prepared: { tested: head, summary: "Admitted delivery" } };
      const admitted = structuredClone(first.shipping);
      f.outcomes.set("shop", "moved"); f.outcomes.set("api", "moved"); f.hold(); f.release();
      expect(await f.refresh.run(f.task, f.signal)).toBe(false);
      expect(first.shipping).toEqual(admitted);
      expect(f.calls).not.toContain("update:shop"); expect(f.calls).not.toContain("clear:shop:true");
      expect(f.scopes()[1]!.work.baseSha).toBe(f.observations.get("api")!.onto);
      expect(f.task.runtimeWait?.refreshProducts).toEqual(["shop"]);
      first.landed = { branch: "main", sha: head };
      expect(await f.refresh.run(f.task, f.signal)).toBe(false);
      expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
      expect(first.shipping).toEqual(admitted);
    } finally { await f.close(); }
  });

  it("stops before Builder admission on an unavailable companion after a new conflict", async () => {
    const f = sourceConflictFixture(), failure = new Error("The companion source is unavailable");
    try {
      f.outcomes.set("shop", "conflict"); f.outcomes.set("api", failure); f.hold(); f.release();
      await expect(f.drive()).rejects.toBe(failure);
      expect(f.builders).toEqual([]); expect(f.task.state).toBe("failed"); expect(f.task.error).toBe(failure.message);
      expect(f.task.runtimeWait?.refreshPending).toBe(true);
      const port = structuredClone(f.scope.work.updating);
      f.outcomes.set("api", "moved");
      expect(await f.refresh.run(f.task, f.signal)).toBe(false);
      expect(f.scopes()[1]!.work.baseSha).toBe(f.observations.get("api")!.onto);
      expect(f.scope.work.updating).toEqual(port);
      expect(f.task.runtimeWait?.refreshPending).toBe(true);
    } finally { await f.close(); }
  });
});

describe("a pending Builder repair after a prerequisite wait", () => {
  for (const scenario of [
    { name: "two new conflicts", conflicts: ["shop", "api"] },
    { name: "only the companion conflicts", conflicts: ["api"] },
  ]) it(`keeps conflict-only owners out of findings-fix mode at round four: ${scenario.name}`, async () => {
    const f = sourceConflictFixture();
    try {
      f.task.rounds.review = 4; f.reviewed();
      for (const product of scenario.conflicts) f.outcomes.set(product, "conflict");
      f.hold(); f.release();
      expect(await f.refresh.run(f.task, f.signal)).toBe(true);
      await f.drive();
      expect(f.task.state).not.toBe("failed"); expect(f.reached).toEqual([1]);
      expect(f.task.rounds.review).toBe(4); expect(f.task.findings).toEqual([]); expect(f.task.repair).toBeUndefined();
      expect(f.builders.map(builder => builder.productId)).toEqual(scenario.conflicts);
      for (const builder of f.builders) {
        expect(builder.fixing).toBe(false); expect(builder.rethink).toBe(false); expect(builder.given).toEqual([]); expect(builder.port).toBe(true);
        expect(f.scopes().find(scope => scope.work.productId === builder.productId)!.work.portReview).toBeDefined();
      }
    } finally { await f.close(); }
  });

  for (const scenario of [
    { name: "one product conflicts", shared: false, owner: "shop", conflict: true, wait: true },
    { name: "the first product conflicts", shared: true, owner: "shop", conflict: true, wait: true },
    { name: "a companion conflicts", shared: true, owner: "api", conflict: true, wait: true },
    { name: "a clean source update", shared: true, owner: "api", conflict: false, wait: true },
    { name: "ordinary repairs without a wait", shared: true, owner: "api", conflict: true, wait: false },
  ]) it(`keeps every owed finding and Builder repair: ${scenario.name}`, async () => {
    const f = sourceConflictFixture(scenario.shared);
    try {
      expect(f.repair()).toBe(true);
      if (scenario.wait) {
        f.hold(); await f.drive(); expect(f.builders).toEqual([]); expect(f.reached).toEqual([]);
      }
      f.outcomes.set(scenario.owner, scenario.conflict ? "conflict" : "moved");
      if (scenario.wait) f.release();
      else await f.begin(f.scopes().find(scope => scope.work.productId === scenario.owner)!);
      await f.drive();
      expect(f.task.state).not.toBe("failed"); expect(f.reached).toEqual([1]); expect(f.task.rounds.review).toBe(2);
      expect(f.task.repair).toBeUndefined(); expect(f.task.findings.map(finding => finding.status)).toEqual(f.scopes().map(() => "fixed"));
      expect(f.builders.map(builder => builder.productId)).toEqual(f.scopes().map(scope => scope.work.productId));
      for (const [index, scope] of f.scopes().entries()) {
        const builder = f.builders[index]!;
        expect(builder.fixing).toBe(true); expect(builder.rethink).toBe(false); expect(builder.given.map(finding => finding.id)).toEqual([`f${index}`]);
        expect(f.task.findings[index]!.answer?.fixed).toBe(true); expect(scope.work.portReview).toBeUndefined();
      }
      if (scenario.wait) expect(f.scopes().find(scope => scope.work.productId === scenario.owner)!.work.baseSha).toBe(f.observations.get(scenario.owner)!.onto);
    } finally { await f.close(); }
  });
});

describe("port review eligibility", () => {
  for (const fixing of [false, true]) it(fixing ? "gives unreviewed fixes the full planned review after resolving conflicts" : "sends a first-review conflict to the builder, then every planned reviewer looks at the whole change", async () => {
    const f = sourceConflictFixture(false);
    try {
      f.task.fixing = fixing;
      await f.begin(); const update = f.scope.work.updating!;
      await finishSourcePort(f.scope, update, f.portEffects(f.scope));
      expect(f.scope.work.updating).toBeUndefined(); expect(f.scope.work.portReview).toBeUndefined(); expect(f.scope.work.reviewedTree).toBeUndefined();
      expect(f.reviewPlaces()).toEqual([{ key: "0", profileId: "opus-high" }, { key: "1", profileId: "sol-high" }]);
      expect(f.calls.some(call => call.startsWith("tree:") || call.startsWith("merge:") || call.startsWith("files:"))).toBe(false);
    } finally { await f.close(); }
  });
});

describe("source-conflict effect boundaries", () => {
  it("requires a build-result role before observing or checkpointing a conflict", async () => {
    const f = sourceConflictFixture(false);
    try {
      f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.roleId !== "builder"); f.reviewed();
      await expect(f.begin()).rejects.toThrow("the plan has no builder"); expect(f.calls).toEqual([]); expect(f.scope.work.updating).toBeUndefined();
    } finally { await f.close(); }
  });

  it("checkpoints the bound conflict before opening markers and retains exact rejection without a completion milestone", async () => {
    const f = sourceConflictFixture(), opened = deferred<void>(), release = deferred<void>();
    const failure = new Error("Opening native markers failed");
    const operation = f.conflicts.begin(f.scope, f.observations.get("shop")!, { head: async () => { throw new Error("Unreviewed head read"); }, open: async () => { opened.resolve(); await release.promise; throw failure; } });
    const outcome = operation.catch(error => error);
    try {
      await opened.promise;
      expect(f.checkpoints.at(-1)?.repositories?.[0]?.updating?.onto).toBe(f.observations.get("shop")!.onto);
      expect(f.checkpoints.at(-1)?.stageIndex).toBe(0); expect(f.notes).toEqual([]);
      f.task.activeProductId = "api";
      release.resolve(); expect(await outcome).toBe(failure);
      expect(f.scope.work.updating).toBeDefined(); expect(f.scopes()[1]!.work.updating).toBeUndefined();
      expect(f.task.journey?.some(step => step.kind === "petrina" && step.outcome?.includes("conflict"))).not.toBe(true);
      expect(f.calls).not.toContain("changed");
    } finally { release.resolve(); await outcome; await f.close(); }
  });

  it("preserves an existing repair cursor, return stage and findings ownership without duplicating an unfinished owner", async () => {
    const f = sourceConflictFixture();
    try {
      f.task.repair = { products: ["finished", "shop"], index: 1, returnStage: 2, kind: "acceptance", final: true };
      f.task.fixing = true;
      await f.begin(); await f.begin(); await f.begin(f.scopes()[1]!);
      expect(f.task.repair).toEqual({ products: ["finished", "shop", "api"], index: 1, returnStage: 2, kind: "acceptance", final: true, portProducts: ["api"] });
      expect(f.task.fixing).toBe(true);
    } finally { await f.close(); }
  });

  it("drops saved review seats with per-seat reasons and clears the old approval before opening a conflict", async () => {
    const f = sourceConflictFixture();
    try {
      f.task.reviewSessions = { review: { "0": { scope: "review", round: 2, plannedProfileId: "opus-high", profileId: "opus-high", toolId: "claude-code", model: "supplied", sessionId: "old-review" } } };
      f.task.reviewFreshReasons = { review: { "1": "Existing reason" } };
      f.scope.work.approvedSha = "approved"; f.scope.work.approvedPatch = "patch";
      f.scope.work.approvedFor = { by: "coordinator", mode: "local", destination: "main" };
      await f.begin();
      expect(f.task.reviewSessions).toBeUndefined();
      expect(f.task.reviewFreshReasons).toEqual({ review: { "0": "main conflicted with the change in shop, so the Builder had to port it", "1": "Existing reason" } });
      expect(f.scope.work.approvedSha).toBeUndefined(); expect(f.scope.work.approvedPatch).toBeUndefined(); expect(f.scope.work.approvedFor).toBeUndefined();
      expect(f.calls.indexOf("checkpoint")).toBeLessThan(f.calls.indexOf("open:shop"));
    } finally { await f.close(); }
  });

  for (const observation of ["missing", "mismatch", "unmergeable", "extra-file", "port-only"] as const) it(`uses actual supplied tree and changed-path observations: ${observation}`, async () => {
    const f = sourceConflictFixture(false);
    try {
      f.reviewed(); await f.begin(); const updating = f.scope.work.updating!, effects = f.portEffects(f.scope);
      if (observation === "missing") effects.treeOf = async () => undefined;
      if (observation === "mismatch") effects.treeOf = async () => "another-reviewed-tree";
      if (observation === "unmergeable") effects.merge = async () => undefined;
      if (observation === "extra-file") effects.changedFiles = async () => ["greeting.txt", "unrelated.txt"];
      await finishSourcePort(f.scope, updating, effects);
      if (observation === "port-only") {
        expect(f.scope.work.portReview).toEqual({ from: updating.from, onto: updating.onto, head: updating.head, files: updating.files });
        expect(f.scope.work.reviewedTree).toBe("scripted:reviewed:shop"); expect(f.reviewPlaces()).toHaveLength(1);
      } else { expect(f.scope.work.portReview).toBeUndefined(); expect(f.scope.work.reviewedTree).toBeUndefined(); }
    } finally { await f.close(); }
  });

  for (const failure of [new Error("Native tree read failed"), undefined]) it(`leaves port bookkeeping untouched after a rejected observation (${failure ? "error" : "undefined"})`, async () => {
    const f = sourceConflictFixture(false);
    try {
      f.reviewed(); await f.begin(); const before = structuredClone(f.scope.work), effects = f.portEffects(f.scope);
      effects.treeOf = async () => { throw failure; };
      await expect(finishSourcePort(f.scope, f.scope.work.updating!, effects)).rejects.toBe(failure);
      expect(f.scope.work).toEqual(before);
    } finally { await f.close(); }
  });
});
