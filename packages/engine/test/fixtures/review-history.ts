import { type EngineCaseOwner } from "./engine-cases.js";
import { mkdtempSync } from "node:fs";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { beginAgentStep, BUILT_IN_ROLES, type DeepMutable, type Finding, type JourneyStep } from "@petrina/core";
import { Context, type Section } from "../../src/context.js";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import { prepareReviewInput, readReviewInput, type ReviewInput } from "../../src/review-context.js";
import { buildPrompt, continuePrompt } from "../../src/prompts.js";
import { git, makeProduct } from "../fixtures.js";
export function frozenHistoryFixtures() {
  const sha = (body: string) => createHash("sha256").update(body).digest("hex");
  const role = BUILT_IN_ROLES.find(role => role.id === "code-reviewer")!;
  const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: role.id, profileIds: ["sol-high", "opus-high", "grok-high"] };
  function finding(id = "f"): DeepMutable<Finding> {
    return { id, text: `Full problem statement for ${id}`, where: "The affected location", productIds: ["p"], severity: "blocking", raisedBy: "sol-high", roleId: role.id, status: "fixed", confirmedBy: ["opus-high"], evidence: `Original evidence for ${id}. `.repeat(100), steps: `Original reproduction for ${id}`, votes: [{ by: "grok-high", toolId: "grok", verdict: "real", reason: `Original vote for ${id}` }], answer: { fixed: true, text: `Builder answer for ${id}`, at: 10 }, sameBug: "card", tracking: { taskId: "card" } };
  }
  function examined(findings: readonly Finding[], extra: Partial<JourneyStep> = {}): DeepMutable<JourneyStep> {
    return structuredClone({ id: "checked", kind: "agent", roleId: role.id, stageId: stage.id, round: 2, sub: 0, startedAt: 20, endedAt: 30, seats: ["reviewer:0", "reviewer:1", "reviewer:2"], result: { findings, findingsSettled: true, findingChanges: { raised: [], fixed: findings.map(f => f.id), dismissed: [], claimedFixed: findings.map(f => f.id) } }, ...extra }) as DeepMutable<JourneyStep>;
  }
  async function fixture(owner: EngineCaseOwner, count = 1) {
    const root = mkdtempSync(join(owner.root, "petrina-history-"));
    const repo = await makeProduct(root), base = await git(repo, "rev-parse", "HEAD");
    const data = join(root, "data");
    const engine = owner.open(data, { admissionsClosed: true, agentCommand: () => undefined, terminals: () => [] });
    return setupWithCleanup(async () => {
      engine.schedule = () => {}; engine.setPoolPaused(true);
      engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
      const id = engine.addTask({ productId: "p", title: "Review history", backlog: true });
      const task = engine.task(id)!, scope = executionFor(task);
      Object.assign(scope.work, { worktree: repo, baseSha: base, base: "main", report: { summary: "Current Builder report", changes: [] } });
      task.plan = { rationale: "Review", plannerProfileId: "sol-high", stages: [stage] }; task.stageIndex = 0; task.rounds = { review: 3 };
      task.findings = Array.from({ length: count }, (_, index) => finding(`f${index}`));
      task.journey = count ? [examined(task.findings)] : [];
      const context = new Context(engine, { pendingPoints: async () => [] });
      return { owner, root, repo, base, data, engine, task, scope, context };
    }, () => owner.stop(engine));
  }
  async function freeze(f: Awaited<ReturnType<typeof fixture>>, cards?: ReviewInput["cards"]) {
    return f.owner.run(f.engine, async () => {
      const snapshot = await f.context.captureReview(f.scope); if (cards) snapshot.cards = cards;
      const ref = await prepareReviewInput(f.data, f.scope, snapshot, new AbortController().signal);
      f.task.hunt = { id: "round-3", stageId: stage.id, round: 3, reported: {}, input: ref };
      const step = beginAgentStep(f.task, role.id, "sol-high", 40, f.engine.s.roles, stage.profileIds, f.scope.work);
      step.reviewInput = ref;
      return { ref, input: await readReviewInput(ref), step };
    });
  }
  const longCard = { id: "card", title: "Complete follow-up identity", productIds: ["p"], problem: "Opening of the original problem. ".repeat(100) + "Unique tail identity and evidence." };
  async function supplied(f: Awaited<ReturnType<typeof fixture>>, input: ReviewInput, member = "review-0") {
    return f.owner.run(f.engine, async () => {
      const sections = await f.context.sectionsFor(f.scope, role.id, member, undefined, undefined, input);
      return (await f.engine["turns"]["prepareTurnPrompt"](f.scope, role, `fresh-${member}`, sections, undefined, { packet: true, findings: input.findings })).sections;
    });
  }
  const opening = (f: Awaited<ReturnType<typeof fixture>>, sections: readonly Section[]) => buildPrompt({ task: repositoryView(f.scope), product: f.engine.s.products[0]!, role, roles: f.engine.s.roles, profiles: f.engine.s.profiles, tools: f.engine.s.tools, worktree: f.repo, branch: "task", base: "main", defaultBranch: "main", sections });
  function journeyCharacters(f: Awaited<ReturnType<typeof fixture>>, before: readonly Section[], after: readonly Section[], mode = "fresh") {
    const step = f.task.journey!.at(-1)!;
    const inputs = (supplied: readonly Section[]) => [0, 1, 2].map(i => ({ mode, roleId: role.id, profileId: stage.profileIds[i]!, reviewerKey: String(i), taskTitle: f.task.title, reviewInput: step.reviewInput, sections: supplied.map(({ title, body }) => ({ title, body })) }));
    return { before: JSON.stringify({ ...step, reviewHistory: undefined, agentInputs: inputs(before) }).length, after: JSON.stringify({ ...step, agentInputs: inputs(after) }).length };
  }
  function measure(name: string, f: Awaited<ReturnType<typeof fixture>>, sections: readonly Section[], body = "") {
    const complete = sections.map(section => ({ ...section, body: section.background ?? section.body }));
    const before = opening(f, complete).length, after = opening(f, sections).length;
    const saved = journeyCharacters(f, complete, sections);
    // Whole serialized fixture journey step: three supplied seat records and the
    // single retained body, including JSON escaping. Working files are separate.
    console.log(`History characters ${name}: opening ${before} -> ${after}; serialized journey round (3 fixture seats) ${saved.before} -> ${saved.after}; complete reference ${body.length ? "available" : "not needed"}. Tokens, cost and time unmeasured.`);
    return { before, after };
  }
  function measureWarm(name: string, f: Awaited<ReturnType<typeof fixture>>, beforeSections: readonly Section[], afterSections: readonly Section[]) {
    const ctx = { task: repositoryView(f.scope), product: f.engine.s.products[0]!, role, roles: f.engine.s.roles, profiles: f.engine.s.profiles, tools: f.engine.s.tools, worktree: f.repo, branch: "task", base: "main", defaultBranch: "main" };
    const before = continuePrompt({ ...ctx, sections: beforeSections }).length, after = continuePrompt({ ...ctx, sections: afterSections }).length;
    const saved = journeyCharacters(f, beforeSections, afterSections, "continued");
    console.log(`History characters ${name}: opening ${before} -> ${after}; serialized journey round (3 fixture seats) ${saved.before} -> ${saved.after}; complete packet available, no shortened entries supplied. Tokens, cost and time unmeasured.`);
    expect(before).toBe(after); expect(saved.before).toBe(saved.after);
  }

  return { sha, role, stage, finding, examined, fixture, freeze, longCard, supplied, opening, journeyCharacters, measure, measureWarm };
}
