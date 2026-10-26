import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePlan, type DeepMutable } from "@petrina/core";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import type { Engine } from "../engine.js";
import { git } from "../fixtures.js";
import { checkBrief, checkPlan, type CheckScript } from "./check-agents.js";

/** A real built working copy is the prerequisite; every check and later repair still runs normally. */
export async function checksPrepared(engine: Engine, root: string, productId: string, script: CheckScript, available: () => void) {
  available();
  engine.setPoolPaused(true);
  await engine.waitUntilReady();
  available();
  const id = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]", backlog: true });
  const task = engine.task(id)!, scope = executionFor(task);
  const product = engine.s.products.find(product => product.id === productId)!;
  const base = await git(product.path!, "rev-parse", "HEAD"), branch = `prepared-checks-${id}`;
  const worktree = join(root, "built-work");
  available();
  await git(product.path!, "worktree", "add", "-q", "-b", branch, worktree, base);
  available();
  writeFileSync(join(worktree, "greeting.txt"), "Hello\n");
  await git(worktree, "add", ".");
  available();
  await git(worktree, "commit", "-q", "-m", "Add a greeting");
  available();
  Object.assign(scope.work, {
    worktree, branch, base: "main", baseSha: base, delivery: "local", preparation: "ready",
    report: { summary: "Added a greeting.", changes: ["People see a greeting"], tests: "Petrina runs the product checks." },
    source: { product: { ...product }, start: { kind: "default", branch: "main" },
      destination: { kind: "branch", mode: "local", repo: product.repo, branch: "main" }, confirmed: true, initialSha: base },
  });
  const plan = normalizePlan({ task: repositoryView(scope), result: checkPlan(script), roles: engine.s.roles,
    profiles: engine.s.profiles, plannerProfileId: "sol-high", releaseManagerProfileId: "opus-high", onUsable: id => engine.onUsable(id) });
  task.plan = structuredClone(plan) as DeepMutable<typeof plan>;
  const build = plan.stages.findIndex(stage => stage.kind === "do" && engine.role(stage.roleId, task)?.result === "build");
  if (build < 0) throw new Error("The prepared check recipe has no initial Builder stage");
  const brief = checkBrief();
  task.brief = { summary: brief.summary, forUsers: brief.forUsers, areas: brief.areas,
    acceptance: brief.acceptance.map(text => ({ text })), risks: brief.risks };
  scope.work.completedStages = plan.stages.slice(0, build + 1).map(stage => stage.id);
  task.risk = { level: "medium", why: "The planner did not rate it." };
  task.stageIndex = build + 1; task.sub = 0; task.startedAt = Date.now(); task.state = "waiting";
  task.column = engine.columnFor(task);
  // No result, setup observation, passing check, approval or participant session is invented here.
  engine.commitNow(task);
  return id;
}
