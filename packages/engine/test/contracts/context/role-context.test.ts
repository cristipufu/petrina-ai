import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll as closeOwnedCases } from "bun:test";
import { executionFor, restoreRepositoryState } from "@petrina/orchestrator";
import { describe, expect, it } from "bun:test";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, DEMO_PRODUCTS, KNOWN_TOOLS, draftOf, FINDING_REQUIREMENT_RULE, ROLE_STARTS } from "@petrina/core";
import { buildPrompt, type PromptContext } from "../../../src/prompts.js";
import { contractFor, shapeFor } from "../../../src/roles.js";
import { Context } from "../../../src/context.js";
import { designReviewCases } from "../../design-review-cases.js";
import { findingReviewCases } from "../../finding-review-cases.js";
import { promptTask } from "../../fixtures/prompt-context.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const state = { products: DEMO_PRODUCTS, profiles: DEFAULT_PROFILES, tools: KNOWN_TOOLS };
const task = promptTask();
const ctx = (overrides: Partial<PromptContext["task"]> = {}): PromptContext => ({ task: { ...task, ...overrides }, product: state.products[0]!, role: BUILT_IN_ROLES[0]!, roles: BUILT_IN_ROLES, profiles: state.profiles, tools: state.tools, worktree: "/w", branch: "b", base: "origin/main", defaultBranch: "main", sections: [] });


describe("every role's contract", () => {
  it("supplies the approved requirements, coordinator decisions and proof rules to findings and votes roles", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const root = mkdtempSync(join(owner.root, "petrina-finding-context-"));
      const engine = owner.open(root, { agentCommand: () => [], toolPath: () => undefined });
      engine.setPoolPaused(true);
      try {
        await owner.run(engine, async () => {
          const added = engine.addRole(ROLE_STARTS.find(entry => entry.id === "security")!.draft);
          const context = new Context(engine, { pendingPoints: async () => [] });
          const current = structuredClone(task) as import("../../../src/kernel.js").RuntimeTask;
          restoreRepositoryState(current);
          current.queued = [];
          current.sourcePointers = [];
          current.findings = [];
          current.plan = { stages: [{ id: "acceptance", kind: "do", title: "Acceptance", roleId: "tester", profileIds: ["sol-high"] }], rationale: "Verify required outcomes.", plannerProfileId: "sol-high" };
          for (const edited of [false, true]) {
            if (edited) for (const id of ["code-reviewer", "security-reviewer", "verifier", added]) {
              const role = engine.getState().roles.find(entry => entry.id === id)!;
              engine.saveRole(id, { ...draftOf(role), instructions: "Check only this product's requested behavior." });
            }
            for (const sample of findingReviewCases) {
              current.title = sample.name;
              current.description = sample.request;
              current.brief = { summary: sample.name, forUsers: [], areas: [], acceptance: [{ text: sample.acceptance }], risks: [] };
              current.notes = [{ id: "scope-decision", text: sample.decision, at: 1 }];
              for (const id of ["code-reviewer", "security-reviewer", "verifier", added]) {
                const role = engine.getState().roles.find(entry => entry.id === id)!;
                const sections = await context.sectionsFor(executionFor(current), id);
                const prompt = buildPrompt({ ...ctx(current), role, roles: engine.getState().roles, sections });
                expect(prompt).toContain(sample.request);
                expect(prompt).toContain(sample.acceptance);
                expect(prompt).toContain(sample.decision);
                expect(prompt.split(FINDING_REQUIREMENT_RULE)).toHaveLength(2);
                const proof = sections.find(section => section.title === "Proof requests for final acceptance testing");
                if (role.result === "findings") {
                  expect(proof?.body).toContain("Do not raise, reopen or confirm a finding solely for missing validation");
                  expect(shapeFor(contractFor(role), { ...ctx(current), role })).toContain('"proofRequests": [');
                } else expect(proof).toBeUndefined();
              }
            }
          }

        });
      } finally { await owner.stop(engine);  }

    });
  });

  it("hands every brief rule to downstream roles, including covered, missing and contradictory calendar cases", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const root = mkdtempSync(join(owner.root, "petrina-design-context-"));
      const engine = owner.open(root, { agentCommand: () => [], usageCommands: { codex: null, grok: null },  toolPath: () => undefined });
      engine.setPoolPaused(true);
      try {
        await owner.run(engine, async () => {
          const context = new Context(engine, { pendingPoints: async () => [] });
          const current = structuredClone(task) as import("../../../src/kernel.js").RuntimeTask;
          restoreRepositoryState(current);
          current.queued = [];
          current.sourcePointers = [];
          for (const test of designReviewCases) {
            current.brief = { summary: test.name, forUsers: ["Run maintenance"], areas: [...test.areas], acceptance: test.acceptance.map((text) => ({ text })), risks: ["Keep missed runs bounded"] };
            for (const roleId of ["architect", "design-reviewer", "builder", "tester", "code-reviewer"]) {
              const brief = (await context.sectionsFor(executionFor(current), roleId)).find((section) => section.title === "Design brief")!.body;
              for (const rule of [...test.areas, ...test.acceptance]) expect(brief).toContain(rule);
            }
          }

        });
      } finally { await owner.stop(engine);  }

    });
  });
});
