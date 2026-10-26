import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePlan, type DeepMutable } from "@petrina/core";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import type { Engine } from "../engine.js";
import { directDrivers, closeDirectDrivers } from "./direct-drivers.js";
import { installPreparedProduct } from "./prepared-product.js";
import { git, makeProduct } from "../fixtures.js";
import { commandInputText } from "../../src/checks.js";

/** The native Tester owns real Git/check/session work; unrelated planning/building is an explicit starting boundary. */
export function testerEvidenceFixtures() {
  const active = new Set<ReturnType<typeof directDrivers>>();
  const own = (root: string) => {
    const owner = directDrivers(root); active.add(owner);
    return { ...owner, close: async () => { await owner.close(); active.delete(owner); } };
  };
  async function prepare(engine: Engine, root: string, title: string, first: boolean, full = false) {
    const repo = await makeProduct(root);
    const productId = installPreparedProduct(engine, { id: "clone", name: "Clone", repo: "local/clone", tone: "blue", path: repo,
      remote: join(root, "origin.git"), defaultBranch: "main", delivery: "local", approveDelivery: true });
    if (full) return { productId, id: engine.addTask({ productId, title, description: "[no-check]" }) };
    const id = engine.addTask({ productId, title, description: "[no-check]", backlog: true }), task = engine.task(id)!;
    const scope = executionFor(task), product = engine.s.products.find(product => product.id === productId)!;
    const base = await git(repo, "rev-parse", "HEAD"), branch = "prepared-tester", worktree = join(root, "work");
    await git(repo, "worktree", "add", "-q", "-b", branch, worktree, base);
    writeFileSync(join(worktree, "greeting.txt"), "Hello\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Prepare the greeting for acceptance");
    scope.work.source = { product: { ...product }, start: { kind: "default", branch: "main" },
      destination: { kind: "branch", mode: "local", repo: product.repo, branch: "main" }, confirmed: true, initialSha: base };
    Object.assign(scope.work, { worktree, branch, base: "main", baseSha: base, delivery: "local", preparation: "ready",
      report: { summary: "Added the greeting.", changes: ["People see a greeting"] } });
    const plan = normalizePlan({ task: repositoryView(scope), result: {
      rationale: "Build, try acceptance, review and deliver the greeting.", stages: [
        ...(!first ? [{ kind: "converge" as const, title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 }] : []),
        { kind: "do", title: "Build", roleId: "builder", profileIds: [first ? "opus-xhigh" : "sol-xhigh"] },
        { kind: "do", title: "Try acceptance", roleId: "tester", profileIds: ["opus-high"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: first ? ["opus-xhigh", "sol-xhigh"] : ["opus-high", "sol-high"], maxRounds: 2 },
      ] }, roles: engine.s.roles, profiles: engine.s.profiles, plannerProfileId: "sol-high", releaseManagerProfileId: "opus-high", onUsable: id => engine.onUsable(id) });
    task.plan = structuredClone(plan) as DeepMutable<typeof plan>;
    task.brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: [{ text: "A greeting file exists" }], risks: [] };
    task.stageIndex = plan.stages.findIndex(stage => engine.role(stage.roleId, task)?.result === "checks");
    scope.work.completedStages = plan.stages.slice(0, task.stageIndex).map(stage => stage.id);
    // These are declarations, never saved successful checks; the actual runner verifies them before testing.
    engine.setProductChecks(productId, [{ name: "Version", command: commandInputText(["git", "--version"]) }]);
    task.startedAt = Date.now(); task.state = "waiting";
    engine.commitNow(task); engine.schedule();
    return { productId, id };
  }
  return { own, prepare, close: async () => { await closeDirectDrivers(active); active.clear(); } };
}
