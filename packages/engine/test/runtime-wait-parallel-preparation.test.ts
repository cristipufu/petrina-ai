import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckId } from "@petrina/core";
import { Engine } from "./engine.js";
import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { FAKE_AGENT, Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** Only the real parallel review and its next checkpoint; every stand-in reports on a release signal. */
async function fixture(limit = 2) {
  const root = tempDir("petrina-wait-parallel-preparation-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ controlled: true, reopen: "resume" });
  const engine = new Engine(join(root, "data"), {
    agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir], toolPath: () => process.execPath,
  });
  engine.schedule = () => {};
  await engine.waitUntilReady();
  engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  engine.s.tools.forEach(tool => { tool.status = "ready"; });
  engine.s.pool.limit = limit;
  const path = await makeProduct(join(root, "product"));
  const product = { id: "p", name: "Product", path, repo: "local/product", tone: "blue" as const, defaultBranch: "main", remoteRefused: "Local delivery only", checks: [], checksBy: "coordinator" as const };
  engine.s.products.push(product);
  const id = engine.addTask({ productId: "p", title: "Review the current change", backlog: true });
  const prerequisite = engine.addTask({ productId: "p", title: "Land the required fix", backlog: true });
  const task = engine.task(id)!, scope = executionFor(task);
  const base = await git(path, "rev-parse", "HEAD"), branch = "task-change", worktree = join(root, "work");
  await git(path, "worktree", "add", "-qb", branch, worktree, "main");
  writeFileSync(join(worktree, "feature.txt"), "Accepted task work\n");
  await git(worktree, "add", "."); await git(worktree, "commit", "-qm", "Build the feature");
  Object.assign(scope.work, { worktree, branch, baseSha: base, base: "main", delivery: "local", report: { summary: "The feature is built", changes: [] },
    source: { product: { ...product }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true, initialSha: base } });
  task.startedAt = 1; task.state = "running"; task.stageIndex = 0;
  task.plan = { rationale: "Review the accepted code", plannerProfileId: "sol-high", stages: [
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"] },
    { id: "checkpoint", title: "Review completed", kind: "gate", gate: "design", roleId: "coordinator", profileIds: [] },
  ] };
  const prepared = Promise.withResolvers<void>(), releasePreparation = Promise.withResolvers<void>();
  const refresh = engine["turns"].refresh.bind(engine["turns"]);
  let preparationCalls = 0;
  engine["turns"].refresh = async (...args) => {
    // Together has already pinned its version and disposed old copies, but has not admitted a seat.
    if (preparationCalls++ === 0) { prepared.resolve(); await releasePreparation.promise; }
    return refresh(...args);
  };
  const copies: { seat: string; path: string; head: string; fix: boolean; base?: string }[] = [];
  const turns = engine["turns"], parallel = turns.parallel.bind(turns);
  turns.parallel = async <T>(...args: Parameters<typeof turns.parallel<T>>) => {
    copies.push({ seat: args[7]?.key ?? "", path: args[3], head: await git(args[3], "rev-parse", "HEAD"), fix: existsSync(join(args[3], "required-fix.txt")), base: scope.work.baseSha });
    return parallel<T>(...args);
  };
  const release = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
  const drive = () => {
    if (!engine.drivers.has(id) && !engine.settling.has(id)) engine.startDriver(id);
    return engine.settling.get(id)!;
  };
  return { engine, task, scope, base, fakes, copies, prepared, releasePreparation, drive, release,
    preparations: () => preparationCalls,
    hold() { engine.setRuntimeWait(id, [prerequisite], "The review needs the required fix", "parallel-hold"); engine["driver"].syncRuntimeWaits(); },
    async land() { writeFileSync(join(path, "required-fix.txt"), "The required fix\n"); await git(path, "add", "."); await git(path, "commit", "-qm", "Land the required fix"); return git(path, "rev-parse", "HEAD"); },
    end(how: "clear" | "landed", latest: string) {
      if (how === "clear") engine.setRuntimeWait(id, [], "The required code is now available", "parallel-clear");
      else { const required = engine.task(prerequisite)!; required.repository!.delivery = "local"; required.repository!.landed = { branch: "main", sha: latest }; required.state = "done"; engine["driver"].syncRuntimeWaits(); }
    },
    async reported(count: number) { await waitFor(() => fakes.received("code reviewer").length === count, `${count} parallel reviewer inputs`); },
    async finish(current: Promise<void>) {
      // Catch-up may already have re-entered through the ordinary scheduler after the first driver yielded.
      const active = engine.settling.get(id) ?? current;
      for (const prompt of fakes.received("code reviewer")) release(prompt.session);
      await active;
    },
    async close(current?: Promise<void>) { releasePreparation.resolve(); for (const prompt of fakes.received()) release(prompt.session); await engine.shutdown(); await current; },
  };
}

describe.concurrent("parallel review admission after prerequisite waits", () => {
  for (const how of ["clear", "landed", "held", "before", "none"] as const) it(`uses current prepared copies before any reviewer starts (${how})`, async () => {
    const f = await fixture();
    let current: Promise<void> | undefined;
    try {
      const rounds = structuredClone(f.task.rounds);
      let latest = f.base;
      if (how === "before") { f.hold(); latest = await f.land(); f.end("clear", latest); }
      current = f.drive(); await f.prepared.promise;
      expect(f.copies).toEqual([]);
      expect(f.fakes.received("code reviewer")).toEqual([]);
      if (how !== "none" && how !== "before") { f.hold(); latest = await f.land(); }
      if (how === "clear" || how === "landed") f.end(how, latest);
      const changes = structuredClone(f.task.runtimeWait?.changes);
      f.releasePreparation.resolve();
      // Returning through the ordinary driver is required before a newly prepared group can start.
      await waitFor(() => f.copies.length === 2 || !f.engine.drivers.has(f.task.id), "parallel preparation to yield or admit reviewers");
      if (how === "held") {
        await current;
        expect(f.copies).toEqual([]);
        expect(f.task.state).toBe("waiting");
        expect(f.task.hunt?.reported).toEqual({});
        f.end("clear", latest); current = f.drive();
      } else if (!f.copies.length) { await current; current = f.drive(); }
      await f.reported(2);
      expect(f.copies).toHaveLength(2);
      expect(new Set(f.copies.map(copy => copy.path)).size).toBe(2);
      for (const copy of f.copies) {
        expect(copy.fix).toBe(how !== "none");
        expect(copy.base).toBe(latest);
      }
      expect(f.task.rounds).toEqual(rounds);
      if (how === "clear" || how === "landed") expect(f.preparations()).toBe(2);
      expect(f.task.hunt?.input?.heads.p).toBe(f.copies[0]!.head);
      if (how !== "held") expect(f.task.runtimeWait?.changes).toEqual(changes);
      await f.finish(current);
      expect(f.task.error).toBeUndefined();
      expect(f.task.stageIndex).toBe(1);
      expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
      const reviews = f.task.journey!.filter(step => step.roleId === "code-reviewer");
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.agentInputs).toHaveLength(2);
      expect(reviews[0]!.agentResults).toHaveLength(2);
      expect(reviews[0]!.result?.findingsSettled).toBe(true);
      expect(f.fakes.received("code reviewer")).toHaveLength(2);
      expect(f.task.timeline.some(entry => /rethink|rounds used up|fresh.*wait/i.test(entry.text))).toBe(false);
    } finally { await f.close(current); }
  });

  it("finishes an already-admitted peer group on its original copies, then catches up once", async () => {
    const f = await fixture(1);
    let current: Promise<void> | undefined;
    try {
      current = f.drive(); await f.prepared.promise; f.releasePreparation.resolve(); await f.reported(1);
      const first = f.fakes.received("code reviewer")[0]!, originalHead = f.copies[0]!.head;
      f.hold(); const latest = await f.land(); f.release(first.session); await current;
      expect(f.copies).toHaveLength(1);
      expect(f.task.hunt?.reported).toEqual({ "0": true });
      const partial = f.task.journey!.findLast(step => step.roleId === "code-reviewer")!;
      const firstResult = structuredClone(partial.agentResults![0]);
      expect(partial.endedAt).toBeUndefined();
      expect(partial.result?.findingsSettled).toBeUndefined();
      f.end("clear", latest); current = f.drive(); await f.reported(2);
      expect(f.copies.map(copy => copy.head)).toEqual([originalHead, originalHead]);
      expect(f.copies.map(copy => copy.fix)).toEqual([false, false]);
      expect(f.scope.work.baseSha).toBe(f.base);
      expect(f.task.rounds.review ?? 1).toBe(1);
      expect(f.task.runtimeWait?.refreshPending).toBe(true);
      await f.finish(current);
      expect(f.task.error).toBeUndefined();
      expect(f.scope.work.baseSha).toBe(latest);
      expect(existsSync(join(f.scope.work.worktree!, "required-fix.txt"))).toBe(true);
      expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
      expect(f.task.journey!.filter(step => step.roleId === "code-reviewer")).toHaveLength(1);
      expect(partial.agentResults).toHaveLength(2);
      expect(partial.agentResults![0]).toEqual(firstResult);
      expect(partial.agentInputs).toHaveLength(2);
      expect(partial.result?.findingsSettled).toBe(true);
      expect(f.fakes.received("code reviewer").filter(prompt => prompt.session === first.session)).toHaveLength(1);
      expect(f.task.runtimeWait?.changes).toHaveLength(2);
      expect(f.task.timeline.some(entry => /rethink|rounds used up|fresh.*wait/i.test(entry.text))).toBe(false);
    } finally { await f.close(current); }
  });

  it("settles a reserved review during copy creation before updating its version", async () => {
    const f = await fixture(1);
    const reserved = Promise.withResolvers<void>(), releaseCopy = Promise.withResolvers<void>();
    const addCopy = gitOps.addCopy;
    let held = false;
    const copying = spyOn(gitOps, "addCopy").mockImplementation(async (...args) => {
      if (!held && args[1].startsWith(f.engine.dataDir)) { held = true; reserved.resolve(); await releaseCopy.promise; }
      return addCopy(...args);
    });
    let current: Promise<void> | undefined;
    try {
      current = f.drive(); await f.prepared.promise; f.releasePreparation.resolve(); await reserved.promise;
      expect(f.fakes.received("code reviewer")).toEqual([]);
      f.hold(); const latest = await f.land(); f.end("clear", latest);
      expect(f.task.runtimeWait?.refreshAfterStep).toBeDefined();
      releaseCopy.resolve(); await f.reported(1);
      const first = f.fakes.received("code reviewer")[0]!;
      f.release(first.session); await f.reported(2);
      expect(f.copies.map(copy => copy.fix)).toEqual([false, false]);
      expect(f.copies[0]!.head).toBe(f.copies[1]!.head);
      expect(f.task.rounds.review ?? 1).toBe(1);
      expect(f.scope.work.baseSha).toBe(f.base);
      await f.finish(current);
      expect(f.task.error).toBeUndefined();
      expect(f.task.stageIndex).toBe(1);
      expect(f.scope.work.baseSha).toBe(latest);
      expect(existsSync(join(f.scope.work.worktree!, "required-fix.txt"))).toBe(true);
      expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
      expect(f.task.runtimeWait?.changes).toHaveLength(2);
      const review = f.task.journey!.findLast(step => step.roleId === "code-reviewer")!;
      expect(review.agentInputs).toHaveLength(2);
      expect(review.agentResults).toHaveLength(2);
      expect(f.fakes.received("code reviewer").filter(prompt => prompt.session === first.session)).toHaveLength(1);
    } finally { releaseCopy.resolve(); copying.mockRestore(); await f.close(current); }
  });
});
