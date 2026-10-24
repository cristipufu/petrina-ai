import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxItem, Task, TaskSource } from "@petrina/core";
import { Engine } from "./engine.js";
import { executionFor } from "@petrina/orchestrator";
import { AcceptedPoints } from "../src/accepted-points.js";
import { addLearnings, keptLearnings, Learnings } from "../src/learnings.js";
import * as gitOps from "../src/git.js";
import { Fakes, git, gitWith, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";
import { expectRejection } from "./rejections.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const INTRO = "What agents learned about working in this repository, added with the coordinator's OK.";
const BASE = `# Working on the demo\n\nKeep changes small.\n\n## Learnings\n\n${INTRO}\n\n- Run the package tests before delivering.\n`;
const SCRIPT_LESSON = "Engine tests script the stand-in agent through the JSON file named by --script; write it before the step starts.";
const TOOL_LESSON = "The stand-in agent used in engine tests reports token usage only when started with --tool=<tool id> (as the work-log tests do); without it, every turn records 'not reported'.";
const KEPT = "Kept both sets of approved learnings";

/** A file exactly as committed, without the helper's trimming. */
const show = (cwd: string, spec: string) => gitWith({ cwd, raw: true, timeoutMs: 30_000 }, "cat-file", "blob", spec);
const commit = async (cwd: string, message: string) => { await git(cwd, "add", "-A"); await git(cwd, "commit", "-q", "-m", message); return git(cwd, "rev-parse", "HEAD"); };

/** Two tasks on one product delivering locally, driven by fake agents. `ship` decides each delivery check. */
async function twoTasks(name: string, script: (root: string) => object = () => ({})) {
  const root = tempDir(`petrina-${name}-`);
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({});
  const scriptPath = join(root, "agents.json");
  writeFileSync(scriptPath, JSON.stringify({ ownFiles: true, ...script(root) }));
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, `--script=${scriptPath}`] });
  const repo = await makeProduct(root);
  writeFileSync(join(repo, "AGENTS.md"), BASE);
  await commit(repo, "Agent instructions");
  const productId = await engine.addProduct(repo);
  engine.setProductDelivery(productId, "local", true);
  const product = engine.s.products.find((entry) => entry.id === productId)!;
  // Each delivery check by its place among the task's checks: 1 for the first.
  const counted = new Map<string, number>(), perTask = new Map<string, number>();
  let ship = (_item: InboxItem, _count: number) => false;
  const find = (id: string) => engine.getState().tasks.find((task) => task.id === id) as Task;
  const until = <T>(check: () => T | undefined | false, what: string) => waitFor(() => {
    const done = check();
    if (done) return done;
    for (const task of engine.getState().tasks) if (task.state === "failed") throw new Error(`${task.title} failed: ${task.error}`);
    for (const item of engine.getState().inbox) {
      if (item.kind === "plan") engine.approve(item.id);
      else if (item.kind === "permission") engine.allow(item.id, "once");
      else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "delivery") {
        if (!counted.has(item.id)) perTask.set(item.taskId, counted.set(item.id, (perTask.get(item.taskId) ?? 0) + 1).get(item.id)!);
        if (ship(item, counted.get(item.id)!)) engine.approve(item.id);
      }
    }
    return undefined;
  }, what, 90_000);
  const checks = (id: string) => perTask.get(id) ?? 0;
  /** Accepted at the task's earlier delivery check: its next delivery writes it. */
  const accept = (text: string, fromTask: string) => { product.learnings = [...(product.learnings ?? []), { text, at: Date.now(), fromTask }]; };
  const sentBack = (task: Task | undefined) => task?.journey?.filter((step) => step.update || (step.work === "update" && step.tone === "back"))
    .map((step) => step.update ? "Builder (update)" : `Update branch: ${step.outcome}`) ?? [];
  return { root, engine, repo, productId, product, find, until, checks, accept, sentBack, setShip: (decide: typeof ship) => { ship = decide; } };
}

describe.concurrent("two deliveries that each add an approved lesson to AGENTS.md", () => {
  it("keeps main's lesson and the task's own when only those conflict, with no Builder turn", async () => {
    let hold = "";
    // The second task's reviewers wait while the first task lands, as in the observed case.
    const f = await twoTasks("learnings-update", (root) => {
      hold = join(root, "hold-review");
      writeFileSync(hold, "");
      return { hold: { title: "Greet visitors", file: hold, role: "code reviewer" } };
    });
    try {
      const second = f.engine.addTask({ productId: f.productId, title: "Greet visitors", description: "[no-check]" });
      await f.until(() => existsSync(`${hold}.reached`), "the second task's reviewers to start");
      const first = f.engine.addTask({ productId: f.productId, title: "Wave goodbye", description: "[no-check]" });
      f.accept(SCRIPT_LESSON, first);
      f.setShip((item) => item.taskId === first);
      await f.until(() => f.find(first)?.state === "done", "the first task to land");
      expect(await show(f.repo, "main:AGENTS.md")).toBe(`${BASE}- ${SCRIPT_LESSON}\n`);
      // Separately accepted for the second task, which writes it on its own branch at its delivery check.
      f.accept(TOOL_LESSON, second);
      rmSync(hold);
      await f.until(() => f.sentBack(f.engine.task(second)).length || f.checks(second), "the second task's delivery check");
      const task = f.engine.task(second)!, work = executionFor(task).work;
      // Only AGENTS.md conflicted, with nothing but approved lessons on each side: no send-back to the Builder.
      expect({ sentBack: f.sentBack(task), conflicting: work.updating?.files }).toEqual({ sentBack: [], conflicting: undefined });
      expect(task.reviewSessions).toBeDefined();
      expect(task.reviewFreshReasons).toBeUndefined();
      const worktree = work.worktree!;
      expect(await show(worktree, "HEAD:AGENTS.md")).toBe(`${BASE}- ${SCRIPT_LESSON}\n- ${TOOL_LESSON}\n`);
      expect(await git(worktree, "rev-parse", "HEAD~1")).toBe(await git(f.repo, "rev-parse", "main"));
      expect((await git(worktree, "diff", "--name-only", "HEAD~1", "HEAD")).split("\n")).toEqual(["AGENTS.md", "greet-visitors.txt"]);
      const update = task.journey!.find((step) => step.kind === "petrina" && step.work === "update")!;
      expect([update.outcome, update.reason, update.tone]).toEqual([KEPT, "up to date with main", undefined]);
      // The checks ran on the combined version before the delivery check.
      expect(work.checks?.tree).toBe(await git(worktree, "rev-parse", "HEAD^{tree}"));
      expect(task.journey!.findLastIndex((step) => !!step.productChecks?.length)).toBeGreaterThan(task.journey!.indexOf(update));
      expect(task.timeline.map((entry) => entry.text)).toContain(`Brought up to date with main (1 new commit there): main and this work only added approved learnings to AGENTS.md, so Petrina kept main's and added this work's: ${TOOL_LESSON}`);
      f.setShip(() => true);
      await f.until(() => f.find(second)?.state === "done", "the second task to land");
      expect(await show(f.repo, "main:AGENTS.md")).toBe(`${BASE}- ${SCRIPT_LESSON}\n- ${TOOL_LESSON}\n`);
      expect(await git(f.repo, "log", "--format=%s", "-3", "main")).toBe("Greet visitors\nWave goodbye\nAgent instructions");
    } finally {
      await f.engine.shutdown();
    }
  });

  it("asks again after an approval when the combining happens on the way out, with the checks run on the new version", async () => {
    const f = await twoTasks("learnings-approved");
    try {
      const first = f.engine.addTask({ productId: f.productId, title: "Wave goodbye", description: "[no-check]" });
      f.accept(TOOL_LESSON, first);
      await f.until(() => f.checks(first), "the first task's delivery check");
      // The first task wrote and reserved its lesson; the second writes only its own.
      const second = f.engine.addTask({ productId: f.productId, title: "Greet visitors", description: "[no-check]" });
      f.accept(SCRIPT_LESSON, second);
      await f.until(() => f.checks(second), "the second task's delivery check");
      f.setShip((item) => item.taskId === first);
      await f.until(() => f.find(first)?.state === "done", "the first task to land");
      f.setShip((item, count) => item.taskId === second && count === 1);
      await f.until(() => f.checks(second) === 2, "the second task's delivery check again");
      const task = f.engine.task(second)!, work = executionFor(task).work;
      expect(f.sentBack(task)).toEqual([]);
      const steps = task.journey!;
      const update = steps.findIndex((step) => step.work === "update");
      expect(steps[update]!.outcome).toBe(KEPT);
      expect(steps.slice(update + 1).map((step) => step.outcome)).toContain("Needs your OK again");
      expect(task.timeline.map((entry) => entry.text)).toContain("Main moved on, and on top of it this change reads differently from what you approved, so Petrina asks you again");
      expect(await show(work.worktree!, "HEAD:AGENTS.md")).toBe(`${BASE}- ${TOOL_LESSON}\n- ${SCRIPT_LESSON}\n`);
      expect(work.checks?.tree).toBe(await git(work.worktree!, "rev-parse", "HEAD^{tree}"));
      expect(work.approvedSha).toBeUndefined();
      f.setShip(() => true);
      await f.until(() => f.find(second)?.state === "done", "the second task to land");
      expect(await show(f.repo, "main:AGENTS.md")).toBe(`${BASE}- ${TOOL_LESSON}\n- ${SCRIPT_LESSON}\n`);
    } finally {
      await f.engine.shutdown();
    }
  });
});

const X1 = "Run engine tests through the package runner so its cleanup runs.";
const X2 = "Keep disposable repositories outside the working copy.";
const X3 = "Run bun test --parallel only for diagnostics.";
const Y1 = "Read the review guide before building.";
const Y2 = "Run bun test parallel only through the runner.";
const Y3 = "Name every test fixture after the case it proves.";

/**
 * One task on a product with AGENTS.md, its branch in its own working copy, and main moving on in the product's
 * clone, compared locally only. Lessons land on main through Petrina's writer, for another task, and on the task's
 * branch through Petrina's own learnings write.
 */
async function fixture(base = BASE) {
  const root = tempDir("petrina-kept-learnings-");
  roots.push(root);
  const open = () => {
    const engine = new Engine(join(root, "data"), { usageCommands: { codex: null, grok: null, antigravity: null } });
    engine.setPoolPaused(true);
    return engine;
  };
  const engine = open();
  const added = await productWithTask(engine, root, base, "product");
  const other = engine.addTask({ productId: added.productId, title: "Delivered first", backlog: true });
  const id = engine.addTask({ productId: added.productId, title: "Keep both lessons", backlog: true });
  const task = engine.task(id)!;
  task.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [{ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["opus-high"] }] };
  task.stageIndex = 0;
  Object.assign(executionFor(task).work, added.work);
  const f = { root, engine, id, other, ...added };
  const scope = () => executionFor(f.engine.task(id)!);
  const product = () => f.engine.s.products.find((entry) => entry.id === f.productId)!;
  const accept = (text: string, fromTask: string, writtenOn?: string) => {
    product().learnings = [...(product().learnings ?? []), { text, at: Date.now(), fromTask, ...(writtenOn ? { writtenOn } : {}) }];
  };
  return Object.assign(f, {
    scope,
    product,
    accept,
    /** Another task's delivery of its accepted lessons, as Petrina's writer adds them. */
    async land(lessons: string[], by = other): Promise<string> {
      for (const text of lessons) accept(text, by, by);
      addLearnings(f.repo, lessons);
      return commit(f.repo, "Another delivery");
    },
    /** A change on main by hand. */
    async edit(change: (text: string) => string, file = "AGENTS.md"): Promise<string> {
      const path = join(f.repo, file);
      writeFileSync(path, change(existsSync(path) ? readFileSync(path, "utf8") : ""));
      return commit(f.repo, "A change by hand");
    },
    /** This task's accepted lessons, written on its branch by Petrina at its delivery check. */
    async own(lessons: string[]): Promise<void> {
      for (const text of lessons) accept(text, id);
      await new Learnings(f.engine).write(scope());
    },
    /** What Git's three-way merge leaves in AGENTS.md, conflict markers and all. */
    async gitMerge(): Promise<string> {
      const merged = await gitOps.mergeTree(f.copy, await git(f.repo, "rev-parse", "main"));
      return show(f.copy, `${merged!.tree}:AGENTS.md`);
    },
    update: () => f.engine["updates"].upToDate(scope(), new AbortController().signal),
    file: () => show(f.copy, "HEAD:AGENTS.md"),
    lines: () => scope().task.timeline.map((entry) => entry.text),
    async restart(): Promise<void> {
      await f.engine.shutdown();
      f.engine = open();
    },
  });
}

/** A product whose clone has AGENTS.md (`base`) on main, and the task's branch with its own change in a working copy. */
async function productWithTask(engine: Engine, root: string, base: string, name: string) {
  const repo = await makeProduct(join(root, name));
  if (base) writeFileSync(join(repo, "AGENTS.md"), base);
  writeFileSync(join(repo, "greeting.txt"), "Hi\n");
  const start = await commit(repo, "Agent instructions");
  const productId = await engine.addProduct(repo, name);
  const entry = engine.s.products.find((candidate) => candidate.id === productId)!;
  delete entry.remote;
  entry.remoteRefused = "No GitHub in this fixture";
  const copy = join(root, `${name}-task`);
  await git(repo, "worktree", "add", "-q", "-b", `task-${name}`, copy, start);
  writeFileSync(join(copy, `${name}-change.txt`), "The task's own change\n");
  await commit(copy, "The task's change");
  return { repo, copy, productId, start, work: { worktree: copy, branch: `task-${name}`, baseSha: start, base: "main", delivery: "local" as const } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

type History = "a grafts file" | "an ordinary commit index" | "a forged commit index";

/**
 * Local records in the clone's shared Git folder that tell Git `commit`'s parent is `parent`, while the commits and
 * files stay intact: a grafts file, or Git's commit index (commit-graph) written as usual and then edited, its
 * checksum recalculated. An ordinary commit index, as Git writes it, changes nothing.
 */
async function rewriteParent(repo: string, how: History, commit: string, parent: string): Promise<void> {
  if (how === "a grafts file") {
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "grafts"), `${commit} ${parent}\n`);
  } else {
    await git(repo, "commit-graph", "write", "--reachable");
    if (how === "a forged commit index") {
      const path = join(repo, ".git", "objects", "info", "commit-graph");
      const data = readFileSync(path);
      // The chunk table (an id and an offset each) after the header; the fan-out's last entry counts the commits.
      const chunks = new Map(Array.from({ length: data[6]! }, (_, index) => [data.toString("latin1", 8 + 12 * index, 12 + 12 * index), Number(data.readBigUInt64BE(12 + 12 * index))] as const));
      const ids = chunks.get("OIDL")!, entries = chunks.get("CDAT")!, count = data.readUInt32BE(chunks.get("OIDF")! + 255 * 4);
      const position = (sha: string) => Array.from({ length: count }, (_, index) => data.toString("hex", ids + 20 * index, ids + 20 * index + 20)).indexOf(sha);
      expect([position(commit), position(parent)].every((index) => index >= 0)).toBe(true);
      data.writeUInt32BE(position(parent), entries + 36 * position(commit) + 20);
      createHash("sha1").update(data.subarray(0, -20)).digest().copy(data, data.length - 20);
      chmodSync(path, 0o644);
      writeFileSync(path, data);
    }
  }
}

/** `commit`'s parent rewritten as above, so that Git's own history of main skips `hidden`, unless the commit index is ordinary. */
async function rewriteHistory(repo: string, how: History, commit: string, parent: string, hidden: string): Promise<void> {
  await rewriteParent(repo, how, commit, parent);
  expect((await git(repo, "rev-list", "main")).split("\n").includes(hidden)).toBe(how === "an ordinary commit index");
}

/** The task went back to its Builder, its working copy on main with AGENTS.md exactly as Git merged it. */
async function toBuilder(f: Fixture, merged: string, files = ["AGENTS.md"], source = "main") {
  expect(await f.update()).toBe("conflict");
  expect(f.scope().work.updating?.files).toEqual(files);
  expect(await git(f.copy, "rev-parse", "HEAD")).toBe(await git(f.repo, "rev-parse", "main"));
  expect(readFileSync(join(f.copy, "AGENTS.md"), "utf8")).toBe(merged);
  expect(f.scope().task.journey!.find((step) => step.work === "update")).toMatchObject({ outcome: `${files.length === 1 ? "1 file conflicts" : `${files.length} files conflict`} with ${source}`, tone: "back" });
}

/** Petrina kept both sides: AGENTS.md is `expected` in full, the task's one commit sits on main, and no Builder was needed. */
async function kept(f: Fixture, expected: string) {
  const main = await git(f.repo, "rev-parse", "main");
  expect(await f.update()).toBe("moved");
  expect(f.scope().work.updating).toBeUndefined();
  expect(await f.file()).toBe(expected);
  expect(f.scope().work.savedVersion).toEqual({ commit: await git(f.copy, "rev-parse", "HEAD"), tree: await git(f.copy, "rev-parse", "HEAD^{tree}") });
  expect(await git(f.copy, "rev-parse", "HEAD~1")).toBe(main);
  expect(await git(f.copy, "status", "--porcelain")).toBe("");
  // Every other file is the clean combination: main's, plus the task's own change.
  const changed = (await git(f.copy, "diff", "--name-only", "HEAD~1", "HEAD")).split("\n");
  expect(changed).toEqual([...(expected === await show(f.repo, "main:AGENTS.md") ? [] : ["AGENTS.md"]), "product-change.txt"]);
  expect(f.scope().task.stageIndex).toBe(0);
  expect(f.scope().task.journey!.filter((step) => step.work === "update").map((step) => [step.outcome, step.tone])).toEqual([[KEPT, undefined]]);
}

describe.concurrent("an update where main and the task only added approved learnings", () => {
  for (const [first, then] of [[X1, Y1], [Y1, X1]] as const) it(`puts main's lesson first and the task's after it, delivered in either order (${first === X1 ? "X then Y" : "Y then X"})`, async () => {
    const f = await fixture();
    try {
      await f.land([first]);
      await f.own([then]);
      await kept(f, `${BASE}- ${first}\n- ${then}\n`);
      expect(f.lines()).toContain(`Brought up to date with main (1 new commit there): main and this work only added approved learnings to AGENTS.md, so Petrina kept main's and added this work's: ${then}`);
      // The task's lesson stays reserved for it, and the next learnings write adds nothing again.
      expect(f.product().learnings!.find((line) => line.text === then)!.writtenOn).toBe(f.id);
      await new Learnings(f.engine).write(f.scope());
      expect(await f.file()).toBe(`${BASE}- ${first}\n- ${then}\n`);
      expect(await f.update()).toBe("current");
    } finally { await f.engine.shutdown(); }
  });

  it("keeps both sides' approved learnings with Git's commit index written as usual", async () => {
    const f = await fixture();
    try {
      const landed = await f.land([X1]);
      await f.own([Y1]);
      await rewriteHistory(f.repo, "an ordinary commit index", landed, f.start, landed);
      await kept(f, `${BASE}- ${X1}\n- ${Y1}\n`);
    } finally { await f.engine.shutdown(); }
  });

  it("keeps several lessons from each side in order, each once, before the next section", async () => {
    const f = await fixture(`${BASE}\n## Checks\n\nRun them all.\n`);
    try {
      await f.land([X1, X2]);
      await f.land([X3]);
      await f.own([Y1, Y2, Y3]);
      // X3 and Y2 differ only in a flag; the same-lesson rule keeps them apart, so both stay.
      await kept(f, `${BASE}- ${X1}\n- ${X2}\n- ${X3}\n- ${Y1}\n- ${Y2}\n- ${Y3}\n\n## Checks\n\nRun them all.\n`);
      expect(f.lines()).toContain(`Brought up to date with main (2 new commits there): main and this work only added approved learnings to AGENTS.md, so Petrina kept main's and added this work's: ${Y1}; ${Y2}; ${Y3}`);
    } finally { await f.engine.shutdown(); }
  });

  for (const ours of [[Y1, Y2], [Y1]]) it(`keeps a lesson main already has word for word once${ours.length === 1 ? ", when it has all of the task's" : ""}`, async () => {
    const f = await fixture();
    try {
      await f.land([Y1, X1]);
      // Main took them in; later this task was offered and approved the same words again, and wrote them.
      await new AcceptedPoints(f.engine).sweep();
      expect(f.product().learnings).toEqual([]);
      await f.own(ours);
      await kept(f, `${BASE}- ${Y1}\n- ${X1}\n${ours.length > 1 ? `- ${Y2}\n` : ""}`);
      expect(f.lines()).toContain(`Brought up to date with main (1 new commit there): main and this work only added approved learnings to AGENTS.md, so Petrina ${ours.length > 1 ? `kept main's and added this work's: ${Y2}; already on main, kept once` : "kept main's, which already has this work's"}: ${Y1}`);
    } finally { await f.engine.shutdown(); }
  });

  it("keeps a lesson approved while the task is brought up to date waiting and reserved for the next write", async () => {
    const f = await fixture();
    const versions = gitOps.versionsBetween;
    let reads = 0;
    const read = spyOn(gitOps, "versionsBetween").mockImplementation(async (...args) => {
      // The coordinator accepts another lesson while Petrina reads main's history (only this fixture's reads).
      if (args[0] === f.copy) {
        reads += 1;
        f.engine.addLessons(f.engine.raise(f.scope().task, "learnings", "What agents learned", false, { body: `- ${Y3}` }), [0]);
      }
      return versions(...args);
    });
    try {
      await f.land([X1]);
      await f.own([Y1]);
      await kept(f, `${BASE}- ${X1}\n- ${Y1}\n`);
      expect(reads).toBe(1);
      expect(f.product().learnings!.map((line) => [line.text, line.writtenOn])).toEqual([[X1, f.other], [Y1, f.id], [Y3, undefined]]);
      await new Learnings(f.engine).write(f.scope());
      expect(await f.file()).toBe(`${BASE}- ${X1}\n- ${Y1}\n- ${Y3}\n`);
      expect(f.product().learnings!.find((line) => line.text === Y3)!.writtenOn).toBe(f.id);
    } finally { read.mockRestore(); await f.engine.shutdown(); }
  });

  it("proves main's lessons with receipts kept across a restart, and a restart after the update changes nothing", async () => {
    const f = await fixture();
    try {
      const landed = await f.land([X1]);
      await new AcceptedPoints(f.engine).sweep();
      await f.restart();
      expect(f.product().learnings).toEqual([]);
      expect(f.product().learningReceipts).toEqual([{ text: X1, fromTask: f.other, writtenOn: f.other, foundOn: landed }]);
      await f.own([Y1]);
      await kept(f, `${BASE}- ${X1}\n- ${Y1}\n`);
      await f.restart();
      const head = await git(f.copy, "rev-parse", "HEAD");
      expect(await f.update()).toBe("current");
      await new Learnings(f.engine).write(f.scope());
      expect(await git(f.copy, "rev-parse", "HEAD")).toBe(head);
      expect(await f.file()).toBe(`${BASE}- ${X1}\n- ${Y1}\n`);
      expect(f.scope().task.journey!.filter((step) => step.work === "update")).toHaveLength(1);
    } finally { await f.engine.shutdown(); }
  });

  for (const reviewed of ["with", "before"] as const) it(`carries the version the last review saw onto main, so the next round compares only what changed since (reviewed ${reviewed} the task's lesson)`, async () => {
    const f = await fixture();
    try {
      await f.land([X1]);
      if (reviewed === "before") f.scope().work.reviewedSha = await git(f.copy, "rev-parse", "HEAD");
      await f.own([Y1]);
      if (reviewed === "with") f.scope().work.reviewedSha = await git(f.copy, "rev-parse", "HEAD");
      // A fix after that review: the one change the next round should see, with the lesson if it came later.
      writeFileSync(join(f.copy, "product-change.txt"), "The task's fixed change\n");
      await commit(f.copy, "A fix after the review");
      await kept(f, `${BASE}- ${X1}\n- ${Y1}\n`);
      const carried = f.scope().work.reviewedSha!;
      expect(carried).toBeDefined();
      expect(await git(f.copy, "rev-parse", `${carried}~1`)).toBe(await git(f.repo, "rev-parse", "main"));
      expect((await git(f.copy, "diff", "--name-only", carried, "HEAD")).split("\n")).toEqual(reviewed === "with" ? ["product-change.txt"] : ["AGENTS.md", "product-change.txt"]);
    } finally { await f.engine.shutdown(); }
  });

  it("leaves a conflict already with the Builder there after a restart, even once main's lesson is proven", async () => {
    const f = await fixture();
    try {
      await f.land([X1]);
      f.product().learnings = f.product().learnings!.filter((line) => line.text !== X1);
      await f.own([Y1]);
      const merged = await f.gitMerge();
      await toBuilder(f, merged);
      f.accept(X1, f.other, f.other);
      await f.restart();
      expect(f.scope().work.updating?.files).toEqual(["AGENTS.md"]);
      expect(await f.update()).toBe("current");
      await f.engine["updates"].reopen(f.scope());
      expect(f.scope().work.updating?.files).toEqual(["AGENTS.md"]);
      expect(readFileSync(join(f.copy, "AGENTS.md"), "utf8")).toBe(merged);
    } finally { await f.engine.shutdown(); }
  });
});

describe.concurrent("an update that still goes to the Builder", () => {
  const cases: [string, (f: Fixture) => Promise<void>][] = [
    ["a task lesson nobody approved", async (f) => { await f.land([X1]); addLearnings(f.copy, [Y1]); await commit(f.copy, "By hand"); }],
    ["a task lesson the coordinator declined", async (f) => { await f.land([X1]); f.product().learningsDeclined = [Y1]; addLearnings(f.copy, [Y1]); await commit(f.copy, "By hand"); }],
    ["an approved task lesson with changed punctuation", async (f) => { await f.land([X1]); await f.own([Y1]); await git(f.copy, "reset", "-q", "--hard", "HEAD~1"); addLearnings(f.copy, [Y1.replace(/\.$/, "!")]); await commit(f.copy, "Reworded"); }],
    ["a task lesson written for another task", async (f) => { await f.land([X1]); f.accept(Y1, f.other, f.other); addLearnings(f.copy, [Y1]); await commit(f.copy, "Copied"); }],
    ["a task lesson approved but never written by Petrina", async (f) => { await f.land([X1]); f.accept(Y1, f.id); addLearnings(f.copy, [Y1]); await commit(f.copy, "By hand"); }],
    ["a main lesson with no record", async (f) => { await f.land([X1]); f.product().learnings = []; await f.own([Y1]); }],
    ["a main lesson whose record says this task wrote it", async (f) => { await f.land([X1], f.id); await f.own([Y1]); }],
    ["a main lesson whose receipt was dropped", async (f) => { await f.land([X1]); await new AcceptedPoints(f.engine).sweep(); f.product().learningReceipts = []; await f.own([Y1]); }],
    ["a task lesson that is a differently written main lesson", async (f) => { await f.land([`${Y1.slice(0, -1)}!`]); await f.own([Y1]); }],
    ["a task lesson that matches a line of the starting version", async (f) => { await f.land([X1]); f.accept("Run the package tests before delivering!", f.id, f.id); addLearnings(f.copy, ["Run the package tests before delivering!"]); await commit(f.copy, "Repeated"); }],
    ["two task lessons that are the same lesson", async (f) => { await f.land([X1]); await f.own([Y1]); f.accept(Y1.slice(0, -1), f.id, f.id); addLearnings(f.copy, [Y1.slice(0, -1)]); await commit(f.copy, "Repeated"); }],
    ["an edit to an existing instruction on the task's branch", async (f) => { await f.land([X1]); await f.own([Y1]); writeFileSync(join(f.copy, "AGENTS.md"), readFileSync(join(f.copy, "AGENTS.md"), "utf8").replace("Keep changes small.", "Keep changes tiny.")); await commit(f.copy, "By hand"); }],
    ["a Builder's edit to the task's own lesson line", async (f) => { await f.land([X1]); await f.own([Y1]); writeFileSync(join(f.copy, "AGENTS.md"), readFileSync(join(f.copy, "AGENTS.md"), "utf8").replace(`- ${Y1}`, `* ${Y1}`)); await commit(f.copy, "By hand"); }],
    ["an edit to an existing instruction on main", async (f) => { await f.land([X1]); await f.edit((text) => text.replace("Keep changes small.", "Keep changes tiny.")); await f.own([Y1]); }],
    ["an existing lesson removed on main", async (f) => { await f.land([X1]); await f.edit((text) => text.replace("- Run the package tests before delivering.\n", "")); await f.own([Y1]); }],
    ["a changed intro on main", async (f) => { await f.land([X1]); await f.edit((text) => text.replace(INTRO, "Lessons, added with the coordinator's OK.")); await f.own([Y1]); }],
    ["a renamed heading on main", async (f) => { await f.land([X1]); await f.edit((text) => text.replace("## Learnings", "## Lessons")); await f.own([Y1]); }],
    ["a new section on main", async (f) => { await f.land([X1]); await f.edit((text) => `${text}\n## Review guide\n\nRead REVIEW.md.\n`); await f.own([Y1]); }],
    ["a lesson main added and removed between tidy-ups", async (f) => {
      await f.edit((text) => `${text}- ${Y1}\n`);
      await f.edit((text) => text.replace(`- ${Y1}\n`, ""));
      await f.land([X1]);
      await f.own([Y1]);
    }],
  ];
  for (const [name, setup] of cases) it(`for ${name}`, async () => {
    const f = await fixture();
    try {
      await setup(f);
      const before = structuredClone(f.product().learnings ?? []);
      await toBuilder(f, await f.gitMerge());
      // The records are as they were: nothing approved is lost or written twice.
      expect(f.product().learnings ?? []).toEqual(before);
    } finally { await f.engine.shutdown(); }
  });

  for (const history of [undefined, "a grafts file", "an ordinary commit index", "a forged commit index"] as const) it(`for a lesson a receipt shows main took in before the task started, and no longer has${history ? `, with ${history}` : ""}`, async () => {
    const f = await fixture("");
    try {
      // Main took the lesson in and dropped it before this task's starting point, which this task then reaches.
      const taken = await f.edit(() => `${BASE}- ${Y1}\n`);
      f.product().learningReceipts = [{ text: Y1, fromTask: f.other, writtenOn: f.other, foundOn: taken }];
      const start = await f.edit(() => BASE);
      await git(f.copy, "reset", "-q", "--hard", start);
      writeFileSync(join(f.copy, "product-change.txt"), "The task's own change\n");
      await commit(f.copy, "The task's change");
      f.scope().work.baseSha = start;
      await f.land([X1]);
      await f.own([Y1]);
      if (history) await rewriteHistory(f.repo, history, start, f.start, taken);
      await toBuilder(f, await f.gitMerge());
    } finally { await f.engine.shutdown(); }
  });

  for (const history of ["a grafts file", "an ordinary commit index", "a forged commit index"] as const) it(`for a lesson main removed, with ${history}`, async () => {
    const f = await fixture();
    try {
      const added = await f.edit((text) => `${text}- ${Y1}\n`);
      const removed = await f.edit(() => BASE);
      await f.land([X1]);
      await f.own([Y1]);
      await rewriteHistory(f.repo, history, removed, f.start, added);
      await toBuilder(f, await f.gitMerge());
    } finally { await f.engine.shutdown(); }
  });

  it("for a starting point a forged commit index would move past main's removal", async () => {
    const f = await fixture();
    try {
      await f.edit((text) => `${text}- ${Y1}\n`);
      const removed = await f.edit(() => BASE);
      await f.land([X1]);
      await f.own([Y1]);
      // The task's own change claims to start after main removed the lesson.
      await rewriteParent(f.repo, "a forged commit index", await git(f.copy, "rev-parse", "HEAD~1"), removed);
      expect((await git(f.copy, "rev-list", "HEAD")).split("\n")).toContain(removed);
      await toBuilder(f, await f.gitMerge());
      expect(f.lines().some((line) => line.includes("into the branch itself"))).toBe(false);
      expect(await git(f.copy, "rev-parse", "HEAD")).toBe(await git(f.repo, "rev-parse", "main"));
    } finally { await f.engine.shutdown(); }
  });

  it("for a starting point taken from a forged commit index", async () => {
    const f = await fixture();
    try {
      await f.edit((text) => `${text}- ${Y1}\n`);
      const removed = await f.edit(() => BASE);
      const main = await f.land([X1]);
      await f.own([Y1]);
      // The task's own change claims to start after main removed the lesson.
      const change = await git(f.copy, "rev-parse", "HEAD~1");
      await rewriteParent(f.repo, "a forged commit index", change, removed);
      expect((await git(f.copy, "rev-list", "HEAD")).split("\n")).toContain(removed);
      const fork = await gitOps.mergeBase(f.copy, "HEAD", main);
      expect(fork).toBe(removed);
      const merged = (await gitOps.mergeTree(f.copy, main))!;
      expect(merged.conflicts).toEqual(["AGENTS.md"]);
      expect(await keptLearnings(f.product(), f.id, f.copy, fork!, main, merged)).toBeUndefined();
    } finally { await f.engine.shutdown(); }
  });

  it("for a lesson main removed, whose earlier version Git can no longer read", async () => {
    const f = await fixture();
    try {
      // Main added the task's lesson with another, and removed both, between tidy-ups.
      const added = await f.edit((text) => `${text}- ${Y1}\n- A short-lived lesson.\n`);
      await f.edit(() => BASE);
      await f.land([X1]);
      await f.own([Y1]);
      const blob = await git(f.repo, "rev-parse", `${added}:AGENTS.md`);
      const stored = join(f.repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
      expect(existsSync(stored)).toBe(true);
      rmSync(stored);
      await toBuilder(f, await f.gitMerge());
    } finally { await f.engine.shutdown(); }
  });

  it("for a lesson only a side branch merged into main had", async () => {
    const f = await fixture();
    try {
      await git(f.repo, "switch", "-q", "-c", "side");
      await f.edit((text) => `${text}- ${Y1}\n`);
      await git(f.repo, "switch", "-q", "main");
      await f.land([X1]);
      // The merge keeps main's file: the side branch's lesson never reached latest main.
      await git(f.repo, "merge", "-q", "-s", "ours", "-m", "Merge the side branch", "side");
      await f.own([Y1]);
      await toBuilder(f, await f.gitMerge());
    } finally { await f.engine.shutdown(); }
  });

  it("for a Learnings section that did not exist at the starting point", async () => {
    const f = await fixture("# Working on the demo\n\nKeep changes small.\n");
    try {
      await f.land([X1]);
      await f.own([Y1]);
      await toBuilder(f, await f.gitMerge());
    } finally { await f.engine.shutdown(); }
  });

  it("for any other file conflicting too, with AGENTS.md left as Git merged it", async () => {
    const f = await fixture();
    try {
      await f.land([X1]);
      await f.edit(() => "Hello from main\n", "greeting.txt");
      writeFileSync(join(f.copy, "greeting.txt"), "Hello from the task\n");
      await commit(f.copy, "The task's greeting");
      await f.own([Y1]);
      await toBuilder(f, await f.gitMerge(), ["AGENTS.md", "greeting.txt"]);
    } finally { await f.engine.shutdown(); }
  });

  for (const start of ["branch", "pull-request"] as const) it(`for work started from ${start === "branch" ? "another branch" : "a pull request"}`, async () => {
    const f = await fixture();
    try {
      const main = await f.land([X1]);
      await f.own([Y1]);
      const product = { id: f.productId, name: "Product", repo: "local/product", path: f.repo, defaultBranch: "main" };
      f.scope().work.source = {
        product,
        start: start === "branch" ? { kind: "branch", branch: "main" } : { kind: "pull-request", number: 7, url: "https://github.com/local/product/pull/7", headRepo: "local/product", branch: "main" },
        destination: { mode: "local", repo: "local/product", branch: "main", kind: "branch" },
        confirmed: true,
      } satisfies TaskSource;
      await git(f.repo, "update-ref", `refs/petrina/sources/${f.id}`, main);
      f.engine["sources"].fetch = async () => ({ ref: "main", sha: main });
      await toBuilder(f, await f.gitMerge(), ["AGENTS.md"], start === "branch" ? "main" : "PR #7");
    } finally { await f.engine.shutdown(); }
  });
});

describe.concurrent("a task with two products", () => {
  for (const other of ["a real conflict", "lessons approved only in the first product"] as const) it(`keeps the first product's approved learnings and sends the second's ${other} to its Builder repair`, async () => {
    const f = await fixture();
    try {
      const second = await productWithTask(f.engine, f.root, BASE, "second");
      const task = f.scope().task;
      task.repositories = [{ ...f.scope().work, productId: f.productId, completedStages: [] }, { ...second.work, productId: second.productId, completedStages: [] }];
      delete task.repository;
      const scope = (productId: string) => executionFor(f.engine.task(f.id)!, productId);
      await f.land([X1]);
      await f.own([Y1]);
      // The second product's file gets the same lines, but its own records approve none of them.
      addLearnings(second.repo, [X1]);
      await commit(second.repo, "Another delivery");
      if (other === "a real conflict") {
        writeFileSync(join(second.repo, "greeting.txt"), "Hello from main\n");
        await commit(second.repo, "A greeting on main");
        writeFileSync(join(second.copy, "greeting.txt"), "Hello from the task\n");
      } else addLearnings(second.copy, [Y1]);
      await commit(second.copy, "The task's second change");
      const signal = new AbortController().signal;
      expect(await f.engine["updates"].upToDate(scope(f.productId), signal)).toBe("moved");
      expect(await show(f.copy, "HEAD:AGENTS.md")).toBe(`${BASE}- ${X1}\n- ${Y1}\n`);
      expect(await f.engine["updates"].upToDate(scope(second.productId), signal)).toBe("conflict");
      expect(scope(second.productId).work.updating?.files).toEqual([other === "a real conflict" ? "greeting.txt" : "AGENTS.md"]);
      expect(task.repair).toMatchObject({ products: [second.productId] });
      expect(scope(f.productId).work.updating).toBeUndefined();
    } finally { await f.engine.shutdown(); }
  });
});

describe("main's history of AGENTS.md", () => {
  it("cannot be read completely from a shallow copy", async () => {
    const root = tempDir("petrina-shallow-history-");
    roots.push(root);
    const repo = await makeProduct(join(root, "full"));
    writeFileSync(join(repo, "AGENTS.md"), BASE);
    await commit(repo, "Agent instructions");
    addLearnings(repo, [X1]);
    const latest = await commit(repo, "Another delivery");
    expect(await gitOps.versionsBetween(repo, await git(repo, "rev-parse", "HEAD~1"), latest, "AGENTS.md")).toEqual([BASE, `${BASE}- ${X1}\n`]);
    await git(root, "clone", "-q", "--depth", "2", `file://${repo}`, join(root, "shallow"));
    await expectRejection(gitOps.versionsBetween(join(root, "shallow"), await git(repo, "rev-parse", "HEAD~1"), latest, "AGENTS.md"), "Part of the history is not in this copy");
  });
});

describe("the receipts the tidy-up keeps", () => {
  it("keep the exact text, both tasks and main's version, for the last 100 lessons", async () => {
    const f = await fixture();
    try {
      const older = Array.from({ length: 100 }, (_, index) => ({ text: `An older lesson ${index}.`, fromTask: f.other, foundOn: "0".repeat(40) }));
      f.product().learningReceipts = older;
      f.accept(Y1, f.id);
      f.accept(Y2, f.id);
      await f.land([X1]);
      // The coordinator adds one waiting lesson by hand: no task wrote it.
      const landed = await f.edit((text) => `${text}- ${Y2}\n`);
      await new AcceptedPoints(f.engine).sweep();
      expect(f.product().learnings!.map((line) => line.text)).toEqual([Y1]);
      expect(f.product().learningReceipts).toEqual([...older.slice(2), { text: Y2, fromTask: f.id, foundOn: landed }, { text: X1, fromTask: f.other, writtenOn: f.other, foundOn: landed }]);
    } finally { await f.engine.shutdown(); }
  });
});
