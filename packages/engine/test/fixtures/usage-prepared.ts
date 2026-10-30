import { join } from "node:path";
import { normalizePlan, type DeepMutable, type PlanDraft } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import type { Engine } from "../engine.js";
import type { Scenario } from "../fake-agent.js";
import { localFixtureSource } from "./prepared-runtime.js";
import { materializePreparedWorktree } from "./shared-preparation.js";
import type { ProductRepository } from "@petrina/test-support/repositories";

/** Declared inputs for usage subjects; no earlier participant execution is claimed. */
export async function prepareUsageStage(engine: Engine, root: string, id: string, scenario: Scenario, entry: "design" | "builder" | "review", available: () => void, initial: ProductRepository) {
  const task = engine.task(id)!;
  if (task.plan || task.journey?.some(step => step.kind === "agent") || task.findings.length)
    throw new Error("A prepared usage stage must precede its first actual participant");
  const planner = scenario.planner;
  if (planner !== undefined && !["claude-build", "short", "two-opus"].includes(planner))
    throw new Error(`No declared usage-stage recipe for ${planner}`);
  const builder = planner === "claude-build" ? "opus-high" : "sol-xhigh";
  const reviewers = planner === "claude-build" ? ["sol-high"] : planner === "short" ? ["opus-high"]
    : planner === "two-opus" ? ["opus-high", "opus-xhigh"] : ["opus-high", "sol-high"];
  const design: PlanDraft["stages"][number] = { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"],
    reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 };
  const draft: PlanDraft = { rationale: "Declared usage handoff input at its first relevant native stage", stages: [
    ...(entry === "design" ? [design] : []),
    { kind: "do", title: "Build", roleId: "builder", profileIds: [builder] },
    { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: reviewers,
      maxRounds: scenario.reviewRounds ?? (scenario.reviewer === "confirm" || planner === undefined ? 2 : 1) },
  ] };
  available();
  await localFixtureSource(engine, task, { initial, check: available });
  available();
  const plan = normalizePlan({ task, result: draft, roles: engine.s.roles, profiles: engine.s.profiles,
    plannerProfileId: "opus-high", releaseManagerProfileId: "opus-high", onUsable: id => engine.onUsable(id) });
  task.plan = structuredClone(plan) as DeepMutable<typeof plan>;
  task.risk = { level: scenario.risk ?? "medium", why: "Declared usage-stage input" };
  task.approvePlan = false;
  task.stageIndex = entry === "review" ? plan.stages.findIndex(stage => stage.kind === "review-chain") : 0;
  task.sub = 0;
  if (task.stageIndex < 0) throw new Error("The usage recipe has no review stage");
  if (entry === "review") {
    const scope = executionFor(task), product = engine.s.products.find(product => product.id === task.productId)!;
    const base = scope.work.source!.initialSha!, branch = `usage-review-${id}`, worktree = join(root, "review-input");
    scope.work.branch = branch;
    scope.work.worktree = worktree;
    await materializePreparedWorktree(engine, scope, product.path!, "main", base, "greeting.txt", "Hello\n");
    available();
    Object.assign(scope.work, { worktree, branch, base: "main", baseSha: base, preparation: "ready",
      completedStages: plan.stages.slice(0, task.stageIndex).filter(stage => stage.kind === "do").map(stage => stage.id),
      report: { summary: "Prepared greeting", changes: ["People see a greeting"], tests: "Supplied review input; no completed checks are claimed" },
    });
    // These tests concern native review/usage attribution, not check discovery. The actual
    // no-command check boundary still records its own version and environment observations.
    product.checks = []; product.checksBy = "coordinator";
    task.brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"],
      acceptance: [{ text: "A greeting file exists" }], risks: [] };
    available();
  }
  if (executionFor(task).work.checks || executionFor(task).work.checkSetup || executionFor(task).work.builderSession || task.reviewSessions)
    throw new Error("Prepared usage input cannot claim native check or participant results");
  engine.commitNow(task);
}
