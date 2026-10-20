import { executionFor } from "../src/repository-context.js";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_STARTS } from "@petrina/core";
import { Context } from "../src/context.js";
import { Engine } from "../src/engine.js";
import { fileAt } from "../src/git.js";
import type { GuideKeeper } from "../src/guide-keeper.js";
import { makeProduct, removeDir, SLOW, tempDir } from "./support.js";

const folder = tempDir("petrina-instruction-read-");
writeFileSync(join(folder, "package.json"), '{"private":true,"type":"module"}');
afterAll(() => removeDir(folder));
let serial = 0;

/** A controlled Git response, through the real process APIs on both sides of the repair. */
async function withGit(script: string, check: () => Promise<void>): Promise<void> {
  const entry = join(folder, `git-${++serial}.ts`);
  writeFileSync(entry, script);
  const spawn = Bun.spawn;
  const sync = Bun.spawnSync;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const route = (args: unknown[]) => {
    const command = args[0];
    return Array.isArray(command) && command[0] === "git" && command[1] === "cat-file"
      ? [[process.execPath, entry], ...args.slice(1)] : args;
  };
  const asynchronous = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
    const child = Reflect.apply(spawn, Bun, route(args)) as ReturnType<typeof Bun.spawn>;
    children.push(child);
    return child;
  }) as typeof Bun.spawn);
  const synchronous = spyOn(Bun, "spawnSync").mockImplementation(((...args: unknown[]) => Reflect.apply(sync, Bun, route(args))) as typeof Bun.spawnSync);
  try {
    await check();
  } finally {
    asynchronous.mockRestore();
    synchronous.mockRestore();
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
  }
}

describe("reading a product's committed files", () => {
  it("leaves coordinator messages queued when a parallel context read fails", async () => {
    const root = join(folder, "failed-context");
    const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, codexCommand: null, grokCommand: null, antigravityCommand: null, terminals: () => [] });
    engine.setPoolPaused(true);
    try {
      const productId = await engine.addProduct(makeProduct(root));
      const taskId = engine.addTask({ productId, title: "Keep messages through a failed preparation", backlog: true });
      const scope = executionFor(engine.task(taskId)!);
      scope.work.checks = { at: 1, results: [{ name: "Quick", command: "check", ok: true, ms: 1, output: "passed" }] };
      const context = new Context(engine, { pendingPoints: async () => [] } as unknown as GuideKeeper, async () => { throw new Error("Could not inspect check freshness"); });
      const reading = context.sectionsFor(scope, "code-reviewer");
      engine.sendMessage(taskId, "Keep this instruction for the successful retry.");
      await expect(reading).rejects.toThrow("Could not inspect check freshness");
      expect(scope.task.queued.map((message) => message.text)).toEqual(["Keep this instruction for the successful retry."]);
    } finally { await engine.shutdown(); }
  });

  for (const mode of ["sections", "snapshot"] as const) it(`reads guide and check evidence together without losing late notes (${mode})`, async () => {
    const root = join(folder, `parallel-context-${mode}`);
    const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, codexCommand: null, grokCommand: null, antigravityCommand: null, terminals: () => [] });
    engine.setPoolPaused(true);
    const started: string[] = [];
    let guideDone!: (points: string[]) => void, checksDone!: (current: boolean) => void;
    const guideRead = new Promise<string[]>((resolve) => { guideDone = resolve; });
    const checkRead = new Promise<boolean>((resolve) => { checksDone = resolve; });
    let reading: Promise<Awaited<ReturnType<Context["sectionsFor"]>>> | undefined;
    try {
      const productId = await engine.addProduct(makeProduct(root));
      const taskId = engine.addTask({ productId, title: "Keep live notes while reading context", backlog: true });
      const scope = executionFor(engine.task(taskId)!);
      scope.work.checks = { at: 1, results: [{ name: "Quick", command: "check", ok: true, ms: 1, output: "passed" }] };
      const guide = { pendingPoints: () => { started.push("guide"); return guideRead; } } as unknown as GuideKeeper;
      const context = new Context(engine, guide, () => { started.push("checks"); return checkRead; });
      reading = mode === "sections" ? context.sectionsFor(scope, "code-reviewer") : context.captureReview(scope).then((review) => context.sectionsFor(scope, "code-reviewer", undefined, undefined, undefined, review));
      expect(started).toEqual(["guide", "checks"]);
      engine.sendMessage(taskId, "Keep the latest instruction from the coordinator.");
      guideDone(["Preserve the greeting."]);
      await Promise.resolve();
      expect(scope.task.queued).toHaveLength(1);
      checksDone(true);
      const sections = await reading;
      expect(sections.find((section) => section.title.startsWith("The coordinator's notes"))?.body).toContain("Keep the latest instruction");
      expect(sections.find((section) => section.title.startsWith("Points the coordinator accepted"))?.body).toContain("Preserve the greeting.");
      expect(sections.find((section) => section.title === "Current product checks, run by Petrina itself")?.body).toContain("Quick: passed");
      expect(started).toEqual(["guide", "checks"]);
      expect(scope.task.queued).toEqual([]);
    } finally { guideDone([]); checksDone(false); await reading?.catch(() => {}); await engine.shutdown(); }
  });

  it("keeps the event loop responsive while Git reads a guide, and preserves its exact text", async () => {
    await withGit('setTimeout(() => process.stdout.write("\\ufeff\\n# Review guide\\n\\n "), 200)', async () => {
      const order: string[] = [];
      const heartbeat = new Promise<void>((resolve) => setTimeout(() => { order.push("responsive"); resolve(); }, 20));
      const read = Promise.resolve().then(() => fileAt(process.cwd(), "HEAD", "REVIEW.md")).then((text) => {
        order.push("read");
        expect(text).toBe("\ufeff\n# Review guide\n\n ");
      });
      await Promise.all([read, heartbeat]);
      expect(order).toEqual(["responsive", "read"]);
    });
  });

  it("reports an expired read as a failure, never as a missing guide", async () => {
    await withGit('setInterval(() => {}, 1000)', async () => {
      await expect(fileAt(process.cwd(), "HEAD", "REVIEW.md", 80 * SLOW)).rejects.toThrow("Git did not finish reading");
    });
  });

  it("drains a large saved file and Git's diagnostics while the process is still writing", async () => {
    await withGit('process.stderr.write("d".repeat(256 * 1024)); process.stdout.write("# Guide\\n" + "x".repeat(1024 * 1024) + "\\n")', async () => {
      const text = await fileAt(process.cwd(), "HEAD", "REVIEW.md");
      expect(text).toBe("# Guide\n" + "x".repeat(1024 * 1024) + "\n");
    });
  });

  for (const pullRequest of [false, true]) it(`includes a coordinator note received while its review guide was being read${pullRequest ? " for a pull request task" : ""}`, async () => {
    const root = join(folder, `context-${pullRequest}`);
    const engine = new Engine(join(root, "data"), { codexCommand: null });
    try {
      engine.setPoolPaused(true);
      const productId = await engine.addProduct(makeProduct(root));
      const taskId = engine.addTask({ productId, title: "Keep the coordinator's latest note" });
      const task = engine.task(taskId)!;
      if (pullRequest) {
        const product = engine.getState().products.find((entry) => entry.id === productId)!;
        executionFor(task).work.source = {
          product,
          start: { kind: "pull-request", number: 7, url: "https://github.com/acme/demo/pull/7", headRepo: "contributor/demo", branch: "review-work" },
          destination: { mode: "pull-request", kind: "update-pr", repo: "contributor/demo", branch: "review-work" },
          confirmed: true,
        };
      }
      let finish!: (points: string[]) => void;
      const pending = new Promise<string[]>((resolve) => { finish = resolve; });
      const guide = { pendingPoints: () => pending } as unknown as GuideKeeper;
      const reading = new Context(engine, guide).sectionsFor(executionFor(task), "code-reviewer");
      engine.sendMessage(taskId, "Keep the existing welcome page.");
      expect(task.queued).toHaveLength(1);
      finish(["Every greeting also shows on the welcome page."]);
      const sections = await reading;
      expect(sections.find((section) => section.title.startsWith("The coordinator's notes"))?.body).toContain("Keep the existing welcome page.");
      expect(sections.find((section) => section.title.startsWith("Points the coordinator accepted"))?.body).toContain("Every greeting also shows on the welcome page.");
      if (pullRequest) {
        const source = sections.find((section) => section.title === "Approved starting point and delivery")?.body;
        expect(source).toContain("from PR #7");
        expect(source).toContain("Update PR #7 contributor/demo · review-work");
        expect(executionFor(task).work.source?.confirmed).toBe(true);
      }
      expect(task.queued).toEqual([]);
    } finally {
      engine.shutdown();
    }
  });

  for (const pullRequest of [false, true]) it(`keeps earlier role notes and new coordinator notes for an added reviewer while its guide is read${pullRequest ? " on a PR task" : ""}`, async () => {
    const root = join(folder, `added-context-${pullRequest}`);
    const engine = new Engine(join(root, "data"), { codexCommand: null });
    try {
      engine.setPoolPaused(true);
      const reviewer = engine.addRole(ROLE_STARTS.find((start) => start.id === "security")!.draft);
      const productId = await engine.addProduct(makeProduct(root));
      const taskId = engine.addTask({ productId, title: "Keep every role's notes" });
      const task = engine.task(taskId)!;
      if (pullRequest) executionFor(task).work.source = {
        product: engine.getState().products.find((product) => product.id === productId)!,
        start: { kind: "pull-request", number: 7, url: "https://github.com/acme/demo/pull/7", headRepo: "contributor/demo", branch: "review-work" },
        destination: { mode: "pull-request", kind: "update-pr", repo: "contributor/demo", branch: "review-work" },
        confirmed: true,
      };
      task.handedBack = [{ stageId: "research", roleId: "researcher", roleName: "Researcher", title: "Research", at: Date.now(), summary: "The welcome page is important.", notes: ["Keep its greeting visible."] }];
      let finish!: (points: string[]) => void;
      const pending = new Promise<string[]>((resolve) => { finish = resolve; });
      const guide = { pendingPoints: () => pending } as unknown as GuideKeeper;
      const reading = new Context(engine, guide).sectionsFor(executionFor(task), reviewer);
      engine.sendMessage(taskId, "Check the welcome page too.");
      expect(task.queued).toHaveLength(1);
      finish(["The welcome page must show who can see each greeting."]);
      const sections = await reading;
      expect(sections.find((section) => section.title.startsWith("The coordinator's notes"))?.body).toContain("Check the welcome page too.");
      expect(sections.find((section) => section.title.startsWith("Points the coordinator accepted"))?.body).toContain("The welcome page must show who can see each greeting.");
      expect(sections.find((section) => section.title === "What earlier agents on this task handed back")?.body).toBe("Researcher, in “Research”: The welcome page is important.\n- Keep its greeting visible.");
      if (pullRequest) expect(sections.find((section) => section.title === "Approved starting point and delivery")?.body).toContain("Update PR #7 contributor/demo · review-work");
      expect(task.queued).toHaveLength(0);
    } finally {
      engine.shutdown();
    }
  });
});
