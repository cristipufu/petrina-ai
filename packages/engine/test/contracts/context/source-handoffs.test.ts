import { executionFor, repositoryView } from "@petrina/orchestrator";
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JourneyAgentInput, type WorkChoice } from "@petrina/core";
import { Engine } from "../../engine.js";
import type { MTask } from "../../../src/kernel.js";
import { BuildResult } from "../../../src/roles.js";
import { currentSourcePointers } from "@petrina/repositories/source-pointers";
import { Fakes } from "../../fixtures.js";
import { git } from "@petrina/test-support/commands";
import { makeProduct } from "@petrina/test-support/repositories";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { scriptedToolProbe } from "../../scripted-probes.js";

const HINTS = "Previously inspected source locations (verify independently)";
const signal = () => new AbortController().signal;

/** Registered products with private copies, scripted agents, and the real planner, design and context code. */
async function handoff(products: readonly { id: string; repo: string }[]) {
  const root = tempDir("petrina-source-hints-");
  const fakes = new Fakes(join(root, "fake"));
  const engine = new Engine(join(root, "data"), {
    agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir],
    toolPath: () => process.execPath,
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "ready" }, gh: { status: "unknown" }, git: { status: "ready" }, node: { status: "ready" } }), usageCommands: { codex: null, grok: null, antigravity: null },
  });
  try {
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
  } catch (error) { await engine.shutdown(); removeDir(root); throw error; }
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
