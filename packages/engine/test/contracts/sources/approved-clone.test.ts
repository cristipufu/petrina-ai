import { expectRejection } from "@petrina/test-support/rejections";
import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Connections } from "../../../src/connection.js";
import { Sources } from "../../../src/sources.js";
import type { Engine, EngineOptions } from "../../engine.js";
import { nativeWorldFixtures, type NativeWorld } from "../../fixtures/native-worlds.js";
import { readRef, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { commitOnCloneBranch } from "../../fixtures/source-world.js";
import { git } from "../../support.js";

function checkedOutBranch(repoOrWorktree: string): string {
  const dotGit = join(repoOrWorktree, ".git");
  let gitDir = dotGit;
  try {
    const content = readFileSync(dotGit, "utf8");
    if (content.startsWith("gitdir:")) gitDir = resolve(repoOrWorktree, content.slice("gitdir:".length).trim());
  } catch {
    // dotGit is a directory
  }
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "";
}

const fixtures = nativeWorldFixtures();
afterAll(fixtures.close);
const engineOptions = (): EngineOptions => ({ agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] });

async function prepare(world: NativeWorld, engine: Engine) {
  engine.setPoolPaused(true);
  const id = engine.addTask({ productId: "", title: "An approved addition", backlog: true });
  const path = join(world.dir, "saved-addition");
  mkdirSync(path);
  const choice = { productId: "addition", startFrom: { kind: "default" as const }, delivery: "pull-request" as const };
  const product = { id: "addition", name: "Approved product", repo: "acme/demo", remote: "https://github.com/acme/demo.git", defaultBranch: "main", path };
  engine.task(id)!.workRows = [{ choice, source: { product, start: { kind: "default", branch: "main" }, destination: { kind: "new-pr", mode: "pull-request", repo: product.repo, branch: "main", remote: product.remote }, confirmed: true }, addition: { productId: product.id, name: product.name, path, created: true } }];
  const add = (current = engine) => new Sources(current, new Connections(current)).addApproved(current.task(id)!, product.id, new AbortController().signal);
  return { world, engine, id, path, product, add };
}

describe.concurrent("approved clone recovery", () => {
for (const saved of [false, true]) it(`prepares a local delivery on its own branch with only origin/main${saved ? " from a saved preparation" : ""}`, async () => {
    await fixtures.world(`source-addition-local-preparation-${saved}`, async ({ world, engine: ownedEngine }) => {
    await ownedEngine(async engine => {
    const { id, path, add } = await prepare(world, engine);
    try {
      const row = engine.task(id)!.workRows![0]!;
      row.choice.delivery = "local";
      row.source!.destination.mode = "local";
      row.source!.destination.kind = "branch";
      const trunk = await commitOnCloneBranch(world.clone, "trunk", "TRUNK_ONLY.md", "Unapproved default\n", "Unapproved new default");
      cpSync(join(world.clone, ".git", "objects"), join(world.remote, "objects"), { recursive: true, force: true });
      mkdirSync(dirname(join(world.remote, "refs", "heads", "trunk")), { recursive: true });
      writeFileSync(join(world.remote, "refs", "heads", "trunk"), `${trunk}\n`);
      writeFileSync(join(world.remote, "HEAD"), "ref: refs/heads/trunk\n");
      await add();
      expect(readRef(join(path, ".git"), "refs/heads/main")).toBeUndefined();
      const task = engine.task(id)!;
      new Sources(engine, new Connections(engine)).confirm(task);
      expect(task.delivery).toBe("local");
      if (saved) task.repositories![0]!.preparingCopy = { path: join(world.data, "worktrees", "addition", id), branch: "petrina/saved-approved-local", base: "main" };
      await engine["driver"]["prepare"](executionFor(task), new AbortController().signal);
      expect(executionFor(task).work.source!.initialSha).toBe(world.initial);
      expect(executionFor(task).work.baseSha).toBe(world.initial);
      expect(existsSync(join(executionFor(task).work.worktree!, "TRUNK_ONLY.md"))).toBe(false);
      expect(checkedOutBranch(executionFor(task).work.worktree!)).toBe(executionFor(task).work.branch!);
      expect(readRef(join(path, ".git"), "refs/heads/main")).toBeUndefined();
    } finally { await engine.shutdown(); }
    }, engineOptions());
    });
  });
});

describe.concurrent("approved clone recovery", () => {
for (const committed of [true, false]) it(`preserves a saved folder replaced by another repository ${committed ? "with" : "without"} the expected branch`, async () => {
    await fixtures.world(`source-addition-replaced-${committed}`, async ({ world, engine: ownedEngine }) => {
    const next = await ownedEngine(async engine => {
      const { id, path, product, add } = await prepare(world, engine);
      // The exclusive folder was saved before clone interruption; a restart must not
      // mistake a different repository now occupying that path for the approved clone.
      engine.save();
      await engine.shutdown();
      await git(path, "init", "-q", "-b", "main");
      await git(path, "remote", "add", "origin", "https://github.com/else/unrelated.git");
      if (committed) {
        await git(path, "config", "user.name", "Test");
        await git(path, "config", "user.email", "test@example.com");
        writeFileSync(join(path, "README.md"), "Unrelated work\n");
        await git(path, "add", ".");
        await git(path, "commit", "-q", "-m", "Unrelated history");
      }
      const config = readFileSync(join(path, ".git", "config"), "utf8");
      return async (current: Engine) => {
      try {
      await expectRejection(add(current), "Change folder");
      expect(current.task(id)!.workRows![0]!.addition?.ready).not.toBe(true);
      expect(current.s.products.some((entry) => entry.id === product.id)).toBe(false);
      expect(readFileSync(join(path, ".git", "config"), "utf8")).toBe(config);
      if (committed) expect(await git(path, "show", "main:README.md")).toBe("Unrelated work");
      else expect(existsSync(join(path, ".git", "HEAD"))).toBe(true);
    } finally { await current.shutdown(); }
      };
    }, engineOptions());
    await ownedEngine(next, engineOptions());
    });
  });
});

describe.concurrent("approved clone recovery", () => {
for (const progress of ["empty", "interrupted", "complete"]) it(`resumes an approved ${progress} clone in its saved folder`, async () => {
    await fixtures.world(`source-addition-${progress}`, async ({ world, engine: ownedEngine }) => {
    await ownedEngine(async engine => {
    const { id, path, product, add } = await prepare(world, engine);
    try {
      if (progress === "interrupted") {
        await git(path, "init", "-q", "-b", "main");
        await git(path, "remote", "add", "origin", world.remote);
      } else if (progress === "complete") {
        await git(world.dir, "clone", "-q", world.remote, path);
        writeFileSync(join(path, "keep.txt"), "Preserve existing work\n");
      }
      await add();
      expect(engine.task(id)!.workRows![0]!.addition?.ready).toBe(true);
      expect(engine.s.products.find((entry) => entry.id === product.id)?.path).toBe(realpathSync.native(path));
      expect(readRef(join(path, ".git"), "refs/heads/main")).toBe(world.initial);
      if (progress === "complete") expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("Preserve existing work\n");
    } finally { await engine.shutdown(); }
    }, engineOptions());
    });
  });
});

describe.concurrent("approved clone recovery", () => {
for (const recovery of ["new", "retry", "restart", "foreign-origin", "missing-approved-branch"]) it(`keeps the approved branch when the remote default changes before ${recovery}`, async () => {
    await fixtures.world(`source-addition-changed-default-${recovery}`, async ({ world, engine: ownedEngine }) => {
    const next = await ownedEngine(async engine => {
      const { id, path, product, add } = await prepare(world, engine);
      const trunk = await commitOnCloneBranch(world.clone, "trunk", "TRUNK_ONLY.md", "This is not the approved main branch.\n", "A distinct new default branch");
      cpSync(join(world.clone, ".git", "objects"), join(world.remote, "objects"), { recursive: true, force: true });
      mkdirSync(dirname(join(world.remote, "refs", "heads", "trunk")), { recursive: true });
      writeFileSync(join(world.remote, "refs", "heads", "trunk"), `${trunk}\n`);
      writeFileSync(join(world.remote, "HEAD"), "ref: refs/heads/trunk\n");
      expect(trunk).not.toBe(world.initial);
      if (recovery === "missing-approved-branch") rmSync(join(world.remote, "refs", "heads", "main"), { force: true });
      if (recovery !== "new") {
        // Clone completed, but the engine never recorded ready=true. Git checks out its
        // new default; the approved main remains a remote-tracking branch only.
        await git(world.dir, "clone", "-q", world.remote, path);
        expect(checkedOutBranch(path)).toBe("trunk");
        expect(readRef(join(path, ".git"), "refs/heads/main")).toBeUndefined();
        writeFileSync(join(path, "keep.txt"), "Do not reclone over completed work\n");
        if (recovery === "foreign-origin") await git(path, "remote", "set-url", "origin", "https://github.com/else/unrelated.git");
      }
      const complete = async (current: Engine) => {
      try {
      if (recovery === "foreign-origin" || recovery === "missing-approved-branch") {
        const config = readFileSync(join(path, ".git", "config"), "utf8");
        await expectRejection(add(current), "Change folder");
        expect(current.task(id)!.workRows![0]!.addition?.ready).not.toBe(true);
        expect(current.s.products.some((entry) => entry.id === product.id)).toBe(false);
        expect(readFileSync(join(path, ".git", "config"), "utf8")).toBe(config);
      } else {
        await add(current);
        expect(current.task(id)!.workRows![0]!.addition?.ready).toBe(true);
        expect(current.s.products.find((entry) => entry.id === product.id)?.defaultBranch).toBe("main");
        expect(readRef(join(path, ".git"), "refs/remotes/origin/main")).toBe(world.initial);
        expect(readWorktreeCommit(path)?.commit).toBe(trunk);
        expect(current.task(id)!.workRows![0]!.source!.start).toEqual({ kind: "default", branch: "main" });
        const task = current.task(id)!;
        new Sources(current, new Connections(current)).confirm(task);
        await current["driver"]["prepare"](executionFor(task), new AbortController().signal);
        expect(executionFor(task).work.baseSha).toBe(world.initial);
        expect(readWorktreeCommit(executionFor(task).work.worktree!)?.commit).toBe(world.initial);
        expect(checkedOutBranch(path)).toBe("trunk");
      }
      if (recovery !== "new") expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("Do not reclone over completed work\n");
    } finally { await current.shutdown(); }
      };
      if (recovery === "restart") { engine.save(); await engine.shutdown(); return complete; }
      await complete(engine);
      return undefined;
    }, engineOptions());
    if (next) await ownedEngine(next, engineOptions());
    });
  });
});

describe.concurrent("approved clone recovery", () => {
it("leaves an initially occupied folder untouched before ownership is saved", async () => {
    await fixtures.world("source-addition-initially-occupied", async ({ world, engine: ownedEngine }) => {
    await ownedEngine(async engine => {
    const { id, path, add } = await prepare(world, engine);
    try {
      delete engine.task(id)!.workRows![0]!.addition!.created;
      writeFileSync(join(path, "keep.txt"), "Unrelated occupied folder\n");
      await expectRejection(add(), "EEXIST");
      expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("Unrelated occupied folder\n");
      expect(existsSync(join(path, ".git"))).toBe(false);
      expect(engine.s.products).toEqual([]);
    } finally { await engine.shutdown(); }
    }, engineOptions());
    });
  });
});
