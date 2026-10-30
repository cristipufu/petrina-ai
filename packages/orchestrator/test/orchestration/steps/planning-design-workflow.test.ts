import { BUILT_IN_ROLES, DEFAULT_PROFILES, beginAgentStep, roleForTask, type Product } from "@petrina/core";
import { describe, expect, it } from "vitest";
import {
  DesignConversations,
  DesignWorkflow,
  PlanningWorkflow,
  executionFor,
} from "../../../src/index.js";
import { repositoryTask } from "../../fixtures/tasks.js";

const products: readonly Product[] = [
  { id: "a", name: "Shop", repo: "local/shop", tone: "blue" },
  { id: "b", name: "API", repo: "local/api", tone: "green" },
];

describe("portable planning and design workflows", () => {
  it("normalizes planner replies, defaults risk, and filters source pointers to planned products", async () => {
    const task = repositoryTask(false);
    const notes: string[] = [];
    let finished = 0;
    let ended = 0;
    beginAgentStep(task, "planner", "sol-high", 10, BUILT_IN_ROLES);
    const workflow = new PlanningWorkflow(
      {
        plannerProfileId: "sol-high",
        releaseManagerProfileId: "sol-high",
        riskWord: { low: "Low", medium: "Medium", high: "High" },
        now: () => 20,
        products: () => products,
        roles: () => BUILT_IN_ROLES,
        profiles: () => DEFAULT_PROFILES,
        onUsable: (id) => id,
        note: (_task, _tone, text) => {
          notes.push(text);
        },
        finishStep: () => {
          finished += 1;
        },
        endStage: () => {
          ended += 1;
        },
        changed: () => {},
      },
      {
        readOrientation: async () => [{ title: "Orientation", body: "README summary" }],
        proposeSources: async () => {},
        runTurn: async (_scope, request) => {
          expect(request.sections()).toHaveLength(2);
          return {
            rationale: "Build and review cleanly",
            sourcePointers: [
              { productId: "a", revision: "a".repeat(40), path: "src/index.ts" },
              { productId: "unknown", revision: "b".repeat(40), path: "src/other.ts" },
            ],
            stages: [{ kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-xhigh"] }],
          };
        },
      },
    );

    await workflow.runPlanner(task, new AbortController().signal);

    expect(task.risk).toEqual({ level: "medium", why: "The planner did not rate it." });
    expect(task.sourcePointers).toEqual([{ productId: "a", revision: "a".repeat(40), path: "src/index.ts" }]);
    expect(task.plan?.stages.some((stage) => stage.roleId === "builder")).toBe(true);
    expect(notes.some((line) => line.includes("Left out 1 optional source location"))).toBe(true);
    expect(notes.some((line) => line.startsWith("Plan ready:"))).toBe(true);
    expect(finished).toBe(1);
    expect(ended).toBe(1);
  });

  it("converges design author and reviewer rounds and settles non-blocking final notes", async () => {
    const task = repositoryTask(false);
    const stage = {
      id: "design",
      kind: "converge" as const,
      title: "Design",
      roleId: "architect",
      profileIds: ["opus-xhigh"],
      reviewerRoleId: "design-reviewer",
      reviewerProfileIds: ["sol-xhigh"],
      maxRounds: 2,
    };
    task.plan = { rationale: "Design first", plannerProfileId: "sol-high", stages: [stage] };
    task.stageIndex = 0;
    const conversations = new DesignConversations({
      profile: (id) => DEFAULT_PROFILES.find((profile) => profile.id === id),
      profiles: () => DEFAULT_PROFILES,
      role: (id) => roleForTask(BUILT_IN_ROLES, id, task),
      digest: (text) => text,
      conversation: () => undefined,
      contextIntact: async () => true,
      unavailable: (reason) => new Error(reason),
    });
    const notes: string[] = [];
    const workflow = new DesignWorkflow(
      conversations,
      {
        now: () => 50,
        id: (prefix) => `${prefix}-1`,
        role: (id) => roleForTask(BUILT_IN_ROLES, id, task),
        formatObjections: (items) => items.map((item) => item.id).join(","),
        note: (_scope, _tone, text) => {
          notes.push(text);
        },
        finishStep: () => {},
        rerun: () => false,
        recordDesignRound: () => {},
        recordDesignEnd: () => {},
        endStage: () => {},
        raiseDisagreement: () => {},
        checkpoint: () => {},
        changed: () => {},
      },
      {
        runAuthorTurn: async () => ({
          summary: "Clear design brief",
          forUsers: ["Simpler flow"],
          areas: ["orchestrator"],
          acceptance: ["All tests pass"],
          risks: [],
          answers: [],
        }),
        runReviewerTurn: async () => ({
          objections: [{ text: "Optional minor polish", blocking: false }],
        }),
        saveRoleEdits: async () => {},
      },
    );

    const scope = executionFor(task);
    beginAgentStep(task, "architect", "opus-xhigh", 30, BUILT_IN_ROLES);
    expect(await workflow.runConverge(scope, stage, new AbortController().signal)).toBe("continue");
    expect(task.sub).toBe(1);
    expect(task.brief?.summary).toBe("Clear design brief");

    beginAgentStep(task, "design-reviewer", "sol-xhigh", 40, BUILT_IN_ROLES);
    expect(await workflow.runConverge(scope, stage, new AbortController().signal)).toBe("continue");
    expect(task.stageIndex).toBe(1);
    expect(task.sub).toBe(0);
    expect(task.objections[0]?.status).toBe("noted");
    expect(notes).toContain("Design settled: no blocking objections");
  });
});
