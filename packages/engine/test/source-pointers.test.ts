import { hintProducts } from "@petrina/core";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ROLES, createDemoState, type JourneyAgentInput, type Role, type Task, type WorkChoice } from "@petrina/core";
import { AgentBrowser } from "../src/browser.js";
import { Context } from "../src/context.js";
import { Engine } from "./engine.js";
import type { GuideKeeper } from "../src/guide-keeper.js";
import type { MTask } from "../src/kernel.js";
import { BriefResult, BuildResult, contractFor, PlanResult } from "../src/roles.js";
import { checkSourceHints, currentSourcePointers } from "../src/source-pointers.js";
import { Fakes, git, makeProduct, removeDir, tempDir } from "./fixtures.js";

it("carries only bounded current source locations to design or a first builder, never independent reviewers", async () => {
  const root = tempDir("petrina-source-pointers-");
  const engine = new Engine(join(root, "data"), { usageCommands: { codex: null, grok: null },  });
  try {
    engine.setPoolPaused(true);
    const copy = await makeProduct(root);
    const productId = await engine.addProduct(copy);
    const id = engine.addTask({ productId, title: "Choose the design independently", backlog: true });
    const task = engine.task(id)!;
    executionFor(task).work.worktree = copy;
    const revision = await git(copy, "rev-parse", "HEAD");
    const pointer = { productId, revision, path: "README.md" };
    task.sourcePointers = [pointer, pointer, { ...pointer, revision: "f".repeat(40) }, { ...pointer, path: "absent.md" }, { ...pointer, productId: "another-product" }];
    expect(await currentSourcePointers(repositoryView(executionFor(task)), task.sourcePointers)).toEqual([pointer]);
    const guide = { pendingPoints: async () => [] } as unknown as GuideKeeper;
    for (const role of ["architect", "builder"]) {
      const section = (await new Context(engine, guide).sectionsFor(executionFor(task), role)).find((entry) => entry.title.startsWith("Previously inspected"))!;
      expect(section.body).toContain(`${productId}: README.md (source version ${revision})`);
      expect(section.body).toContain("selection can steer attention");
      expect(section.body).toContain("no recommendations or extra requirements");
      expect(section.body.length).toBeLessThan(700);
    }
    for (const role of ["code-reviewer", "security-reviewer", "design-reviewer", "verifier"]) {
      expect((await new Context(engine, guide).sectionsFor(executionFor(task), role)).some((entry) => entry.title.startsWith("Previously inspected"))).toBe(false);
    }
    task.fixing = true;
    expect((await new Context(engine, guide).sectionsFor(executionFor(task), "builder")).some((entry) => entry.title.startsWith("Previously inspected"))).toBe(false);
    task.fixing = false;
    task.plan = { stages: [{ id: "design", kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-high"] }], rationale: "Design first", plannerProfileId: "opus-high" };
    task.brief = { summary: "Choose independently", forUsers: [], areas: [], risks: [], acceptance: [] };
    expect((await new Context(engine, guide).sectionsFor(executionFor(task), "builder")).some((entry) => entry.title.startsWith("Previously inspected"))).toBe(false);
    task.brief.sourcePointers = [pointer];
    task.sourcePointers = [];
    for (const role of ["architect", "builder"]) {
      expect((await new Context(engine, guide).sectionsFor(executionFor(task), role)).find((entry) => entry.title.startsWith("Previously inspected"))?.body).toContain("README.md");
    }
    expect((await new Context(engine, guide).sectionsFor(executionFor(task), "design-reviewer")).some((entry) => entry.title.startsWith("Previously inspected"))).toBe(false);
    engine.commitNow();
    expect(engine.store.loadActive()!.tasks.find((entry) => entry.id === id)!.sourcePointers).toEqual(task.sourcePointers);
    expect(engine.store.loadActive()!.tasks.find((entry) => entry.id === id)!.brief!.sourcePointers).toEqual([pointer]);
    writeFileSync(join(copy, "VERSION"), "2.0.0\n");
    await git(copy, "add", "VERSION");
    await git(copy, "commit", "-q", "-m", "A different source version");
    expect(await currentSourcePointers(repositoryView(executionFor(task)), [pointer])).toEqual([]);
  } finally { await engine.shutdown(); removeDir(root); }
});


it("keeps each valid hint by its exact product id and leaves out the rest without failing the result", () => {
  const pointer = { productId: "shop", revision: "a".repeat(40), path: "docs/design.md" };
  for (const none of [undefined, null, []]) expect(checkSourceHints(none, ["shop"])).toEqual({ pointers: [] });
  const site = { ...pointer, productId: "site" };
  const mixed = checkSourceHints([pointer, { ...pointer, recommendation: "Use my preferred design" }, { ...pointer, path: "../other-product" }, { ...pointer, revision: "main" }, { ...pointer, productId: "acme/shop" }, { ...pointer, productId: " shop" }, pointer, site], ["shop", "site"]);
  expect(mixed).toEqual({ pointers: [pointer, site], left: "Left out 5 optional source locations: 2 did not name one of this task's products by its exact id; 3 were not repository locations at a full source version. Kept 2." });
  const many = Array.from({ length: 10 }, (_, index) => ({ ...pointer, path: `file-${index}.md` }));
  expect(checkSourceHints([...many.slice(0, 8), many[0], ...many.slice(8)], ["shop"])).toEqual({ pointers: many.slice(0, 8), left: "Left out 2 optional source locations: 2 went past the limit of eight. Kept 8." });
  // The current version is settled only when hints are passed on: an older copy listed first never displaces it.
  const older = { ...pointer, revision: "b".repeat(40) };
  expect(checkSourceHints([older, pointer, { ...pointer, revision: "A".repeat(40) }, older], ["shop"])).toEqual({ pointers: [older, pointer] });
  expect(checkSourceHints("docs/design.md", ["shop"])).toEqual({ pointers: [], left: "Left out 1 optional source location: 1 was not a repository location at a full source version. Kept none." });
  expect(checkSourceHints([pointer], [])).toEqual({ pointers: [], left: "Left out 1 optional source location: 1 did not name one of this task's products by its exact id. Kept none." });
  // Optional hints never decide whether the rest of a plan or brief is usable; required fields keep their checks.
  expect(BriefResult.safeParse({ summary: "A brief", acceptance: ["Done"], sourcePointers: "docs/design.md" }).success).toBe(true);
  expect(BriefResult.safeParse({ summary: "A brief", acceptance: [], sourcePointers: [pointer] }).success).toBe(false);
  expect(PlanResult.safeParse({ rationale: "Build it", stages: [{ kind: "do", title: "Build", roleId: "builder" }], sourcePointers: [...many, { ...pointer, revision: "main" }] }).success).toBe(true);
  expect(hintProducts({ productId: "shop", repositories: [{ productId: "shop", delivery: "local", completedStages: [] }, { productId: "site", delivery: "local", completedStages: [], removed: true }] })).toEqual(["shop"]);
  expect(hintProducts({ productId: "shop" })).toEqual(["shop"]);
});

it("names the exact registered product ids to built-in, renamed and added design authors and to the planner", () => {
  const state = createDemoState(1_000_000_000);
  const base: Task = { ...state.tasks[0]!, productId: "petrina-ai", repositories: undefined, selectedProducts: [{ productId: "petrina-ai", startFrom: { kind: "default" }, delivery: "pull-request" }] };
  const shared: Task = { ...base, repositories: ["shop", "site", "gone"].map((productId) => ({ productId, delivery: "local", completedStages: [], ...(productId === "gone" ? { removed: true } : {}) })) };
  const job = (role: Role, task: Task) => contractFor(role).instructions({ task, product: state.products[0]!, role, roles: BUILT_IN_ROLES, profiles: state.profiles, tools: state.tools, worktree: "/w", branch: "b", base: "origin/main", defaultBranch: "main", sections: [] });
  const architect = BUILT_IN_ROLES.find((role) => role.id === "architect")!;
  for (const role of [architect, { ...architect, name: "Designer", instructions: "Design the change." }, { ...architect, id: "added-designer", name: "Designer", added: true, instructions: "Design the change." }]) {
    expect(job(role, base)).toContain(`productId: "petrina-ai" (this task's registered product id)`);
    expect(job(role, shared)).toContain(`productId: one of "shop", "site" (this task's registered product ids)`);
    expect(job(role, base)).toContain("never a GitHub repository, folder or product name");
  }
  expect(job(BUILT_IN_ROLES.find((role) => role.id === "planner")!, base)).toContain(`productId: the registered id of a product in worksOn (selected now: "petrina-ai")`);
});

const HINTS = "Previously inspected source locations (verify independently)";
const signal = () => new AbortController().signal;

// Native ACP still receives the prompts; this contract does not need a browser server.
let browser: ReturnType<typeof spyOn<typeof AgentBrowser, "start">>;
beforeAll(() => { browser = spyOn(AgentBrowser, "start").mockResolvedValue(undefined as never); });
afterAll(() => browser.mockRestore());

/** Registered products with private copies, scripted agents, and the real planner, design and context code. */
async function handoff(products: readonly { id: string; repo: string }[]) {
  const root = tempDir("petrina-source-hints-");
  const fakes = new Fakes(join(root, "fake"));
  const engine = new Engine(join(root, "data"), {
    agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir],
    toolPath: () => process.execPath, usageCommands: { codex: null, grok: null, antigravity: null },
  });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  await engine.checkTools();
  const copies: Record<string, string> = {};
  for (const { id, repo } of products) {
    copies[id] = await makeProduct(join(root, id));
    engine.s.products.push({ id, name: `Product ${id}`, repo, path: copies[id], defaultBranch: "main", tone: "blue" });
  }
  engine.s.pool.paused = false;
  const head = (id: string) => git(copies[id]!, "rev-parse", "HEAD");
  const commit = async (id: string, file: string) => {
    writeFileSync(join(copies[id]!, file), `${file}\n`);
    await git(copies[id]!, "add", file);
    await git(copies[id]!, "commit", "-q", "-m", `Add ${file}`);
    return head(id);
  };
  const plan = (task: MTask) => engine["planning"].runPlanner(task, signal());
  const design = (task: MTask, productId?: string) => {
    const index = task.plan!.stages.findIndex((stage) => stage.kind === "converge");
    task.stageIndex = index;
    task.sub = 0;
    const scope = executionFor(task, productId);
    delete scope.work.conversation;
    return engine["design"].runConverge(scope, task.plan!.stages[index]!, signal());
  };
  const build = (task: MTask, productId?: string) => {
    task.stageIndex = task.plan!.stages.findIndex((stage) => stage.roleId === "builder");
    const scope = executionFor(task, productId);
    delete scope.work.conversation;
    return engine["turns"].turn(scope, "builder", "sol-xhigh", () => engine["context"].sectionsFor(scope, "builder"), BuildResult, signal());
  };
  const close = async () => { await engine.shutdown(); removeDir(root); };
  return { engine, fakes, copies, head, commit, plan, design, build, close };
}

/** The receiving agent's latest saved input, which must show any hints in its sections, manifest and exact text alike. */
function delivered(task: MTask, roleId: string): string[] {
  const input = task.journey!.flatMap((step) => step.agentInputs ?? []).filter((entry) => entry.roleId === roleId).at(-1) as JourneyAgentInput;
  const section = input.sections.find((entry) => entry.title === HINTS);
  const listed = input.manifest!.filter((entry) => entry.name === HINTS);
  const exact = readFileSync(input.exact!.file, "utf8");
  if (!section) {
    expect(listed).toEqual([]);
    expect(exact).not.toContain(HINTS);
    return [];
  }
  expect(listed).toEqual([expect.objectContaining({ kind: "text", size: section.body.length })]);
  expect(exact).toContain(`## ${HINTS}\n${section.body}`);
  return section.body.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
}

const instructions = (task: MTask, roleId: string) => task.journey!.flatMap((step) => step.agentInputs ?? []).filter((entry) => entry.roleId === roleId).at(-1)!.instructions;
const notes = (task: MTask) => task.timeline.filter((entry) => entry.text.startsWith("Left out")).map((entry) => `${entry.roleId}: ${entry.text}`);
const line = (productId: string, path: string, revision: string) => `${productId}: ${path} (source version ${revision})`;

describe.concurrent("source hints between agents", () => {
  it("hands a single product's valid hints from the planner to the Architect and the first Builder, by exact product id", async () => {
    const f = await handoff([{ id: "petrina-ai", repo: "cristipufu/petrina-ai" }, { id: "elsewhere", repo: "local/elsewhere" }]);
    try {
      const old = await f.head("petrina-ai");
      const head = await f.commit("petrina-ai", "NOTES.md");
      const at = (path: string, productId = "petrina-ai", revision = head) => ({ productId, revision, path });
      const task = f.engine.task(f.engine.addTask({ productId: "petrina-ai", title: "Keep hints", description: "Keep navigation hints tied to products.", backlog: true }))!;
      f.fakes.scenario({ architect: "plain", builder: "plain", sourcePointers: { planner: [
        at("README.md", "petrina-ai", old), at("README.md"), at("README.md", "cristipufu/petrina-ai"), at("NOTES.md", "cristipufu/petrina-ai"), at("README.md"),
        at("docs/guide.md", "unknown-product"), at("README.md", "elsewhere"), { ...at("NOTES.md"), recommendation: "Prefer my design" }, at("../outside"), "README.md",
        at("NOTES.md"), at("VERSION", "petrina-ai", old), at("absent.md"),
      ] } });
      await f.plan(task);
      // One planner turn: optional hints never send the plan back for another one.
      expect(f.fakes.prompts("planner")).toHaveLength(1);
      expect(instructions(task, "planner")).toContain('productId: the registered id of a product in worksOn (selected now: "petrina-ai")');
      expect(task.sourcePointers).toEqual([at("README.md", "petrina-ai", old), at("README.md"), at("NOTES.md"), at("VERSION", "petrina-ai", old), at("absent.md")]);
      expect(notes(task)).toEqual(["planner: Left out 7 optional source locations: 4 did not name one of this task's products by its exact id; 3 were not repository locations at a full source version. Kept 5."]);
      Object.assign(executionFor(task).work, { worktree: f.copies["petrina-ai"], branch: "main", base: "main", baseSha: head });

      f.fakes.scenario({ architect: "plain", builder: "plain", sourcePointers: { architect: [at("VERSION", "petrina-ai", old), at("VERSION"), at("VERSION", "cristipufu/petrina-ai"), at("VERSION")] } });
      await f.design(task);
      expect(instructions(task, "architect")).toContain('productId: "petrina-ai" (this task\'s registered product id)');
      // Only current locations reach the Architect: old revisions and the missing file stay out, and an older copy listed first does not displace the current one.
      expect(delivered(task, "architect")).toEqual([line("petrina-ai", "README.md", head), line("petrina-ai", "NOTES.md", head)]);
      expect(task.brief!.sourcePointers).toEqual([at("VERSION", "petrina-ai", old), at("VERSION")]);

      // A revision that omits its list keeps the earlier brief hints that still qualify.
      f.fakes.scenario({ architect: "plain", builder: "plain" });
      task.rounds[task.plan!.stages[task.stageIndex]!.id] = 2;
      await f.design(task);
      expect(delivered(task, "architect")).toEqual([line("petrina-ai", "VERSION", head), line("petrina-ai", "README.md", head), line("petrina-ai", "NOTES.md", head)]);
      expect(task.brief!.sourcePointers).toEqual([at("VERSION", "petrina-ai", old), at("VERSION")]);

      // Following the coordinator's call, a supplied list replaces the earlier one with its valid entries.
      const stageId = task.plan!.stages.find((stage) => stage.kind === "converge")!.id;
      task.call = { text: "Keep it small.", stageId, open: [], at: Date.now() };
      f.fakes.scenario({ architect: "plain", builder: "plain", sourcePointers: { architect: [at("NOTES.md", "petrina-ai", old), at("NOTES.md", "cristipufu/petrina-ai"), at("NOTES.md"), at("README.md", "elsewhere")] } });
      await f.design(task);
      expect(task.brief!.sourcePointers).toEqual([at("NOTES.md", "petrina-ai", old), at("NOTES.md")]);
      expect(f.fakes.prompts("architect")).toHaveLength(3);

      // After design, the first Builder gets the approved design's hints, not the planner's.
      await f.build(task);
      expect(delivered(task, "builder")).toEqual([line("petrina-ai", "NOTES.md", head)]);
      expect(notes(task).slice(1)).toEqual([
        "architect: Left out 1 optional source location: 1 did not name one of this task's products by its exact id. Kept 2.",
        "architect: Left out 2 optional source locations: 2 did not name one of this task's products by its exact id. Kept 2.",
      ]);

      // An explicit empty list clears the brief's hints; the Builder then gets none, and the planner's stay with design.
      task.stageIndex = task.plan!.stages.findIndex((stage) => stage.kind === "converge");
      f.fakes.scenario({ architect: "plain", builder: "plain", sourcePointers: { architect: [] } });
      await f.design(task);
      expect(task.brief!.sourcePointers).toBeUndefined();
      await f.build(task);
      expect(delivered(task, "builder")).toEqual([]);
    } finally { await f.close(); }
  });

  it("hands the planner's valid hints straight to the first Builder when design is skipped, and nothing when there are none", async () => {
    const f = await handoff([{ id: "petrina-ai", repo: "cristipufu/petrina-ai" }]);
    try {
      const head = await f.head("petrina-ai");
      const at = (path: string, productId = "petrina-ai") => ({ productId, revision: head, path });
      const tasks = ["With hints", "Without hints"].map((title) => f.engine.task(f.engine.addTask({ productId: "petrina-ai", title, backlog: true }))!);
      f.fakes.scenario({ planner: "short", builder: "plain", sourcePointers: { planner: [at("README.md", "cristipufu/petrina-ai"), at("VERSION", "cristipufu/petrina-ai")] } });
      await f.plan(tasks[0]!);
      // Exactly the same locations under the repository address are all left out.
      expect(tasks[0]!.sourcePointers).toBeUndefined();
      f.fakes.scenario({ planner: "short", builder: "plain", sourcePointers: { planner: [at("README.md", "cristipufu/petrina-ai"), at("VERSION"), at("README.md")] } });
      await f.plan(tasks[0]!);
      f.fakes.scenario({ planner: "short", builder: "plain" });
      await f.plan(tasks[1]!);
      expect(tasks[1]!.sourcePointers).toBeUndefined();
      for (const task of tasks) Object.assign(executionFor(task).work, { worktree: f.copies["petrina-ai"], branch: "main", base: "main", baseSha: head });
      await f.build(tasks[0]!);
      expect(delivered(tasks[0]!, "builder")).toEqual([line("petrina-ai", "VERSION", head), line("petrina-ai", "README.md", head)]);
      await f.build(tasks[1]!);
      expect(delivered(tasks[1]!, "builder")).toEqual([]);
      expect(notes(tasks[1]!)).toEqual([]);
    } finally { await f.close(); }
  });

  it("keeps shared products' hints apart and drops a removed product's hints before saving or forwarding", async () => {
    const f = await handoff([{ id: "shop", repo: "local/shop" }, { id: "site", repo: "local/site" }, { id: "elsewhere", repo: "local/elsewhere" }]);
    try {
      const shop = await f.head("shop");
      const site = await f.commit("site", "SITE.md");
      const at = (productId: string, path: string) => ({ productId, revision: productId === "site" ? site : shop, path });
      const worksOn = ["shop", "site"].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "local" }) satisfies WorkChoice);
      const task = f.engine.task(f.engine.addTask({ productId: "shop", worksOn, title: "Share hints", backlog: true }))!;
      f.fakes.scenario({ architect: "plain", builder: "plain", sourcePointers: { planner: [
        at("shop", "README.md"), at("site", "README.md"), { ...at("shop", "README.md"), productId: "local/shop" }, at("elsewhere", "README.md"), at("shop", "SITE.md"), at("shop", "README.md"),
      ] } });
      await f.plan(task);
      expect(task.workRows!.map((row) => row.choice.productId)).toEqual(["shop", "site"]);
      // The same relative path in two products is two locations.
      expect(task.sourcePointers).toEqual([at("shop", "README.md"), at("site", "README.md"), at("shop", "SITE.md")]);
      expect(notes(task)).toEqual(["planner: Left out 2 optional source locations: 2 did not name one of this task's products by its exact id. Kept 3."]);
      task.repositories = ["shop", "site"].map((productId) => ({ productId, delivery: "local", completedStages: [], worktree: f.copies[productId], branch: "main", base: "main", baseSha: productId === "site" ? site : shop }));
      delete task.repository;
      task.activeProductId = "shop";

      f.fakes.scenario({ architect: "plain", builder: "plain", sourcePointers: { architect: [at("shop", "README.md"), at("site", "SITE.md"), at("shop", "SITE.md"), { ...at("site", "SITE.md"), productId: "local/site" }] } });
      await f.design(task, "shop");
      expect(instructions(task, "architect")).toContain('productId: one of "shop", "site" (this task\'s registered product ids)');
      // A path that exists only in another product is not passed off under this one.
      expect(delivered(task, "architect")).toEqual([line("shop", "README.md", shop), line("site", "README.md", site)]);
      expect(task.brief!.sourcePointers).toEqual([at("shop", "README.md"), at("site", "SITE.md"), at("shop", "SITE.md")]);
      await f.build(task, "shop");
      expect(delivered(task, "builder")).toEqual([line("shop", "README.md", shop), line("site", "SITE.md", site)]);

      // Removing a product drops its earlier hints from a revision that omits its list, and from forwarding.
      task.repositories[1]!.removed = true;
      f.fakes.scenario({ architect: "plain", builder: "plain" });
      await f.design(task, "shop");
      expect(instructions(task, "architect")).toContain('productId: "shop" (this task\'s registered product id)');
      expect(delivered(task, "architect")).toEqual([line("shop", "README.md", shop)]);
      expect(task.brief!.sourcePointers).toEqual([at("shop", "README.md"), at("shop", "SITE.md")]);
      expect(notes(task).at(-1)).toBe("architect: Left out 1 optional source location: 1 did not name one of this task's products by its exact id. Kept 2.");
      expect(await currentSourcePointers(repositoryView(executionFor(task, "shop")), [at("site", "README.md")])).toEqual([]);
      await f.build(task, "shop");
      expect(delivered(task, "builder")).toEqual([line("shop", "README.md", shop)]);
    } finally { await f.close(); }
  });
});
