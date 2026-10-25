import { expectRejection } from "@petrina/test-support/rejections";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_STARTS } from "@petrina/core";
import { Context, EARLIER_REPORTS_RULE } from "../../../src/context.js";
import { Engine } from "../../engine.js";
import { removeDir, tempDir } from "../../fixtures.js";

const folder = tempDir("petrina-instruction-read-");

writeFileSync(join(folder, "package.json"), '{"private":true,"type":"module"}');

afterAll(() => removeDir(folder));

function registerProduct(engine: Engine): string {
  const id = "product";
  engine.s.products.push({ id, name: "Product", repo: "local/product", tone: "blue" });
  return id;
}
describe("reading a product's committed files",()=>{
it("leaves coordinator messages queued when a parallel context read fails", async () => {
    const root = join(folder, "failed-context");
    const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
    engine.setPoolPaused(true);
    try {
      const productId = registerProduct(engine);
      const taskId = engine.addTask({ productId, title: "Keep messages through a failed preparation", backlog: true });
      const scope = executionFor(engine.task(taskId)!);
      scope.work.checks = { at: 1, results: [{ name: "Quick", command: "check", ok: true, execution: completeCheckExecution(0), ms: 1, output: "passed" }] };
      const context = new Context(engine, { pendingPoints: async () => [] }, async () => { throw new Error("Could not inspect check freshness"); });
      const reading = context.sectionsFor(scope, "code-reviewer");
      engine.sendMessage(taskId, "Keep this instruction for the successful retry.");
      await expectRejection(reading, "Could not inspect check freshness");
      expect(scope.task.queued.map((message) => message.text)).toEqual(["Keep this instruction for the successful retry."]);
    } finally { await engine.shutdown(); }
  });
});

describe("reading a product's committed files",()=>{
for (const mode of ["sections", "snapshot"] as const) it(`reads guide and check evidence together without losing late notes (${mode})`, async () => {
    const root = join(folder, `parallel-context-${mode}`);
    const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
    engine.setPoolPaused(true);
    const started: string[] = [];
    let guideDone!: (points: string[]) => void, checksDone!: (current: boolean) => void;
    const guideRead = new Promise<string[]>((resolve) => { guideDone = resolve; });
    const checkRead = new Promise<boolean>((resolve) => { checksDone = resolve; });
    let reading: Promise<Awaited<ReturnType<Context["sectionsFor"]>>> | undefined;
    try {
      const productId = registerProduct(engine);
      const taskId = engine.addTask({ productId, title: "Keep live notes while reading context", backlog: true });
      const scope = executionFor(engine.task(taskId)!);
      scope.work.checks = { at: 1, results: [{ name: "Quick", command: "check", ok: true, execution: completeCheckExecution(0), ms: 1, output: "passed" }] };
      const guide = { pendingPoints: () => { started.push("guide"); return guideRead; } };
      const context = new Context(engine, guide, () => { started.push("checks"); return checkRead; });
      reading = mode === "sections" ? context.sectionsFor(scope, "code-reviewer") : context.captureReview(scope).then((review) => context.sectionsFor(scope, "code-reviewer", undefined, undefined, undefined, review));
      expect(started).toEqual(["guide", "checks"]);
      engine.sendMessage(taskId, "Keep the latest instruction from the coordinator.");
      guideDone(["Preserve the greeting."]);
      await Promise.resolve();
      expect(scope.task.queued).toHaveLength(1);
      checksDone(true);
      const sections = await reading;
      expect(sections.some((section) => section.body.includes("Keep the latest instruction"))).toBe(false);
      expect(scope.task.queued[0]?.text).toBe("Keep the latest instruction from the coordinator.");
      expect(sections.find((section) => section.title.startsWith("Points the coordinator accepted"))?.body).toContain("Preserve the greeting.");
      expect(sections.find((section) => section.title === "Current product checks, run by Petrina itself")?.body).toContain("Quick: passed");
      expect(started).toEqual(["guide", "checks"]);
      expect(scope.task.queued[0]?.deliveries).toBeUndefined();
    } finally { guideDone([]); checksDone(false); await reading?.catch(() => {}); await engine.shutdown(); }
  });
});

describe("reading a product's committed files",()=>{
for (const pullRequest of [false, true]) it(`keeps a coordinator note waiting for prompt handoff while its review guide is read${pullRequest ? " for a pull request task" : ""}`, async () => {
    const root = join(folder, `context-${pullRequest}`);
    const engine = new Engine(join(root, "data"), { usageCommands: { codex: null } });
    try {
      engine.setPoolPaused(true);
      const productId = registerProduct(engine);
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
      const guide = { pendingPoints: () => pending };
      const reading = new Context(engine, guide).sectionsFor(executionFor(task), "code-reviewer");
      engine.sendMessage(taskId, "Keep the existing welcome page.");
      expect(task.queued).toHaveLength(1);
      finish(["Every greeting also shows on the welcome page."]);
      const sections = await reading;
      expect(sections.some((section) => section.body.includes("Keep the existing welcome page."))).toBe(false);
      expect(task.queued[0]?.text).toBe("Keep the existing welcome page.");
      expect(sections.find((section) => section.title.startsWith("Points the coordinator accepted"))?.body).toContain("Every greeting also shows on the welcome page.");
      if (pullRequest) {
        const source = sections.find((section) => section.title === "Approved starting point and delivery")?.body;
        expect(source).toContain("from PR #7");
        expect(source).toContain("Update PR #7 contributor/demo · review-work");
        expect(executionFor(task).work.source?.confirmed).toBe(true);
      }
      expect(task.queued[0]?.deliveries).toBeUndefined();
    } finally {
      await engine.shutdown();
    }
  });
});

describe("reading a product's committed files",()=>{
for (const pullRequest of [false, true]) it(`keeps earlier role notes and new coordinator notes for an added reviewer while its guide is read${pullRequest ? " on a PR task" : ""}`, async () => {
    const root = join(folder, `added-context-${pullRequest}`);
    const engine = new Engine(join(root, "data"), { usageCommands: { codex: null } });
    try {
      engine.setPoolPaused(true);
      const reviewer = engine.addRole(ROLE_STARTS.find((start) => start.id === "security")!.draft);
      const productId = registerProduct(engine);
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
      const guide = { pendingPoints: () => pending };
      const reading = new Context(engine, guide).sectionsFor(executionFor(task), reviewer);
      engine.sendMessage(taskId, "Check the welcome page too.");
      expect(task.queued).toHaveLength(1);
      finish(["The welcome page must show who can see each greeting."]);
      const sections = await reading;
      expect(sections.some((section) => section.body.includes("Check the welcome page too."))).toBe(false);
      expect(task.queued[0]?.text).toBe("Check the welcome page too.");
      expect(sections.find((section) => section.title.startsWith("Points the coordinator accepted"))?.body).toContain("The welcome page must show who can see each greeting.");
      expect(sections.find((section) => section.title === "What earlier agents on this task handed back")?.body).toBe(`${EARLIER_REPORTS_RULE}\n\nResearcher, in “Research”: The welcome page is important.\n- Keep its greeting visible.`);
      if (pullRequest) expect(sections.find((section) => section.title === "Approved starting point and delivery")?.body).toContain("Update PR #7 contributor/demo · review-work");
      expect(task.queued[0]?.deliveries).toBeUndefined();
    } finally {
      await engine.shutdown();
    }
  });
});
