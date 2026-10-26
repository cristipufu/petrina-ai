import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeWaitHolds, runtimeWaitView, type CheckId, type DeliveryMode } from "@petrina/core";
import type { Engine } from "../../engine.js";
import { nativeWorldFixtures, type NativeWorld } from "../../fixtures/native-worlds.js";
import { Coordination } from "../../../src/coordination.js";
import { WaitingForUsage } from "../../../src/usage.js";
import { commandInputText } from "../../../src/checks.js";
import { executionFor } from "@petrina/orchestrator";
import { git, remoteRef, waitFor } from "../../support.js";

const fixtures = nativeWorldFixtures();
afterAll(fixtures.close);

/** Real approval, checks, source update and publication; planning, build and review have settled. */
type CandidateFixture = Awaited<ReturnType<typeof prepareCandidate>>;
type CandidatePhase = (fixture: CandidateFixture) => Promise<void | CandidatePhase>;
async function fixture(body: CandidatePhase, mode: DeliveryMode = "pull-request", prepare = true) {
  let current: CandidateFixture | undefined;
  return fixtures.world("wait-prepared-delivery", async ({ world, engine: ownedEngine }) => {
  if (mode === "release") {
    await git(world.remote, "update-ref", "refs/tags/v1.0.0", world.initial);
    world.setGitHub(state => state.releases.push({ tagName: "v1.0.0", url: "https://github.com/acme/demo/releases/tag/v1.0.0", publishedAt: "2025-01-01T00:00:00Z", isDraft: false, name: "v1.0.0", body: "The earlier release" }));
  }

    let next = await ownedEngine(async engine => { current = await prepareCandidate(world, engine, mode, prepare); return body(current); }, { terminals: () => [] });
    if (next) {
      const resume = next;
      next = await ownedEngine(async engine => { await current!.reopened(engine); return resume(current!); }, { terminals: () => [] });
    }
    if (next) {
      const resume = next;
      await ownedEngine(async engine => { await current!.reopened(engine); return resume(current!); }, { terminals: () => [] });
    }
  }, mode === "release" ? { version: "1.0.0" } : {}, { stopPeers: () => current?.releaseHeldChecks() });
}
async function prepareCandidate(world: NativeWorld, first: Engine, mode: DeliveryMode, prepare: boolean) {
  let engine = first;
  engine.schedule = () => {};
  const productId = await engine.addProduct(world.clone);
  const id = engine.addTask({ productId, title: "Deliver the approved improvement", delivery: mode, backlog: true });
  let task = engine.task(id)!;
  task.startedAt = 1; task.state = "running"; task.stageIndex = 2;
  task.plan = { rationale: "Only the delivery boundary is under test", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
    { id: "approval", title: "Approve delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
    { id: "ship", title: "Publish", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
  ] };
  const signal = new AbortController().signal;
  let scope = executionFor(task);
  scope.work.source = { ...await engine["sources"].resolve(task, { productId, delivery: mode, startFrom: { kind: "default" } }), confirmed: true };
  engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  engine.s.tools.forEach(tool => { tool.status = "ready"; });
  await engine["driver"]["prepare"](scope, signal);
  writeFileSync(join(scope.work.worktree!, "task-change.txt"), "The accepted task's change\n");
  await git(scope.work.worktree!, "add", "."); await git(scope.work.worktree!, "commit", "-qm", "Improve the product");
  scope.work.report = { summary: "Improved the product", title: "Improve the product", changes: ["An approved improvement"], description: "The approved product improvement" };
  const log = join(world.dir, "checks.jsonl"), script = join(world.dir, "check.ts");
  writeFileSync(script, `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { git } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/commands"))};
if (process.argv[3]) {
  writeFileSync(process.argv[3] + ".started", "The final check is running");
  while (!existsSync(process.argv[3] + ".release")) await Bun.sleep(10);
}
const sha = await git(process.cwd(), "rev-parse", "HEAD");
const ok = !existsSync("required-check-failure");
appendFileSync(process.argv[2], JSON.stringify({ sha, fix: existsSync("required-fix.txt"), ok }) + "\\n");
process.exit(ok ? 0 : 1);`);
  engine.setProductChecks(productId, [{ name: "Tests", command: commandInputText([process.execPath, script, log]) }]);
  expect(await engine["shipping"]["readyToShip"](scope, signal)).toBe("ready");
  scope.work.checkedSha = await git(scope.work.worktree!, "rev-parse", "HEAD");
  scope.work.checkedPatch = await engine["updates"].patch(scope);
  task.stageIndex = 1;
  engine.gate(task, "delivery");
  await engine.approve(engine.s.inbox.find(item => item.taskId === id && item.kind === "delivery")!.id);
  expect(scope.work.approvedSha).toBe(scope.work.checkedSha!);
  if (prepare) expect(await engine["shipping"]["prepare"](scope, task.plan.stages[2]!, signal)).toBe("ready");
  const before = await git(scope.work.worktree!, "rev-parse", "HEAD"), checkedBefore = evidence().length;
  const prerequisite = engine.addTask({ productId, title: "Land the required fix", backlog: true });
  function evidence(): { sha: string; fix: boolean; ok: boolean }[] {
    return readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  }
  const hold = () => engine.setRuntimeWait(id, [prerequisite], "This delivery needs the landed fix", "hold-before-publish");
  const land = async (failChecks = false) => {
    writeFileSync(join(world.clone, "required-fix.txt"), "The prerequisite's fix\n");
    if (failChecks) writeFileSync(join(world.clone, "required-check-failure"), "The integrated product must fail this check\n");
    await git(world.clone, "add", "."); await git(world.clone, "commit", "-qm", "Land the required fix");
    await git(world.clone, "push", "-q", world.remote, "main");
    return git(world.clone, "rev-parse", "HEAD");
  };
  const release = (how: "automatic" | "clear", latest: string) => {
    if (how === "automatic") {
      const required = engine.task(prerequisite)!;
      required.state = "done";
      required.repository!.delivery = "local";
      required.repository!.landed = { branch: "main", sha: latest.slice(0, 7) };
      engine["driver"].syncRuntimeWaits();
    } else engine.setRuntimeWait(id, [], "The fix is available", "clear-before-publish");
    expect(runtimeWaitHolds(task)).toBe(false);
  };
  const stopForRestart = async () => { engine.commitNow(); await engine.shutdown(); };
  const reopened = async (current: Engine) => {
    engine = current; engine.schedule = () => {};
    await engine.waitUntilReady();
    task = engine.task(id)!; scope = executionFor(task);
  };
  const refresh = () => engine["driver"]["refreshAfterWait"](task, signal);
  const publish = () => engine["shipping"].deliver(task, task.plan!.stages[2]!, signal);
  let releaseFinalCheck = () => {};
  const blockFinalChecks = () => {
    const gate = join(world.dir, "final-check");
    releaseFinalCheck = () => writeFileSync(`${gate}.release`, "Continue");
    engine.setProductChecks(productId, [{ name: "Tests", command: commandInputText([process.execPath, script, log, gate]) }]);
    return { started: () => waitFor(() => existsSync(`${gate}.started`), "the final check to start"), release: releaseFinalCheck };
  };
  return { world, productId, id, prerequisite, before, checkedBefore, hold, land, release, stopForRestart, reopened, refresh, publish, evidence, blockFinalChecks, releaseHeldChecks: () => releaseFinalCheck(), engine: () => engine, task: () => task, scope: () => scope };
}

async function expectFreshPublication(f: CandidateFixture, mode: DeliveryMode, latest: string) {
  const { work } = f.scope();
  const target = mode === "pull-request" ? `refs/heads/${work.branch}` : "refs/heads/main";
  const published = (await remoteRef(f.world.remote, target))!;
  expect(published).not.toBe(f.before);
  expect(await git(f.world.remote, "show", `${published}:required-fix.txt`)).toBe("The prerequisite's fix");
  expect(await git(f.world.remote, "merge-base", published, latest)).toBe(latest);
  expect(f.evidence().slice(f.checkedBefore).some(run => run.sha === published && run.fix && run.ok)).toBe(true);
  expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
  if (mode === "pull-request") {
    expect(await git(work.worktree!, "rev-parse", "HEAD")).toBe(published);
    expect(f.world.github().prs).toHaveLength(1);
  }
}

describe.concurrent("publishing prepared delivery after a prerequisite wait", () => {
  for (const [mode, how] of [["pull-request", "automatic"], ["pull-request", "clear"], ["local", "clear"], ["release", "clear"]] as const) it(`updates ${mode} before publishing when ${how} release happens inside the final check`, async () => {
    await fixture(async f => {

    const gate = f.blockFinalChecks();
    const delivery = f.publish().catch(error => error);
    try {
      await gate.started(); f.hold();
      const latest = await f.land(); f.release(how, latest); gate.release();
      expect(await delivery).toBe("continue");
      expect(f.world.github().prs).toHaveLength(0);
      expect(await remoteRef(f.world.remote, `refs/heads/${f.scope().work.branch}`)).toBeUndefined();
      expect(f.task().runtimeWait?.refreshPending).toBe(true);
      expect(await f.refresh()).toBe(false);
      expect(await f.publish()).toBe("stop");
      await expectFreshPublication(f, mode, latest);
    } finally { gate.release(); await delivery; await f.engine().shutdown(); }

    }, mode, false);
  });

  it("holds an unreleased wait after the running final check settles", async () => {
    await fixture(async f => {

    const gate = f.blockFinalChecks();
    const delivery = f.publish().catch(error => error);
    try {
      await gate.started(); f.hold(); gate.release();
      expect(await delivery).toBeInstanceOf(WaitingForUsage);
      expect(f.world.github().prs).toHaveLength(0);
      expect(f.evidence()).toHaveLength(f.checkedBefore + 1);
      expect(runtimeWaitHolds(f.task())).toBe(true);
    } finally { gate.release(); await delivery; await f.engine().shutdown(); }

    }, "pull-request", false);
  });

  it("ends a wait set during admitted publication when the task starts awaiting merge", async () => {
    await fixture(async f => {

    const shipping = f.engine()["shipping"];
    const publishStep = shipping["publishStep"].bind(shipping);
    let held = false;
    shipping["publishStep"] = (scope, signal, step, status, run) => publishStep(scope, signal, step, status, async () => {
      if (!held) {
        held = true; f.hold();
        expect(runtimeWaitView(f.task(), id => f.engine().taskDetails(id))?.phase).toBe("after-current-work");
      }
      return run();
    });

      f.engine().startDriver(f.id);
      await f.engine().settling.get(f.id);
      expect(held).toBe(true); expect(f.task().state).toBe("pr-open");
      expect(runtimeWaitHolds(f.task())).toBe(false);
      expect(f.task().runtimeWait?.releaseReason).toContain("Publishing finished");
      expect(f.task().runtimeWait?.changes).toHaveLength(1);
      const required = f.engine().task(f.prerequisite)!;
      required.startedAt = 1; required.state = "waiting";
      expect(f.engine().setRuntimeWait(f.prerequisite, [f.id], "Await this published task", "reverse-runtime")).toBe(true);
      const queued = f.engine().addTask({ productId: f.productId, title: "Wait before starting", backlog: true });
      f.engine().setAfter(queued, [f.id]);
      expect(f.engine().task(queued)?.after).toEqual([f.id]);
      f.engine().cancel(f.prerequisite);
      expect(runtimeWaitView(f.task(), id => f.engine().taskDetails(id))).toMatchObject({ held: false, decisionNeeded: false, phase: "released" });
      const coordination = new Coordination(f.engine());
      expect(await coordination.call("task.inspect", { taskId: f.id })).toMatchObject({ task: { waitKind: null } });
      const saved = structuredClone(f.task().runtimeWait);
      await f.stopForRestart();
return async (f: CandidateFixture) => {

      expect(f.task().runtimeWait).toEqual(saved);
      expect(f.world.github().prs).toHaveLength(1);


};
    });
  });

  it("keeps the paused-pool status specific to publishing for a task without a wait", async () => {
    await fixture(async f => {

    try {
      f.engine().setPoolPaused(true);
      const result = await f.publish().catch(error => error);
      expect(result).toBeInstanceOf(WaitingForUsage);
      expect((result as WaitingForUsage).words).toBe("Waiting for the pool to resume before publishing");
      expect(f.world.github().prs).toHaveLength(0);
    } finally { await f.engine().shutdown(); }

    });
  });

  for (const recovery of ["restart", "retry"] as const) it(`describes a held saved publication as waiting after ${recovery}, until actual recovery begins`, async () => {
    await fixture(async f => {


      f.scope().work.shipping!.step = "push";
      f.hold();

const continueWithCurrent: CandidatePhase = async (f: CandidateFixture) => {

      expect(runtimeWaitView(f.task(), id => f.engine().taskDetails(id))).toMatchObject({ held: true, phase: "active" });
      f.engine().startDriver(f.id); await f.engine().settling.get(f.id);
      expect(f.task().state).toBe("waiting");
      expect(f.task().agent).toBeUndefined(); expect(f.engine().drivers.has(f.id)).toBe(false);
      expect(f.scope().work.shipping?.step).toBe("push");
      expect(f.world.github().prs).toHaveLength(0);
      expect(runtimeWaitView(f.task(), id => f.engine().taskDetails(id))?.phase).toBe("active");
      f.engine().setRuntimeWait(f.id, [], "Resume the saved publication", "clear-saved-publication");
      expect(await f.publish()).toBe("stop");
      expect(f.world.github().prs).toHaveLength(1);
      expect(f.task().state).toBe("pr-open");


};
if (recovery === "restart") { await f.stopForRestart(); return continueWithCurrent; }
      else {
        f.engine().fail(f.id, new Error("The admitted publication stopped"));
        const item = f.engine().s.inbox.find(item => item.taskId === f.id && item.kind === "stuck")!;
        await f.engine().retry(item.id);
      }
return continueWithCurrent(f);
    });
  });

  it("keeps an ordinary no-wait prepared candidate and its current checks", async () => {
    await fixture(async f => {

    try {
      expect(await f.publish()).toBe("stop");
      expect(await remoteRef(f.world.remote, `refs/heads/${f.scope().work.branch}`)).toBe(f.before);
      expect(f.evidence()).toHaveLength(f.checkedBefore);
      expect(f.task().runtimeWait).toBeUndefined();
      expect(f.world.github().prs).toHaveLength(1);
    } finally { await f.engine().shutdown(); }

    });
  });

  for (const how of ["automatic", "clear"] as const) it(`rechecks and publishes the current PR candidate after ${how} release`, async () => {
    await fixture(async f => {

    try {
      f.scope().work.shipping!.moves = 1;
      f.scope().work.shipping!.failures = 1;
      f.hold(); const latest = await f.land(); f.release(how, latest);
      expect(await f.refresh()).toBe(false);
      expect(f.scope().work.shipping).toEqual({ moves: 1, failures: 1 });
      expect(await f.publish()).toBe("stop");
      await expectFreshPublication(f, "pull-request", latest);
    } finally { await f.engine().shutdown(); }

    });
  });

  it("preserves the required re-preparation over restart and pause", async () => {
    await fixture(async f => {


      f.hold(); f.engine().pause(f.id); await f.stopForRestart();
return async (f: CandidateFixture) => {

      expect(f.scope().work.shipping?.prepared?.tested).toBe(f.before);
      const latest = await f.land(); f.release("clear", latest);
      f.engine().resume(f.id);
      expect(await f.refresh()).toBe(false);
      await f.stopForRestart();
return async (f: CandidateFixture) => {

      expect(f.scope().work.shipping?.prepared).toBeUndefined();
      expect(await f.publish()).toBe("stop");
      await expectFreshPublication(f, "pull-request", latest);


};
};
    });
  });

  it("keeps the before-preparation PR path on the same current-code check boundary", async () => {
    await fixture(async f => {

    try {
      f.hold(); const latest = await f.land(); f.release("clear", latest);
      expect(await f.refresh()).toBe(false);
      expect(await f.publish()).toBe("stop");
      await expectFreshPublication(f, "pull-request", latest);
    } finally { await f.engine().shutdown(); }

    }, "pull-request", false);
  });

  for (const mode of ["local", "release"] as const) it(`preserves ${mode} preparation rules when source moves during the wait`, async () => {
    await fixture(async f => {

    try {
      f.hold(); const latest = await f.land(); f.release("clear", latest);
      expect(await f.refresh()).toBe(false);
      const first = await f.publish();
      if (first === "continue") expect(await f.publish()).toBe("stop");
      await expectFreshPublication(f, mode, latest);
      if (mode === "release") {
        expect(f.world.github().releases).toHaveLength(2);
        const messages = (await git(f.world.remote, "log", "--format=%s", `${latest}..main`)).split("\n");
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatch(/^Release v/);
        expect(messages[1]).toBe("Improve the product");
        expect(f.world.script().releaseManagerPrompts).toHaveLength(2);
        expect(f.world.github().releases.at(-1)!.body).toContain("Land the required fix");
      }
    } finally { await f.engine().shutdown(); }

    }, mode);
  });

  it("asks for approval again if the candidate changes after the wait update", async () => {
    await fixture(async f => {

    try {
      f.hold(); const latest = await f.land(); f.release("clear", latest);
      expect(await f.refresh()).toBe(false);
      writeFileSync(join(f.scope().work.worktree!, "unapproved.txt"), "A different candidate needs a new approval\n");
      await git(f.scope().work.worktree!, "add", "."); await git(f.scope().work.worktree!, "commit", "-qm", "Change the approved work");
      expect(await f.publish()).toBe("continue");
      expect(f.task().stageIndex).toBe(1);
      expect(f.scope().work.approvedSha).toBeUndefined();
      expect(f.world.github().prs).toHaveLength(0);
      expect(await remoteRef(f.world.remote, `refs/heads/${f.scope().work.branch}`)).toBeUndefined();
    } finally { await f.engine().shutdown(); }

    });
  });

  it("does not publish a prepared PR when the newly integrated source fails its required checks", async () => {
    await fixture(async f => {

    try {
      f.hold(); const latest = await f.land(true); f.release("clear", latest);
      expect(await f.refresh()).toBe(false);
      expect(await f.publish()).toBe("continue");
      expect(f.evidence().slice(f.checkedBefore).some(run => run.fix && !run.ok)).toBe(true);
      expect(f.world.github().prs).toHaveLength(0);
      expect(await remoteRef(f.world.remote, `refs/heads/${f.scope().work.branch}`)).toBeUndefined();
      expect(f.scope().work.approvedSha).toBeUndefined();
      expect(f.task().stageIndex).toBeLessThan(2);
    } finally { await f.engine().shutdown(); }

    });
  });
});
