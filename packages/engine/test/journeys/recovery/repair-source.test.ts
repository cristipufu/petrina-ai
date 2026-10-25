import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckId, DeepMutable, Product, TaskRepository } from "@petrina/core";
import { Engine } from "../../engine.js";
import { acceptanceAgents } from "../../fixtures/acceptance-agents.js";
import { ScriptedAgents } from "../../scripted-agents.js";
import { scopesFor } from "@petrina/orchestrator";
import { beginRepair } from "@petrina/orchestrator";
import { git, makeProduct, removeDir, tempDir } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** Real Builder conversations and source updates; stop at the step that the pending repair owes. */
async function fixture(shared: boolean, kind: "review" | "checks" | "acceptance" = "review", repairOwners?: readonly number[]) {
  const root = tempDir("petrina-wait-repair-"); roots.push(root);
  const replies = acceptanceAgents(); replies.configure({ builder: "plain", reopen: "resume" });
  const agents = new ScriptedAgents(replies.respond);
  const fakes = { received: (role: string) => agents.received().filter(prompt => prompt.roleId.replaceAll("-", " ") === role).map(prompt => ({ ...prompt, session: prompt.sessionId })) };
  const home = join(root, "data");
  const open = () => {
    const engine = new Engine(home, { agentCommand: () => undefined, startAgentSession: agents.start, toolPath: () => process.execPath });
    engine.schedule = () => {};
    engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
    engine.s.tools.forEach(tool => { tool.status = "ready"; });
    return engine;
  };
  let engine = open();
  const products: DeepMutable<Product>[] = await Promise.all((shared ? ["shop", "api"] : ["shop"]).map(async (id): Promise<DeepMutable<Product>> => {
    const path = await makeProduct(join(root, id));
    writeFileSync(join(path, "greeting.txt"), "Original greeting\n");
    await git(path, "add", "."); await git(path, "commit", "-qm", "Prepare the common source");
    return { id, name: id, path, repo: `local/${id}`, tone: "blue", defaultBranch: "main", delivery: "local", remoteRefused: "Local delivery only", checks: [] };
  }));
  engine.s.products.push(...products);
  const prerequisite = engine.addTask({ productId: "shop", title: "Land the required fix", backlog: true });
  const id = engine.addTask({ productId: "shop", title: "Repair the greeting", backlog: true });
  const task = engine.task(id)!;
  const works = await Promise.all(products.map(async (product): Promise<DeepMutable<TaskRepository>> => {
    const worktree = join(root, `${product.id}-work`), branch = "task-change";
    await git(product.path!, "worktree", "add", "-qb", branch, worktree, "main");
    const baseSha = await git(worktree, "rev-parse", "HEAD");
    return { productId: product.id, delivery: "local" as const, completedStages: [], preparation: "ready" as const, worktree, branch, base: "main", baseSha,
      source: { product: { ...product }, start: { kind: "default" as const, branch: "main" }, destination: { mode: "local" as const, kind: "branch" as const, repo: product.repo, branch: "main" }, confirmed: true, initialSha: baseSha } };
  }));
  if (shared) { task.repositories = works; delete task.repository; task.leadProductId = "shop"; task.activeProductId = "shop"; }
  else task.repository = works[0]!;
  task.startedAt = 1; task.state = "running"; task.stageIndex = 0;
  const build = { id: "build", kind: "do" as const, title: "Build", roleId: "builder", profileIds: ["sol-high"] };
  task.plan = { rationale: "Repair the accepted work", plannerProfileId: "sol-high", stages: [build,
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "grok-high"] },
    { id: "acceptance", kind: "do", title: "Acceptance", roleId: "tester", profileIds: ["sol-high"] },
  ] };
  const signal = new AbortController().signal;
  for (const scope of scopesFor(task)) await engine["work"].runDo(scope, build, signal);
  const sessions = scopesFor(task).map(scope => scope.work.builderSession!.sessionId);
  const text = kind === "checks" ? "Check failed: Greeting check" : kind === "acceptance" ? "Failed acceptance check: The greeting works" : "The greeting needs a repair";
  const owners = repairOwners ?? products.map((_, index) => index);
  task.findings = products.flatMap((product, index) => owners.includes(index) ? [{ id: `f${index}`, text, severity: "blocking" as const, raisedBy: kind === "checks" ? "petrina" : "opus-high", confirmedBy: [], status: "open" as const, ...(shared ? { productIds: [product.id] } : {}) }] : []);
  task.rounds.review = 2;
  const returnStage = kind === "acceptance" ? 2 : 1;
  if (!owners.length) { task.stageIndex = returnStage; task.fixing = false; }
  else if (shared) expect(beginRepair(engine, task, kind, returnStage)).toBe(true);
  else { task.stageIndex = 0; task.fixing = true; }
  if (kind !== "review" || !owners.length) for (const { work } of scopesFor(task)) work.reviewedTree = await git(work.worktree!, "rev-parse", "HEAD^{tree}");
  const reached: number[] = [];
  const observe = () => {
    engine["reviews"].runReview = async current => { reached.push(current.stageIndex); return "stop"; };
    const runDo = engine["work"].runDo.bind(engine["work"]);
    engine["work"].runDo = async (scope, stage, signal) => {
      if (stage.roleId === "tester") { reached.push(scope.task.stageIndex); return "stop"; }
      return runDo(scope, stage, signal);
    };
  };
  observe();
  engine.commitNow(task);
  return {
    get engine() { return engine; }, id, products, fakes, sessions, reached, returnStage,
    task: () => engine.task(id)!,
    scopes: () => scopesFor(engine.task(id)!),
    hold() { engine.setRuntimeWait(id, [prerequisite], "The repair needs the prerequisite first", "hold"); },
    release() { engine.setRuntimeWait(id, [], "The coordinator resolved the prerequisite", "clear"); },
    async advance(index: number, conflict: boolean) {
      const product = products[index]!;
      writeFileSync(join(product.path!, conflict ? "greeting.txt" : "incoming.txt"), "The required source change\n");
      await git(product.path!, "add", "."); await git(product.path!, "commit", "-qm", "Land the required source change");
      return await git(product.path!, "rev-parse", "HEAD");
    },
    refresh: () => engine["driver"]["refreshAfterWait"](engine.task(id)!, signal),
    async drive() { engine.startDriver(id); await engine.settling.get(id); },
    async restart() { await engine.shutdown(); engine = open(); await engine.waitUntilReady(); observe(); },
    close: () => engine.shutdown(),
  };
}

describe.concurrent("a pending Builder repair after a prerequisite wait", () => {
  for (const scenario of [
    { name: "two new conflicts", conflicts: [0, 1], existing: false, restart: false },
    { name: "only the companion conflicts", conflicts: [1], existing: false, restart: false },
    { name: "an existing port and a companion conflict survive restart", conflicts: [0, 1], existing: true, restart: true },
  ]) it(`keeps conflict-only owners out of findings-fix mode at round four: ${scenario.name}`, async () => {
    const f = await fixture(true, "review", []);
    try {
      f.task().rounds.review = 4;
      for (const owner of scenario.conflicts) await f.advance(owner, true);
      if (scenario.existing) expect(await f.engine["updates"].upToDate(f.scopes()[0]!, new AbortController().signal, true, true)).toBe("conflict");
      f.hold(); f.release();
      expect(await f.refresh()).toBe(!scenario.existing || scenario.conflicts.length > 1);
      if (scenario.restart) { f.engine.pause(f.id); await f.restart(); f.engine.resume(f.id); }
      await f.drive();
      expect(f.task().state).not.toBe("failed");
      expect(f.reached).toEqual([1]);
      expect(f.task().rounds.review).toBe(4);
      expect(f.task().findings).toEqual([]);
      expect(f.task().repair).toBeUndefined();
      expect(f.fakes.received("builder")).toHaveLength(f.products.length + scenario.conflicts.length);
      for (const [index, { work }] of f.scopes().entries()) {
        const inputs = f.task().journey!.flatMap(step => step.agentInputs ?? []).filter(input => input.roleId === "builder" && input.productId === work.productId);
        expect(inputs).toHaveLength(scenario.conflicts.includes(index) ? 2 : 1);
        expect(work.builderSession?.sessionId).toBe(f.sessions[index]);
        if (!scenario.conflicts.includes(index)) continue;
        const port = inputs[1]!;
        expect(port.mode).toBe("continued");
        expect(port.freshReason).toBeUndefined();
        expect(port.instructions).not.toContain("You are fixing the review findings");
        expect(port.instructions).not.toContain("Step back before patching again");
        expect(port.instructions).toContain("conflict markers");
        expect(work.portReview).toBeDefined();
      }
      expect(f.task().journey!.flatMap(step => step.agentResults ?? []).filter(result => result.roleId === "builder")).toHaveLength(f.products.length + scenario.conflicts.length);
    } finally { await f.close(); }
  });

  it("keeps a genuine late findings repair while an appended companion does only its conflict port", async () => {
    const f = await fixture(true, "review", [0]);
    try {
      f.task().rounds.review = 4;
      // Both products conflict, but only shop was sent back for a finding.
      for (const [index, { work }] of f.scopes().entries()) {
        work.reviewedTree = await git(work.worktree!, "rev-parse", "HEAD^{tree}");
        await f.advance(index, true);
      }
      f.hold(); f.release();
      expect(await f.refresh()).toBe(true);
      await f.drive();
      expect(f.reached).toEqual([1]);
      expect(f.task().rounds.review).toBe(4);
      expect(f.task().findings).toHaveLength(1);
      expect(f.task().findings[0]!.answer?.fixed).toBe(true);
      const inputs = f.task().journey!.flatMap(step => step.agentInputs ?? []).filter(input => input.roleId === "builder");
      const repair = inputs.findLast(input => input.productId === "shop")!;
      expect(repair.instructions).toContain("You are fixing the review findings");
      expect(repair.instructions).toContain("Step back before patching again");
      expect(repair.mode).toBe("fresh");
      expect(repair.freshReason).toContain("deliberate fresh rethink");
      expect(JSON.stringify(repair.sections)).toContain("f0");
      expect(f.scopes()[0]!.work.portReview).toBeUndefined();
      const port = inputs.findLast(input => input.productId === "api")!;
      expect(port.instructions).not.toContain("You are fixing the review findings");
      expect(port.instructions).not.toContain("Step back before patching again");
      expect(port.mode).toBe("continued");
      expect(port.sessionId).toBe(f.sessions[1]);
      expect(port.freshReason).toBeUndefined();
      expect(f.scopes()[1]!.work.portReview).toBeDefined();
      expect(f.fakes.received("builder")).toHaveLength(4);
      expect(inputs).toHaveLength(4);
    } finally { await f.close(); }
  });

  it("keeps ordinary sequential conflict ports in their saved conversations without a wait", async () => {
    const f = await fixture(true, "review", []);
    try {
      f.task().rounds.review = 4;
      for (const owner of [0, 1]) await f.advance(owner, true);
      for (const scope of f.scopes()) {
        expect(await f.engine["updates"].upToDate(scope, new AbortController().signal, true, true)).toBe("conflict");
        await f.drive();
      }
      expect(f.reached).toEqual([1, 1]);
      expect(f.task().rounds.review).toBe(4);
      for (const [index, { work }] of f.scopes().entries()) {
        const input = f.task().journey!.flatMap(step => step.agentInputs ?? []).findLast(input => input.roleId === "builder" && input.productId === work.productId)!;
        expect(input.mode).toBe("continued");
        expect(input.sessionId).toBe(f.sessions[index]);
        expect(input.instructions).not.toContain("You are fixing the review findings");
        expect(work.portReview).toBeDefined();
      }
      expect(f.fakes.received("builder")).toHaveLength(4);
    } finally { await f.close(); }
  });

  for (const scenario of [
    { name: "one product conflicts", shared: false, owner: 0, conflict: true, wait: true },
    { name: "the first product conflicts", shared: true, owner: 0, conflict: true, wait: true },
    { name: "a companion conflicts", shared: true, owner: 1, conflict: true, wait: true },
    { name: "a clean source update", shared: true, owner: 1, conflict: false, wait: true },
    { name: "ordinary repairs without a wait", shared: true, owner: 1, conflict: true, wait: false },
  ]) it(`keeps every owed finding and Builder conversation: ${scenario.name}`, async () => {
    const f = await fixture(scenario.shared);
    try {
      if (scenario.wait) {
        f.hold(); await f.drive();
        expect(f.fakes.received("builder")).toHaveLength(f.products.length);
        expect(f.reached).toEqual([]);
      }
      const latest = await f.advance(scenario.owner, scenario.conflict);
      if (scenario.wait) f.release();
      await f.drive();
      expect(f.task().state).not.toBe("failed");
      expect(f.reached).toEqual([1]);
      expect(f.task().rounds.review).toBe(2);
      expect(f.task().repair).toBeUndefined();
      expect(f.task().findings.map(finding => finding.status)).toEqual(f.products.map(() => "fixed"));
      for (const [index, scope] of f.scopes().entries()) {
        const inputs = f.task().journey!.flatMap(step => step.agentInputs ?? []).filter(input => input.sessionId === f.sessions[index]);
        expect(inputs).toHaveLength(2);
        expect(inputs[1]!.mode).toBe("continued");
        expect(JSON.stringify(inputs[1]!.sections)).toContain(`f${index}`);
        expect(f.task().findings[index]!.answer?.fixed).toBe(true);
        expect(scope.work.builderSession?.sessionId).toBe(f.sessions[index]);
        expect(scope.work.portReview).toBeUndefined();
      }
      expect(f.fakes.received("builder")).toHaveLength(f.products.length * 2);
      expect(f.task().journey!.flatMap(step => step.agentResults ?? []).filter(result => result.roleId === "builder")).toHaveLength(f.products.length * 2);
      if (scenario.wait) expect(f.scopes()[scenario.owner]!.work.baseSha).toBe(latest);
    } finally { await f.close(); }
  });

  it.each(["checks", "acceptance"] as const)("keeps pending %s repairs and full review after a conflict survives pause and restart", async kind => {
    const f = await fixture(true, kind);
    try {
      const repair = structuredClone(f.task().repair);
      const returns = () => f.scopes().map(({ work }) => [work.checkReturns, work.acceptanceReturns]);
      const allowance = returns();
      f.hold(); await f.advance(1, true); f.release();
      expect(await f.refresh()).toBe(true);
      expect(f.scopes()[1]!.work.updating).toBeDefined();
      f.engine.pause(f.id);
      await f.restart();
      expect(f.task().repair).toEqual(repair);
      expect(f.task().fixing).toBe(true);
      f.engine.resume(f.id); await f.drive();
      expect(f.task().state).not.toBe("failed");
      expect(f.reached).toEqual([f.returnStage]);
      expect(f.task().repair).toBeUndefined();
      expect(returns()).toEqual(allowance);
      expect(f.task().rounds.review).toBe(2);
      expect(f.task().findings.every(finding => finding.answer?.fixed)).toBe(true);
      if (kind === "checks") expect(f.task().findings.every(finding => finding.status === "open")).toBe(true);
      expect(f.scopes().every(({ work }) => !work.updating && !work.portReview)).toBe(true);
      for (const [index, scope] of f.scopes().entries()) expect(scope.work.builderSession?.sessionId).toBe(f.sessions[index]);
      expect(f.fakes.received("builder")).toHaveLength(f.products.length * 2);
    } finally { await f.close(); }
  });
});
