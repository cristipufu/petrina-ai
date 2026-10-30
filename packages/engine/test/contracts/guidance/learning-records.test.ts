import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { executionFor } from "@petrina/orchestrator";
import { describe, expect, it, spyOn } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Learnings } from "../../../src/learnings.js";
import * as gitOps from "@petrina/repositories/git";
import { makeProduct } from "../../fixtures.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


describe("lessons agents pass on", () => {
  for (const state of ["before-copy", "deleted", "empty"] as const) it(`reads learning instructions from the authoritative version: ${state}`, async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const root = mkdtempSync(join(owner.root, `petrina-learning-source-${state}-`));
      const engine = owner.open(join(root, "data"), { agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
      try {
        await owner.run(engine, async () => {
          engine.setPoolPaused(true);
          const repo = await makeProduct(root, { origin: "none" }), lesson = "Use the repository's focused greeting checks before the full suite.";
          writeFileSync(join(repo, "AGENTS.md"), `## Learnings\n\n- ${lesson}\n`);
          await gitOps.commitChanges(repo, "Record the original instruction");
          const base = (await gitOps.head(repo))!;
          await engine.waitUntilReady(); owner.check();
          const productId = installPreparedProduct(engine, privateCloneProduct(repo));
          const scope = executionFor(engine.task(engine.addTask({ productId, title: "Learn from the current instructions", backlog: true }))!);
          scope.work.baseSha = base;
          if (state !== "before-copy") {
            scope.work.worktree = repo;
            if (state === "deleted") rmSync(join(repo, "AGENTS.md"));
            else writeFileSync(join(repo, "AGENTS.md"), "");
            await gitOps.commitChanges(repo, "Remove the old instruction");
          }
          const read = spyOn(gitOps, "fileAt");
          try {
            await new Learnings(engine).note(scope, [lesson], "builder", "sol-high");
            const sourcePath = state === "before-copy" ? engine.s.products.find((product) => product.id === productId)!.path! : repo;
            expect(read.mock.calls.filter(([, , file]) => file === "AGENTS.md")).toEqual([[sourcePath, state === "before-copy" ? base : "HEAD", "AGENTS.md"]]);
            expect(scope.work.lessons?.map((entry) => entry.text) ?? []).toEqual(state === "before-copy" ? [] : [lesson]);
          } finally { read.mockRestore(); }

        });
      } finally {

        await owner.stop(engine);

      }

    });
  });

  it("offers and saves a complete lesson, including the instructions beyond 240 characters", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const root = mkdtempSync(join(owner.root, "petrina-lessons-complete-"));

      const engine = owner.open(join(root, "data"), { toolProbe: privateAgentToolProbe(), usageCommands: { codex: null } });
      try {
        await owner.run(engine, async () => {
          engine.setPoolPaused(true);
          const repo = await makeProduct(root, { origin: "none" });
          await engine.waitUntilReady(); owner.check();
          const productId = installPreparedProduct(engine, privateCloneProduct(repo));
          const task = engine.task(engine.addTask({ productId, title: "Keep a complete instruction" }))!;
          executionFor(task).work.worktree = repo;
          const learnings = new Learnings(engine);
          const lesson = "The Claude Code connector and SDK sources can be read without installing anything, in ~/.bun/install/cache (@agentclientprotocol/claude-agent-acp dist/acp-agent.js, and @anthropic-ai/claude-agent-sdk sdk.d.ts for the full settings and sandbox options); check both sources before changing how sessions start.";
          await learnings.note(executionFor(task), [lesson], "builder", "sol-xhigh");
          await learnings.offer(executionFor(task));
          const offer = engine.getState().inbox.find((item) => item.kind === "learnings")!;
          expect(offer.body).toBe(`- ${lesson}`);
          engine.addLessons(offer.id, [0]);
          await learnings.write(executionFor(task));
          expect(await gitOps.fileAt(repo, "HEAD", "AGENTS.md")).toContain(`- ${lesson}`);
          await learnings.note(executionFor(task), [lesson], "builder", "sol-xhigh");
          await learnings.offer(executionFor(task));
          expect(engine.getState().inbox.filter((item) => item.kind === "learnings")).toEqual([]);

        });
      } finally {

        await owner.stop(engine);

      }

    });
  });

});

describe("repeated lessons", () => {


  it("offers changed instructions even when an existing, accepted or declined lesson shares most of their words", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const root = mkdtempSync(join(owner.root, "petrina-lessons-distinct-"));

      const engine = owner.open(join(root, "data"), { toolProbe: privateAgentToolProbe(), usageCommands: { codex: null } });
      try {
        await owner.run(engine, async () => {
          engine.setPoolPaused(true);
          const repo = await makeProduct(root, { origin: "none" });
          await engine.waitUntilReady(); owner.check();
          const productId = installPreparedProduct(engine, privateCloneProduct(repo));
          writeFileSync(join(repo, "AGENTS.md"), "- Run engine tests with bun test --parallel.\n");
          await gitOps.commitChanges(repo, "Existing guidance");
          const task = engine.task(engine.addTask({ productId, title: "Keep distinct instructions" }))!;
          executionFor(task).work.worktree = repo;
          const product = engine.productOf(task)!;
          product.learnings = [{ text: "Use scripts/check-one.sh for focused checks.", fromTask: task.id, at: 0 }];
          product.learningsDeclined = ["Run integration tests without installing dependencies."];
          const instructions = [
            "Do not run engine tests with bun test --parallel; use the package test command so its cleanup runs.",
            "Use scripts/check/one.sh for focused checks.",
            "Run integration tests after installing dependencies.",
            "A check with no evidence is not verified.",
            "A check with no evidence is verified.",
          ];
          const learnings = new Learnings(engine);
          await learnings.note(executionFor(task), instructions, "builder", "sol-xhigh");
          await learnings.note(executionFor(task), instructions.map((line) => `  ${line}  `), "code-reviewer", "grok-xhigh");
          await learnings.offer(executionFor(task));
          const offer = engine.getState().inbox.find((item) => item.kind === "learnings")!;
          expect(offer.body).toBe(instructions.map((line) => `- ${line}`).join("\n"));
          engine.addLessons(offer.id, [0, 1, 2, 3]);
          await learnings.write(executionFor(task));
          const writtenAgents = await gitOps.fileAt(repo, "HEAD", "AGENTS.md");
          expect(writtenAgents).toContain(instructions[0]!);
          expect(writtenAgents).toContain(instructions[1]!);
          expect(writtenAgents).not.toContain(`- ${instructions[4]}`);

        });
      } finally {

        await owner.stop(engine);

      }

    });
  });
});
