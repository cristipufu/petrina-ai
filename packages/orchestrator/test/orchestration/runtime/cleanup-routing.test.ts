import { describe, expect, it } from "vitest";
import { admissionFixture } from "../../fixtures/agent-workflow.js";
import { parallelFixture } from "../../fixtures/parallel-admission.js";
import { deferred } from "../../fixtures/tool-checks.js";

const outcome = (work: Promise<void>) => work.then(
  () => ({ kind: "value" as const }),
  error => ({ kind: "error" as const, error }),
);

describe("parallel cleanup authority", () => {
  for (const failure of [new Error("Released cleanup failed"), undefined]) {
    it(`keeps copies when released cleanup rejects ${failure === undefined ? "undefined" : "Error"}`, async () => {
      const f = parallelFixture();
      let done: Promise<void> | undefined, memberCompleted = false;
      try {
        f.workspaces.releasedStops = async function () {
          expect(this).toBe(f.workspaces);
          expect(memberCompleted).toBe(true);
          f.effects.push("releasedStops");
          throw failure;
        };
        done = f.group.run(f.request([f.member("0", async () => { memberCompleted = true; })]));
        const result = await outcome(done);
        expect(result).toEqual({ kind: "error", error: failure });
        expect(result.kind).toBe("error");
        if (result.kind !== "error") throw new Error("The rejected cleanup became successful");
        expect(result.error).toBe(failure);
        expect(f.effects).toEqual(["prepare:review-0", "activate:review-0", "finish:review-0", "stopHelpers", "releasedStops"]);
        expect(f.ownership.groups.size).toBe(0);
        expect(f.current.helpers).toBeUndefined();
      } finally { f.stop.abort(); await done?.catch(() => undefined); await f.close(); }
    });
  }

  for (const memberFailure of [new Error("Member failed"), undefined]) {
    for (const cleanupFailure of [new Error("Copy cleanup uncertain"), undefined]) {
      it(`preserves member ${memberFailure === undefined ? "undefined" : "Error"} and cleanup ${cleanupFailure === undefined ? "undefined" : "Error"}`, async () => {
        const f = parallelFixture();
        let done: Promise<void> | undefined;
        try {
          f.workspaces.releasedStops = async () => { f.effects.push("releasedStops"); throw cleanupFailure; };
          done = f.group.run(f.request([f.member("0", async () => { throw memberFailure; })]));
          const result = await outcome(done);
          expect(result.kind).toBe("error");
          if (result.kind !== "error") throw new Error("The failed group became successful");
          expect(result.error).toBeInstanceOf(AggregateError);
          const errors: unknown[] = (result.error as AggregateError).errors;
          expect(errors).toHaveLength(2);
          expect(errors[0]).toBe(memberFailure);
          expect(errors[1]).toBe(cleanupFailure);
          expect(f.effects).toEqual(["prepare:review-0", "activate:review-0", "finish:review-0", "stopHelpers", "closeTaskRun", "releasedStops"]);
          expect(f.ownership.groups.size).toBe(0);
        } finally { f.stop.abort(); await done?.catch(() => undefined); await f.close(); }
      });
    }
  }

  for (const stopFailure of [new Error("Stop request threw"), undefined]) {
    it(`still closes the task and joins its held peer after stopHelpers throws ${stopFailure === undefined ? "undefined" : "Error"}`, async () => {
      const f = parallelFixture(), fail = deferred<void>(), release = deferred<void>();
      const entered = new Set<string>(), memberFailure = new Error("The first member failed");
      let done: Promise<void> | undefined, peerCompleted = false, closeRequested = false;
      try {
        f.workspaces.stopHelpers = function () {
          expect(this).toBe(f.workspaces);
          f.effects.push("stopHelpers");
          throw stopFailure;
        };
        f.workspaces.closeTaskRun = function () {
          expect(this).toBe(f.workspaces);
          expect(peerCompleted).toBe(false);
          f.effects.push("closeTaskRun"); closeRequested = true;
        };
        f.workspaces.releasedStops = async () => {
          expect(peerCompleted).toBe(true);
          f.effects.push("releasedStops");
        };
        done = f.group.run(f.request([
          f.member("0", async () => { entered.add("first"); await fail.promise; throw memberFailure; }),
          f.member("1", async () => { entered.add("peer"); await release.promise; peerCompleted = true; }),
        ]));
        const observed = outcome(done).then(result => ({ result, peerCompleted }));
        await f.waitFor(() => entered.size === 2, "both working members", 1_000, done);
        fail.resolve();
        await f.waitFor(() => closeRequested, "the independent task stop request", 1_000, done);
        release.resolve();
        const reported = await observed;
        expect(reported.peerCompleted).toBe(true);
        expect(reported.result.kind).toBe("error");
        if (reported.result.kind !== "error") throw new Error("The failed stop request became successful");
        expect(reported.result.error).toBeInstanceOf(AggregateError);
        const errors: unknown[] = (reported.result.error as AggregateError).errors;
        expect(errors).toHaveLength(2);
        expect(errors[0]).toBe(memberFailure);
        expect(errors[1]).toBe(stopFailure);
        expect(f.effects).toContain("finish:review-1");
        expect(f.effects.slice(-2)).toEqual(["finish:review-1", "releasedStops"]);
        expect(f.effects.filter(effect => effect.startsWith("finishCopies:"))).toEqual([]);
        expect(f.ownership.groups.size).toBe(0);
        expect(f.current.helpers).toBeUndefined();
      } finally { fail.resolve(); release.resolve(); f.stop.abort(); await done?.catch(() => undefined); await f.close(); }
    });
  }
});

describe("driver failure restoration", () => {
  for (const phase of ["planner", "stage"] as const) {
    for (const mode of ["distinct-errors", "original-undefined", "cleanup-undefined", "same-error", "same-undefined"] as const) {
      it(`reports ${phase} and restoration failures without losing ${mode}, then finishes the actual drive`, async () => {
        const f = admissionFixture(1, 1, 1), id = f.ids[0]!, task = f.task(id)!;
        const original = mode === "original-undefined" || mode === "same-undefined" ? undefined : new Error("The phase failed");
        const cleanup = mode === "same-error" || mode === "same-undefined" ? original
          : mode === "cleanup-undefined" ? undefined : new Error("Restoration cleanup was not confirmed");
        const effects: string[] = [];
        let done: Promise<void> | undefined;
        try {
          f.state.pool.paused = false;
          f.host.schedule = () => {};
          if (phase === "planner") {
            f.phases.planner = async function (current) {
              expect(this).toBe(f.phases); expect(current).toBe(task);
              effects.push("phase"); throw original;
            };
          } else {
            task.stageIndex = 0;
            task.plan = { plannerProfileId: "opus-high", rationale: "Exercise a failing do-stage", stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] }] };
            f.phases.doStage = async function (scope, stage) {
              expect(this).toBe(f.phases); expect(scope.task).toBe(task); expect(stage).toBe(task.plan!.stages[0]);
              effects.push("phase"); throw original;
            };
          }
          f.phases.clearUnpublishedOnFailure = async function (current) {
            expect(this).toBe(f.phases); expect(current).toBe(task);
            effects.push("restore"); throw cleanup;
          };
          const failed = f.host.failed, finish = f.phases.finish;
          f.host.failed = function (failedId, error) {
            expect(this).toBe(f.host); expect(failedId).toBe(id);
            effects.push("failed"); failed.call(this, failedId, error);
          };
          f.phases.finish = async function (finishedId, signal) {
            expect(this).toBe(f.phases); expect(finishedId).toBe(id);
            effects.push("finish"); await finish.call(this, finishedId, signal);
          };
          f.workflow.startDriver(id);
          done = f.ownership.settling.get(id)!;
          await done; await Promise.all([...f.background]);
          expect(effects).toEqual(["phase", "restore", "failed", "finish"]);
          expect(f.failures).toHaveLength(1);
          if (mode === "same-error" || mode === "same-undefined") expect(f.failures[0]).toBe(original);
          else {
            expect(f.failures[0]).toBeInstanceOf(AggregateError);
            const errors: unknown[] = (f.failures[0] as AggregateError).errors;
            expect(errors).toHaveLength(2);
            expect(errors[0]).toBe(original);
            expect(errors[1]).toBe(cleanup);
          }
          expect(task.state).toBe("failed");
          expect(f.observations.filter(entry => entry.kind === "finished")).toEqual([{ kind: "finished", taskId: id }]);
          expect(f.driverErrors).toEqual([]);
          expect(f.ownership.drivers.size).toBe(0);
          expect(f.ownership.settling.size).toBe(0);
          expect(f.background.size).toBe(0);
        } finally { await done?.catch(() => undefined); await f.close(); }
      });
    }
  }
});
