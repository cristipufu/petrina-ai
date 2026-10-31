import { cpSync, mkdirSync } from "node:fs";
import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { resolve as testFixturePath } from "node:path";
const TEST_FIXTURE_ROOT = testFixturePath(import.meta.dir, "../..");
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";
import { Engine, type EngineOptions } from "../../engine.js";
import * as gitOps from "@petrina/repositories/git";
import { git, waitFor } from "../../fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import { EngineLifecycle } from "../../../src/lifecycle.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import * as files from "node:fs/promises";
import { readGitHub, writeGitHub } from "../../fake-gh.js";
import { serviceExtraFixture, type ExtraFixture } from "../../extra-fixtures.js";
import { readWorktreeCommit } from "../../fixtures/shared-preparation.js";

function patchContainer(engine: Engine) {
  const container = engine.extraValidations["container"];
  const origSnapshot = container.snapshot.bind(container);
  container.snapshot = async record => {
    const fast = readWorktreeCommit(record.source);
    if (fast) {
      mkdirSync(join(engine.dataDir, "extra-snapshots"), { recursive: true });
      cpSync(record.source, record.snapshot, { recursive: true });
      if (fast.commit !== record.commit || fast.tree !== record.tree) {
        await gitOps.resetTo(record.snapshot, record.commit);
      }
      return;
    }
    return origSnapshot(record);
  };
  container["stopClient"] = async record => {
    if (!record.clientPid) return true;
    try { process.kill(-record.clientPid, "SIGKILL"); } catch {}
    try { process.kill(record.clientPid, "SIGKILL"); } catch {}
    return true;
  };
}

function extraFixture<T>(owner: EngineCaseOwner, body: (fixture: ExtraFixture) => Promise<T>, options: EngineOptions = {}): Promise<T> {
  return serviceExtraFixture(owner, f => {
    patchContainer(f.engine);
    return body(f);
  }, options, { actorLease: false, scriptedNonHoldRuns: true });
}

const cases = engineCaseFixtures();
afterAll(() => cases.close());

describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
  // Native anchors retain each owned preparation resource and every lifecycle action.
  // Phase admission permutations run against the same production ValidationRun controller.
  for (const [phase, action] of [["inspection", "pause"], ["copy", "restart"], ["log", "stop"]] as const) it(`defers an extra run when ${action} arrives during ${phase} preparation`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const record = await f.submit("prepare-admission", ["probe", "pass"]);
    const following = await f.submit("prepare-follower", ["probe", "pass"], (await f.add()).id);
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    owner.onStop(() => released.resolve());
    const container = f.engine.extraValidations["container"];
    let restore = () => {};
    if (phase === "log") {
      const open = files.open;
      const read = spyOn(files, "open");
    owner.onStop(() => read.mockRestore());
    read.mockImplementation(async (...args) => {
        const file = await open(...args);
        if (String(args[0]).startsWith(join(f.data, "checks")) && args[1] === "wx+") { entered.resolve(); await released.promise; }
        return file;
      });
      restore = () => read.mockRestore();
    } else if (phase === "inspection") {
      const prepare = container.prepare.bind(container);
      container.prepare = async record => { const result = await prepare(record); entered.resolve(); await released.promise; return result; };
    } else {
      const snapshot = container.snapshot.bind(container);
      container.snapshot = async record => { await snapshot(record); entered.resolve(); await released.promise; };
    }
    owner.check();
    const store = new LifecycleStore(join(f.root, "admission-lifecycle"));
    const closeStore = owner.afterBody(() => store.close());
    const handoffs: boolean[] = [];
    const lifecycle = new EngineLifecycle(f.engine, store, async restart => { handoffs.push(restart); });
    owner.onStop(() => lifecycle.close());
    let replacement: Engine | undefined;
    try {
      f.engine.setPoolPaused(false); await entered.promise;
      expect(f.engine.checkQueue.running).toBe(1);
      await lifecycle.request(action, { requestId: `admission-${action}` });
      released.resolve();
      await waitFor(() => f.engine.extraValidations.active === 0, "preparation to relinquish its place");
      const pending = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
      expect(pending.state).toBe("queued"); expect(pending.startedAt).toBeUndefined(); expect(pending.result).toBeUndefined();
      expect([pending.commit, pending.tree, pending.queueOrder, pending.queuedAt]).toEqual([record.commit, record.tree, record.queueOrder, record.queuedAt]);
      expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(2);
      expect(existsSync(record.snapshot)).toBe(false);
      expect(existsSync(join(f.service, "started")) ? readdirSync(join(f.service, "started")) : []).toEqual([]);
      expect(f.engine.events.log.collect({}, 0, 100).events.some(event => event.kind === "extra.started")).toBe(false);
      await lifecycle["settle"]();
      let current = f.engine;
      if (action === "pause") await lifecycle.request("resume", { requestId: "admission-resume" });
      else {
        expect(handoffs).toEqual([action === "restart"]);
        lifecycle.close(); await owner.stop(f.engine);
        replacement = owner.open(f.data, f.settings); patchContainer(replacement); current = replacement;
        await current.extraValidations.ready; current.setPoolPaused(false);
      }
      await waitFor(() => current.extraValidations.get(following.requestId)?.outcome === "completed", "both requests to run once in order");
      expect((current.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("passed");
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual([record.containerName, following.containerName]);
      expect(current.checkQueue.running).toBe(0);
    } finally { released.resolve(); restore(); lifecycle.close(); await closeStore(); await (replacement ? owner.stop(replacement) : undefined); await owner.stop(f.engine); }

  });

  });
});

  for (const holdAt of ["submission", "queued"] as const) it(`reports prerequisite deferral separately from a queue place at ${holdAt}`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {const prerequisite = await f.add();

    if (holdAt === "submission") f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "deferred-hold");
    const first = await f.submit("deferred-place", ["probe", "pass"]);
    if (holdAt === "queued") await f.coordination.call("task.wait", { taskId: f.task.id, after: [prerequisite.id], reason: "Wait for the required fix", requestId: "deferred-hold" });
    const deferred = f.engine.extraValidations.get(first.requestId)!.validation as ExtraValidation;
    if (holdAt === "submission") { expect(first.queuePosition).toBeUndefined(); expect(first.waitingReason).toBe(deferred.waitingReason); }
    expect(deferred.queuePosition).toBeUndefined();
    expect(deferred.waitingReason).toContain("prerequisite");
    expect(f.engine.extraValidations.get(first.requestId)!.message).toContain(deferred.waitingReason!);
    expect(f.engine.store.load()!.extraValidations![0]!.waitingReason).toBe(deferred.waitingReason);
    expect(f.engine.checkQueue.waiting).toBe(0); expect(f.engine.checkQueue.running).toBe(0);
    const note = f.task.timeline.filter(line => line.text.includes("Extra validation")).at(-1)!;
    expect(note.text).toContain("before joining the check queue"); expect(note.text).not.toContain("place");
    const second = await f.submit("ready-place", ["probe", "pass"], (await f.add()).id);
    expect(second.queuePosition).toBe(1);
    expect(f.engine.checkQueue.waiting).toBe(1);
    expect((await f.coordination.call("validation.run", f.request(first.requestId, ["probe", "pass"]))).validation).toEqual(deferred);
    await f.coordination.call("task.wait", { taskId: f.task.id, after: [], reason: "The fix is available", requestId: "deferred-clear" });
    const joined = f.engine.extraValidations.get(first.requestId)!.validation as ExtraValidation;
    expect(joined.waitingReason).toBeUndefined(); expect(joined.queuePosition).toBe(1);
    expect(f.engine.checkQueue.waiting).toBe(2);
    f.engine.setPoolPaused(false);
    expect((await f.finished(first)).result).toBe("passed"); expect((await f.finished(second)).result).toBe("passed");
    const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
    expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual([first.containerName, second.containerName]);

  });

  });
});

  it("keeps deferred ownership and evidence consistent when saving queue re-entry fails", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {const prerequisite = await f.add();

    f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "failed-reentry-hold");
    const record = await f.submit("failed-reentry", ["probe", "pass"]), timeline = structuredClone(f.task.timeline);
    f.engine.setRuntimeWait(f.task.id, [], "The fix is available", "failed-reentry-clear");
    const afterClear = structuredClone(f.task.timeline);
    const save = spyOn(f.engine, "commitNow");
    owner.onStop(() => save.mockRestore());
    save.mockImplementationOnce(() => { throw new Error("Queue re-entry save unavailable"); });
    try { expect(() => f.engine.extraValidations.pump()).toThrow("Queue re-entry save unavailable"); }
    finally { save.mockRestore(); }
    expect(f.engine.extraValidations.get(record.requestId)!.validation).toEqual(record);
    expect(f.engine.store.load()!.extraValidations![0]).toEqual(record);
    expect(f.task.timeline).toEqual(afterClear); expect(afterClear.length).toBeGreaterThan(timeline.length);
    expect(f.engine.checkQueue.waiting).toBe(0); expect(f.engine.checkQueue.running).toBe(0);
    expect(existsSync(join(f.service, "started"))).toBe(false);
    f.engine.extraValidations.pump();
    const joined = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
    expect(joined.waitingReason).toBeUndefined(); expect(joined.queuePosition).toBe(1);
    f.engine.setPoolPaused(false); expect((await f.finished(record)).result).toBe("passed");

  });

  });
});

  it("leaves a join whose save keeps failing for the next scheduling pass, without retrying it in a loop", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
      const prerequisite = await f.add();
      f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "looping-reentry-hold");
      const record = await f.submit("looping-reentry", ["probe", "pass"]);
      f.engine.setRuntimeWait(f.task.id, [], "The fix is available", "looping-reentry-clear");
      const save = spyOn(f.engine, "commitNow").mockImplementation(() => { throw new Error("Queue re-entry save unavailable"); });
      owner.onStop(() => save.mockRestore());
      try {
        expect(() => f.engine.extraValidations.pump()).toThrow("Queue re-entry save unavailable");
        const attempts = save.mock.calls.length;
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
        expect(save.mock.calls.length).toBe(attempts);
        expect(f.engine.checkQueue.waiting).toBe(0); expect(f.engine.checkQueue.running).toBe(0);
      } finally { save.mockRestore(); }
      f.engine.extraValidations.pump();
      const joined = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
      expect(joined.waitingReason).toBeUndefined(); expect(joined.queuePosition).toBe(1);
      f.engine.setPoolPaused(false); expect((await f.finished(record)).result).toBe("passed");
    });
  });
});

  for (const restart of [false, true]) it(`joins a deferred extra run during the scheduling pass that observes landing${restart ? " after restart" : ""}`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {const prerequisite = await f.add();

    f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "landing-hold");
    const first = await f.submit("landing-extra", ["probe", "pass"]);
    const second = await f.submit("landing-ready", ["probe", "pass"], (await f.add()).id);
    f.engine.setPoolPaused(false); expect((await f.finished(second)).result).toBe("passed");
    expect(existsSync(join(f.service, "started", first.id))).toBe(false);
    let current = f.engine;
    if (restart) {
      await owner.stop(current); current = owner.open(f.data, f.settings); patchContainer(current); await current.waitUntilReady();
    }
    try {
      const required = current.task(prerequisite.id)!;
      const work = executionFor(required).work;
      work.delivery = "local"; work.landed = { branch: "main", sha: work.savedVersion!.commit }; required.state = "done";
      current.schedule(); // Use the real prerequisite release, with no second scheduling call or timer.
      expect(current.task(f.task.id)!.runtimeWait!.releasedAt).toBeDefined();
      expect(current.checkQueue.running).toBe(1);
      const joined = current.extraValidations.get(first.requestId)!.validation as ExtraValidation;
      expect(joined.waitingReason).toBeUndefined(); expect(joined.queuePosition).toBe(1);
      expect([joined.commit, joined.tree, joined.queueOrder, joined.queuedAt]).toEqual([first.commit, first.tree, first.queueOrder, first.queuedAt]);
      await waitFor(() => current.extraValidations.get(first.requestId)?.outcome === "completed", "the released extra request to finish");
      expect((current.extraValidations.get(first.requestId)!.validation as ExtraValidation).result).toBe("passed");
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual([second.containerName, first.containerName]);
      expect(current.s.extraValidations).toEqual([]); expect(current.checkQueue.running).toBe(0);
    } finally { await owner.stop(current); }

  });

  });
});

  it("joins a deferred extra run when its prerequisite's driver finishes delivery", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {const prerequisite = await f.add();

    await f.engine.waitUntilReady();
    f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "driver-landing-hold");
    const record = await f.submit("driver-landing-extra", ["probe", "pass"]);
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    owner.onStop(() => released.resolve());
    const shipping = f.engine["shipping"];
    const delivery = spyOn(shipping, "deliver");
    owner.onStop(() => delivery.mockRestore());
    delivery.mockImplementation(async task => {
      entered.resolve(); await released.promise;
      const scope = executionFor(task);
      scope.work.delivery = "local"; scope.work.landed = { branch: "main", sha: scope.work.savedVersion!.commit };
      shipping["recovery"].finished(scope, "Committed to main");
      f.engine.commitNow();
      return "stop";
    });
    const tidy = spyOn(f.engine, "tidy");
    owner.onStop(() => tidy.mockRestore());
    tidy.mockImplementation(() => {});
    prerequisite.plan = { stages: [{ id: "ship", title: "Deliver", kind: "do", roleId: "release-manager", profileIds: [] }], rationale: "Deliver the required fix", plannerProfileId: "sol-high" };
    prerequisite.stageIndex = 0; prerequisite.state = "running";
    try {
      f.engine.setPoolPaused(false);
      f.engine.startDriver(prerequisite.id, true);
      const driving = f.engine.settling.get(prerequisite.id)!;
    owner.onStop(async () => { await Promise.allSettled([driving]); });
      await Promise.race([entered.promise, driving.then(() => { throw new Error(`Delivery ended before landing: ${prerequisite.statusLine}`); })]);
      expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(0);
      released.resolve(); await driving; // Its registered completion callback runs before this continuation, without a timer or explicit scheduling call.
      expect(f.task.runtimeWait!.releasedAt).toBeDefined();
      expect(f.engine.checkQueue.running).toBe(1);
      const joined = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
      expect(joined.waitingReason).toBeUndefined(); expect(joined.state).not.toBe("queued"); expect(joined.queuePosition).toBeUndefined();
      expect([joined.commit, joined.tree, joined.queueOrder, joined.queuedAt]).toEqual([record.commit, record.tree, record.queueOrder, record.queuedAt]);
      expect((await f.finished(record)).result).toBe("passed");
      expect(delivery).toHaveBeenCalledTimes(1);
      expect(f.engine.checkQueue.running).toBe(0);
    } finally { released.resolve(); delivery.mockRestore(); tidy.mockRestore(); await owner.stop(f.engine); }

  });

  });
});

  it("joins a deferred extra run in the pass that notices its prerequisite pull request merged", async () => {
  return cases.use("petrina-extra-", async owner => {
    const githubRoot = join(owner.root, "extra-pr-wake"); mkdirSync(githubRoot);
    const githubState = join(githubRoot, "github.json");
    return await extraFixture(owner, async f => {
    await f.engine.waitUntilReady();
    const prerequisite = await f.add(), work = executionFor(prerequisite).work;
    f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the merged fix", "pr-merge-hold");
    const first = await f.submit("pr-merge-deferred", ["probe", "hold"]);
    const second = await f.submit("pr-merge-ready", ["probe", "pass"], (await f.add()).id);
    prerequisite.state = "pr-open";
    work.delivery = "pull-request";
    work.pr = { number: 7, url: "https://github.com/acme/demo/pull/7", state: "open", openedAt: Date.now() };
    const product = f.engine.s.products.find(product => product.id === f.productId)!;
    writeGitHub(githubState, { repo: product.repo, prs: [{ number: 7, url: work.pr.url, headRefName: "required-fix", baseRefName: "main",
      headRefOid: work.savedVersion!.commit, state: "MERGED", isCrossRepository: false, title: "Required fix", body: "" }], releases: [], calls: [] });
    // The saved request stays on its original version even if the task's next saved version changes.
    writeFileSync(join(product.path!, "later.txt"), "Saved after the extra request\n");
    await gitOps.commitChanges(product.path!, "Later saved version");
    executionFor(f.task).work.savedVersion = readWorktreeCommit(product.path!)!;
    const occupied = f.engine.checkQueue.hold();
    owner.onStop(() => occupied?.());
    const tidy = spyOn(f.engine, "tidy");
    owner.onStop(() => tidy.mockRestore());
    tidy.mockImplementation(() => {});
    const scheduled = spyOn(f.engine, "schedule");
    owner.onStop(() => scheduled.mockRestore());
    try {
      f.engine.setPoolPaused(false);
      expect(f.engine.checkQueue.waiting).toBe(1);
      expect((f.engine.extraValidations.get(first.requestId)!.validation as ExtraValidation).waitingReason).toContain("prerequisite");
      scheduled.mockClear();
      await f.engine["shipping"].monitor.pollPullRequests(); // The monitor owns the only scheduling call.
      expect(scheduled).toHaveBeenCalledTimes(1);
      expect(work.pr.state).toBe("merged"); expect(f.engine.task(prerequisite.id)!.state).toBe("done");
      expect(f.task.runtimeWait!.releasedAt).toBeDefined();
      expect(f.engine.checkQueue.running).toBe(1); expect(f.engine.checkQueue.waiting).toBe(2);
      const joined = f.engine.extraValidations.get(first.requestId)!.validation as ExtraValidation;
      expect(joined.waitingReason).toBeUndefined(); expect(joined.queuePosition).toBe(2);
      expect([joined.commit, joined.tree, joined.queueOrder, joined.queuedAt]).toEqual([first.commit, first.tree, first.queueOrder, first.queuedAt]);
      occupied(); await f.started(first);
      expect(readWorktreeCommit(first.snapshot)?.commit ?? await git(first.snapshot, "rev-parse", "HEAD")).toBe(first.commit);
      expect(existsSync(join(first.snapshot, "later.txt"))).toBe(false);
      f.release(first);
      expect((await f.finished(first)).result).toBe("passed"); expect((await f.finished(second)).result).toBe("passed");
      const runs = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(runs.map(args => args[args.indexOf("--name") + 1])).toEqual([first.containerName, second.containerName]);
      expect(readGitHub(githubState).calls.filter(args => args[0] === "pr" && args[1] === "view")).toHaveLength(1);
      expect(f.engine.s.extraValidations).toEqual([]); expect(f.engine.checkQueue.running).toBe(0);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    } finally { occupied(); scheduled.mockRestore(); tidy.mockRestore(); await owner.stop(f.engine); }

  }, { gh: [process.execPath, join(TEST_FIXTURE_ROOT, "fake-gh.ts"), githubState, githubRoot] });

  });
});

  for (const boundary of ["queued", "handoff", "inspection", "copy", "log", "running"] as const) it(`honors a task prerequisite wait for extra validation at ${boundary}`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {const prerequisite = await f.add();

    const record = await f.submit("prerequisite-extra", ["probe", boundary === "running" ? "hold" : "pass"]);
    const following = await f.submit("prerequisite-follower", ["probe", "pass"], (await f.add()).id);
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    owner.onStop(() => released.resolve());
    const container = f.engine.extraValidations["container"];
    let restore = () => {}, occupied = () => {};
    owner.onStop(() => occupied?.());
    if (boundary === "inspection") {
      const prepare = container.prepare.bind(container);
      container.prepare = async current => {
        const result = await prepare(current);
        if (current.id === record.id) { entered.resolve(); await released.promise; }
        return result;
      };
    } else if (boundary === "copy") {
      const snapshot = container.snapshot.bind(container);
      container.snapshot = async current => {
        await snapshot(current);
        if (current.id === record.id) { entered.resolve(); await released.promise; }
      };
    } else if (boundary === "log") {
      const open = files.open;
      const read = spyOn(files, "open");
    owner.onStop(() => read.mockRestore());
    read.mockImplementation(async (...args) => {
        const file = await open(...args);
        if (String(args[0]).startsWith(join(f.data, "checks", record.taskId)) && args[1] === "wx+") { entered.resolve(); await released.promise; }
        return file;
      });
      restore = () => read.mockRestore();
    }
    try {
      if (boundary === "handoff") occupied = f.engine.checkQueue.hold();
      if (boundary !== "queued") f.engine.setPoolPaused(false);
      if (["inspection", "copy", "log"].includes(boundary)) await entered.promise;
      if (boundary === "running") await f.started(record);
      if (boundary === "handoff") occupied(); // Apply the wait before the reserved continuation runs.
      if (boundary === "handoff") {
        f.engine.setRuntimeWait(f.task.id, [prerequisite.id], "Wait for the required fix", "hold-extra");
        f.engine.schedule();
      } else {
        const reply = await f.coordination.call("task.wait", { taskId: f.task.id, after: [prerequisite.id], reason: "Wait for the required fix", requestId: "hold-extra" });
        expect(reply.outcome).toBe("completed");
      }
      released.resolve();
      if (boundary === "queued") f.engine.setPoolPaused(false);
      if (boundary === "running") {
        expect(f.engine.s.extraValidations!.find(run => run.id === record.id)!.state).toBe("running");
        f.release(record); expect((await f.finished(record)).result).toBe("passed");
      }
      expect((await f.finished(following)).result).toBe("passed");
      if (boundary !== "running") {
        const pending = f.engine.extraValidations.get(record.requestId)!.validation as ExtraValidation;
        expect(pending.state).toBe("queued"); expect(pending.startedAt).toBeUndefined(); expect(pending.result).toBeUndefined();
        expect([pending.commit, pending.tree, pending.queueOrder, pending.queuedAt]).toEqual([record.commit, record.tree, record.queueOrder, record.queuedAt]);
        expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(0);
        expect(existsSync(record.snapshot)).toBe(false);
        expect(existsSync(join(f.service, "started", record.id))).toBe(false);
      }
      expect((await f.coordination.call("task.wait", { taskId: f.task.id, after: [], reason: "The required fix is available", requestId: "clear-extra" })).outcome).toBe("completed");
      expect((await f.finished(record)).result).toBe("passed");
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual(boundary === "running" ? [record.containerName, following.containerName] : [following.containerName, record.containerName]);
      expect(f.engine.checkQueue.running).toBe(0);
    } finally { released.resolve(); occupied(); restore(); await owner.stop(f.engine); }

  });

  });
});

  for (const held of [false, true]) it(`keeps cancellation final during deferred preparation cleanup${held ? " across held cleanup and restart" : ""}`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const record = await f.submit("cancel-deferred", ["probe", "pass"]);
    const copied = Promise.withResolvers<void>(), releaseCopy = Promise.withResolvers<void>();
    owner.onStop(() => releaseCopy.resolve());
    const cleaning = Promise.withResolvers<void>(), releaseCleanup = Promise.withResolvers<void>();
    owner.onStop(() => releaseCleanup.resolve());
    const container = f.engine.extraValidations["container"];
    const snapshot = container.snapshot.bind(container), cleanup = container.cleanup.bind(container);
    container.snapshot = async record => { await snapshot(record); copied.resolve(); await releaseCopy.promise; };
    container.cleanup = async record => { cleaning.resolve(); await releaseCleanup.promise; return held ? false : cleanup(record); };
    let replacement: Engine | undefined;
    try {
      f.engine.setPoolPaused(false); await copied.promise;
      f.engine.setPoolPaused(true); releaseCopy.resolve(); await cleaning.promise;
      f.engine.cancel(f.task.id); releaseCleanup.resolve();
      await waitFor(() => f.engine.extraValidations.active === 0, "cancelled preparation to settle");
      if (held) {
        expect(f.engine.checkQueue.running).toBe(1);
        expect(f.engine.s.extraValidations![0]!.state).toBe("held");
        await owner.stop(f.engine);
        replacement = owner.open(f.data, f.settings);
        patchContainer(replacement);
        await replacement.extraValidations.ready;
      }
      const current = replacement ?? f.engine;
      expect((current.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("stopped");
      expect(current.checkQueue.running).toBe(0); expect(current.checkQueue.waiting).toBe(0);
      current.setPoolPaused(false);
      expect(existsSync(join(f.service, "started")) ? readdirSync(join(f.service, "started")) : []).toEqual([]);
      expect(existsSync(record.snapshot)).toBe(false);
    } finally { releaseCopy.resolve(); releaseCleanup.resolve(); await (replacement ? owner.stop(replacement) : undefined); await owner.stop(f.engine); }

  });

  });
});
});
