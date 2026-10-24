import { executionFor, restoreRepositoryState } from "../src/repository-context.js";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { BUILT_IN_ROLES, createDemoState, DESIGN_OBJECTION_RULE, draftOf, FINDING_REQUIREMENT_RULE, NOTES_HANDOFF_RULE, ROLE_STARTS, type State } from "@petrina/core";
import { Engine } from "./engine.js";
import { type MState, renameRoles } from "../src/kernel.js";
import { buildPrompt, type PromptContext } from "../src/prompts.js";
import { contractFor, ROLE_CONTRACTS, shapeFor } from "../src/roles.js";
import { Store } from "../src/store.js";
import { makeProduct, removeDir, tempDir } from "./fixtures.js";
import { Context } from "../src/context.js";
import type { GuideKeeper } from "../src/guide-keeper.js";
import { designReviewCases } from "./design-review-cases.js";
import { findingReviewCases } from "./finding-review-cases.js";

const state = createDemoState(1_000_000_000);
const task = state.tasks[0]!;
const ctx = (overrides: Partial<PromptContext["task"]> = {}): PromptContext => ({ task: { ...task, ...overrides }, product: state.products[0]!, role: BUILT_IN_ROLES[0]!, roles: BUILT_IN_ROLES, profiles: state.profiles, worktree: "/w", branch: "b", base: "origin/main", defaultBranch: "main", sections: [] });

describe("every role's contract", () => {
  it("supplies the approved requirements, coordinator decisions and proof rules to findings and votes roles", async () => {
    const root = tempDir("petrina-finding-context-");
    const engine = new Engine(root, { agentCommand: () => [], toolPath: () => undefined });
    engine.setPoolPaused(true);
    try {
      const added = engine.addRole(ROLE_STARTS.find(entry => entry.id === "security")!.draft);
      const context = new Context(engine, { pendingPoints: async () => [] } as unknown as GuideKeeper);
      const current = structuredClone(task) as import("../src/kernel.js").MTask;
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
    } finally { await engine.shutdown(); removeDir(root); }
  });

  it("hands every brief rule to downstream roles, including covered, missing and contradictory calendar cases", async () => {
    const root = tempDir("petrina-design-context-");
    const engine = new Engine(root, { agentCommand: () => [], usageCommands: { codex: null, grok: null },  toolPath: () => undefined });
    engine.setPoolPaused(true);
    try {
      const context = new Context(engine, { pendingPoints: async () => [] } as unknown as GuideKeeper);
      const current = structuredClone(task) as import("../src/kernel.js").MTask;
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
    } finally { await engine.shutdown(); removeDir(root); }
  });

  it("grounds design blockers for built-in and edited roles, with revision-focused later rounds", () => {
    const reviewer = BUILT_IN_ROLES.find((role) => role.id === "design-reviewer")!;
    const stage = { id: "design", kind: "converge" as const, title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], maxRounds: 3 };
    const later = ctx({ plan: { stages: [stage], rationale: "Design", plannerProfileId: "opus-high" }, stageIndex: 0, rounds: { design: 2 } });
    for (const role of [reviewer, { ...reviewer, instructions: "Review the scheduling behavior." }, { ...reviewer, id: "added-design-reviewer", added: true, instructions: "Review the scheduling behavior." }]) {
      expect(contractFor(role).instructions(later)).toContain(DESIGN_OBJECTION_RULE);
      expect(contractFor(role).instructions(later)).toContain("first check the Architect's answers");
      expect(contractFor(role).reads).toEqual(["notes", "brief", "objections"]);
    }
    expect(contractFor(reviewer).instructions(later)).toContain("Design review round 2 of 3");
    expect(contractFor(reviewer).instructions(ctx())).not.toContain("Design review round 2");
  });

  it("covers every built-in role, and its example result passes its own schema", () => {
    for (const role of BUILT_IN_ROLES) expect(ROLE_CONTRACTS[role.id]).toBeDefined();
    for (const [id, contract] of Object.entries(ROLE_CONTRACTS)) {
      for (const shape of new Set([shapeFor(contract, ctx()), shapeFor(contract, ctx({ call: { text: "Do it this way", at: 1, stageIndex: 0, open: [] } as never }))])) {
        const parsed = contract.result.safeParse(JSON.parse(shape));
        expect(parsed.success ? id : `${id}: ${parsed.error.message}`).toBe(id);
      }
    }
  });

  it("tells a role the coordinator made its purpose, and has it hand back notes", () => {
    const contract = contractFor({ ...BUILT_IN_ROLES[1]!, id: "added-copy-editor", added: true, purpose: "Tighten the wording of every screen.", instructions: "Tighten the wording of every screen." });
    expect(contract.instructions(ctx())).toBe(`Tighten the wording of every screen.\n${NOTES_HANDOFF_RULE}`);
    expect(contract.reads).toEqual(["notes", "brief"]);
    expect(contract.result.safeParse({ summary: "Done.", notes: [] }).success).toBe(true);
  });
});

describe("a role renamed after the state was saved", () => {
  it("moves every stored “shipper” to the Release Manager once, as Petrina loads its state", async () => {
    const root = tempDir("petrina-renamed-role-");
    const data = join(root, "data");
    let engine = new Engine(data);
    try {
      engine.setPoolPaused(true);
      const productId = await engine.addProduct(await makeProduct(root));
      const taskId = engine.addTask({ productId, title: "Old work" });
      const saved = JSON.parse(JSON.stringify(engine.getState())) as State;
      await engine.shutdown();
      // Saved by the Petrina from before the rename, with the old id everywhere a role id is kept.
      const by = { roleId: "shipper", profileId: "opus-high" };
      Object.assign(saved.tasks[0]!, {
        state: "paused",
        delivery: "release",
        plan: {
          plannerProfileId: "sonnet-medium",
          rationale: "Old.",
          stages: [
            { id: `${taskId}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
            { id: `${taskId}:delivery`, kind: "gate", title: "Your delivery check", roleId: "shipper", profileIds: [], gate: "delivery" },
            { id: `${taskId}:ship`, kind: "do", title: "Publish a release", roleId: "shipper", profileIds: ["opus-high"] },
          ],
        },
        stageIndex: 2,
        agent: { ...by, since: 1, step: 0 },
        helpers: [{ ...by, since: 1, step: 0 }],
        conversation: { step: `${taskId}:ship`, ...by, toolId: "claude-code", model: "Opus 5.5", sessionId: "old", startedAt: 1 },
        lessons: [{ text: "Tags here are signed.", ...by, at: 1 }],
        timeline: [{ id: "old-1", at: 1, ...by, text: "Shipper started", tone: "milestone" }],
        session: [{ id: "old-2", at: 1, from: "agent", ...by, text: "Writing the notes" }],
      });
      saved.inbox = [{ id: "old-question", taskId, kind: "question", title: "Which tag?", ...by, at: 1, blocking: false }];
      const store = new Store(join(data, "petrina.db"));
      store.save(saved);
      store.close();

      engine = new Engine(data);
      const task = engine.getState().tasks[0]!;
      expect(task.plan!.stages.map((stage) => stage.roleId)).toEqual(["builder", "release-manager", "release-manager"]);
      expect(task.timeline.find((entry) => entry.id === "old-1")?.roleId).toBe("release-manager");
      expect(task.session.find((line) => line.id === "old-2")?.roleId).toBe("release-manager");
      expect(task.lessons?.[0]?.roleId).toBe("release-manager");
      expect(engine.getState().inbox.find((item) => item.id === "old-question")?.roleId).toBe("release-manager");
      // The working agents and the conversation note, as far as Petrina keeps them on a paused task, and as they were saved.
      for (const kept of [task.agent, ...(task.helpers ?? []), task.conversation]) if (kept) expect(kept.roleId).toBe("release-manager");
      restoreRepositoryState(saved.tasks[0]! as import("../src/kernel.js").MTask);
      renameRoles(saved as unknown as MState);
      const moved = saved.tasks[0]!;
      expect([moved.agent?.roleId, moved.helpers?.[0]?.roleId, moved.repository?.conversation?.roleId]).toEqual(["release-manager", "release-manager", "release-manager"]);
      expect(JSON.stringify(engine.getState())).not.toContain('"shipper"');
      // Saved under the new id: the next load has nothing to move.
      await engine.shutdown();
      const again = new Store(join(data, "petrina.db"));
      expect(JSON.stringify(again.load())).not.toContain('"shipper"');
      again.close();
      engine = new Engine(data);
    } finally {
      await engine.shutdown();
      removeDir(root);
    }
  });
});
