import { completeAll } from "@petrina/core";
import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckId, DeepMutable, Product, TaskRepository } from "@petrina/core";

import { scopesFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { makeProduct, tempDir } from "../../fixtures.js";
import { materializePreparedWorktree, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());

let commonSourceSeed: Promise<{ dir: string; head: string }> | undefined;
function getCommonSourceSeed(): Promise<{ dir: string; head: string }> {
  if (!commonSourceSeed) {
    commonSourceSeed = (async () => {
      const dir = await makeProduct(tempDir("petrina-shared-source-seed-"), { origin: "none" });
      writeFileSync(join(dir, "feature.txt"), "Original value\n");
      await gitOps.commitChanges(dir, "Prepare the common source");
      return { dir, head: readWorktreeCommit(dir)!.commit };
    })();
  }
  return commonSourceSeed;
}

/** Only post-wait updates and the next admission: each product owns its own private repository. */
async function prepareFixture(owner: EngineCaseOwner) {
  const root = owner.root;
  const home = join(root, "data");
  const open = () => {
    const engine = owner.open(home, { agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), terminals: () => [] });
    engine.schedule = () => {};
    engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
    engine.s.tools.forEach(tool => { tool.status = "ready"; });
    return engine;
  };
  let engine = open();
  const seed = await getCommonSourceSeed();
  const products: DeepMutable<Product>[] = ["shop", "api"].map((id): DeepMutable<Product> => {
    const path = join(root, id, "repo");
    cpSync(seed.dir, path, { recursive: true });
    return { id, name: id, path, repo: `local/${id}`, tone: "blue", defaultBranch: "main", delivery: "local", remoteRefused: "Local delivery only", checks: [] };
  });
  engine.s.products.push(...products);
  const prerequisite = engine.addTask({ productId: "shop", title: "Land the shared fix", backlog: true });
  const id = engine.addTask({ productId: "shop", title: "Refresh every product", backlog: true });
  const task = engine.task(id)!;
  task.repositories = products.map((product): DeepMutable<TaskRepository> => {
    const worktree = join(root, `${product.id}-work`), branch = "task-change";
    const baseSha = seed.head;
    return { productId: product.id, delivery: "local", completedStages: ["build"], preparation: "ready", worktree, branch, base: "main", baseSha,
      source: { product: { ...product }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true, initialSha: baseSha },
      builderSession: { stageId: "build", profileId: "sol-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: `${product.id}-builder` } };
  });
  delete task.repository;
  await completeAll(scopesFor(task).map(scope => materializePreparedWorktree(engine, scope, scope.work.source!.product.path!, "main", seed.head, "feature.txt", "Accepted task work\n", "Improve the feature")));
  task.activeProductId = "shop"; task.leadProductId = "shop";
  task.startedAt = 1; task.state = "waiting"; task.stageIndex = 1;
  task.plan = { rationale: "Review accepted work", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
  ] };
  const controller = new AbortController(), signal = controller.signal;
  owner.onStop(() => controller.abort());
  const admitted: string[] = [];
  const observe = () => { engine["work"].runDo = async scope => { admitted.push(scope.work.productId); return "stop"; }; };
  observe();
  return {
    get engine() { return engine; }, products, id, signal, admitted,
    task: () => engine.task(id)!,
    scopes: () => scopesFor(engine.task(id)!),
    async advance(index: number, conflict = false, text?: string) {
      const product = products[index]!;
      writeFileSync(join(product.path!, conflict ? "feature.txt" : "incoming-fix.txt"), text ?? `${product.name}: required fix\n`);
      await gitOps.commitChanges(product.path!, "Land the required fix");
      return (await gitOps.head(product.path!))!;
    },
    async port() {
      const scope = scopesFor(engine.task(id)!)[0]!;
      expect(await engine["updates"].upToDate(scope, signal, true, true)).toBe("conflict");
    },
    release() {
      engine.setRuntimeWait(id, [prerequisite], "The next step needs every product's fix", "hold");
      engine.setRuntimeWait(id, [], "The coordinator resolved the prerequisites", "clear");
    },
    refresh: () => { const current = engine; return owner.run(current, () => current["driver"]["refreshAfterWait"](current.task(id)!, signal)); },
    async drive() { const current = engine; return owner.run(current, async () => { current.startDriver(id); await current.settling.get(id); }); },
    restart: () => owner.prepare(async () => { await owner.stop(engine); owner.check(); engine = open(); await engine.waitUntilReady(); observe(); }),
    close: () => owner.stop(engine),
  };
}

function fixture<T>(owner: EngineCaseOwner, body: (fixture: Awaited<ReturnType<typeof prepareFixture>>) => Promise<T>): Promise<T> {
  return owner.prepare(async () => { const value = await prepareFixture(owner); owner.check(); return body(value); });
}

describe.concurrent("post-wait source updates across products", () => {
  it("keeps an existing port intact while updating its companion, and finishes the owed port check after restart", async () => {
    return cases.use("petrina-wait-refresh-", owner => fixture(owner, async (f) => {
    try {
      await f.advance(0, true); await f.port();
      const first = f.scopes()[0]!.work;
      const port = structuredClone(first.updating), repair = structuredClone(f.task().repair), conversation = structuredClone(first.builderSession);
      const markers = readFileSync(join(first.worktree!, "feature.txt"), "utf8");
      const latest = await f.advance(1); f.release();
      expect(await f.refresh()).toBe(false);
      expect(f.scopes()[1]!.work.baseSha).toBe(latest);
      expect(readFileSync(join(f.scopes()[1]!.work.worktree!, "incoming-fix.txt"), "utf8")).toBe("api: required fix\n");
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
      await gitOps.commitChanges(restored.worktree!, "Resolve the existing port");
      delete restored.updating;
      expect(await f.refresh()).toBe(false);
      expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      expect(f.task().timeline.filter(line => line.text.includes("source checks are complete"))).toHaveLength(1);
      // A later wait keeps an admitted publication's real candidate while updating its companion.
      const admittedWork = f.scopes()[0]!.work;
      const head = (await gitOps.head(admittedWork.worktree!))!;
      admittedWork.shipping = { moves: 1, failures: 1, start: head, step: "push", prepared: { tested: head, summary: "Admitted delivery" } };
      const admitted = structuredClone(admittedWork.shipping);
      await f.advance(0); const admittedLatest = await f.advance(1, false, "api: next required fix\n"); f.release();
      expect(await f.refresh()).toBe(false);
      expect(admittedWork.shipping).toEqual(admitted);
      expect(await gitOps.head(admittedWork.worktree!)).toBe(head);
      expect(f.scopes()[1]!.work.baseSha).toBe(admittedLatest);
      expect(f.task().runtimeWait?.refreshProducts).toEqual(["shop"]);
      // Existing publication recovery confirms its landing; it is then immutable.
      admittedWork.landed = { branch: "main", sha: head };
      expect(await f.refresh()).toBe(false);
      expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      expect(admittedWork.shipping).toEqual(admitted);

    } finally { await f.close(); }

  }));
});

  it.each([true])("stops before Builder admission on an unavailable companion and retains the update across restart (existing port: %s)", async existing => {
    return cases.use("petrina-wait-refresh-", owner => fixture(owner, async (f) => {
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
      f.engine["connections"].fetchDefault = async scope => ({ ok: true, sha: (await gitOps.revParse(f.products.find(product => product.id === scope.work.productId)!.path!, "main"))! });
      const stuck = f.engine.s.inbox.find(item => item.taskId === f.id && item.kind === "stuck")!;
      await f.engine.retry(stuck.id); await f.drive();
      expect(f.scopes()[1]!.work.baseSha).toBe(latest);
      expect(f.scopes()[0]!.work.updating).toEqual(port);
      expect(f.admitted).toEqual(["shop"]);
      expect(f.task().runtimeWait?.refreshPending).toBe(true);
    } finally { await f.close(); }

  }));
});
});
