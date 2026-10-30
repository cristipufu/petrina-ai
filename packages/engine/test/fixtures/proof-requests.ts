import { directDrivers, closeDirectDrivers, removeFixtureRoot } from "./direct-drivers.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { installPreparedProduct } from "./prepared-product.js";
import { fakeEngineSettings } from "./fake-agent-sessions.js";
import { privateAgentToolProbe } from "../scripted-probes.js";
import { installSharedWorkflowFastPaths, materializePreparedWorktree, readWorktreeCommit } from "./shared-preparation.js";
import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { beginAgentStep, refreshProofs, type DeepMutable, type JourneyStep, type ProofRequest, type Product } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import type { EngineOptions } from "../engine.js";
import { Fakes, createProductRepository, tempDir } from "../fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import { changesOf, versionsOf } from "../../src/repositories.js";

export function proofRequestFixtures() {
const roots: string[] = [];
const fixtures = new Set<ReturnType<typeof directDrivers>>();
const signal = () => new AbortController().signal;
async function fixture(shared = false, brief = false, fakes?: Fakes, options: EngineOptions = {}) {
  const root = tempDir("petrina-proof-requests-"); roots.push(root);
  const lifetime = directDrivers(root); fixtures.add(lifetime);
  const close = async () => { await lifetime.close(); fixtures.delete(lifetime); };
  return setupWithCleanup(() => lifetime.prepare(async () => {
    const baseOptions: EngineOptions = {
      ...(fakes ? fakeEngineSettings(fakes) : { agentCommand: () => undefined, toolProbe: privateAgentToolProbe() }),
      terminals: () => [],
      ...options,
    };
    const openEngine = (dataDir: string, nextOptions: EngineOptions = {}) => {
      const opened = lifetime.open(dataDir, { ...baseOptions, ...nextOptions });
      installSharedWorkflowFastPaths(opened);
      return opened;
    };
    const engine = openEngine(join(root, "data"));
    engine.schedule = () => {};
    await engine.waitUntilReady();
    engine.setPoolPaused(false);
    const products: DeepMutable<Product>[] = [];
    const initialVersions = new Map<DeepMutable<Product>, string>();
    for (let i = 0; i < (shared ? 2 : 1); i++) {
      const dir = join(root, `product-${i}`); mkdirSync(dir);
      const { path: repo, initialSha } = await createProductRepository(dir, { origin: "none" });
      const id = installPreparedProduct(engine, { id: i === 0 ? "clone" : "clone-2", path: repo, name: `Product ${i + 1}`, repo: "local/clone",
        tone: i === 0 ? "blue" : "green", defaultBranch: "main", delivery: "local", approveDelivery: true });
      const product = engine.s.products.find(product => product.id === id)!;
      // Native command contracts supply their command at the case; proof/version contracts
      // still use the real check owner without launching an unrelated success program.
      product.checks = []; product.checksBy = "coordinator";
      products.push(product);
      initialVersions.set(product, initialSha);
    }
    const task = engine.task(engine.addTask({ productId: products[0]!.id, title: "Keep required Linux proof current", backlog: true }))!;
    const initialSeeds = new Map<string, { baseSha: string; head: string; tree: string; patch: string }>();
    const owner = async (product: DeepMutable<Product>, i: number) => {
      const baseSha = initialVersions.get(product);
      if (!baseSha) throw new Error("The private proof product lost its initial commit");
      const worktree = join(root, `work-${i}`), branch = `proof-${i}`;
      const work = { productId: product.id, worktree, baseSha, base: baseSha, branch, delivery: "local" as const, completedStages: ["build"], preparation: "ready" as const,
        source: { product, start: { kind: "default" as const, branch: "main" }, destination: { mode: "local" as const, kind: "branch" as const, repo: product.repo, branch: "main" }, confirmed: true } };
      const seed = await materializePreparedWorktree(engine, { task, work } as unknown as ReturnType<typeof executionFor>, product.path!, baseSha, baseSha, "feature.txt", "the task's change\n", "Add the feature");
      initialSeeds.set(product.id, { ...seed, baseSha });
      return work;
    };
    const owners: Awaited<ReturnType<typeof owner>>[] = [];
    for (const [i, product] of products.entries()) owners.push(await owner(product, i));
    if (shared) { delete task.repository; task.repositories = owners; task.activeProductId = products[0]!.id; }
    else task.repository = owners[0];
    const build = { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
    const tester = { id: "test", title: "Acceptance", kind: "do" as const, roleId: "tester", profileIds: ["opus-high"] };
    const review = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 };
    const gate = { id: "gate", title: "Delivery", kind: "gate" as const, gate: "delivery" as const, roleId: "coordinator", profileIds: [] };
    const ship = { id: "ship", title: "Ship", kind: "do" as const, roleId: "release-manager", profileIds: ["opus-high"] };
    task.plan = { rationale: "Focused acceptance workflow", plannerProfileId: "sol-high", stages: [build, tester, review, gate, ship] };
    if (brief) task.brief = { summary: "Try it", areas: [], forUsers: [], risks: [], acceptance: [{ text: "Linux recovery works" }] };
    task.state = "running"; task.stageIndex = 3; task.risk = { level: "low", why: "Only copy" };
    const scope = executionFor(task);
    let sequence = 0;
    const advance = async (index = 0) => {
      const product = products[index]!;
      writeFileSync(join(product.path!, `incoming-${++sequence}.txt`), `main ${sequence}\n`);
      await gitOps.commitChanges(product.path!, "Main advances");
    };
    const request = async (text = "Run Linux recovery", ids = products.map(product => product.id)): Promise<DeepMutable<ProofRequest>> => {
      const reviewedVersions: Record<string, string> = {};
      for (const owner of owners) reviewedVersions[owner.productId] = (await gitOps.treeOf(owner.worktree))!;
      const item: DeepMutable<ProofRequest> = {
        id: `proof-${(task.proofRequests?.length ?? 0) + 1}`,
        text,
        reason: "Required on final code",
        productIds: ids,
        source: `source-${task.proofRequests?.length ?? 0}`,
        requestedBy: { stageId: review.id, round: 1, seat: "0", roleId: "code-reviewer", profileId: "sol-high" },
        ownerStageId: tester.id,
        reviewedVersions,
        status: "pending",
      };
      task.proofRequests ??= [];
      task.proofRequests.push(item);
      return item;
    };
    const recordPass = async (requests = task.proofRequests ?? []) => {
      const versions = await versionsOf(task);
      const node: DeepMutable<JourneyStep> = {
        id: `saved-test-${task.journey?.length ?? 0}`,
        kind: "agent",
        stageId: tester.id,
        roleId: "tester",
        profileId: "opus-high",
        round: 1,
        sub: 0,
        startedAt: 10,
        endedAt: 20,
        end: "done",
        proofChecks: requests.map(item => ({
          id: item.id,
          result: "pass",
          evidence: "Private Ubuntu capacity and nearby recovery passed",
        })),
        acceptanceChecks: [{
          text: "Linux recovery works",
          result: "pass",
          evidence: "Private Ubuntu recovery passed",
        }],
        agentResults: [{ roleId: "tester", profileId: "opus-high", at: 20, value: {}, versions }],
      };
      task.journey ??= [];
      task.journey.push(node);
      for (const item of requests) item.proof = { stepId: node.id, versions, result: "pass", evidence: "Private Ubuntu recovery passed" };
      refreshProofs(task, versions);
      const canUseSeedPatches = owners.every((w) => {
        const seed = initialSeeds.get(w.productId);
        return Boolean(seed && w.baseSha === seed.baseSha && readWorktreeCommit(w.worktree)?.commit === seed.head);
      });
      task.testedVersions = versions;
      task.testedChanges = canUseSeedPatches
        ? Object.fromEntries(owners.map((w) => [w.productId, initialSeeds.get(w.productId)!.patch]))
        : await changesOf(task);
      task.testedPatch = await engine["checks"].acceptanceVersion(scope, versions);
      task.acceptancePassed = true;
      return node;
    };
    const drive = async () => {
      const admit = spyOn(engine["driver"].workflow as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockResolvedValue(true);
      try { task.state = "running"; await lifetime.run(engine, () => engine["driver"].workflow["drive"](task.id)); if (engine.task(task.id)?.state === "failed") throw new Error(task.error); }
      finally { admit.mockRestore(); }
    };
    const f = { root, engine, task, scope, owners, products, build, tester, review, gate, ship,
      advance: (...args: Parameters<typeof advance>) => lifetime.run(f.engine, () => advance(...args)),
      request: (...args: Parameters<typeof request>) => lifetime.run(f.engine, () => request(...args)),
      recordPass: (...args: Parameters<typeof recordPass>) => lifetime.run(f.engine, () => recordPass(...args)),
      drive, close, open: openEngine, stop: lifetime.stop, run: lifetime.run,
      body: <T>(start: () => Promise<T>) => lifetime.prepare(start),
    };
    return f;
  }), close);
}
function testerReply(f: Awaited<ReturnType<typeof fixture>>, answers: (ids: readonly string[]) => unknown[], before?: () => void | Promise<void>, checklist?: unknown[]) {
  return spyOn(f.engine["turns"], "turn").mockImplementation(async (scope, roleId, profileId, _given, schema, _signal, options) => {
    expect(roleId).toBe("tester");
    before && await before();
    const value = schema.parse({ summary: "Tried required proof", checks: checklist ?? (f.task.brief ? [{ text: "Linux recovery works", result: "pass", evidence: "Recovery worked" }] : []), proofAnswers: answers(f.task.acceptanceRun!.requestIds) });
    const error = await options?.check?.(value);
    expect(error).toBeUndefined();
    options?.used?.(profileId);
    const node = beginAgentStep(scope.task, roleId, profileId, Date.now(), f.engine.s.roles, undefined, scope.work);
    node.proofRun = structuredClone(scope.task.acceptanceRun);
    node.agentResults = [{ roleId, profileId, at: Date.now(), value }];
    return value;
  });
}
const passes = (ids: readonly string[]) => ids.map(id => ({ id, result: "pass" as const, evidence: "Ubuntu capacity 30/30 and recovery 71/71 passed on this prepared copy" }));
const greetingPass = { text: "A greeting file exists", result: "pass" as const, evidence: "The scripted greeting check returned the expected result." };
const testerSteps = (f: Awaited<ReturnType<typeof fixture>>, roleId = "tester") => f.task.journey!.filter(step => step.kind === "agent" && step.roleId === roleId);
const restoredLine = (what: string, product: string, files: string) => `This acceptance run cannot verify the restored product: Petrina is undoing ${what} from Tester in ${product} (${files})`;
function lockRecords(folder: string, kept: string) {
  const refused: string[] = [];
  const refuse = (path: unknown, only?: string) => {
    if (typeof path !== "string" || dirname(resolve(path)) !== resolve(folder) || (only !== undefined && resolve(path) !== resolve(only))) return undefined;
    refused.push(basename(path));
    return Object.assign(new Error(`EACCES: permission denied, '${path}'`), { code: "EACCES", path });
  };
  const remove = fs.rmSync as (...args: unknown[]) => void, write = fs.writeFileSync as (...args: unknown[]) => void;
  const spies = [
    spyOn(fs, "rmSync").mockImplementation(((path: unknown, ...rest: unknown[]) => { const error = refuse(path, kept); if (error) throw error; return remove(path, ...rest); }) as never),
    spyOn(fs, "writeFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => { const error = refuse(path); if (error) throw error; return write(path, ...rest); }) as never),
  ];
  let restored = false;
  return { refused, restore: () => { if (!restored) for (const spy of spies) spy.mockRestore(); restored = true; } };
}
const cleanupHolds = { answered: "worktreeStatus", detected: "trackedChangesSince", restoring: "discardChanges", commit: "resetTo", companion: "resetTo", "approval-off": "worktreeStatus" } as const;
async function close() {
  await closeDirectDrivers(fixtures); fixtures.clear();
  roots.forEach(removeFixtureRoot);
}
return { roots, signal, fixture, testerReply, passes, greetingPass, testerSteps, restoredLine, lockRecords, cleanupHolds, close };
}
