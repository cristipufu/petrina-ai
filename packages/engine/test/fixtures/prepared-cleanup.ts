import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor, resolveSource, type SourceQueries } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { git } from "@petrina/test-support/commands";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { headNow } from "@petrina/test-support/repository-head";
import type { Engine } from "../engine.js";
import { cleanupBuildOutput } from "./cleanup-agents.js";
import type { CleanupWorld } from "./cleanup-world.js";

type CleanupInputWorld = Pick<CleanupWorld, "script" | "signal" | "clone">;
const available = (engine: Engine, world: CleanupInputWorld) => {
  world.signal.throwIfAborted();
  engine.stopRequested.signal.throwIfAborted();
};

/** A saved cleanup input owns a real copy and commit, without claiming checks or publication. */
export async function addSavedCleanupInput(engine: Engine, world: CleanupInputWorld, request: Parameters<Engine["addTask"]>[0]): Promise<string> {
  available(engine, world);
  const id = engine.addTask({ ...request, backlog: true });
  const task = engine.task(id)!, scope = executionFor(task), product = engine.s.products.find(product => product.id === scope.work.productId)!;
  const path = fixtureFiles.canonical(world.clone), remote = product.remote, workProduct = scope.work.workProduct;
  const active = () => {
    available(engine, world);
    if (engine.task(id) !== task || task.repositories || task.workRows || scope.work.workProduct !== workProduct
      || executionFor(task).work !== scope.work || engine.productOf(scope) !== product || product.path !== path
      || product.defaultBranch !== "main" || product.remote !== remote
      || workProduct?.id !== product.id || workProduct.path !== path || workProduct.repo !== product.repo
      || workProduct.defaultBranch !== "main" || workProduct.remote !== remote
      || !(product.id === "demo" && product.repo === "acme/demo" && remote === "https://github.com/acme/demo.git"
        || product.id === "clone" && product.repo === "local/clone" && remote === undefined))
      throw new Error("The saved cleanup input requires its captured private main product");
  };
  active();
  task.startedAt = Date.now(); task.state = "paused"; task.stageIndex = 2; task.holdsSlot = false;
  task.plan = { rationale: "Supplied work preceding owned delivery and working-copy cleanup", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
    { id: "delivery", kind: "gate", title: "Your delivery check", roleId: "coordinator", profileIds: [], gate: "delivery" },
    { id: "publish", kind: "do", title: "Publish", roleId: "release-manager", profileIds: ["opus-high"] },
  ] };
  const choice = { productId: product.id, delivery: scope.work.delivery, startFrom: { kind: "default" as const } };
  let validated = false;
  // This completed private recipe declares main; source/destination policy still belongs to resolveSource.
  const queries: SourceQueries = {
    async validBranch(name) {
      active();
      if (validated || name !== "main") throw new Error("Unexpected cleanup fixture branch validation");
      validated = true;
      return true;
    },
    async requireBranch() { active(); throw new Error("Cleanup input must not request a remote branch lookup"); },
    async pullRequest() { active(); throw new Error("Cleanup input must not request pull-request resolution"); },
  };
  const source = await resolveSource(scope, choice, engine.s.products, queries);
  active();
  if (!validated) throw new Error("The saved cleanup source did not consume its main precondition");
  scope.work.source = { ...source, confirmed: true };
  await engine["driver"]["prepare"](scope, world.signal);
  active();
  writeFileSync(join(scope.work.worktree!, "greeting.txt"), "Hello\n");
  cleanupBuildOutput(world, scope.work.worktree!);
  await git(scope.work.worktree!, "add", ".");
  active();
  await git(scope.work.worktree!, "commit", "-qm", "Prepare the supplied cleanup fixture change");
  active();
  scope.work.report = { summary: "Added the greeting", title: task.title, changes: ["People see a greeting"], description: "The completed fixture change" };
  engine.commitNow(task);
  return id;
}

/** Start the real delivery/cleanup boundary from an explicitly completed private build and review. */
export async function addPreparedCleanupTask(engine: Engine, world: CleanupInputWorld, request: Parameters<Engine["addTask"]>[0]): Promise<string> {
  const id = await addSavedCleanupInput(engine, world, request);
  available(engine, world);
  const task = engine.task(id)!, scope = executionFor(task), product = engine.s.products.find(product => product.id === scope.work.productId)!;
  const tree = (await gitOps.treeOf(scope.work.worktree!))!;
  available(engine, world);
  scope.work.reviewedTree = tree;
  // No discovery turn belongs to this already-reviewed fixture; actual delivery still records its empty check evidence.
  product.checks = []; product.checksBy = "coordinator";
  task.state = "waiting";
  engine.commitNow(task);
  engine.schedule();
  return id;
}

/** Native polling/cleanup starts from a private remote observation; recording still belongs to production. */
export async function addObservedCleanupPullRequest(engine: Engine, world: CleanupInputWorld & Pick<CleanupWorld, "remote">, request: Parameters<Engine["addTask"]>[0]): Promise<string> {
  const id = await addSavedCleanupInput(engine, world, request);
  available(engine, world);
  const task = engine.task(id)!, scope = executionFor(task), work = scope.work;
  if (work.delivery !== "pull-request" || work.source?.destination.kind !== "new-pr" || !work.branch || !work.worktree)
    throw new Error("Cleanup pull-request observations need a prepared private new-PR copy");
  const head = headNow(work.worktree);
  available(engine, world);
  await git(work.worktree, "push", world.remote, `HEAD:refs/heads/${work.branch}`);
  available(engine, world);
  const repo = work.source.product.repo, base = work.source.destination.branch;
  const opened = await engine.github.openPullRequest(repo, { head: work.branch, base, title: task.title, body: "Supplied pull request for native cleanup" });
  available(engine, world);
  if (!opened.ok) throw new Error(`The private cleanup pull request did not open: ${opened.error}`);
  const observed = await engine.github.pullRequests(repo, work.branch);
  available(engine, world);
  if (!observed.ok) throw new Error(`The private cleanup pull request could not be observed: ${observed.error}`);
  const matches = observed.value.filter(pr => pr.head === work.branch && pr.base === base && pr.commit === head && pr.state === "open" && pr.url === opened.url && !pr.fork);
  if (matches.length !== 1) throw new Error("The private cleanup pull request did not match its real branch and commit");
  // The actual recording owner writes the delivered history moment. No check or approval facts are manufactured.
  engine["shipping"]["recordPr"](scope, matches[0]!, "opened");
  return id;
}
