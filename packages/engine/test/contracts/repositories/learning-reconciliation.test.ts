import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskSource } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { AcceptedPoints } from "../../../src/accepted-points.js";
import { addLearnings, keptLearnings, Learnings } from "../../../src/learnings.js";
import * as gitOps from "@petrina/repositories/git";
import { git, makeProduct } from "../../fixtures.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { changedFilesBetween, commit, revParse, show, learningReconciliationFixtures } from "../../fixtures/learning-reconciliation.js";

const worlds = learningReconciliationFixtures();
afterAll(worlds.close);

const INTRO = "What agents learned about working in this repository, added with the coordinator's OK.";
const BASE = `# Working on the demo\n\nKeep changes small.\n\n## Learnings\n\n${INTRO}\n\n- Run the package tests before delivering.\n`;
const KEPT = "Kept both sets of approved learnings";

const X1 = "Run engine tests through the package runner so its cleanup runs.";
const Y1 = "Read the review guide before building.";
const Y2 = "Run bun test parallel only through the runner.";
const Y3 = "Name every test fixture after the case it proves.";


const fixture = (base = BASE) => worlds.fixture(base);

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
  expect(await revParse(f.copy, "HEAD")).toBe(await revParse(f.repo, "main"));
  expect(readFileSync(join(f.copy, "AGENTS.md"), "utf8")).toBe(merged);
  expect(f.scope().task.journey!.find((step) => step.work === "update")).toMatchObject({ outcome: `${files.length === 1 ? "1 file conflicts" : `${files.length} files conflict`} with ${source}`, tone: "back" });
}

/** Petrina kept both sides: AGENTS.md is `expected` in full, the task's one commit sits on main, and no Builder was needed. */
async function kept(f: Fixture, expected: string) {
  const main = await revParse(f.repo, "main");
  expect(await f.update()).toBe("moved");
  expect(f.scope().work.updating).toBeUndefined();
  expect(await show(f.copy, "HEAD:AGENTS.md")).toBe(expected);
  expect(f.scope().work.savedVersion).toEqual({ commit: await revParse(f.copy, "HEAD"), tree: await revParse(f.copy, "HEAD^{tree}") });
  expect(await revParse(f.copy, "HEAD~1")).toBe(main);
  expect(await gitOps.isClean(f.copy)).toBe(true);
  // Every other file is the clean combination: main's, plus the task's own change.
  const changed = await changedFilesBetween(f.copy, "HEAD~1", "HEAD");
  expect(changed).toEqual([...(expected === await show(f.repo, "main:AGENTS.md") ? [] : ["AGENTS.md"]), "product-change.txt"]);
  expect(f.scope().task.stageIndex).toBe(0);
  expect(f.scope().task.journey!.filter((step) => step.work === "update").map((step) => [step.outcome, step.tone])).toEqual([[KEPT, undefined]]);
}

describe.concurrent("an update where main and the task only added approved learnings", () => {
  for (const [first, then] of [[X1, Y1]] as const) it(`puts main's lesson first and the task's after it, delivered in either order (${first === X1 ? "X then Y" : "Y then X"})`, async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        await f.land([first]);
        await f.own([then]);
        await kept(f, `${BASE}- ${first}\n- ${then}\n`);
        expect(f.lines()).toContain(`Brought up to date with main (1 new commit there): main and this work only added approved learnings to AGENTS.md, so Petrina kept main's and added this work's: ${then}`);
        // The task's lesson stays reserved for it, and the next learnings write adds nothing again.
        expect(f.product().learnings!.find((line) => line.text === then)!.writtenOn).toBe(f.id);
        await new Learnings(f.engine).write(f.scope());
        expect(await show(f.copy, "HEAD:AGENTS.md")).toBe(`${BASE}- ${first}\n- ${then}\n`);
        expect(await f.update()).toBe("current");
      });
    } finally { await f.dispose(); }
  });

  it("keeps both sides' approved learnings with Git's commit index written as usual", async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        const landed = await f.land([X1]);
        await f.own([Y1]);
        await rewriteHistory(f.repo, "an ordinary commit index", landed, f.start, landed);
        await kept(f, `${BASE}- ${X1}\n- ${Y1}\n`);
      });
    } finally { await f.dispose(); }
  });


  it("keeps a lesson approved while the task is brought up to date waiting and reserved for the next write", async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        const versions = gitOps.versionsBetween;
        let reads = 0;
        let restore = () => {};
        await setupWithCleanup(async () => {
          const read = spyOn(gitOps, "versionsBetween"); restore = () => read.mockRestore();
          read.mockImplementation(async (...args) => {
            // The coordinator accepts another lesson while Petrina reads main's history (only this fixture's reads).
            if (args[0] === f.copy) {
              reads += 1;
              f.engine.addLessons(f.engine.raise(f.scope().task, "learnings", "What agents learned", false, { body: `- ${Y3}` }), [0]);
            }
            return versions(...args);
          });

          await f.land([X1]);
          await f.own([Y1]);
          await kept(f, `${BASE}- ${X1}\n- ${Y1}\n`);
          expect(reads).toBe(1);
          expect(f.product().learnings!.map((line) => [line.text, line.writtenOn])).toEqual([[X1, f.other], [Y1, f.id], [Y3, undefined]]);
          await new Learnings(f.engine).write(f.scope());
          expect(await show(f.copy, "HEAD:AGENTS.md")).toBe(`${BASE}- ${X1}\n- ${Y1}\n- ${Y3}\n`);
          expect(f.product().learnings!.find((line) => line.text === Y3)!.writtenOn).toBe(f.id);

        }, () => restore());
        restore();
      });
    } finally { await f.dispose(); }
  });

  it("proves main's lessons with receipts kept across a restart, and a restart after the update changes nothing", async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        const landed = await f.land([X1]);
        await new AcceptedPoints(f.engine).sweep();
        await f.restart();
        expect(f.product().learnings).toEqual([]);
        expect(f.product().learningReceipts).toEqual([{ text: X1, fromTask: f.other, writtenOn: f.other, foundOn: landed }]);
        await f.own([Y1]);
        await kept(f, `${BASE}- ${X1}\n- ${Y1}\n`);
        await f.restart();
        const head = await revParse(f.copy, "HEAD");
        expect(await f.update()).toBe("current");
        await new Learnings(f.engine).write(f.scope());
        expect(await revParse(f.copy, "HEAD")).toBe(head);
        expect(await show(f.copy, "HEAD:AGENTS.md")).toBe(`${BASE}- ${X1}\n- ${Y1}\n`);
        expect(f.scope().task.journey!.filter((step) => step.work === "update")).toHaveLength(1);
      });
    } finally { await f.dispose(); }
  });

  for (const reviewed of ["with", "before"] as const) it(`carries the version the last review saw onto main, so the next round compares only what changed since (reviewed ${reviewed} the task's lesson)`, async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        await f.land([X1]);
        if (reviewed === "before") f.scope().work.reviewedSha = await revParse(f.copy, "HEAD");
        await f.own([Y1]);
        if (reviewed === "with") f.scope().work.reviewedSha = await revParse(f.copy, "HEAD");
        // A fix after that review: the one change the next round should see, with the lesson if it came later.
        writeFileSync(join(f.copy, "product-change.txt"), "The task's fixed change\n");
        await commit(f.copy, "A fix after the review");
        await kept(f, `${BASE}- ${X1}\n- ${Y1}\n`);
        const carried = f.scope().work.reviewedSha!;
        expect(carried).toBeDefined();
        expect(await revParse(f.copy, `${carried}~1`)).toBe(await revParse(f.repo, "main"));
        expect(await changedFilesBetween(f.copy, carried, "HEAD")).toEqual(reviewed === "with" ? ["product-change.txt"] : ["AGENTS.md", "product-change.txt"]);
      });
    } finally { await f.dispose(); }
  });

  it("leaves a conflict already with the Builder there after a restart, even once main's lesson is proven", async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
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
      });
    } finally { await f.dispose(); }
  });
});

describe.concurrent("an update that still goes to the Builder", () => {


  for (const history of [undefined, "a grafts file", "an ordinary commit index", "a forged commit index"] as const) it(`for a lesson a receipt shows main took in before the task started, and no longer has${history ? `, with ${history}` : ""}`, async () => {
    const f = await fixture("");
    try {
      await f.run(async () => {
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
      });
    } finally { await f.dispose(); }
  });

  for (const history of ["a grafts file", "an ordinary commit index", "a forged commit index"] as const) it(`for a lesson main removed, with ${history}`, async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        const added = await f.edit((text) => `${text}- ${Y1}\n`);
        const removed = await f.edit(() => BASE);
        await f.land([X1]);
        await f.own([Y1]);
        await rewriteHistory(f.repo, history, removed, f.start, added);
        await toBuilder(f, await f.gitMerge());
      });
    } finally { await f.dispose(); }
  });

  it("for a starting point a forged commit index would move past main's removal", async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        await f.edit((text) => `${text}- ${Y1}\n`);
        const removed = await f.edit(() => BASE);
        await f.land([X1]);
        await f.own([Y1]);
        // The task's own change claims to start after main removed the lesson.
        await rewriteParent(f.repo, "a forged commit index", await revParse(f.copy, "HEAD~1"), removed);
        expect((await git(f.copy, "rev-list", "HEAD")).split("\n")).toContain(removed);
        await toBuilder(f, await f.gitMerge());
        expect(f.lines().some((line) => line.includes("into the branch itself"))).toBe(false);
        expect(await revParse(f.copy, "HEAD")).toBe(await revParse(f.repo, "main"));
      });
    } finally { await f.dispose(); }
  });

  it("for a starting point taken from a forged commit index", async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        await f.edit((text) => `${text}- ${Y1}\n`);
        const removed = await f.edit(() => BASE);
        const main = await f.land([X1]);
        await f.own([Y1]);
        // The task's own change claims to start after main removed the lesson.
        const change = await revParse(f.copy, "HEAD~1");
        await rewriteParent(f.repo, "a forged commit index", change, removed);
        expect((await git(f.copy, "rev-list", "HEAD")).split("\n")).toContain(removed);
        const fork = await gitOps.mergeBase(f.copy, "HEAD", main);
        expect(fork).toBe(removed);
        const merged = (await gitOps.mergeTree(f.copy, main))!;
        expect(merged.conflicts).toEqual(["AGENTS.md"]);
        expect(await keptLearnings(f.product(), f.id, f.copy, fork!, main, merged)).toBeUndefined();
      });
    } finally { await f.dispose(); }
  });

  it("for a lesson main removed, whose earlier version Git can no longer read", async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        // Main added the task's lesson with another, and removed both, between tidy-ups.
        const added = await f.edit((text) => `${text}- ${Y1}\n- A short-lived lesson.\n`);
        await f.edit(() => BASE);
        await f.land([X1]);
        await f.own([Y1]);
        const blob = await revParse(f.repo, `${added}:AGENTS.md`);
        const stored = join(f.repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
        expect(existsSync(stored)).toBe(true);
        rmSync(stored);
        await toBuilder(f, await f.gitMerge());
      });
    } finally { await f.dispose(); }
  });

  it("for a lesson only a side branch merged into main had", async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        await git(f.repo, "switch", "-q", "-c", "side");
        await f.edit((text) => `${text}- ${Y1}\n`);
        await git(f.repo, "switch", "-q", "main");
        await f.land([X1]);
        // The merge keeps main's file: the side branch's lesson never reached latest main.
        await git(f.repo, "merge", "-q", "-s", "ours", "-m", "Merge the side branch", "side");
        await f.own([Y1]);
        await toBuilder(f, await f.gitMerge());
      });
    } finally { await f.dispose(); }
  });


  for (const start of ["branch", "pull-request"] as const) it(`for work started from ${start === "branch" ? "another branch" : "a pull request"}`, async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        const main = await f.land([X1]);
        await f.own([Y1]);
        const product = { id: f.productId, name: "Product", repo: "local/product", path: f.repo, defaultBranch: "main" };
        f.scope().work.source = {
          product,
          start: start === "branch" ? { kind: "branch", branch: "main" } : { kind: "pull-request", number: 7, url: "https://github.com/local/product/pull/7", headRepo: "local/product", branch: "main" },
          destination: { mode: "local", repo: "local/product", branch: "main", kind: "branch" },
          confirmed: true,
        } satisfies TaskSource;
        const sourceRef = join(f.repo, ".git", "refs", "petrina", "sources", f.id);
        mkdirSync(join(f.repo, ".git", "refs", "petrina", "sources"), { recursive: true });
        writeFileSync(sourceRef, `${main}\n`);
        f.engine["sources"].fetch = async () => ({ ref: "main", sha: main });
        await toBuilder(f, await f.gitMerge(), ["AGENTS.md"], start === "branch" ? "main" : "PR #7");
      });
    } finally { await f.dispose(); }
  });
});

describe.concurrent("a task with two products", () => {
  for (const other of ["a real conflict", "lessons approved only in the first product"] as const) it(`keeps the first product's approved learnings and sends the second's ${other} to its Builder repair`, async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
        const second = await f.addProduct(BASE, "second");
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
      });
    } finally { await f.dispose(); }
  });
});

describe("main's history of AGENTS.md", () => {
  it("cannot be read completely from a shallow copy", async () => {
    const f = worlds.history(), root = f.root;
    try {
      await f.run(async () => {
        const repo = await makeProduct(join(root, "full"), { origin: "none" });
        writeFileSync(join(repo, "AGENTS.md"), BASE);
        await commit(repo, "Agent instructions");
        addLearnings(repo, [X1]);
        const latest = await commit(repo, "Another delivery");
        const previous = await revParse(repo, "HEAD~1");
        expect(await gitOps.versionsBetween(repo, previous, latest, "AGENTS.md")).toEqual([BASE, `${BASE}- ${X1}\n`]);
        await git(root, "clone", "-q", "--depth", "2", `file://${repo}`, join(root, "shallow"));
        await expectRejection(gitOps.versionsBetween(join(root, "shallow"), previous, latest, "AGENTS.md"), "Part of the history is not in this copy");
      });
    } finally { await f.dispose(); }
  });
});

describe("the receipts the tidy-up keeps", () => {
  it("keep the exact text, both tasks and main's version, for the last 100 lessons", async () => {
    const f = await fixture();
    try {
      await f.run(async () => {
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
      });
    } finally { await f.dispose(); }
  });
});
