import { expectRejection } from "@petrina/test-support/rejections";
import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connections } from "../../../src/connection.js";
import { Sources } from "../../../src/sources.js";
import type { Engine, EngineOptions } from "../../engine.js";
import { nativeWorldFixtures, type NativeWorld } from "../../fixtures/native-worlds.js";
import { git } from "../../support.js";

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
      await git(world.clone, "switch", "-q", "-c", "trunk");
      writeFileSync(join(world.clone, "TRUNK_ONLY.md"), "Unapproved default\n");
      await git(world.clone, "add", "."); await git(world.clone, "commit", "-qm", "Unapproved new default");
      await git(world.clone, "push", "-q", world.remote, "trunk");
      await git(world.remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
      await add();
      expect(await git(path, "branch", "--list", "main")).toBe("");
      const task = engine.task(id)!;
      new Sources(engine, new Connections(engine)).confirm(task);
      expect(task.delivery).toBe("local");
      if (saved) task.repositories![0]!.preparingCopy = { path: join(world.data, "worktrees", "addition", id), branch: "petrina/saved-approved-local", base: "main" };
      await engine["driver"]["prepare"](executionFor(task), new AbortController().signal);
      expect(executionFor(task).work.source!.initialSha).toBe(world.initial);
      expect(executionFor(task).work.baseSha).toBe(world.initial);
      expect(await git(executionFor(task).work.worktree!, "ls-tree", "--name-only", "HEAD", "TRUNK_ONLY.md")).toBe("");
      expect(await git(executionFor(task).work.worktree!, "branch", "--show-current")).toBe(executionFor(task).work.branch!);
      expect(await git(path, "branch", "--list", "main")).toBe("");
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
      expect(engine.s.products.find((entry) => entry.id === product.id)?.path).toBe(realpathSync(path));
      expect(await git(path, "rev-parse", "main")).toBe(world.initial);
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
      await git(world.clone, "checkout", "-q", "-b", "trunk");
      writeFileSync(join(world.clone, "TRUNK_ONLY.md"), "This is not the approved main branch.\n");
      await git(world.clone, "add", "TRUNK_ONLY.md");
      await git(world.clone, "commit", "-q", "-m", "A distinct new default branch");
      await git(world.clone, "push", "-q", world.remote, "trunk");
      await git(world.remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
      const trunk = await git(world.clone, "rev-parse", "trunk");
      expect(trunk).not.toBe(world.initial);
      if (recovery === "missing-approved-branch") await git(world.remote, "update-ref", "-d", "refs/heads/main");
      if (recovery !== "new") {
        // Clone completed, but the engine never recorded ready=true. Git checks out its
        // new default; the approved main remains a remote-tracking branch only.
        await git(world.dir, "clone", "-q", world.remote, path);
        expect(await git(path, "branch", "--show-current")).toBe("trunk");
        expect(await git(path, "branch", "--list", "main")).toBe("");
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
        expect(await git(path, "rev-parse", "refs/remotes/origin/main")).toBe(world.initial);
        expect(await git(path, "rev-parse", "HEAD")).toBe(trunk);
        expect(current.task(id)!.workRows![0]!.source!.start).toEqual({ kind: "default", branch: "main" });
        const task = current.task(id)!;
        new Sources(current, new Connections(current)).confirm(task);
        await current["driver"]["prepare"](executionFor(task), new AbortController().signal);
        expect(executionFor(task).work.baseSha).toBe(world.initial);
        expect(await git(executionFor(task).work.worktree!, "rev-parse", "HEAD")).toBe(world.initial);
        expect(await git(path, "branch", "--show-current")).toBe("trunk");
      }
      if (recovery !== "new") expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("Do not reclone over completed work\n");
    } finally { await current.shutdown(); }
      };
      if (recovery === "restart") { engine.save(); await engine.shutdown(); return complete; }
      await complete(engine);
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
