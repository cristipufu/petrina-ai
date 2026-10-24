import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckId, DeepMutable, Product, TaskRepository } from "@petrina/core";
import { Engine } from "./engine.js";
import { scopesFor } from "@petrina/orchestrator";
import { git, makeProduct, removeDir, tempDir } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** Only post-wait updates and the next admission: each product owns its own private repository. */
async function fixture() {
  const root = tempDir("petrina-wait-refresh-"); roots.push(root);
  const home = join(root, "data");
  const open = () => {
    const engine = new Engine(home, { agentCommand: () => undefined, terminals: () => [] });
    engine.schedule = () => {};
    engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
    engine.s.tools.forEach(tool => { tool.status = "ready"; });
    return engine;
  };
  let engine = open();
  const products: DeepMutable<Product>[] = await Promise.all(["shop", "api"].map(async (id): Promise<DeepMutable<Product>> => {
    const path = await makeProduct(join(root, id));
    writeFileSync(join(path, "feature.txt"), "Original value\n");
    await git(path, "add", "."); await git(path, "commit", "-qm", "Prepare the common source");
    return { id, name: id, path, repo: `local/${id}`, tone: "blue", defaultBranch: "main", delivery: "local", remoteRefused: "Local delivery only", checks: [] };
  }));
  engine.s.products.push(...products);
  const prerequisite = engine.addTask({ productId: "shop", title: "Land the shared fix", backlog: true });
  const id = engine.addTask({ productId: "shop", title: "Refresh every product", backlog: true });
  const task = engine.task(id)!;
  task.repositories = await Promise.all(products.map(async (product): Promise<DeepMutable<TaskRepository>> => {
    const worktree = join(root, `${product.id}-work`), branch = "task-change";
    await git(product.path!, "worktree", "add", "-qb", branch, worktree, "main");
    const baseSha = await git(worktree, "rev-parse", "HEAD");
    writeFileSync(join(worktree, "feature.txt"), "Accepted task work\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-qm", "Improve the feature");
    return { productId: product.id, delivery: "local", completedStages: ["build"], preparation: "ready", worktree, branch, base: "main", baseSha,
      source: { product: { ...product }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true, initialSha: baseSha },
      builderSession: { stageId: "build", profileId: "sol-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: `${product.id}-builder` } };
  }));
  delete task.repository;
  task.activeProductId = "shop"; task.leadProductId = "shop";
  task.startedAt = 1; task.state = "waiting"; task.stageIndex = 1;
  task.plan = { rationale: "Review accepted work", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
  ] };
  const signal = new AbortController().signal;
  const admitted: string[] = [];
  const observe = () => { engine["work"].runDo = async scope => { admitted.push(scope.work.productId); return "stop"; }; };
  observe();
  return {
    get engine() { return engine; }, products, id, signal, admitted,
    task: () => engine.task(id)!,
    scopes: () => scopesFor(engine.task(id)!),
    async advance(index: number, conflict = false) {
      const product = products[index]!;
      writeFileSync(join(product.path!, conflict ? "feature.txt" : "incoming-fix.txt"), `${product.name}: required fix\n`);
      await git(product.path!, "add", "."); await git(product.path!, "commit", "-qm", "Land the required fix");
      return await git(product.path!, "rev-parse", "HEAD");
    },
    async port() {
      const scope = scopesFor(engine.task(id)!)[0]!;
      expect(await engine["updates"].upToDate(scope, signal, true, true)).toBe("conflict");
    },
    release() {
      engine.setRuntimeWait(id, [prerequisite], "The next step needs every product's fix", "hold");
      engine.setRuntimeWait(id, [], "The coordinator resolved the prerequisites", "clear");
    },
    refresh: () => engine["driver"]["refreshAfterWait"](engine.task(id)!, signal),
    async drive() { engine.startDriver(id); await engine.settling.get(id); },
    async restart() { await engine.shutdown(); engine = open(); await engine.waitUntilReady(); observe(); },
    close: () => engine.shutdown(),
  };
}

describe.concurrent("post-wait source updates across products", () => {
  it("keeps an existing port intact while updating its companion, and finishes the owed port check after restart", async () => {
    const f = await fixture();
    try {
      await f.advance(0, true); await f.port();
      const first = f.scopes()[0]!.work;
      const port = structuredClone(first.updating), repair = structuredClone(f.task().repair), conversation = structuredClone(first.builderSession);
      const markers = readFileSync(join(first.worktree!, "feature.txt"), "utf8");
      const latest = await f.advance(1); f.release();
      expect(await f.refresh()).toBe(false);
      expect(f.scopes()[1]!.work.baseSha).toBe(latest);
      expect(first.updating).toEqual(port); expect(first.builderSession).toEqual(conversation);
      expect(f.task().repair).toEqual(repair);
      expect(readFileSync(join(first.worktree!, "feature.txt"), "utf8")).toBe(markers);
      expect(f.task().runtimeWait?.refreshPending).toBe(true);
      expect(f.task().timeline.some(line => line.text.includes("source checks are complete"))).toBe(false);
      await f.restart();
      const restored = f.scopes()[0]!.work;
      expect(restored.updating).toEqual(port);
      // Stand in for the admitted Builder completing its saved conflict port.
      writeFileSync(join(restored.worktree!, "feature.txt"), "Resolved accepted work\n");
      await git(restored.worktree!, "add", "."); await git(restored.worktree!, "commit", "-qm", "Resolve the existing port");
      delete restored.updating;
      expect(await f.refresh()).toBe(false);
      expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      expect(f.task().timeline.filter(line => line.text.includes("source checks are complete"))).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("examines the companion after a new conflict and retains the conflict until its Builder finishes", async () => {
    const f = await fixture();
    try {
      const first = await f.advance(0, true), second = await f.advance(1); f.release();
      expect(await f.refresh()).toBe(true);
      expect(f.scopes()[0]!.work.updating?.onto).toBe(first);
      expect(f.scopes()[1]!.work.baseSha).toBe(second);
      expect(readFileSync(join(f.scopes()[1]!.work.worktree!, "incoming-fix.txt"), "utf8")).toBe("api: required fix\n");
      expect(f.task().repair).toEqual({ products: ["shop"], index: 0, returnStage: 1, kind: "review", portProducts: ["shop"] });
      expect(f.task().runtimeWait?.refreshPending).toBe(true);
      // All unresolved work is now the existing port; another pass must allow that port to run.
      expect(await f.refresh()).toBe(false);
    } finally { await f.close(); }
  });

  it("keeps every newly conflicted owner in the ordinary repair order and preserves its return step", async () => {
    const f = await fixture();
    try {
      await f.advance(0, true); await f.advance(1, true); f.release();
      expect(await f.refresh()).toBe(true);
      expect(f.scopes().every(scope => !!scope.work.updating)).toBe(true);
      expect(f.task().repair).toEqual({ products: ["shop", "api"], index: 0, returnStage: 1, kind: "review", portProducts: ["shop", "api"] });
      expect(await f.refresh()).toBe(false);
    } finally { await f.close(); }
  });

  it("preserves an admitted publication's candidate while its remaining companion gets the source update", async () => {
    const f = await fixture();
    try {
      const first = f.scopes()[0]!.work;
      const head = await git(first.worktree!, "rev-parse", "HEAD");
      first.shipping = { moves: 1, failures: 1, start: head, step: "push", prepared: { tested: head, summary: "Admitted delivery" } };
      const admitted = structuredClone(first.shipping);
      await f.advance(0); const latest = await f.advance(1); f.release();
      expect(await f.refresh()).toBe(false);
      expect(first.shipping).toEqual(admitted);
      expect(await git(first.worktree!, "rev-parse", "HEAD")).toBe(head);
      expect(f.scopes()[1]!.work.baseSha).toBe(latest);
      expect(f.task().runtimeWait?.refreshProducts).toEqual(["shop"]);
      // Existing publication recovery confirms its landing; it is then immutable.
      first.landed = { branch: "main", sha: head };
      expect(await f.refresh()).toBe(false);
      expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      expect(first.shipping).toEqual(admitted);
    } finally { await f.close(); }
  });

  it.each([false, true])("stops before Builder admission on an unavailable companion and retains the update across restart (existing port: %s)", async existing => {
    const f = await fixture();
    try {
      await f.advance(0, true); if (existing) await f.port();
      const latest = await f.advance(1); f.release();
      const peer = f.scopes()[1]!.work; peer.delivery = "pull-request";
      f.engine["connections"].fetchDefault = async () => ({ ok: false, missing: true, error: "The companion source is unavailable" });
      await f.drive();
      expect(f.admitted).toEqual([]);
      expect(f.task().state).toBe("failed");
      expect(f.task().error).toContain("could not get the latest starting code");
      expect(f.task().runtimeWait?.refreshPending).toBe(true);
      const port = structuredClone(f.scopes()[0]!.work.updating);
      await f.restart();
      // The same approved private source becomes reachable again; retain its delivery choice.
      f.engine["connections"].fetchDefault = async scope => ({ ok: true, sha: await git(f.products.find(product => product.id === scope.work.productId)!.path!, "rev-parse", "main") });
      const stuck = f.engine.s.inbox.find(item => item.taskId === f.id && item.kind === "stuck")!;
      await f.engine.retry(stuck.id); await f.drive();
      expect(f.scopes()[1]!.work.baseSha).toBe(latest);
      expect(f.scopes()[0]!.work.updating).toEqual(port);
      expect(f.admitted).toEqual(["shop"]);
      expect(f.task().runtimeWait?.refreshPending).toBe(true);
    } finally { await f.close(); }
  });
});
