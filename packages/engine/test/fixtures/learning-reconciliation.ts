import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { git, gitWith, makeProduct, tempDir } from "../fixtures.js";
import * as gitOps from "@petrina/repositories/git";
import { addLearnings, Learnings } from "../../src/learnings.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { closeDirectDrivers, directDrivers } from "./direct-drivers.js";

/** A file exactly as committed, without the command helper's trimming. */
export const show = (cwd: string, spec: string) => gitWith({ cwd, raw: true, timeoutMs: 30_000 }, "cat-file", "blob", spec);
export const commit = async (cwd: string, message: string) => { await git(cwd, "add", "-A"); await git(cwd, "commit", "-q", "-m", message); return git(cwd, "rev-parse", "HEAD"); };

/** The actual product clone and owned worktree; caller has already registered the setup operation. */
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

/** Canonical root/generation ownership for both real merge worlds and the history-only repository. */
export function learningReconciliationFixtures() {
  const owners = new Set<ReturnType<typeof directDrivers>>();
  const close = async () => { await closeDirectDrivers(owners); owners.clear(); };
  function root(prefix: string) {
    const path = tempDir(prefix), owner = directDrivers(path); owners.add(owner);
    const close = async () => { await owner.close(); owners.delete(owner); };
    return { root: path, owner, close };
  }
  async function fixture(base: string) {
    const lifetime = root("petrina-kept-learnings-"), { root: path, owner, close: dispose } = lifetime;
    const engineOptions = { usageCommands: { codex: null, grok: null, antigravity: null } };
    return setupWithCleanup(() => owner.prepare(async () => {
      const engine = owner.open(join(path, "data"), engineOptions);
      engine.setPoolPaused(true);
      const added = await productWithTask(engine, path, base, "product");
      const other = engine.addTask({ productId: added.productId, title: "Delivered first", backlog: true });
      const id = engine.addTask({ productId: added.productId, title: "Keep both lessons", backlog: true });
      const task = engine.task(id)!;
      task.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [{ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["opus-high"] }] };
      task.stageIndex = 0;
      Object.assign(executionFor(task).work, added.work);
      const f = { root: path, engine, id, other, ...added };
      const scopeOf = (engine: Engine) => executionFor(engine.task(id)!);
      const productOf = (engine: Engine) => engine.s.products.find((entry) => entry.id === f.productId)!;
      const acceptOn = (engine: Engine, text: string, fromTask: string, writtenOn?: string) => {
        const product = productOf(engine);
        product.learnings = [...(product.learnings ?? []), { text, at: Date.now(), fromTask, ...(writtenOn ? { writtenOn } : {}) }];
      };
      return Object.assign(f, {
        scope: () => scopeOf(f.engine), product: () => productOf(f.engine), dispose,
        accept: (text: string, fromTask: string, writtenOn?: string) => acceptOn(f.engine, text, fromTask, writtenOn),
        // A whole test's adjacent raw Git work may span a restart: register it with the root, not its own old generation.
        run: <T>(work: () => Promise<T>) => owner.prepare(work),
        land(lessons: string[], by = other): Promise<string> {
          const engine = f.engine;
          return owner.run(engine, async () => {
            for (const text of lessons) acceptOn(engine, text, by, by);
            addLearnings(f.repo, lessons);
            return commit(f.repo, "Another delivery");
          });
        },
        edit(change: (text: string) => string, file = "AGENTS.md"): Promise<string> {
          const engine = f.engine;
          return owner.run(engine, async () => {
            const filePath = join(f.repo, file);
            writeFileSync(filePath, change(existsSync(filePath) ? readFileSync(filePath, "utf8") : ""));
            return commit(f.repo, "A change by hand");
          });
        },
        own(lessons: string[]): Promise<void> {
          const engine = f.engine, scope = scopeOf(engine);
          return owner.run(engine, async () => {
            for (const text of lessons) acceptOn(engine, text, id);
            await new Learnings(engine).write(scope);
          });
        },
        gitMerge(): Promise<string> {
          const engine = f.engine;
          return owner.run(engine, async () => {
            const merged = await gitOps.mergeTree(f.copy, await git(f.repo, "rev-parse", "main"));
            return show(f.copy, `${merged!.tree}:AGENTS.md`);
          });
        },
        update() { const engine = f.engine, scope = scopeOf(engine); return owner.run(engine, () => engine["updates"].upToDate(scope, new AbortController().signal)); },
        file() { const engine = f.engine; return owner.run(engine, () => show(f.copy, "HEAD:AGENTS.md")); },
        lines: () => scopeOf(f.engine).task.timeline.map((entry) => entry.text),
        addProduct(base: string, name: string) { const engine = f.engine; return owner.run(engine, () => productWithTask(engine, path, base, name)); },
        restart: () => owner.prepare(async () => {
          const previous = f.engine; await owner.stop(previous);
          f.engine = owner.open(join(path, "data"), engineOptions);
          f.engine.setPoolPaused(true);
        }),
      });
    }), dispose);
  }
  function history() {
    const lifetime = root("petrina-shallow-history-");
    return { root: lifetime.root, run: <T>(work: () => Promise<T>) => lifetime.owner.prepare(work), dispose: lifetime.close };
  }
  return { fixture, history, close };
}
