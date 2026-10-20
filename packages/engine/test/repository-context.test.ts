import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as gitOps from "../src/git.js";
import { Cleanup } from "../src/cleanup.js";
import { detachRepositoryState, executionFor } from "../src/repository-context.js";
import { Learnings } from "../src/learnings.js";
import { git, makeWorld, removeDir, waitFor, type World } from "./support.js";

const worlds: World[] = [];
afterAll(() => worlds.forEach((world) => removeDir(world.dir)));

async function fixture(name: string) {
  const first = makeWorld(`context-first-${name}`), second = makeWorld(`context-second-${name}`);
  worlds.push(first, second);
  const start = () => first.start({ agentCommand: () => undefined, codexCommand: null, grokCommand: null, antigravityCommand: null, terminals: () => [] });
  const engine = start();
  engine.setPoolPaused(true);
  engine.schedule = () => {};
  const products = [first, second].map((world, index) => ({ id: index ? "second" : "first", name: index ? "Second" : "First", repo: index ? "acme/second" : "acme/first", path: world.clone, tone: "blue" as const }));
  engine.s.products.push(...products);
  const id = engine.addTask({ productId: "first", title: "Keep each repository's execution state", backlog: true });
  const task = engine.task(id)!;
  task.repositories = products.map((product) => ({ productId: product.id, worktree: product.path, delivery: "local", branch: `task-${product.id}`, report: { summary: `${product.id} report`, changes: [] }, builderSession: { stageId: "build", profileId: "sol-high", toolId: "codex", model: "sol", sessionId: `${product.id}-conversation` }, completedStages: [] }));
  task.activeProductId = "first";
  detachRepositoryState(task);
  return { engine, start, task, id };
}

describe("explicit repository execution contexts", () => {
  it("inspects hand changes across products concurrently and records every result in product order", async () => {
    const { engine, task } = await fixture("hand-change-reads");
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    const checks: { path: string; resolve: (problems: string[]) => void }[] = [], heads: { path: string; resolve: (sha: string) => void }[] = [];
    const check = spyOn(gitOps, "tamperCheck").mockImplementation((path) => new Promise((resolve) => checks.push({ path, resolve })));
    const head = spyOn(gitOps, "head").mockImplementation((path) => new Promise((resolve) => heads.push({ path, resolve })));
    let pending: Promise<void> | undefined;
    try {
      task.plan = { rationale: "Review hand changes", plannerProfileId: "sol-high", stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"] }] };
      task.stageIndex = 0;
      const products = ["second", "first"], paths = products.map((id) => executionFor(task, id).work.worktree!);
      pending = engine["takeover"]["reviewHandChanges"](task, products);
      expect(checks.map((read) => read.path)).toEqual(paths);
      expect(heads.map((read) => read.path)).toEqual(paths);
      checks[1]!.resolve(["A test was removed"]); heads[1]!.resolve("a".repeat(40));
      await Promise.resolve();
      expect(task.findings).toEqual([]);
      checks[0]!.resolve(["A test was skipped"]); heads[0]!.resolve("b".repeat(40));
      await pending;
      expect(task.findings.map((finding) => [finding.text, finding.productIds])).toEqual([["A test was skipped", ["second"]], ["A test was removed", ["first"]]]);
      expect(executionFor(task, "first").work.tamper?.sha).toBe("a".repeat(40));
      expect(executionFor(task, "second").work.tamper?.sha).toBe("b".repeat(40));
      expect(task.handChanges).toBe(true);
      expect(task.rereview).toBe("review");
    } finally {
      for (const read of checks) read.resolve([]); for (const read of heads) read.resolve("a".repeat(40));
      await pending?.catch(() => {}); check.mockRestore(); head.mockRestore(); await engine.shutdown();
    }
  });

  it("reuses original version contents and reads each committed target once while validating a release", async () => {
    const { engine, task } = await fixture("release-version-reads");
    const scope = executionFor(task, "first"), path = scope.work.worktree!;
    const files = [
      { file: "package.json", text: '{"name":"demo","version":"1.0.0"}\n', version: "1.0.0" },
      { file: "Cargo.toml", text: '[package]\nname = "demo"\nversion = "1.0.0"\n', version: "1.0.0" },
    ];
    const lock = 'version = 3\n\n[[package]]\nname = "demo"\nversion = "1.0.0"\n';
    for (const file of files) writeFileSync(join(path, file.file), file.text);
    writeFileSync(join(path, "Cargo.lock"), lock);
    git(path, "add", "."); git(path, "commit", "-qm", "Record version files");
    const start = git(path, "rev-parse", "HEAD");
    scope.work.shipping = { start, version: "1.0.1", tag: "v1.0.1", moves: 0, failures: 0 };
    const read = spyOn(gitOps, "fileAt");
    try {
      const tested = await engine["shipping"]["setVersion"](scope, files);
      expect(tested).not.toBe(start);
      for (const file of files) {
        expect(read.mock.calls.filter(([, sha, name]) => sha === start && name === file.file)).toHaveLength(0);
        expect(read.mock.calls.filter(([, sha, name]) => sha === tested && name === file.file)).toHaveLength(1);
        expect(git(path, "show", `${tested}:${file.file}`)).toContain("1.0.1");
      }
      expect(read.mock.calls.filter(([, sha, name]) => sha === start && name === "Cargo.lock")).toHaveLength(1);
      expect(read.mock.calls.filter(([, sha, name]) => sha === tested && name === "Cargo.lock")).toHaveLength(1);
      expect(git(path, "show", `${tested}:Cargo.lock`)).toContain('version = "1.0.1"');
      expect(git(path, "diff", "--name-only", start, tested).split("\n").sort()).toEqual(["Cargo.lock", "Cargo.toml", "package.json"]);
    } finally { read.mockRestore(); await engine.shutdown(); }
  });

  it("resolves shared source rows concurrently, retaining their order and independent errors", async () => {
    const { engine, task } = await fixture("source-validation");
    const sources = engine["sources"];
    const choices = ["first", "second"].map((productId) => ({ productId, startFrom: { kind: "default" as const }, delivery: "local" as const }));
    const replies: { choice: string; resolve: (value: Awaited<ReturnType<typeof sources.resolve>>) => void; reject: (reason: Error) => void }[] = [];
    const resolve = spyOn(sources, "resolve").mockImplementation((_task, choice) => new Promise((resolve, reject) => replies.push({ choice: choice.productId, resolve, reject })));
    let pending: Promise<void> | undefined;
    try {
      pending = sources.propose(task, choices, true);
      expect(replies.map((reply) => reply.choice)).toEqual(["first", "second"]);
      const product = engine.s.products.find((product) => product.id === "second")!;
      replies[1]!.resolve({ product, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: false });
      await Promise.resolve();
      expect(task.workValidating).toBe(true);
      replies[0]!.reject(new Error("The first branch is unavailable."));
      await pending;
      expect(task.workRows!.map((row) => row.choice.productId)).toEqual(["first", "second"]);
      expect(task.workRows![0]!.error).toBe("The first branch is unavailable.");
      expect(task.workRows![1]!.source?.product.id).toBe("second");
      expect(task.workRows![1]!.error).toBeUndefined();
      expect(task.workError).toBe("The first branch is unavailable.");
      expect(task.workValidating).toBe(false);
    } finally {
      for (const reply of replies) reply.reject(new Error("Test closed"));
      await pending?.catch(() => {}); resolve.mockRestore(); await engine.shutdown();
    }
  });

  it("rejects duplicate repository rows after concurrent validation finishes", async () => {
    const { engine, task } = await fixture("duplicate-sources");
    const sources = engine["sources"], product = engine.s.products[0]!;
    const resolve = spyOn(sources, "resolve").mockImplementation(async (_task, choice) => ({ product: { ...product, id: choice.productId, repo: choice.productId === "first" ? product.repo : product.repo.toUpperCase() }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: false }));
    try {
      await sources.propose(task, ["first", "second"].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "local" })), true);
      expect(task.workRows![0]!.error).toBeUndefined();
      expect(task.workRows![1]!.error).toContain("already included");
      expect(task.workError).toContain("already included");
    } finally { resolve.mockRestore(); await engine.shutdown(); }
  });

  it("keeps a newer source proposal when older parallel reads finish late", async () => {
    const { engine, task } = await fixture("superseded-sources");
    const sources = engine["sources"];
    const replies: (() => void)[] = [];
    const resolve = spyOn(sources, "resolve").mockImplementation((_task, choice) => {
      const product = engine.s.products.find((product) => product.id === choice.productId)!;
      const result = { product, start: { kind: "default" as const, branch: "main" }, destination: { mode: "local" as const, kind: "branch" as const, repo: product.repo, branch: "main" }, confirmed: false };
      return choice.reason === "old" ? new Promise((resolve) => replies.push(() => resolve(result))) : Promise.resolve(result);
    });
    let pending: Promise<void> | undefined;
    try {
      pending = sources.propose(task, ["first", "second"].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "local", reason: "old" })), true);
      expect(replies).toHaveLength(2);
      await sources.propose(task, [{ productId: "second", startFrom: { kind: "default" }, delivery: "local", reason: "new" }], true);
      const latest = structuredClone(task.workRows);
      for (const reply of replies) reply();
      await pending;
      expect(task.workRows).toEqual(latest);
      expect(task.workRows).toHaveLength(1);
      expect(task.workError).toBeUndefined();
      expect(task.workValidating).toBe(false);
    } finally { for (const reply of replies) reply(); await pending?.catch(() => {}); resolve.mockRestore(); await engine.shutdown(); }
  });

  it("reads shared PR states concurrently and ignores late replies after a driver starts", async () => {
    const { engine, task } = await fixture("parallel-pr-reads");
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    task.state = "pr-open";
    for (const [index, work] of task.repositories!.entries()) {
      const product = engine.s.products.find((product) => product.id === work.productId)!;
      work.source = { product, confirmed: true, start: { kind: "default", branch: "main" }, destination: { mode: "pull-request", repo: product.repo, branch: "main", kind: "new-pr" } };
      work.pr = { number: index + 1, url: "https://example.test/pr", state: "open", openedAt: 1 };
    }
    let closing = false, pending: Promise<void> | undefined;
    const replies: ((value: Awaited<ReturnType<typeof gitOps.prState>>) => void)[] = [];
    const read = spyOn(gitOps, "prState").mockImplementation(() => closing ? Promise.resolve("open") : new Promise((resolve) => replies.push(resolve)));
    try {
      pending = engine["shipping"].pollPullRequests();
      expect(replies).toHaveLength(2);
      engine.drivers.set(task.id, new AbortController());
      replies[0]!("merged"); replies[1]!("closed");
      await pending;
      expect(task.repositories!.map((work) => work.pr!.state)).toEqual(["open", "open"]);
      expect(task.state as string).toBe("pr-open");
    } finally {
      closing = true; for (const reply of replies) reply("open");
      await pending?.catch(() => {}); engine.drivers.delete(task.id); read.mockRestore(); await engine.shutdown();
    }
  });

  it("observes check inputs once per gate and rechecks freshness instead of trusting a saved current flag", async () => {
    const { engine, task } = await fixture("check-observations");
    const probe = spyOn(gitOps, "worktreeStatus");
    try {
      engine.setPoolPaused(false);
      const scope = executionFor(task, "first"), checks = engine["checks"], signal = new AbortController().signal;
      const commands = [{ name: "Quick check", argv: [process.execPath, "-e", "console.log('Checked')"] }];
      engine.s.products.find((product) => product.id === "first")!.checks = commands;
      expect(await checks.failing(scope, signal, commands)).toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(await checks.failing(scope, signal, commands)).toBe(false);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(scope.work.checks!.current).toBe(true);
      writeFileSync(join(scope.work.worktree!, "README.md"), "A tracked change after the checks\n");
      expect(await checks.current(scope)).toBe(false);
      expect(probe).toHaveBeenCalledTimes(3);
    } finally { probe.mockRestore(); await engine.shutdown(); }
  });

  it("keeps bound owners and canonical state through snapshots, saves and restart", async () => {
    const f = await fixture("snapshots");
    let engine = f.engine;
    try {
      const first = executionFor(f.task, "first"), second = executionFor(f.task, "second");
      first.work.checkReturns = 1;
      f.task.activeProductId = "second";
      const before = JSON.stringify(f.task);
      expect(engine.activeState().tasks.find((task) => task.id === f.id)!.worktree).toBeUndefined();
      expect(engine.getState().tasks.find((task) => task.id === f.id)!.worktree).toBe(second.work.worktree);
      expect(engine.windowState().tasks.find((task) => task.id === f.id)!.report?.summary).toBe("second report");
      expect(engine.taskDetails(f.id)!.builderSession?.sessionId).toBe("second-conversation");
      expect(JSON.stringify(f.task)).toBe(before);
      first.work.report!.summary = "First finished while the second product was selected";
      engine.commitNow();
      const saved = engine.store.load()!.tasks.find((task) => task.id === f.id)!;
      expect(saved.worktree).toBeUndefined();
      expect(saved.report).toBeUndefined();
      expect(saved.repositories!.map((work) => work.report!.summary)).toEqual([first.work.report!.summary, "second report"]);
      expect(() => executionFor(f.task, "outside")).toThrow("outside the approved task");
      await engine.shutdown();
      engine = f.start();
      const task = engine.task(f.id)!;
      expect(Object.hasOwn(task, "worktree")).toBe(false);
      expect(Object.hasOwn(task, "builderSession")).toBe(false);
      expect(task.repositories!.map((work) => work.builderSession!.sessionId)).toEqual(["first-conversation", "second-conversation"]);
      expect(task.repositories!.map((work) => work.checkReturns)).toEqual([1, undefined]);
      expect(engine.taskDetails(f.id)!.branch).toBe("task-second");
    } finally { await engine.shutdown(); }
  });

  it("finishes a queued check against its bound owner after the task's current product changes", async () => {
    const { engine, task } = await fixture("queued-check");
    let release: (() => void) | undefined;
    let pending: Promise<number> | undefined;
    try {
      engine.setPoolPaused(false);
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"];
      const signal = new AbortController().signal;
      release = await checks["turnToRun"](second, signal);
      pending = checks.runProductChecks(first, [{ name: "First product only", argv: [process.execPath, "-e", "console.error('Failure from the first product'); process.exit(1)"] }], signal);
      await waitFor(() => checks["line"].length === 1, "the first product's check to queue");
      writeFileSync(join(first.work.worktree!, "queued-change.txt"), "Committed while checks waited\n");
      git(first.work.worktree!, "add", "."); git(first.work.worktree!, "commit", "-qm", "Keep the change made while checks waited");
      const queuedHead = await gitOps.head(first.work.worktree!);
      const hook = join(first.work.worktree!, ".git", "hooks", "commit-msg");
      writeFileSync(hook, "#!/bin/sh\nexit 0\n"); chmodSync(hook, 0o755);
      task.activeProductId = "second";
      engine.getState(); engine.windowState(); engine.taskDetails(task.id); engine.commitNow();
      release(); release = undefined;
      expect(await pending).toBe(1);
      expect(await gitOps.head(first.work.worktree!)).toBe(queuedHead);
      expect(engine.s.products.find((product) => product.id === "first")!.hooks).toEqual(["commit-msg"]);
      expect(first.work.checks!.results[0]!.output).toContain("Failure from the first product");
      expect(second.work.checks).toBeUndefined();
      expect(Object.hasOwn(task, "checks")).toBe(false);
      expect(task.findings.filter((finding) => finding.raisedBy === "petrina").map((finding) => finding.productIds)).toEqual([["first"]]);
      expect(task.timeline.filter((line) => line.text.includes("First product only")).length).toBeGreaterThan(0);
      expect(task.timeline.filter((line) => line.text.includes("First product only")).every((line) => line.productId === "first")).toBe(true);
      expect(engine.taskDetails(task.id)!.checks).toBeUndefined();
      engine.save();
      expect(engine.store.load()!.tasks.find((entry) => entry.id === task.id)!.repositories![0]!.checks!.results[0]!.ok).toBe(false);
    } finally { release?.(); await pending?.catch(() => {}); await engine.shutdown(); }
  });

  it("cleans each included and excluded repository's review copies once using its own clone", async () => {
    const { engine, task } = await fixture("cleanup-roots");
    try {
      await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
      task.state = "cancelled";
      task.excludedRepositories = [{ ...structuredClone(task.repositories![0]!), productId: "excluded" }];
      const works = [...task.repositories!, ...task.excludedRepositories];
      for (const work of works) {
        const product = engine.s.products.find((product) => product.id === work.productId) ?? engine.s.products[0]!;
        work.source = { product: { ...product, id: work.productId }, confirmed: true, start: { kind: "default", branch: "main" }, destination: { mode: "local", repo: product.repo, branch: "main", kind: "branch" } };
        work.worktree = join(engine.dataDir, "worktrees", work.productId, task.id);
      }
      const copies = spyOn(gitOps, "removeFinishedCopies").mockResolvedValue(true);
      const main = spyOn(gitOps, "removeWorktree").mockResolvedValue(true);
      try {
        await new Cleanup(engine).removeCopy(task.id);
        expect(copies.mock.calls).toEqual(works.map((work) => [work.source!.product.path!, join(engine.dataDir, "worktrees", work.productId, `${task.id}.copies`)]));
        expect(main.mock.calls).toEqual(works.map((work) => [work.source!.product.path!, work.worktree!]));
        expect(works.every((work) => work.cleanup?.reviewCopiesRemovedAt !== undefined)).toBe(true);
      } finally { copies.mockRestore(); main.mockRestore(); }
    } finally { await engine.shutdown(); }
  });

  it("groups a shared reviewer's companion lessons and reads only their repository once", async () => {
    const { engine, task } = await fixture("named-learning");
    const read = spyOn(gitOps, "fileAt");
    try {
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const learnings = new Learnings(engine);
      const texts = ["Use the second product's focused check for its UI changes.", "The second product's fixtures live beside its tests."];
      await learnings.note(first, [...texts.map((text) => ({ productId: "second", text })), { productId: "second", text: texts[0]! }, "An unassigned shared lesson stays with the task."], "code-reviewer", "sol-high");
      expect(first.work.lessons).toBeUndefined();
      expect(second.work.lessons?.map((lesson) => lesson.text)).toEqual(texts);
      expect(task.sharedLessons?.map((lesson) => lesson.text)).toEqual(["An unassigned shared lesson stays with the task."]);
      expect(read.mock.calls.filter(([, , file]) => file === "AGENTS.md")).toEqual([[second.work.worktree!, "HEAD", "AGENTS.md"]]);
      expect(Object.hasOwn(task, "lessons")).toBe(false);
    } finally { read.mockRestore(); await engine.shutdown(); }
  });

  it("keeps a single repository's saved execution separate from its public task view", async () => {
    const world = makeWorld("canonical-single"); worlds.push(world);
    const start = () => world.start({ agentCommand: () => undefined, codexCommand: null, grokCommand: null, antigravityCommand: null, terminals: () => [] });
    let engine = start(); engine.setPoolPaused(true);
    try {
      const productId = await engine.addProduct(world.clone);
      const id = engine.addTask({ productId, title: "One canonical execution record", backlog: true });
      const task = engine.task(id)!;
      const { work } = executionFor(task);
      work.report = { summary: "Persisted only on the repository", changes: [] };
      work.checkReturns = 2;
      engine.commitNow();
      const saved = engine.store.load()!.tasks.find((task) => task.id === id)!;
      expect(saved.report).toBeUndefined();
      expect(saved.repository!.report?.summary).toBe("Persisted only on the repository");
      expect(engine.taskDetails(id)!.repository).toBeUndefined();
      expect(engine.windowState().tasks.find((task) => task.id === id)!.report?.summary).toBe("Persisted only on the repository");
      await engine.shutdown(); engine = start();
      expect(Object.hasOwn(engine.task(id)!, "report")).toBe(false);
      expect(executionFor(engine.task(id)!).work.checkReturns).toBe(2);
      expect(engine.taskDetails(id)!.report?.summary).toBe("Persisted only on the repository");
    } finally { await engine.shutdown(); }
  });

  it("imports an existing saved cursor once without retaining another writable copy", async () => {
    const f = await fixture("saved-cursor");
    let engine = f.engine;
    try {
      f.task.activeProductId = "second";
      Object.assign(f.task, { branch: "latest-saved-second", report: { summary: "Latest second report from the previous engine", changes: [] } });
      engine.commitNow();
      await engine.shutdown();
      engine = f.start();
      const restored = engine.task(f.id)!;
      expect(Object.hasOwn(restored, "branch")).toBe(false);
      expect(Object.hasOwn(restored, "report")).toBe(false);
      expect(restored.repositories!.map((work) => work.branch)).toEqual(["task-first", "latest-saved-second"]);
      expect(restored.repositories![1]!.report!.summary).toBe("Latest second report from the previous engine");
      engine.save();
      const saved = engine.store.load()!.tasks.find((task) => task.id === f.id)!;
      expect(saved.branch).toBeUndefined();
      expect(saved.repositories![1]!.branch).toBe("latest-saved-second");
    } finally { await engine.shutdown(); }
  });
});
