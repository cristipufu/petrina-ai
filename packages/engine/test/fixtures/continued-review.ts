import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, MAINTENANCE_ROLES, type DeepMutable, type Finding, type Stage, type Task } from "@petrina/core";
import { directDrivers, closeDirectDrivers } from "./direct-drivers.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { installPreparedProduct } from "./prepared-product.js";
import { executionFor } from "@petrina/orchestrator";

import { ReviewResult } from "../../src/roles.js";

import { git, makeProduct, tempDir } from "../fixtures.js";

// Controls for a coordinator's decision to continue an exhausted review (the whole workflow is in
// review-continuation.test.ts): one review round at a time, on real working copies.
export function continuedReviewFixtures() {
const fixtures = new Set<ReturnType<typeof directDrivers>>();

const COVERED = "review passed; 1 earlier important still open under your decision to continue";

const signal = () => new AbortController().signal;
const important = (id: string, extra: Partial<DeepMutable<Finding>> = {}): DeepMutable<Finding> => ({ id, text: `Problem ${id}`, evidence: `Reproduced ${id}`, severity: "blocking", status: "open", raisedBy: "sol-high", confirmedBy: ["opus-high"], ...extra });

/**
 * A task at its code review's only round, on products each with the task's own commit, with a later review and
 * acceptance testing to come. `later`: the later review's role; `builder`: the Builder stage's role; `tested`:
 * acceptance testing comes before that review.
 */
async function rounds(options: { shared?: boolean; later?: string; builder?: string; tested?: boolean } = {}) {
  const root = tempDir("petrina-review-continuation-rounds-");
  const lifetime = directDrivers(root); fixtures.add(lifetime);
  const close = async () => { await lifetime.close(); fixtures.delete(lifetime); };
  return setupWithCleanup(() => lifetime.prepare(async () => {
  const engine = lifetime.open(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  const owner = async (index: number, name: string) => {
    const repo = await makeProduct(join(root, `product-${index}`), { origin: "none" });
    const productId = installPreparedProduct(engine, { id: index === 0 ? "clone" : "clone-2", path: repo, name, repo: "local/clone",
      tone: index === 0 ? "blue" : "green", defaultBranch: "main", delivery: "local", approveDelivery: true });
    const product = engine.s.products.find((entry) => entry.id === productId)!;
    const worktree = join(root, `work-${index}`), baseSha = await git(repo, "rev-parse", "HEAD"), branch = `continued-${index}`;
    await git(repo, "worktree", "add", "-q", "-b", branch, worktree, baseSha);
    writeFileSync(join(worktree, "feature.txt"), "the task's change\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Add the feature");
    return { productId, repo, worktree, baseSha, base: baseSha, branch, delivery: "local" as const, completedStages: ["build"], preparation: "ready" as const,
      source: { product, start: { kind: "default" as const, branch: "main" }, destination: { mode: "local" as const, kind: "branch" as const, repo: product.repo, branch: "main" }, confirmed: true } };
  };
  const owners: Awaited<ReturnType<typeof owner>>[] = [];
  for (const [index, name] of (options.shared ? ["Shop", "API"] : ["Shop"]).entries()) owners.push(await owner(index, name));
  const task = engine.task(engine.addTask({ productId: owners[0]!.productId, title: "A continued review", backlog: true }))!;
  if (options.shared) { delete task.repository; task.repositories = owners.map(({ repo: _repo, ...work }) => work); task.activeProductId = owners[0]!.productId; }
  else { const { repo: _repo, ...work } = owners[0]!; task.repository = work; }
  const builder = options.builder ?? "builder";
  if (builder !== "builder") task.maintenance = { routineId: "daily", routineName: "Daily", scheduledAt: 1, queuedAt: 1, zone: "UTC", focus: "Care", input: "Care", role: { ...MAINTENANCE_ROLES.find((role) => role.result === "build")!, id: builder, name: "Saved caretaker" }, profile: engine.profile("opus-high")!, product: engine.s.products[0]! };
  const later = options.later ?? "security-reviewer";
  const stage = (id: string, kind: Stage["kind"], roleId: string, extra: Partial<DeepMutable<Stage>> = {}): DeepMutable<Stage> => ({ id, title: id, kind, roleId, profileIds: kind === "gate" ? [] : ["opus-high"], ...extra });
  const test = stage("test", "do", "tester"), security = stage("security", "review-chain", later, { maxRounds: 2 });
  task.plan = { rationale: "Round-level fixture", plannerProfileId: "sol-high", stages: [
    stage("build", "do", builder), stage("review", "review-chain", "code-reviewer", { maxRounds: 1 }),
    ...(options.tested ? [test, security] : [security, test]),
    stage("delivery", "gate", "release-manager", { gate: "delivery" }), stage("ship", "do", "release-manager"),
  ] };
  task.state = "running"; task.stageIndex = 1;
  const reviewsOwner = engine["reviews"];
  const reviews = {
    closeReviewRound: reviewsOwner["closeReviewRound"].bind(reviewsOwner),
    applyReview: reviewsOwner["applyReview"].bind(reviewsOwner),
  };
  const stageOf = (id: string) => task.plan!.stages.find((entry) => entry.id === id)!;
  const open = () => engine.s.inbox.filter((item) => item.taskId === task.id && item.kind === "delivery");
  /** Later work always comes after the decision it follows: wait for the clock to pass it. */
  const after = async () => { while (task.reviewDecision?.at !== undefined && Date.now() <= task.reviewDecision.at) await Bun.sleep(1); };
  /** The code review runs out with what is open now, and the coordinator continues. */
  const exhaust = async (decide: "continue" | "changes" = "continue") => {
    beginAgentStep(task, "code-reviewer", "sol-high", Date.now(), engine.s.roles, undefined, executionFor(task).work);
    expect(await reviews.closeReviewRound(task, stageOf("review"), 1, "Important findings")).toBe("stop");
    expect(open()).toHaveLength(1);
    if (decide === "continue") engine.approve(open()[0]!.id);
    else engine.requestChanges(open()[0]!.id, "Repair it");
  };
  /** One round of the later review: what its reviewer hands back, then how the round ends. */
  const review = async (result: Record<string, unknown> = { verdict: "pass" }) => {
    await after();
    const at = stageOf("security"), round = task.rounds[at.id] ?? 1;
    task.stageIndex = task.plan!.stages.indexOf(at);
    task.hunt = { id: engine.id(task.id), stageId: at.id, round, reported: {}, findings: task.findings.length };
    beginAgentStep(task, at.roleId, "opus-high", Date.now(), engine.s.roles, undefined, executionFor(task).work);
    await reviews.applyReview(executionFor(task), at, ReviewResult.parse(result), "opus-high", at.roleId, "0");
    delete task.hunt;
    return reviews.closeReviewRound(task, at, round, "The review's outcome");
  };
  /** The later review's latest step. */
  const step = () => task.journey!.findLast((entry) => entry.kind === "agent" && entry.stageId === "security")!;
  const commit = async (index = 0) => {
    writeFileSync(join(owners[index]!.worktree, "feature.txt"), "the task's change, changed again\n");
    await git(owners[index]!.worktree, "commit", "-qam", "Change the feature");
  };
  return { engine, task, owners,
    exhaust: (...args: Parameters<typeof exhaust>) => lifetime.run(engine, () => exhaust(...args)),
    after: () => lifetime.run(engine, after),
    review: (...args: Parameters<typeof review>) => lifetime.run(engine, () => review(...args)),
    commit: (...args: Parameters<typeof commit>) => lifetime.run(engine, () => commit(...args)),
    run: <T>(start: () => Promise<T>) => lifetime.run(engine, start),
    open, step, stageOf, close };
  }), close);
}

/** The later review passed on, nothing sent back, the decision still accepted. */
const passedCovered = (task: Task) => task.plan!.stages[task.stageIndex]!.id !== "security" && !task.fixing && task.reviewDecision?.accepted === true;

return { COVERED, signal, important, rounds, passedCovered, close: async () => { await closeDirectDrivers(fixtures); fixtures.clear(); } };
}
