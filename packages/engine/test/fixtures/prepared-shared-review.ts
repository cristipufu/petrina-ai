import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePlan, type DeepMutable } from "@petrina/core";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import type { Engine } from "../engine.js";
import { git } from "../fixtures.js";
import { commandInputText } from "../../src/checks.js";

/** Call inside sharedWorld's mandatory owned generation callback. Every copy/check/review below remains native. */
export async function preparedSharedReview(engine: Engine, ids: readonly string[], title: string, parallel: boolean) {
  engine.setPoolPaused(true);
  const id = engine.addTask({ productId: ids[0]!, worksOn: ids.map(productId => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title, backlog: true });
  const task = engine.task(id)!;
  const owners = [];
  for (const productId of ids) {
    const product = engine.s.products.find(product => product.id === productId)!;
    const base = await git(product.path!, "rev-parse", "HEAD"), branch = `prepared-review-${id}-${productId}`, worktree = join(engine.dataDir, "prepared-review", id, productId);
    await git(product.path!, "worktree", "add", "-q", "-b", branch, worktree, base);
    writeFileSync(join(worktree, "greeting.txt"), "Hello\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Prepare the shared greeting for review");
    owners.push({ productId, worktree, branch, base: "main", baseSha: base, delivery: "pull-request" as const,
      preparation: "ready" as const, completedStages: [] as string[], report: { summary: "Added a greeting.", changes: ["People see a greeting"] },
      workChoice: { productId, startFrom: { kind: "default" as const }, delivery: "pull-request" as const },
      source: { product: { ...product }, start: { kind: "default" as const, branch: "main" }, destination: { mode: "pull-request" as const, kind: "new-pr" as const, repo: product.repo, branch: "main" }, confirmed: true, initialSha: base } });
    engine.setProductChecks(productId, [{ name: "Version", command: commandInputText(["git", "--version"]) }]);
  }
  delete task.repository; task.repositories = owners; task.activeProductId = ids[0]; task.leadProductId = ids[0];
  const scope = executionFor(task);
  const plan = normalizePlan({ task: repositoryView(scope), result: { rationale: "Explicit shared repository prerequisites.", stages: [
    { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
    { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: parallel ? ["opus-high", "sol-high"] : ["opus-high"], maxRounds: 1 },
  ] }, roles: engine.s.roles, profiles: engine.s.profiles, plannerProfileId: "sol-high", releaseManagerProfileId: "opus-high", onUsable: id => engine.onUsable(id) });
  task.plan = structuredClone(plan) as DeepMutable<typeof plan>;
  task.stageIndex = plan.stages.findIndex(stage => stage.kind === "review-chain");
  for (const work of owners) work.completedStages = plan.stages.slice(0, task.stageIndex).map(stage => stage.id);
  task.startedAt = Date.now(); task.state = "waiting";
  engine.commitNow(task); engine.setPoolPaused(false);
  return id;
}
