import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeWaitHolds, runtimeWaitView, type CheckId } from "@petrina/core";
import { commandText } from "../src/checks.js";
import { executionFor } from "@petrina/orchestrator";
import { FAKE_AGENT, Fakes, git, makeProduct, makeWorld, remoteRef, removeDir, waitFor, type World } from "./support.js";

const worlds: World[] = [];
afterAll(() => worlds.forEach(world => removeDir(world.dir)));

/** Planning, build and review have settled; only the real delivery driver and its recovery run. */
async function fixture() {
  const world = await makeWorld("wait-release-notes-recovery", { version: "1.0.0" }); worlds.push(world);
  await git(world.remote, "update-ref", "refs/tags/v1.0.0", world.initial);
  world.setGitHub(state => state.releases.push({ tagName: "v1.0.0", url: "https://github.com/acme/demo/releases/tag/v1.0.0", publishedAt: "2025-01-01T00:00:00Z", isDraft: false, name: "v1.0.0", body: "The previous release" }));
  const notesHold = join(world.dir, "notes-hold"), log = join(world.dir, "checks.jsonl"), check = join(world.dir, "check.ts");
  writeFileSync(notesHold, "Hold the first release notes");
  world.setScript(script => { script.hold = { role: "release manager", title: "Deliver the approved improvement", file: notesHold }; });
  writeFileSync(check, `import { appendFileSync, existsSync } from "node:fs";
import { git } from ${JSON.stringify(import.meta.resolve("./commands.js"))};
const sha = await git(process.cwd(), "rev-parse", "HEAD");
appendFileSync(process.argv[2], JSON.stringify({ sha, fix: existsSync("required-fix.txt") }) + "\\n");`);
  const open = () => {
    const engine = world.start({ terminals: () => [], agentCommand: profile => [process.execPath, FAKE_AGENT, world.dir, `--script=${join(world.dir, "agents.json")}`, `--record-tool=${profile.toolId}`] });
    engine.schedule = () => {};
    // The real driver is intentionally tested. A broken synchronous retry must fail this bounded
    // regression instead of starving Bun's own timeout and the rest of the test worker forever.
    const deliver = engine["shipping"].deliver.bind(engine["shipping"]);
    let attempts = 0;
    engine["shipping"].deliver = (...args) => {
      if (++attempts > 8) throw new Error("Delivery repeatedly refused its own unfinished preparation");
      return deliver(...args);
    };
    return engine;
  };
  let engine = open();
  await engine.waitUntilReady();
  const productId = await engine.addProduct(world.clone);
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
  await engine["driver"]["prepare"](scope, signal);
  writeFileSync(join(scope.work.worktree!, "task-change.txt"), "The accepted task change\n");
  await git(scope.work.worktree!, "add", "."); await git(scope.work.worktree!, "commit", "-qm", "Improve the product");
  scope.work.report = { summary: "Improved the product", title: "Improve the product", changes: ["The approved improvement"], description: "The approved product improvement" };
  engine.setProductChecks(productId, [{ name: "Tests", command: commandText([process.execPath, check, log]) }]);
  expect(await engine["shipping"]["readyToShip"](scope, signal)).toBe("ready");
  scope.work.checkedSha = await git(scope.work.worktree!, "rev-parse", "HEAD");
  scope.work.checkedPatch = await engine["updates"].patch(scope);
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
      writeFileSync(join(world.clone, "required-fix.txt"), "The prerequisite fix\n");
      await git(world.clone, "add", "."); await git(world.clone, "commit", "-qm", "Land the required fix"); await git(world.clone, "push", "-q", world.remote, "main");
      return await git(world.clone, "rev-parse", "HEAD");
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
    async restart() {
      await engine.shutdown(); engine = open(); await engine.waitUntilReady();
      task = engine.task(id)!; scope = executionFor(task);
    },
    evidence: (): { sha: string; fix: boolean }[] => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)),
    fakes: new Fakes(world.dir),
  };
}

describe.concurrent("prerequisite waits during release notes recovery", () => {
  it("strictly refreshes every owner before restarting shared release-note previews at the delivery checkpoint", async () => {
    const f = await fixture();
    let first: Promise<void> | undefined;
    try {
      const task = f.task(), release = f.scope().work;
      const companion = { id: "companion", name: "Companion", path: await makeProduct(join(f.world.dir, "companion")), repo: "local/companion", tone: "blue" as const, defaultBranch: "main", delivery: "local" as const, remoteRefused: "Local delivery only", checks: [] };
      f.engine().s.products.push(companion);
      const worktree = join(f.world.dir, "companion-work");
      await git(companion.path, "worktree", "add", "-qb", "companion-task", worktree, "main");
      const baseSha = await git(worktree, "rev-parse", "HEAD");
      task.repositories = [
        Object.assign(release, { completedStages: ["build"], preparation: "ready" as const }),
        { productId: companion.id, delivery: "local", worktree, branch: "companion-task", base: "main", baseSha, completedStages: ["build"], preparation: "ready",
          source: { product: { ...companion }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: companion.repo, branch: "main" }, confirmed: true, initialSha: baseSha } },
      ];
      delete task.repository;
      task.leadProductId = release.productId; task.activeProductId = release.productId;
      task.stageIndex = 1;
      first = f.drive(); await f.notesStarted();
      // Shared notes are an internal agent of the checkpoint, not its coordinator role.
      expect(f.task().plan!.stages[f.task().stageIndex]!.roleId).toBe("coordinator");
      expect(f.task().journey!.at(-1)!.roleId).toBe("release-manager");
      const originalId = f.task().journey!.at(-1)!.id;
      f.hold(); await f.restart(); await first;
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
      expect(await git(restored.worktree!, "show", "HEAD:required-fix.txt")).toBe("The prerequisite fix");
      expect(restored.releasePreview?.notes).toContain("Land the required fix");
      expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      expect(f.task().journey!.filter(step => step.id === originalId)).toHaveLength(1);
      expect(f.fakes.openings("release manager")).toHaveLength(2);
      expect(f.world.github().releases).toHaveLength(1);
    } finally {
      f.unblock(); await f.engine().shutdown(); await first;
    }
  });

  for (const [recovery, how] of [["pause", "clear"], ["restart", "landed"], ["live", "clear"], ["no-wait", "clear"]] as const) it(`finishes notes and publishes the right source after ${recovery}`, async () => {
    const f = await fixture();
    let first: Promise<void> | undefined;
    try {
      first = f.drive(); await f.notesStarted();
      const original = f.task().journey!.at(-1)!;
      const originalId = original.id, originalInput = structuredClone(original.agentInputs);
      if (recovery !== "no-wait") {
        f.hold();
        expect(runtimeWaitView(f.task(), id => f.engine().taskDetails(id))?.phase).toBe("after-current-work");
      }
      if (recovery === "pause" || recovery === "no-wait") {
        f.engine().pause(f.id); await first;
      } else if (recovery === "restart") {
        await f.restart(); await first;
      }
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
        expect(await git(f.world.remote, "merge-base", released, latest)).toBe(latest);
        expect(await git(f.world.remote, "show", `${released}:required-fix.txt`)).toBe("The prerequisite fix");
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
  });
});
