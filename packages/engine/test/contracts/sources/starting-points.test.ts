import { afterAll, describe, expect, it } from "bun:test";
import * as gitOps from "@petrina/repositories/git";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { finish, headNow, itemOf, REPO, taskOf } from "../../support.js";
import { readLooseCommit, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { sourceWorlds, branch, planGate } from "../../fixtures/source-world.js";
import type { Engine } from "../../engine.js";
const fixtures = sourceWorlds();
afterAll(() => fixtures.close());

function refAt(gitDir: string, ref: string): string | undefined {
  try { return readFileSync(join(gitDir, ref), "utf8").trim(); }
  catch { return undefined; }
}

function noChecks(engine: Engine, productId: string): void {
  const product = engine.s.products.find(entry => entry.id === productId)!;
  product.checks = [];
  product.checksBy = "coordinator";
}

async function seedBranch(w: Parameters<typeof branch>[0], name = "release-2.x"): Promise<string> {
  const sha = await branch(w, "release-2.x");
  if (name !== "release-2.x") {
    for (const gitDir of [w.remote, join(w.clone, ".git")]) {
      rmSync(join(gitDir, "refs", "heads", "release-2.x"), { force: true });
      const target = join(gitDir, "refs", "heads", name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${sha}\n`);
    }
  }
  return sha;
}

async function seedPlanned(
  engine: Engine,
  planned: (engine: Engine, input: Parameters<Engine["addTask"]>[0], start?: "plan" | "builder") => Promise<string>,
  input: Parameters<Engine["addTask"]>[0],
): Promise<string> {
  noChecks(engine, input.productId);
  const id = await planned(engine, input, "builder");
  engine.setPoolPaused(true);
  const task = engine.task(id)!;
  task.plan!.stages = task.plan!.stages.filter(stage => stage.kind !== "review-chain");
  engine.commitNow(task);
  engine.setPoolPaused(false);
  return id;
}

async function seedPull(w: Parameters<typeof branch>[0], fork: boolean): Promise<{ sha: string; remote: string }> {
  const sha = await seedBranch(w, "review-work");
  const remote = fork ? join(w.dir, "fork.git") : w.remote;
  if (fork) {
    cpSync(w.remote, remote, { recursive: true });
    rmSync(join(w.remote, "refs", "heads", "review-work"), { force: true });
  }
  const prRef = join(w.remote, "refs", "pull", "7", "head");
  mkdirSync(dirname(prRef), { recursive: true });
  writeFileSync(prRef, `${sha}\n`);
  w.setGitHub((state) => {
    state.forks = fork ? { "contributor/demo": remote } : {};
    state.prs.push({ number: 7, url: `https://github.com/${REPO}/pull/7`, state: "OPEN", title: "Original PR title", body: "Original description", headRefName: "review-work", baseRefName: "main", headRefOid: sha, headRepository: { nameWithOwner: fork ? "contributor/demo" : REPO }, isCrossRepository: fork });
  });
  return { sha, remote };
}

describe.concurrent("one approved product and starting point",()=>{
for (const delivery of ["pull-request", "local"] as const) it(`starts from a branch and delivers with ${delivery}, keeping existing source commits`, async () => {
    await fixtures.world(`branch-${delivery}`, async ({ w, engine: withEngine, planned }) => {
    const source = await seedBranch(w);

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await seedPlanned(engine, planned, { productId, title: "A greeting", startFrom: { kind: "branch", name: "release-2.x" }, delivery, approvePlan: false });
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.source).toMatchObject({ initialSha: source, start: { kind: "branch", branch: "release-2.x" }, destination: { repo: REPO, branch: "release-2.x", mode: delivery } });
      const tested = refAt( join(w.clone, ".git"), `refs/heads/${task.branch!}`)!;
      expect(readLooseCommit(join(w.clone, ".git"), tested)?.parents[0]).toBe(source);
      expect(task.timeline.some((entry) => entry.text === "You approved the plan")).toBe(false);
      expect(task.plan?.stages.find((stage) => stage.roleId === "release-manager" && stage.kind === "do")?.title).toBe(delivery === "local" ? "Commit to release-2.x" : "Open a pull request");
      if (delivery === "pull-request") {
        expect(w.github().prs[0]?.baseRefName).toBe("release-2.x");
        expect(refAt(w.remote, "refs/heads/release-2.x")).toBe(source);
      } else {
        expect(refAt(w.remote, "refs/heads/release-2.x")).toBe(tested);
        expect(refAt(join(w.clone, ".git"), "refs/heads/release-2.x")).toBe(tested);
        expect(readFileSync(join(w.clone, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/main");
        expect(w.github().prs).toHaveLength(0);
      }
      expect(refAt(w.remote, "refs/heads/main")).toBe(w.initial);

    });
    });
  });
});

describe.concurrent("one approved product and starting point",()=>{
it("uses an exact branch name with Unicode and punctuation", async () => {
    await fixtures.world("exact-name", async ({ w, engine: withEngine, candidate }) => { const name = "release/été+2"; await seedBranch(w, name);
    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", startFrom: { kind: "branch", name }, delivery: "local" }, { checks: "none" });
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.source?.start.branch).toBe(name);
      expect(refAt(w.remote, `refs/heads/${name}`)).toBe(refAt(join(w.clone, ".git"), `refs/heads/${task.branch!}`));

    });
    });
  });
});

describe.concurrent("one approved product and starting point",()=>{
for (const fork of [false, true]) for (const link of [false]) it(`updates the original ${fork ? "fork" : "same-repository"} PR from a ${link ? "link" : "number"}, without folding its commits or creating another PR`, async () => {
    const forks: Record<string, string> = {};
    await fixtures.world(`pr-${fork}-${link}`, async ({ w, engine: withEngine }) => {
    const source = await seedPull(w, fork);
    forks["contributor/demo"] = source.remote;

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      noChecks(engine, productId);
      const id = engine.addTask({ productId, title: "A greeting", description: "[quick]", startFrom: { kind: "pull-request", value: link ? `https://github.com/${REPO}/pull/7` : "#7" } });
      const waiting = await planGate(engine, id);
      expect(taskOf(waiting, id).worktree).toBeUndefined();
      expect(taskOf(waiting, id).source).toBeUndefined();
      expect(taskOf(waiting, id).proposedSource?.destination.repo).toBe(fork ? "contributor/demo" : REPO);
      expect(await gitOps.linkedWorktrees(w.clone)).toHaveLength(0);
      expect(w.github().calls.some((args) => args[0] === "api")).toBe(false);
      engine.task(id)!.plan!.stages = engine.task(id)!.plan!.stages.filter(stage => stage.kind !== "review-chain");
      engine.approve(itemOf(waiting, id, "plan")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("pr-open"); expect(task.pr?.number).toBe(7);
      expect(task.statusLine).toStartWith("Updated PR #7");
      expect(task.plan?.stages.find((stage) => stage.roleId === "release-manager" && stage.kind === "do")?.title).toBe("Update PR #7");
      const tested = headNow(task.worktree!);
      expect(readWorktreeCommit(task.worktree!)?.parents[0]).toBe(source.sha);
      expect(task.source?.initialSha).toBe(source.sha);
      expect(refAt(source.remote, "refs/heads/review-work")).toBe(tested);
      expect(w.github().prs).toHaveLength(1);
      expect(w.github().prs[0]).toMatchObject({ title: "Original PR title", body: "Original description" });
      expect(w.github().calls.some((args) => args[0] === "pr" && ["create", "edit", "comment", "merge"].includes(args[1]!))).toBe(false);
      expect(w.script().releaseManagerPrompts ?? []).toHaveLength(0);
      for (const args of w.github().calls) if (args[0] === "pr") expect(args.slice(-2)).toEqual(["--repo", REPO]);
      expect(w.github().cwds?.every((cwd) => !cwd.startsWith(w.clone) && !cwd.startsWith(w.data))).toBe(true);

    });
    }, {}, forks);
  });
});
