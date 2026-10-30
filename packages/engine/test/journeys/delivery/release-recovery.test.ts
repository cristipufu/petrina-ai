import { acmeDemoProduct, installPreparedProduct } from "../../fixtures/prepared-product.js";
import * as gitOps from "@petrina/repositories/git";
import { installSharedWorkflowFastPaths, looseMergeBase, materializeCleanWorktree, materializePreparedWorktree, readLooseBlobInCommit } from "../../fixtures/shared-preparation.js";
import { privateWorldToolProbe } from "../../fixtures/world-tool-probe.js";
import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeWaitHolds, runtimeWaitView, type CheckId } from "@petrina/core";
import { commandInputText } from "../../../src/checks.js";
import type { Engine, EngineOptions } from "../../engine.js";
import { headNow } from "@petrina/test-support/repository-head";
import { createProductRepository } from "@petrina/test-support/repositories";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { fakeEngineSettings } from "../../fixtures/fake-agent-sessions.js";
import { nativeWorldFixtures, type NativeWorld } from "../../fixtures/native-worlds.js";
import { executionFor } from "@petrina/orchestrator";
import { Fakes, git, remoteRef, tempDir, waitFor } from "../../support.js";

const fixtures = nativeWorldFixtures();
const landSeeds = new Map<string, Promise<{ root: string; objectsDir: string; indexFile: string; sha: string }>>();
afterAll(async () => {
  const entries = await Promise.all([...landSeeds.values()]);
  landSeeds.clear();
  for (const entry of entries) rmSync(entry.root, { recursive: true, force: true });
  await fixtures.close();
});

function getLandSeed(clone: string, initial: string) {
  let pending = landSeeds.get(initial);
  if (!pending) {
    pending = (async () => {
      const root = tempDir("petrina-release-recovery-land-");
      const repo = join(root, "clone");
      cpSync(clone, repo, { recursive: true });
      rmSync(join(repo, ".git", "worktrees"), { recursive: true, force: true });
      writeFileSync(join(repo, "required-fix.txt"), "The prerequisite fix\n");
      await gitOps.commitChanges(repo, "Land the required fix");
      const sha = headNow(repo)!;
      return { root, objectsDir: join(repo, ".git", "objects"), indexFile: join(repo, ".git", "index"), sha };
    })();
    landSeeds.set(initial, pending);
  }
  return pending;
}

/** Planning, build and review have settled; only the real delivery driver and its recovery run. */
type ReleaseFixture = Awaited<ReturnType<typeof prepareRelease>>;
type ReleasePhase = (fixture: ReleaseFixture) => Promise<void | ReleasePhase>;
function configureEngine(engine: Engine) {
    installSharedWorkflowFastPaths(engine, { skipDriverPrepare: false, skipUpToDate: true, fastCheckCapture: true, fastCleanup: true, fastCheckpoints: true });
    engine.schedule = () => {};
    // The real driver is intentionally tested. A broken synchronous retry must fail this bounded
    // regression instead of starving Bun's own timeout and the rest of the test worker forever.
    const deliver = engine["shipping"].deliver.bind(engine["shipping"]);
    let attempts = 0;
    engine["shipping"].deliver = (...args) => {
      if (++attempts > 8) throw new Error("Delivery repeatedly refused its own unfinished preparation");
      return deliver(...args);
    };
}
async function fixture(body: ReleasePhase) {
  let current: ReleaseFixture | undefined, releaseNotes = () => {};
  return fixtures.world("wait-release-notes-recovery", async ({ world, engine: ownedEngine }) => {
  mkdirSync(join(world.remote, "refs", "tags"), { recursive: true });
  writeFileSync(join(world.remote, "refs", "tags", "v1.0.0"), `${world.initial}\n`);
  world.setGitHub(state => state.releases.push({ tagName: "v1.0.0", url: "https://github.com/acme/demo/releases/tag/v1.0.0", publishedAt: "2025-01-01T00:00:00Z", isDraft: false, name: "v1.0.0", body: "The previous release" }));
  const notesHold = join(world.dir, "notes-hold"), log = join(world.dir, "checks.jsonl"), check = join(world.dir, "check.ts");
  writeFileSync(notesHold, "Hold the first release notes");
  world.setScript(script => { script.hold = { role: "release manager", title: "Deliver the approved improvement", file: notesHold }; });
  writeFileSync(check, `import { appendFileSync, existsSync } from "node:fs";
import { headNow } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/repository-head"))};
const sha = headNow(process.cwd());
appendFileSync(process.argv[2], JSON.stringify({ sha, fix: existsSync("required-fix.txt") }) + "\\n");`);

    releaseNotes = () => rmSync(notesHold, { force: true });
    const fakes = new Fakes(world.dir);
    const options = (): EngineOptions => ({
      terminals: () => [],
      ...fakeEngineSettings(fakes, { recordTool: true, scriptPath: join(world.dir, "agents.json") }),
      toolProbe: privateWorldToolProbe(world),
      runCheckCommand: (req) => {
        if (req.argv[0] !== process.execPath || req.argv[1] !== check) return undefined;
        appendFileSync(req.argv[2]!, `${JSON.stringify({ sha: headNow(req.cwd), fix: existsSync(join(req.cwd, "required-fix.txt")) })}\n`);
        return { code: 0 };
      },
    });
    const next = await ownedEngine(async engine => { configureEngine(engine); current = await prepareRelease(world, engine, notesHold, log, check); return body(current); }, options());
    if (next) await ownedEngine(async engine => { await current!.reopened(engine); return next(current!); }, options());
  }, { version: "1.0.0" }, { stopPeers: () => releaseNotes() });
}
async function prepareRelease(world: NativeWorld, first: Engine, notesHold: string, log: string, check: string) {
  let engine = first;
  await engine.waitUntilReady();
  const productId = installPreparedProduct(engine, acmeDemoProduct(world.clone));
  const id = engine.addTask({ productId, title: "Deliver the approved improvement", delivery: "release", backlog: true });
  const prerequisite = engine.addTask({ productId, title: "Land the required fix", backlog: true });
  let task = engine.task(id)!;
  task.startedAt = 1; task.state = "running"; task.stageIndex = 2;
  task.plan = { rationale: "Only release preparation and publishing recovery are under test", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
    { id: "approval", title: "Approve delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
    { id: "ship", title: "Publish", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
  ] };
  let scope = executionFor(task);
  const signal = new AbortController().signal;
  scope.work.source = { ...await engine["sources"].resolve(task, { productId, delivery: "release", startFrom: { kind: "default" } }), confirmed: true };
  engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  engine.s.tools.forEach(tool => { tool.status = "ready"; });
  scope.work.report = { summary: "Improved the product", title: "Improve the product", changes: ["The approved improvement"], description: "The approved product improvement" };
  const seed = await materializePreparedWorktree(engine, scope, world.clone, "origin/main", world.initial, "task-change.txt", "The accepted task change\n");
  engine.setProductChecks(productId, [{ name: "Tests", command: commandInputText([process.execPath, check, log]) }]);
  expect(await engine["shipping"]["readyToShip"](scope, signal)).toBe("ready");
  scope.work.checkedSha = seed.head;
  scope.work.checkedPatch = seed.patch;
  task.stageIndex = 1; engine.gate(task, "delivery");
  await engine.approve(engine.s.inbox.find(item => item.taskId === id && item.kind === "delivery")!.id);
  const drive = () => { engine.startDriver(id); return engine.settling.get(id)!; };
  return {
    world, id, prerequisite, productId, drive,
    engine: () => engine, task: () => task, scope: () => scope,
    notesStarted: () => waitFor(() => existsSync(`${notesHold}.reached`) && !!task.agent && !!task.journey?.at(-1)?.agentInputs?.length, "the Release Manager to receive its notes input"),
    unblock: () => rmSync(notesHold, { force: true }),
    hold: () => engine.setRuntimeWait(id, [prerequisite], "The release must contain this fix", "hold-notes"),
    async land() {
      const seeded = await getLandSeed(world.clone, world.initial);
      cpSync(seeded.objectsDir, join(world.clone, ".git", "objects"), { recursive: true, force: true });
      cpSync(seeded.indexFile, join(world.clone, ".git", "index"));
      writeFileSync(join(world.clone, "required-fix.txt"), "The prerequisite fix\n");
      writeFileSync(join(world.clone, ".git", "refs", "heads", "main"), `${seeded.sha}\n`);
      cpSync(seeded.objectsDir, join(world.remote, "objects"), { recursive: true, force: true });
      writeFileSync(join(world.remote, "refs", "heads", "main"), `${seeded.sha}\n`);
      mkdirSync(join(world.clone, ".git", "refs", "remotes", "origin"), { recursive: true });
      writeFileSync(join(world.clone, ".git", "refs", "remotes", "origin", "main"), `${seeded.sha}\n`);
      return seeded.sha;
    },
    release(how: "clear" | "landed", latest: string) {
      if (how === "clear") engine.setRuntimeWait(id, [], "The prerequisite is available", "clear-notes");
      else {
        const required = engine.task(prerequisite)!;
        required.state = "done"; required.repository!.delivery = "local";
        required.repository!.landed = { branch: "main", sha: latest.slice(0, 7) };
        engine["driver"].syncRuntimeWaits();
      }
    },
    async stopForRestart() { await engine.shutdown(); },
    async reopened(current: Engine) {
      engine = current; configureEngine(engine); await engine.waitUntilReady();
      task = engine.task(id)!; scope = executionFor(task);
    },
    evidence: (): { sha: string; fix: boolean }[] => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)),
    fakes: new Fakes(world.dir),
  };
}

describe.concurrent("prerequisite waits during release notes recovery", () => {
  it("strictly refreshes every owner before restarting shared release-note previews at the delivery checkpoint", async () => {
    await fixture(async f => {

    let first: Promise<void> | undefined;

return setupWithCleanup(async () => {

      const task = f.task(), release = f.scope().work;
      const { path: companionPath, initialSha: baseSha } = await createProductRepository(join(f.world.dir, "companion"), { origin: "none" });
      const companion = { id: "companion", name: "Companion", path: companionPath, repo: "local/companion", tone: "blue" as const, defaultBranch: "main", delivery: "local" as const, remoteRefused: "Local delivery only", checks: [], checksBy: "coordinator" as const };
      f.engine().s.products.push(companion);
      const worktree = join(f.world.dir, "companion-work");
      task.repositories = [
        Object.assign(release, { completedStages: ["build"], preparation: "ready" as const }),
        { productId: companion.id, delivery: "local", worktree, branch: "companion-task", base: "main", baseSha, completedStages: ["build"], preparation: "ready",
          source: { product: { ...companion }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: companion.repo, branch: "main" }, confirmed: true, initialSha: baseSha } },
      ];
      delete task.repository;
      task.leadProductId = release.productId; task.activeProductId = release.productId;
      await materializeCleanWorktree(f.engine(), executionFor(task, companion.id), companion.path, "main", baseSha);
      task.stageIndex = 1;
      first = f.drive(); await f.notesStarted();
      // Shared notes are an internal agent of the checkpoint, not its coordinator role.
      expect(f.task().plan!.stages[f.task().stageIndex]!.roleId).toBe("coordinator");
      expect(f.task().journey!.at(-1)!.roleId).toBe("release-manager");
      const originalId = f.task().journey!.at(-1)!.id;
      f.hold(); await f.stopForRestart(); await first;
return async (f: ReleaseFixture) => {
try {

      const latest = await f.land(); f.release("clear", latest);
      const observed: { productId: string; fresh: boolean; required: boolean }[] = [];
      const update = f.engine()["updates"].upToDate.bind(f.engine()["updates"]);
      f.engine()["updates"].upToDate = (scope, signal, fresh = false, required = false) => {
        observed.push({ productId: scope.work.productId, fresh, required });
        return update(scope, signal, fresh, required);
      };
      f.unblock(); await f.drive();
      expect(f.task().error).toBeUndefined();
      expect(f.task().state).toBe("needs-you");
      expect(observed.slice(0, 2)).toEqual([
        { productId: release.productId, fresh: true, required: true },
        { productId: companion.id, fresh: true, required: true },
      ]);
      const restored = f.task().repositories!.find(work => work.productId === release.productId)!;
      expect(restored.baseSha).toBe(latest);
      expect(readFileSync(join(restored.worktree!, "required-fix.txt"), "utf8").trim()).toBe("The prerequisite fix");
      expect(restored.releasePreview?.notes).toContain("Land the required fix");
      expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      expect(f.task().journey!.filter(step => step.id === originalId)).toHaveLength(1);
      expect(f.fakes.openings("release manager")).toHaveLength(2);
      expect(f.world.github().releases).toHaveLength(1);

} finally {

      f.unblock(); await f.engine().shutdown(); await first;

}
};
}, async () => {

      f.unblock(); await f.engine().shutdown(); await first;

});
    });
  });

  for (const [recovery, how] of [["pause", "clear"], ["restart", "landed"], ["live", "clear"], ["no-wait", "clear"]] as const) it(`finishes notes and publishes the right source after ${recovery}`, async () => {
    await fixture(async f => {

    let first: Promise<void> | undefined;

return setupWithCleanup(async () => {

      first = f.drive(); await f.notesStarted();
      const original = f.task().journey!.at(-1)!;
      const originalId = original.id, originalInput = structuredClone(original.agentInputs);
      if (recovery !== "no-wait") {
        f.hold();
        expect(runtimeWaitView(f.task(), id => f.engine().taskDetails(id))?.phase).toBe("after-current-work");
      }

const continueWithCurrent: ReleasePhase = async (f: ReleaseFixture) => {
try {
      if (recovery === "pause" || recovery === "restart") {
        expect(f.task().agent).toBeUndefined();
        expect(runtimeWaitView(f.task(), id => f.engine().taskDetails(id))?.phase).toBe("active");
      }
      const latest = recovery !== "no-wait" ? await f.land() : undefined;
      if (latest) {
        f.release(how, latest);
        expect(runtimeWaitHolds(f.task())).toBe(false);
        expect(f.task().runtimeWait?.refreshPending).toBe(true);
      }
      // A zero-delay responsiveness signal must get a turn while the actual driver settles.
      let responsive = false;
      const timer = setTimeout(() => { responsive = true; }, 0);
      f.unblock();
      try {
        if (recovery === "live") await first;
        else {
          if (recovery === "pause" || recovery === "no-wait") f.engine().resume(f.id);
          await f.drive();
        }
      } finally { clearTimeout(timer); }
      expect(responsive).toBe(true);
      expect(f.task().error).toBeUndefined(); expect(f.task().state).toBe("done");
      expect(f.scope().work.release?.tag).toBe("v1.0.1");
      const released = (await remoteRef(f.world.remote, "refs/tags/v1.0.1"))!;
      expect(released).toBeTruthy();
      expect(f.evidence().some(run => run.sha === released && run.fix === !!latest)).toBe(true);
      expect(f.world.github().releases).toHaveLength(2);
      if (latest) {
        expect(looseMergeBase(f.world.remote, released, latest) ?? await git(f.world.remote, "merge-base", released, latest)).toBe(latest);
        expect(readLooseBlobInCommit(f.world.remote, released, "required-fix.txt")?.trim() ?? await git(f.world.remote, "show", `${released}:required-fix.txt`)).toBe("The prerequisite fix");
        expect(f.world.github().releases.at(-1)!.body).toContain("Land the required fix");
        expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      }
      expect(f.task().rounds).toEqual({});
      expect(f.task().journey!.filter(step => step.id === originalId)).toHaveLength(1);
      expect(f.task().journey!.find(step => step.id === originalId)!.agentInputs?.slice(0, originalInput?.length)).toEqual(originalInput);
      const notes = f.task().journey!.filter(step => step.roleId === "release-manager");
      expect(notes.flatMap(step => step.agentResults ?? [])).toHaveLength(recovery === "live" ? 2 : 1);
      const openings = f.fakes.openings("release manager");
      expect(openings).toHaveLength(2);
      const sessions = f.fakes.received("release manager").map(prompt => prompt.session);
      expect(f.fakes.opens().filter(opening => sessions.includes(opening.session)).every(opening => opening.how === "new")).toBe(true);

} finally {

      f.unblock(); await f.engine().shutdown(); await first;

}
};
      if (recovery === "pause" || recovery === "no-wait") {
        f.engine().pause(f.id); await first;
      } else if (recovery === "restart") {
        await f.stopForRestart(); await first;
return continueWithCurrent;
      }

return continueWithCurrent(f);
}, async () => {

      f.unblock(); await f.engine().shutdown(); await first;

});
    });
  });
});
