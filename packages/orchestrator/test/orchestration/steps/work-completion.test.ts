import { expect, it } from "vitest";
import { applyAcceptanceVersions } from "@petrina/core";
import type { WorkCompletionHost } from "../../../src/ports/work-completion.js";
import { WorkCompletion } from "../../../src/work-completion.js";
import { deferred } from "../../fixtures/tool-checks.js";
import { workCompletionFixture } from "../../fixtures/work-completion.js";

for (const kind of ["acceptance", "checks", "review"] as const) for (const final of kind === "acceptance" ? [false, true] : [false]) it(`returns a completed ${kind}${final ? " final" : " early"} repair through its recorded stage`, async () => {
  const f = workCompletionFixture(), { task, scope } = f;
  task.stageIndex = 0; task.sub = 2; task.fixing = false;
  task.repair = { products: [scope.work.productId], index: 0, returnStage: 1, kind, ...(final ? { final: true } : {}) };
  if (kind === "checks") task.repairCheck = true;
  expect(await f.owner.complete(scope, { stageId: "build", canEdit: true, testedVersions: f.versions })).toBe("continue");
  expect(task.stageIndex).toBe(1); expect(task.sub).toBe(0); expect(task.repair).toBeUndefined();
  expect(task.retest).toBe(final ? true : undefined);
  expect(task.repairCheck).toBe(kind === "acceptance" && !final || kind === "checks" ? true : undefined);
  expect(scope.work.completedStages).toEqual([]);
  expect(f.calls).toEqual(["finish", "end", "rerun", "versions", "checkpoint"]);
  expect(f.checkpoints[0]!.repair).toBeUndefined();
});

for (const port of [false, true]) it(`continues a repair on its next bound product with fixing=${!port}`, async () => {
  const f = workCompletionFixture(), { task, scope } = f;
  task.stageIndex = 0; task.repair = { products: ["a", "b"], index: 0, returnStage: 1, kind: "acceptance", ...(port ? { portProducts: ["b"] } : {}) };
  await f.owner.complete(scope, { stageId: "build", canEdit: true });
  expect(task.repair.index).toBe(1); expect(task.stageIndex).toBe(0); expect(task.activeProductId).toBe("b"); expect(task.fixing).toBe(!port);
  expect(task.repairCheck).toBeUndefined(); expect(task.retest).toBeUndefined();
  expect(f.calls).toEqual(["finish", "end", "rerun", "versions", "checkpoint"]);
});

it("marks only the completed product and reuses the same stage for the next unfinished owner", async () => {
  const f = workCompletionFixture(), { task, scope } = f;
  task.stageIndex = 0; scope.work.completedStages = ["earlier", "build"];
  await f.owner.complete(scope, { stageId: "build", canEdit: true });
  expect(scope.work.completedStages).toEqual(["earlier", "build"]);
  expect(task.repositories![1]!.completedStages).toEqual([]);
  expect(task.activeProductId).toBe("b"); expect(task.stageIndex).toBe(0);
  expect(f.calls.at(-1)).toBe("checkpoint");
});

it("advances after the last product has completed an editable stage", async () => {
  const f = workCompletionFixture(), { task, scope } = f;
  task.stageIndex = 0; task.sub = 3; task.repositories![1]!.completedStages = ["build"];
  await f.owner.complete(scope, { stageId: "build", canEdit: true });
  expect(task.repositories!.map(work => work.completedStages)).toEqual([["build"], ["build"]]);
  expect(task.stageIndex).toBe(1); expect(task.sub).toBe(0);
  expect(f.calls).toEqual(["finish", "end", "rerun", "versions", "changed"]);
});

for (const shared of [false, true]) it(`advances a non-editing stage without native invalidation (shared=${shared})`, async () => {
  const f = workCompletionFixture(shared);
  f.task.stageIndex = 1; f.task.sub = 4;
  await f.owner.complete(f.scope, { stageId: "test", canEdit: false });
  expect(f.task.stageIndex).toBe(2); expect(f.task.sub).toBe(0);
  expect(f.calls).toEqual(["finish", "end", "rerun", "changed"]);
});

it("does not perform shared-product invalidation for an editable single-product stage", async () => {
  const f = workCompletionFixture(false); f.task.stageIndex = 0;
  await f.owner.complete(f.scope, { stageId: "build", canEdit: true });
  expect(f.task.stageIndex).toBe(1);
  expect(f.calls).toEqual(["finish", "end", "rerun", "changed"]);
});

it("lets the actual rerun effect short-circuit before invalidation or ordinary advancement", async () => {
  const f = workCompletionFixture(); f.task.stageIndex = 0;
  f.host.rerun = current => { expect(current).toBe(f.task); f.calls.push("rerun"); return true; };
  await f.owner.complete(f.scope, { stageId: "build", canEdit: true, testedVersions: f.versions });
  expect(f.task.stageIndex).toBe(0); expect(f.scope.work.completedStages).toEqual([]);
  expect(f.calls).toEqual(["finish", "end", "rerun"]); expect(f.checkpoints).toEqual([]);
});

it("propagates invalidation failure before changing repair position or checkpointing", async () => {
  const f = workCompletionFixture(), error = new Error("Version observation unavailable");
  f.task.stageIndex = 0; f.task.repair = { products: ["a", "b"], index: 0, returnStage: 1, kind: "acceptance" };
  f.host.invalidateAcceptance = async bound => { expect(bound).toBe(f.scope); f.calls.push("versions"); throw error; };
  await expect(f.owner.complete(f.scope, { stageId: "build", canEdit: true })).rejects.toBe(error);
  expect(f.task.repair.index).toBe(0); expect(f.task.activeProductId).toBe("a"); expect(f.task.stageIndex).toBe(0);
  expect(f.task.repairCheck).toBeUndefined(); expect(f.checkpoints).toEqual([]);
  expect(f.calls).toEqual(["finish", "end", "rerun", "versions"]);
});

it("retains the supplied execution and tested observations while the visible product changes during invalidation", async () => {
  const f = workCompletionFixture(), entered = deferred<void>(), release = deferred<void>();
  f.task.stageIndex = 0; f.task.repositories![1]!.completedStages = ["build"];
  f.task.brief = { summary: "A greeting", areas: [], forUsers: [], risks: [], acceptance: [{ text: "Greeting", verification: "passed", met: true, productIds: ["a"], versions: { a: "old" } }] };
  f.host.invalidateAcceptance = async (bound, versions) => {
    expect(bound).toBe(f.scope); expect(versions).toBe(f.versions); f.calls.push("versions"); entered.resolve(); await release.promise;
    expect(bound.work).toBe(f.scope.work); applyAcceptanceVersions(bound.task, versions!);
  };
  const running = f.owner.complete(f.scope, { stageId: "build", canEdit: true, testedVersions: f.versions });
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error("Completion ended before its invalidation effect entered"); })]);
    f.task.activeProductId = "b";
    expect(f.scope.work.completedStages).toEqual([]); expect(f.checkpoints).toEqual([]);
  } finally { release.resolve(); await running; }
  expect(f.scope.work.completedStages).toEqual(["build"]); expect(f.task.stageIndex).toBe(1);
  expect(f.task.brief.acceptance[0]!.verification).toBe("stale");
  expect(f.calls).toEqual(["finish", "end", "rerun", "versions", "changed"]);
});

it("preserves method-backed effect receivers and step state cleanup", async () => {
  const f = workCompletionFixture(); f.task.stageIndex = 0;
  f.task.todo = "Finish";
  class Ports implements WorkCompletionHost {
    readonly calls: string[] = [];
    finishStep(scope: typeof f.scope) { this.calls.push("finish"); f.host.finishStep(scope); }
    endStage(scope: typeof f.scope) { this.calls.push("end"); f.host.endStage(scope); }
    rerun(task: typeof f.task) { this.calls.push("rerun"); return f.host.rerun(task); }
    async invalidateAcceptance(scope: typeof f.scope, versions?: Record<string,string>) { this.calls.push("versions"); await f.host.invalidateAcceptance(scope, versions); }
    checkpoint() { this.calls.push("checkpoint"); f.host.checkpoint(); }
    changed() { this.calls.push("changed"); f.host.changed(); }
  }
  const ports = new Ports(), owner = new WorkCompletion(ports);
  await owner.complete(f.scope, { stageId: "build", canEdit: true, testedVersions: f.versions });
  expect(ports.calls).toEqual(["finish", "end", "rerun", "versions", "checkpoint"]);
  expect(f.task.todo).toBeUndefined();
  f.task.repositories![1]!.completedStages = ["build"];
  await owner.complete(f.scope, { stageId: "build", canEdit: true, testedVersions: f.versions });
  expect(ports.calls).toEqual(["finish", "end", "rerun", "versions", "checkpoint", "finish", "end", "rerun", "versions", "changed"]);
});
