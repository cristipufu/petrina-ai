import { describe, expect, it } from "vitest";
import { drainRuntime, inFlightWork } from "../../../src/runtime-drain.js";
import { admissionFixture } from "../../fixtures/agent-workflow.js";
import { deferred } from "../../fixtures/tool-checks.js";

function fixture() {
  const f = admissionFixture(1, 1, 1), id = f.ids[0]!;
  f.host.schedule = () => {};
  f.phases.prepareWorkspace = async () => ({ kind: "stop" });
  return { ...f, id };
}

async function outcome(work: Promise<void>, background: ReadonlySet<Promise<void>>) {
  const result = await work.then(() => ({ status: "fulfilled" as const }), reason => ({ status: "rejected" as const, reason }));
  await Promise.all([...background]);
  return result;
}

describe("driver finalization ownership", () => {
  it("keeps the live drive task-keyed and transfers ownership before tidy, scheduling and idle notification", async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>(), effects: string[] = [];
    let initial = true;
    try {
      const track = f.host.trackWork;
      f.host.trackWork = function (work) {
        expect(this).toBe(f.host);
        expect(f.ownership.settling.get(f.id)).toBe(work);
        effects.push("track"); return track.call(this, work);
      };
      f.phases.prepareWorkspace = async () => {
        expect(f.background.size).toBe(0); expect(f.ownership.settling.has(f.id)).toBe(true);
        effects.push("prepare"); return { kind: "stop" };
      };
      f.phases.finish = async () => { effects.push("finish"); entered.resolve(); await release.promise; };
      f.host.tidy = function (id) {
        expect(this).toBe(f.host); expect(id).toBe(f.id);
        expect(f.ownership.settling.has(id)).toBe(false); expect(f.background.size).toBe(1); effects.push("tidy");
      };
      f.host.schedule = function () { expect(this).toBe(f.host); expect(f.background.size).toBe(1); effects.push("schedule"); };
      f.host.idleChanged = function () {
        expect(this).toBe(f.host); expect(f.background.size).toBe(initial ? 0 : 1); effects.push(initial ? "initial-idle" : "idle"); initial = false;
      };
      f.workflow.startDriver(f.id);
      const done = f.ownership.settling.get(f.id)!;
      await entered.promise;
      expect(f.ownership.settling.get(f.id)).toBe(done); expect(f.background.size).toBe(0);
      expect(effects).toEqual(["prepare", "initial-idle", "finish"]);
      release.resolve(); await done; await Promise.all([...f.background]);
      expect(effects).toEqual(["prepare", "initial-idle", "finish", "track", "tidy", "schedule", "idle"]);
      expect(f.background.size).toBe(0); expect(f.ownership.drivers.size).toBe(0); expect(f.driverErrors).toEqual([]);
    } finally { release.resolve(); await f.close(); }
  });

  it("keeps the actual drain projection nonzero after releasing the scheduling reservation and until final callbacks complete", async () => {
    const f = fixture(), snapshots: number[] = [], drains: Promise<number>[] = [];
    try {
      const count = () => inFlightWork({ agents: 0, settling: f.ownership.settling.size, background: f.background.size, copyCleanups: 0, terminals: 0 });
      f.host.tidy = () => {
        snapshots.push(count());
        drains.push(drainRuntime({ requestStop() {}, stopped: () => false, inFlight: count },
          { now: () => 0, sleep: async () => { throw new Error("No elapsed wait is needed at the observation limit"); } }, 0));
      };
      f.host.schedule = () => { snapshots.push(count()); };
      f.host.idleChanged = () => { if (!f.ownership.settling.size) snapshots.push(count()); };
      f.workflow.startDriver(f.id); await f.ownership.settling.get(f.id)!; await Promise.all([...f.background]);
      expect(snapshots).toEqual([1, 1, 1]); expect(await Promise.all(drains)).toEqual([1]);
      expect(count()).toBe(0);
    } finally { await f.close(); }
  });

  it.each([new Error("finish rejected"), undefined])("retains a single actual finish rejection exactly, including %s", async failure => {
    const f = fixture(), effects: string[] = [], originalState = f.task(f.id)!.state;
    try {
      f.phases.finish = async () => { throw failure; };
      f.host.tidy = () => { effects.push("tidy"); }; f.host.schedule = () => { effects.push("schedule"); };
      f.host.idleChanged = () => { effects.push("idle"); };
      f.workflow.startDriver(f.id);
      const result = await outcome(f.ownership.settling.get(f.id)!, f.background);
      expect(result.status).toBe("rejected"); if (result.status === "rejected") expect(result.reason).toBe(failure);
      expect(effects).toEqual(["idle", "tidy", "schedule", "idle"]);
      expect(f.driverErrors).toEqual([{ taskId: f.id, error: failure }]);
      expect(f.task(f.id)!.state).toBe(originalState); expect(f.failures).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(["tidy", "schedule", "idle"] as const)("owns %s failure and still attempts every later finalization callback", async failing => {
    const f = fixture(), failure = new Error(failing), effects: string[] = [];
    let initial = true;
    try {
      const effect = (name: typeof failing) => { effects.push(name); if (name === failing) throw failure; };
      f.host.tidy = () => effect("tidy"); f.host.schedule = () => effect("schedule");
      f.host.idleChanged = () => { if (initial) { initial = false; return; } effect("idle"); };
      f.workflow.startDriver(f.id);
      const result = await outcome(f.ownership.settling.get(f.id)!, f.background);
      expect(result.status).toBe("rejected"); if (result.status === "rejected") expect(result.reason).toBe(failure);
      expect(effects).toEqual(["tidy", "schedule", "idle"]); expect(f.driverErrors).toEqual([{ taskId: f.id, error: failure }]);
      expect(f.background.size).toBe(0);
    } finally { await f.close(); }
  });

  it("preserves ordered original/finalizer failures and a failed diagnostic reporter without reclassifying the task", async () => {
    const f = fixture(), finish = new Error("finish"), tidy = new Error("tidy"), idle = new Error("idle"), reporter = new Error("reporter");
    let initial = true, reported: unknown;
    const originalState = f.task(f.id)!.state;
    try {
      f.phases.finish = async () => { throw finish; };
      f.host.tidy = () => { throw tidy; }; f.host.schedule = () => { throw undefined; };
      f.host.idleChanged = () => { if (initial) { initial = false; return; } throw idle; };
      f.host.reportDriverError = function (id, error) { expect(this).toBe(f.host); expect(id).toBe(f.id); reported = error; throw reporter; };
      f.workflow.startDriver(f.id);
      const result = await outcome(f.ownership.settling.get(f.id)!, f.background);
      expect(reported).toBeInstanceOf(AggregateError);
      if (reported instanceof AggregateError) expect(reported.errors).toEqual([finish, tidy, undefined, idle]);
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") { expect(result.reason).toBeInstanceOf(AggregateError); if (result.reason instanceof AggregateError) expect(result.reason.errors).toEqual([finish, tidy, undefined, idle, reporter]); }
      expect(f.task(f.id)!.state).toBe(originalState); expect(f.failures).toEqual([]); expect(f.background.size).toBe(0);
    } finally { await f.close(); }
  });

  it("keeps an ordinary handled stage failure in the task without reporting a second lifetime failure", async () => {
    const f = fixture(), failure = new Error("stage failed");
    try {
      f.phases.prepareWorkspace = async () => { throw failure; };
      f.workflow.startDriver(f.id); await f.ownership.settling.get(f.id)!; await Promise.all([...f.background]);
      expect(f.task(f.id)!.state).toBe("failed"); expect(f.failures).toEqual([failure]);
      expect(f.driverErrors).toEqual([]); expect(f.background.size).toBe(0);
    } finally { await f.close(); }
  });

  it("owns a failure escaping the actual stage-failure handler and retains its exact value", async () => {
    const f = fixture(), stageFailure = new Error("stage"), handlerFailure = new Error("failure handler");
    try {
      f.phases.prepareWorkspace = async () => { throw stageFailure; };
      f.host.failed = () => { throw handlerFailure; };
      f.workflow.startDriver(f.id);
      const result = await outcome(f.ownership.settling.get(f.id)!, f.background);
      expect(result.status).toBe("rejected"); if (result.status === "rejected") expect(result.reason).toBe(handlerFailure);
      expect(f.driverErrors).toEqual([{ taskId: f.id, error: handlerFailure }]); expect(f.background.size).toBe(0);
    } finally { await f.close(); }
  });

  it("does not release a replacement run when the older actual drive finishes", async () => {
    const f = fixture(), first = deferred<void>(), second = deferred<void>(), entered = [deferred<void>(), deferred<void>()];
    let turn = 0;
    try {
      f.phases.finish = async () => { const index = turn++; entered[index]!.resolve(); await (index === 0 ? first : second).promise; };
      f.workflow.startDriver(f.id); const older = f.ownership.settling.get(f.id)!; await entered[0]!.promise;
      f.workflow.startDriver(f.id); const newer = f.ownership.settling.get(f.id)!; await entered[1]!.promise;
      expect(f.ownership.settling.get(f.id)).toBe(newer); expect(f.background.size).toBe(0);
      first.resolve(); await older; await Promise.all([...f.background]);
      expect(f.ownership.settling.get(f.id)).toBe(newer); expect(f.background.size).toBe(0);
      second.resolve(); await newer; await Promise.all([...f.background]);
      expect(f.ownership.settling.size).toBe(0); expect(f.background.size).toBe(0); expect(f.driverErrors).toEqual([]);
    } finally { first.resolve(); second.resolve(); await f.close(); }
  });

  it("keeps a newer run owned when scheduling it reentrantly at the original release point", async () => {
    const f = fixture(), release = deferred<void>(), entered = deferred<void>();
    let finishes = 0, scheduled = false;
    try {
      f.phases.finish = async () => { if (++finishes === 2) { entered.resolve(); await release.promise; } };
      f.host.schedule = () => { if (!scheduled) { scheduled = true; f.workflow.startDriver(f.id); } };
      f.workflow.startDriver(f.id); const older = f.ownership.settling.get(f.id)!;
      await entered.promise; await older; await Promise.all([...f.background]);
      const newer = f.ownership.settling.get(f.id)!;
      expect(f.ownership.settling.get(f.id)).toBe(newer); expect(f.background.size).toBe(0);
      release.resolve(); await newer; await Promise.all([...f.background]);
      expect(f.trackedWork).toHaveLength(2); expect(f.ownership.settling.size).toBe(0); expect(f.driverErrors).toEqual([]);
    } finally { release.resolve(); await f.close(); }
  });

  it("retains its task-keyed owner through every callback if finalizer registration fails", async () => {
    const f = fixture(), failure = new Error("could not register"), effects: string[] = [];
    let initial = true;
    try {
      f.host.trackWork = () => { effects.push("track"); throw failure; };
      f.host.tidy = () => { expect(f.ownership.settling.has(f.id)).toBe(true); effects.push("tidy"); };
      f.host.schedule = () => { expect(f.ownership.settling.has(f.id)).toBe(true); effects.push("schedule"); };
      f.host.idleChanged = () => {
        expect(f.ownership.settling.has(f.id)).toBe(true); effects.push(initial ? "initial-idle" : "idle"); initial = false;
      };
      f.workflow.startDriver(f.id); const result = await outcome(f.ownership.settling.get(f.id)!, f.background);
      expect(result.status).toBe("rejected"); if (result.status === "rejected") expect(result.reason).toBe(failure);
      expect(effects).toEqual(["initial-idle", "track", "tidy", "schedule", "idle"]);
      expect(f.driverErrors).toEqual([{ taskId: f.id, error: failure }]);
      expect(f.ownership.settling.size).toBe(0); expect(f.ownership.drivers.size).toBe(0); expect(f.background.size).toBe(0);
    } finally { await f.close(); }
  });

  it("retains drive, registration and callback errors in order when the handoff cannot be registered", async () => {
    const f = fixture(), finish = new Error("finish"), registration = new Error("registration"), tidy = new Error("tidy");
    try {
      f.phases.finish = async () => { throw finish; };
      f.host.trackWork = () => { throw registration; };
      f.host.tidy = () => { expect(f.ownership.settling.has(f.id)).toBe(true); throw tidy; };
      f.workflow.startDriver(f.id); const result = await outcome(f.ownership.settling.get(f.id)!, f.background);
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(AggregateError);
        if (result.reason instanceof AggregateError) expect(result.reason.errors).toEqual([finish, registration, tidy]);
        expect(f.driverErrors).toEqual([{ taskId: f.id, error: result.reason }]);
      }
      expect(f.ownership.settling.size).toBe(0); expect(f.background.size).toBe(0);
    } finally { await f.close(); }
  });

  it("does not release a replacement started during a failed finalizer registration", async () => {
    const f = fixture(), release = deferred<void>(), entered = deferred<void>(), failure = new Error("registration");
    let registrations = 0, finishes = 0, restarted = false;
    const track = f.host.trackWork;
    try {
      f.host.trackWork = work => { if (++registrations === 1) throw failure; return track.call(f.host, work); };
      f.phases.finish = async () => { if (++finishes === 2) { entered.resolve(); await release.promise; } };
      f.host.tidy = () => { if (!restarted) { restarted = true; f.workflow.startDriver(f.id); } };
      f.workflow.startDriver(f.id); const older = f.ownership.settling.get(f.id)!;
      const olderResult = outcome(older, f.background); await entered.promise;
      const newer = f.ownership.settling.get(f.id)!;
      expect(await olderResult).toEqual({ status: "rejected", reason: failure });
      expect(newer).not.toBe(older); expect(f.ownership.settling.get(f.id)).toBe(newer); expect(f.background.size).toBe(0);
      release.resolve(); await newer; await Promise.all([...f.background]);
      expect(f.driverErrors).toEqual([{ taskId: f.id, error: failure }]); expect(f.ownership.settling.size).toBe(0);
    } finally { release.resolve(); await f.close(); }
  });

  it("preserves a synchronous initial idle error while the already registered driver and finalizer remain owned", async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>(), failure = new Error("initial idle"), effects: string[] = [];
    let initial = true;
    try {
      f.phases.finish = async () => { entered.resolve(); await release.promise; };
      f.host.idleChanged = () => { if (initial) { initial = false; throw failure; } effects.push("idle"); };
      f.host.tidy = () => { effects.push("tidy"); }; f.host.schedule = () => { effects.push("schedule"); };
      expect(() => f.workflow.startDriver(f.id)).toThrow(failure);
      const done = f.ownership.settling.get(f.id)!; await entered.promise;
      expect(f.ownership.settling.get(f.id)).toBe(done); expect(f.background.size).toBe(0);
      release.resolve(); await done; await Promise.all([...f.background]);
      expect(effects).toEqual(["tidy", "schedule", "idle"]); expect(f.background.size).toBe(0); expect(f.driverErrors).toEqual([]);
    } finally { release.resolve(); await f.close(); }
  });
});
