import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builderFindings, type CheckId, type DeepMutable, type Product, type Task, type TaskRepository } from "@petrina/core";

import { acceptanceAgents } from "../../fixtures/acceptance-agents.js";
import { ScriptedAgents } from "../../scripted-agents.js";
import { scopesFor, beginRepair, finishSourcePort, type RepositoryContext } from "@petrina/orchestrator";
import { withMarkers } from "@petrina/repositories/git";
import { assignedCheckFailures } from "../../../src/related-check-evidence.js";
import { BuildResult, freshBuilderRethink } from "../../../src/roles.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

const BASE_SHA = "1".repeat(40);
const BASE_TREE = "2".repeat(40);
const BUILT_SHA = "3".repeat(40);
const BUILT_TREE = "4".repeat(40);
const CONFLICT_MAIN_SHA = "5".repeat(40);
const CONFLICT_MERGE_TREE = "6".repeat(40);
const INCOMING_MAIN_SHA = "7".repeat(40);
const INCOMING_MERGE_TREE = "8".repeat(40);
const PORTED_SHA = "9".repeat(40);

/** Real Builder conversations and source updates; stop at the step that the pending repair owes. */
async function fixture(caseOwner: EngineCaseOwner, shared: boolean, kind: "review" | "checks" | "acceptance" = "review", repairOwners?: readonly number[]) {
  const root = caseOwner.root;
  const replies = acceptanceAgents(); replies.configure({ builder: "plain", reopen: "resume" });
  const agents = new ScriptedAgents(replies.respond);
  const fakes = { received: (role: string) => agents.received().filter(prompt => prompt.roleId.replaceAll("-", " ") === role).map(prompt => ({ ...prompt, session: prompt.sessionId })) };
  const home = join(root, "data");
  const ids = shared ? ["shop", "api"] : ["shop"];
  const products: DeepMutable<Product>[] = [];
  const works: DeepMutable<TaskRepository>[] = [];
  const mainRefs = new Map<string, string>();
  const workStates = new Map<string, { workHead: string; workTree: string; workFork: string }>();
  for (const id of ids) {
    const path = join(root, id), worktree = join(root, `${id}-work`), branch = "task-change", baseSha = BASE_SHA;
    mkdirSync(path, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "greeting.txt"), "Original greeting\n");
    mainRefs.set(path, BASE_SHA);
    workStates.set(worktree, { workHead: BASE_SHA, workTree: BASE_TREE, workFork: BASE_SHA });
    const product: DeepMutable<Product> = { id, name: id, path, repo: `local/${id}`, tone: "blue", defaultBranch: "main", delivery: "local", remoteRefused: "Local delivery only", checks: [] };
    products.push(product);
    works.push({ productId: id, delivery: "local" as const, completedStages: [], preparation: "ready" as const, worktree, branch, base: "main", baseSha,
      source: { product: { ...product }, start: { kind: "default" as const, branch: "main" }, destination: { mode: "local" as const, kind: "branch" as const, repo: product.repo, branch: "main" }, confirmed: true, initialSha: baseSha } });
  }
  const open = () => {
    const engine = caseOwner.open(home, { agentCommand: () => undefined, startAgentSession: agents.start, toolPath: () => process.execPath });
    engine.schedule = () => {};
    engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
    engine.s.tools.forEach(tool => { tool.status = "ready"; });
    const turn = engine["turns"].turn.bind(engine["turns"]);
    engine["turns"].turn = async (scope, roleId, plannedId, given, schema, signal, options = {}) => {
      const peers = (scope.task.repositories ?? []).filter(w => w !== scope.work && w.worktree).map(w => ({ w, worktree: w.worktree! }));
      for (const p of peers) delete p.w.worktree;
      const restore = () => { for (const p of peers) p.w.worktree ??= p.worktree; };
      try {
        return await turn(scope, roleId, plannedId, async () => { restore(); return await given(); }, schema, signal, { ...options, started: () => { restore(); options.started?.(); } });
      } finally { restore(); }
    };
    Object.assign(engine["updates"]["effects"], {
      repository: (worktree: string) => {
        const s = workStates.get(worktree)!;
        return {
          observeFold: async () => ({
            kind: "observed" as const, head: s.workHead, tree: s.workTree, parents: [s.workFork],
            squash: async (fork: string) => {
              s.workFork = fork;
              s.workHead = fork === BASE_SHA ? BUILT_SHA : PORTED_SHA;
              return { head: s.workHead, tree: s.workTree };
            },
          }),
          mergeBase: async () => s.workFork,
          contains: async (descendant: string, ancestor: string) => descendant === ancestor || ancestor === BASE_SHA || ancestor === s.workFork,
          isClean: async () => true,
          mergeTree: async (onto: string) => onto === CONFLICT_MAIN_SHA
            ? { tree: CONFLICT_MERGE_TREE, conflicts: ["greeting.txt"], notes: ["CONFLICT (content): Merge conflict in greeting.txt"] }
            : { tree: INCOMING_MERGE_TREE, conflicts: [], notes: [] },
          commitsSince: async (from: string, to: string) => from === to ? 0 : 1,
          treeOf: async () => s.workTree,
          moveTo: async (sha: string) => { s.workHead = sha; },
          commitTree: async (tree: string, parent: string) => {
            s.workTree = tree; s.workFork = parent; s.workHead = PORTED_SHA;
            return PORTED_SHA;
          },
          head: async () => s.workHead,
          openOn: async (onto: string, tree: string) => {
            s.workHead = onto; s.workTree = tree;
            writeFileSync(join(worktree, "greeting.txt"), "<<<<<<< HEAD\nThe required source change\n=======\nHello\n>>>>>>> task-change\n");
          },
          patchId: async () => "patch-1",
        };
      },
      sourceRef: async (path: string) => mainRefs.get(path),
      sourceContains: async () => true,
      fetchDefault: async () => ({ ok: false as const, missing: true, error: "local" }),
      fetchSource: async () => undefined,
      keptLearnings: async () => undefined,
    });
    Object.assign(engine["work"]["buildCompletion"]["effects"], {
      saveChanges: async (scope: RepositoryContext) => {
        const s = workStates.get(scope.work.worktree!)!;
        s.workTree = BUILT_TREE;
        if (scope.work.updating) { s.workFork = scope.work.updating.onto; s.workHead = PORTED_SHA; }
        else s.workHead = BUILT_SHA;
      },
      finishPort: async (scope: RepositoryContext, updating: NonNullable<RepositoryContext["work"]["updating"]>) => {
        await finishSourcePort(scope, updating, {
          treeOf: async () => BUILT_TREE,
          merge: async () => ({ tree: CONFLICT_MERGE_TREE, conflicts: ["greeting.txt"], notes: [] }),
          changedFiles: async () => ["greeting.txt"],
        });
      },
      fold: (scope: RepositoryContext) => engine["updates"].fold(scope),
      tree: async (scope: RepositoryContext) => workStates.get(scope.work.worktree!)!.workTree,
      versions: async () => Object.fromEntries(works.map(w => [w.productId, workStates.get(w.worktree!)!.workTree])),
      repairVersion: async () => undefined,
    });
    Object.assign(engine["driver"]["waitRefresh"]["effects"], {
      clean: async () => true,
    });
    Object.assign(engine["driver"]["acceptancePreflight"]["effects"], {
      ensureChecks: async () => [],
      failing: async () => ({ kind: "passed" as const }),
    });
    return engine;
  };
  let engine = open();
  engine.s.products.push(...products);
  const prerequisite = engine.addTask({ productId: "shop", title: "Land the required fix", backlog: true });
  const id = engine.addTask({ productId: "shop", title: "Repair the greeting", backlog: true });
  const task = engine.task(id)!;
  if (shared) { task.repositories = works; delete task.repository; task.leadProductId = "shop"; task.activeProductId = "shop"; }
  else task.repository = works[0]!;
  task.startedAt = 1; task.state = "running"; task.stageIndex = 0;
  const build = { id: "build", kind: "do" as const, title: "Build", roleId: "builder", profileIds: ["sol-high"] };
  task.plan = { rationale: "Repair the accepted work", plannerProfileId: "sol-high", stages: [build,
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "grok-high"] },
    { id: "acceptance", kind: "do", title: "Acceptance", roleId: "tester", profileIds: ["sol-high"] },
  ] };
  const signal = new AbortController().signal;
  const reached: number[] = [];
  const observe = () => {
    engine["reviews"].runReview = async current => { reached.push(current.stageIndex); return "stop"; };
    engine["work"].runDo = async (scope: RepositoryContext, stage, runSignal) => {
      if (stage.roleId === "tester") { reached.push(scope.task.stageIndex); return "stop"; }
      const { task: currentTask, work: repository } = scope;
      const roleId = stage.roleId, profileId = stage.profileIds[0] ?? "sol-high";
      let by = profileId;
      const updating = repository.updating;
      if (updating) await engine["updates"].reopen(scope);
      const state = workStates.get(repository.worktree!)!;
      const startingTree = state.workTree;
      const given = currentTask.fixing ? builderFindings(currentTask, repository.productId) : [];
      const checkFailures = assignedCheckFailures(scope);
      const own = repository.builderSession;
      const rethink = freshBuilderRethink(currentTask as Task, own, stage.id, profileId);
      const back = (currentTask.fixing || updating) && own?.stageId === stage.id && (own.plannedProfileId ?? own.profileId) === profileId && !rethink ? own : undefined;
      const result = await engine["turns"].turn(scope, roleId, profileId, () => engine["context"].sectionsFor(scope, roleId), BuildResult, runSignal, {
        builderTree: startingTree,
        initialHead: state.workHead,
        used: chosen => { by = chosen; },
        check: async value => {
          const missing = given.filter(finding => !value.answers.some(answer => answer.id === finding.id));
          if (missing.length) return "answer every finding by id";
          const marked = updating ? await withMarkers(repository.worktree!, updating.files) : [];
          if (marked.length) return `these files still have git's conflict markers: ${marked.join(", ")}`;
          return undefined;
        },
        ...(back ? { resume: back } : {}),
        ...(rethink ? { freshReason: "A deliberate fresh rethink after three review rounds; later repairs can keep this replacement conversation." } : {}),
      });
      await engine["work"]["buildCompletion"].complete(scope, { stageId: stage.id, roleId, plannedProfileId: profileId, actualProfileId: by,
        result, maintenance: false, updating, sourceName: "main", startingTree, given, checkFailures, rethought: rethink || back?.rethought });
      return engine["work"]["completion"].complete(scope, { stageId: stage.id, canEdit: true });
    };
  };
  observe();
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
  if (kind !== "review" || !owners.length) for (const { work } of scopesFor(task)) work.reviewedTree = BUILT_TREE;
  engine.commitNow(task);
  return {
    get engine() { return engine; }, id, products, fakes, sessions, reached, returnStage, builtTree: BUILT_TREE,
    task: () => engine.task(id)!,
    scopes: () => scopesFor(engine.task(id)!),
    hold() { engine.setRuntimeWait(id, [prerequisite], "The repair needs the prerequisite first", "hold"); },
    release() { engine.setRuntimeWait(id, [], "The coordinator resolved the prerequisite", "clear"); },
    async advance(index: number, conflict: boolean) {
      const product = products[index]!;
      const sha = conflict ? CONFLICT_MAIN_SHA : INCOMING_MAIN_SHA;
      mainRefs.set(product.path!, sha);
      return sha;
    },
    refresh: () => engine["driver"]["refreshAfterWait"](engine.task(id)!, signal),
    async drive() { engine.startDriver(id); await engine.settling.get(id); },
    async restart() { await caseOwner.stop(engine); engine = open(); await engine.waitUntilReady(); observe(); },
    close: () => engine.shutdown(),
  };
}

describe.concurrent("a pending Builder repair after a prerequisite wait", () => {
  for (const scenario of [
    { name: "an existing port and a companion conflict survive restart", conflicts: [0, 1], existing: true, restart: true },
  ]) it(`keeps conflict-only owners out of findings-fix mode at round four: ${scenario.name}`, async () => {
  return engineCases.use("petrina-wait-repair-", async caseOwner => {
    const f = await fixture(caseOwner, true, "review", []);
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
});

  it("keeps a genuine late findings repair while an appended companion does only its conflict port", async () => {
  return engineCases.use("petrina-wait-repair-", async caseOwner => {
    const f = await fixture(caseOwner, true, "review", [0]);
    try {
      f.task().rounds.review = 4;
      // Both products conflict, but only shop was sent back for a finding.
      for (const [index, { work }] of f.scopes().entries()) {
        work.reviewedTree = f.builtTree;
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
});

  it("keeps ordinary sequential conflict ports in their saved conversations without a wait", async () => {
  return engineCases.use("petrina-wait-repair-", async caseOwner => {
    const f = await fixture(caseOwner, true, "review", []);
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
});

  for (const scenario of [
    { name: "the first product conflicts", shared: true, owner: 0, conflict: true, wait: true },
  ]) it(`keeps every owed finding and Builder conversation: ${scenario.name}`, async () => {
  return engineCases.use("petrina-wait-repair-", async caseOwner => {
    const f = await fixture(caseOwner, scenario.shared);
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
});

  it.each(["checks", "acceptance"] as const)("keeps pending %s repairs and full review after a conflict survives pause and restart", async kind => {
  return engineCases.use("petrina-wait-repair-", async caseOwner => {
    const f = await fixture(caseOwner, true, kind);
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
});
