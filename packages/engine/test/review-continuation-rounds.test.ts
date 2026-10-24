import { afterAll, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, MAINTENANCE_ROLES, type DeepMutable, type Finding, type Stage, type Task } from "@petrina/core";
import { Engine } from "./engine.js";
import { executionFor } from "@petrina/orchestrator";
import { commandText } from "../src/checks.js";
import { changesOf } from "../src/repositories.js";
import { ReviewResult } from "../src/roles.js";
import { checkReviewEvidence } from "../src/review.js";
import { git, makeProduct, removeDir, tempDir } from "./fixtures.js";

// Controls for a coordinator's decision to continue an exhausted review (the whole workflow is in
// review-continuation.test.ts): one review round at a time, on real working copies.
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const COVERED = "review passed; 1 earlier important still open under your decision to continue";

const signal = () => new AbortController().signal;
const important = (id: string, extra: Partial<DeepMutable<Finding>> = {}): DeepMutable<Finding> => ({ id, text: `Problem ${id}`, evidence: `Reproduced ${id}`, severity: "blocking", status: "open", raisedBy: "sol-high", confirmedBy: ["opus-high"], ...extra });

/**
 * A task at its code review's only round, on products each with the task's own commit, with a later review and
 * acceptance testing to come. `later`: the later review's role; `builder`: the Builder stage's role; `tested`:
 * acceptance testing comes before that review.
 */
async function rounds(options: { shared?: boolean; later?: string; builder?: string; tested?: boolean } = {}) {
  const root = tempDir("petrina-review-continuation-rounds-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  const owner = async (index: number, name: string) => {
    const repo = await makeProduct(join(root, `product-${index}`));
    await git(repo, "remote", "remove", "origin");
    const productId = await engine.addProduct(repo, name);
    engine.updateProduct(productId, { name, delivery: "local", approveDelivery: true });
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
  const reviews = engine["reviews"] as unknown as {
    closeReviewRound: (task: unknown, stage: unknown, round: number, outcome: string) => Promise<"continue" | "stop">;
    applyReview: (scope: unknown, stage: unknown, result: unknown, profileId: string, roleId: string, key: string) => Promise<void>;
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
  return { engine, task, owners, exhaust, after, review, open, step, commit, stageOf };
}

/** The later review passed on, nothing sent back, the decision still accepted. */
const passedCovered = (task: Task) => task.plan!.stages[task.stageIndex]!.id !== "security" && !task.fixing && task.reviewDecision?.accepted === true;

for (const [later, builder] of [["security-reviewer", "builder"], ["added-privacy-reviewer", "saved-caretaker"]] as const) it(`passes a later ${later === "security-reviewer" ? "security" : "added"} review over the covered finding, and finds a ${builder === "builder" ? "built-in" : "task-owned"} Builder by its result for a new one`, async () => {
  for (const fresh of [false, true]) {
    const f = await rounds({ later, builder });
    try {
      if (later !== "security-reviewer") f.engine.s.roles.push({ ...f.engine.s.roles.find((role) => role.id === "security-reviewer")!, id: later, name: "Privacy reviewer", added: true });
      f.task.findings = [important("accepted")];
      await f.exhaust();
      const decided = structuredClone(f.task.reviewDecision!);
      expect(decided).toEqual({ stageId: "review", round: 1, accepted: true, covers: ["accepted"], at: expect.any(Number), versions: await changesOf(f.task) });
      const kept = structuredClone(f.task.findings[0]!);
      expect(await f.review(fresh ? { verdict: "fail", findings: [{ text: "Anyone can read the greeting", severity: "important", evidence: "Opened it signed out" }] } : { verdict: "pass" })).toBe("continue");
      expect(f.task.findings[0]).toEqual(kept);
      expect(f.task.reviewDecision).toEqual(decided);
      if (!fresh) {
        expect(f.task.plan!.stages[f.task.stageIndex]!.id).toBe("test");
        expect(f.step().reason).toBe(COVERED);
        expect(f.task.rounds.security).toBeUndefined();
        continue;
      }
      // Exactly as today: back to the Builder, found by its result, with everything open counted.
      expect(f.task.stageIndex).toBe(0); expect(f.task.fixing).toBe(true); expect(f.task.rounds.security).toBe(2);
      expect(f.step().reason).toBe("sent back: 2 important");
      // Its rounds then run out on unchanged work: a new decision covers everything open.
      f.task.fixing = false;
      expect(await f.review({ verdict: "pass" })).toBe("stop");
      expect(f.task.reviewDecision).toEqual({ stageId: "security", round: 2, accepted: false, covers: ["accepted", f.task.findings[1]!.id], at: expect.any(Number), versions: decided.versions });
      expect(f.open()).toHaveLength(1);
    } finally { await f.engine.shutdown(); }
  }
});

it("puts a covered finding back on the usual route when a later reviewer reproduces it, while naming it bare or confirming another finding does not", async () => {
  for (const confirmed of ["nit", "bare", "second"] as const) {
    const f = await rounds();
    try {
      f.task.findings = [important("first"), important("second"), important("nit", { severity: "suggestion" })];
      const bare = ReviewResult.parse({ verdict: "pass", confirms: ["second"] });
      // Before any decision to continue, an open finding may still be confirmed by id alone.
      if (confirmed === "bare") expect(checkReviewEvidence(f.task.findings, bare, f.task)).toBeUndefined();
      await f.exhaust();
      expect(f.task.reviewDecision!.covers).toEqual(["first", "second"]);
      if (confirmed === "bare") {
        // Once it is covered, a bare id is not a reproduction: the reviewer is asked for current evidence or to drop it.
        expect(checkReviewEvidence(f.task.findings, bare, f.task)).toContain("Current evidence is required");
        expect(checkReviewEvidence(f.task.findings, bare, f.task)).toContain("second");
        // Controls: a finding the decision does not list, and a decision saved before covers were recorded.
        expect(checkReviewEvidence(f.task.findings, ReviewResult.parse({ verdict: "pass", confirms: ["nit"] }), f.task)).toBeUndefined();
        expect(checkReviewEvidence(f.task.findings, bare, { reviewDecision: { stageId: "review", round: 1, accepted: true } })).toBeUndefined();
      }
      const reproduced = { id: confirmed === "bare" ? "second" : confirmed, evidence: `On current code, ${confirmed} still fails; the signed-in control passes.` };
      const result = await f.review({ verdict: confirmed === "second" ? "fail" : "pass", confirms: [confirmed === "bare" ? "second" : reproduced] });
      expect(result).toBe("continue");
      // Even a bare id that got past the check leaves the cover alone.
      if (confirmed !== "second") {
        expect(passedCovered(f.task)).toBe(true);
        expect(f.step().reason).toBe("review passed; 2 earlier important still open under your decision to continue");
        expect(f.task.findings.every((finding) => finding.reproducedAt === undefined)).toBe(true);
        continue;
      }
      expect(f.task.fixing).toBe(true); expect(f.task.stageIndex).toBe(0);
      expect(f.task.findings.map((finding) => finding.reproducedAt !== undefined)).toEqual([false, true, false]);
      expect(f.task.findings[1]!.status).toBe("open");
    } finally { await f.engine.shutdown(); }
  }
});

it("judges cover by the task's own change: main moving alone keeps it, a change or an unreadable version ends it", async () => {
  for (const what of ["main", "edit", "unreadable"] as const) {
    const f = await rounds();
    try {
      f.task.findings = [important("accepted")];
      await f.exhaust();
      const scope = executionFor(f.task);
      if (what === "main") {
        writeFileSync(join(f.owners[0]!.repo, "incoming.txt"), "main moved\n");
        await git(f.owners[0]!.repo, "add", "."); await git(f.owners[0]!.repo, "commit", "-q", "-m", "Main advances");
        expect(await f.engine["updates"].upToDate(scope, signal())).toBe("moved");
      } else if (what === "edit") await f.commit();
      else delete scope.work.baseSha;
      expect(await f.review()).toBe("continue");
      if (what === "main") expect(passedCovered(f.task)).toBe(true);
      else { expect(f.task.fixing).toBe(true); expect(f.step().reason).toBe("sent back: 1 important"); }
    } finally { await f.engine.shutdown(); }
  }
});

it("ends the cover of an acceptance finding that fails again, and keeps final acceptance on its own route", async () => {
  for (const again of [true, false]) {
    const f = await rounds({ tested: true });
    const text = "The greeting shows on the welcome page";
    const reply = spyOn(f.engine["turns"], "turn").mockImplementation(async (scope, roleId, profileId, _given, schema, _signal, options) => {
      const value = schema.parse({ summary: "Tried it", checks: [{ text, result: again ? "fail" : "pass", evidence: again ? "Still missing for guests; signed-in control shows it" : "Shown" }], proofAnswers: [] });
      options?.used?.(profileId);
      beginAgentStep(scope.task, roleId, profileId, Date.now(), f.engine.s.roles, undefined, scope.work);
      return value;
    });
    try {
      f.task.brief = { summary: "Show a greeting", areas: [], forUsers: [], risks: [], acceptance: [{ text, met: false, verification: "failed" }] };
      f.task.findings = [important("acceptance", { text: `Failed acceptance check: ${text}`, raisedBy: "opus-high", confirmedBy: [] })];
      await f.exhaust();
      await f.after();
      // Acceptance testing after the decision, before the later review.
      f.task.stageIndex = 2;
      await f.engine["work"].runDo(executionFor(f.task), f.stageOf("test"), signal());
      expect(f.task.findings[0]!.reproducedAt !== undefined).toBe(again);
      expect(f.task.findings[0]!.status).toBe(again ? "open" : "fixed");
      expect(await f.review()).toBe("continue");
      if (!again) { expect(passedCovered(f.task)).toBe(true); continue; }
      expect(f.task.fixing).toBe(true); expect(f.task.stageIndex).toBe(0);
      // Final acceptance failing again goes back to the Builder within its own allowance, never marked fixed.
      f.task.fixing = false; f.task.retest = true; f.task.stageIndex = 2;
      await f.engine["work"].runDo(executionFor(f.task), f.stageOf("test"), signal());
      expect(f.task.stageIndex).toBe(0); expect(executionFor(f.task).work.acceptanceReturns).toBe(1);
      expect(f.task.findings[0]!.status).toBe("open");
    } finally { reply.mockRestore(); await f.engine.shutdown(); }
  }
});

it("sends an unchanged finding back as today without a decision to continue, after asking for changes, or with a decision saved before covers", async () => {
  for (const how of ["none", "changes", "older"] as const) {
    const f = await rounds();
    try {
      f.task.findings = [important("accepted")];
      if (how === "none") f.task.stageIndex = 2;
      else await f.exhaust(how === "changes" ? "changes" : "continue");
      if (how === "changes") { expect(f.task.reviewDecision).toBeUndefined(); expect(f.task.fixing).toBe(true); f.task.fixing = false; }
      if (how === "older") f.task.reviewDecision = { stageId: "review", round: 1, accepted: true };
      expect(await f.review()).toBe("continue");
      expect(f.task.fixing).toBe(true); expect(f.task.stageIndex).toBe(0);
      expect(f.step().reason).toBe("sent back: 1 important");
    } finally { await f.engine.shutdown(); }
  }
});

it("never covers failing product checks before the later review or before delivery", async () => {
  for (const where of ["review", "delivery"] as const) {
    const f = await rounds();
    const admit = spyOn(f.engine["driver"] as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockResolvedValue(false);
    try {
      f.task.findings = [important("accepted")];
      await f.exhaust();
      f.engine.setProductChecks(f.task.productId, [{ name: "Tests", command: commandText([process.execPath, "-e", "console.error('reproduced check failure');process.exit(1)"]) }]);
      // Checks need the pool; nothing else is scheduled.
      f.engine.setPoolPaused(false);
      f.task.stageIndex = f.task.plan!.stages.findIndex((stage) => stage.id === (where === "review" ? "security" : "delivery"));
      // The review's own start runs the checks; delivery preparation runs them before any agent is admitted.
      if (where === "review") expect(await f.engine["reviews"].runReview(f.task, f.stageOf("security"), signal())).toBe("continue");
      else await f.engine["driver"]["drive"](f.task.id);
      expect(f.task.stageIndex).toBe(0); expect(executionFor(f.task).work.checkReturns).toBe(1);
      expect(f.task.findings.some((finding) => finding.raisedBy === "petrina" && finding.status === "open")).toBe(true);
      expect(f.task.reviewDecision!.accepted).toBe(true);
    } finally { admit.mockRestore(); await f.engine.shutdown(); }
  }
});

it("judges shared cover per finding's products and repairs only the owners of findings it does not cover", async () => {
  for (const moved of ["api", "shop"] as const) {
    const f = await rounds({ shared: true });
    try {
      const [shop, api] = f.owners.map((owner) => owner.productId) as [string, string];
      f.task.findings = [important("accepted", { productIds: [shop] })];
      await f.exhaust();
      expect(Object.keys(f.task.reviewDecision!.versions!).sort()).toEqual([shop, api].sort());
      await f.commit(moved === "api" ? 1 : 0);
      if (moved === "api") {
        // Only the API's own change moved: the shop's finding stays covered.
        expect(await f.review()).toBe("continue");
        expect(passedCovered(f.task)).toBe(true);
      }
      // A new API finding: the API is repaired, and the shop too only once its own change moved.
      expect(await f.review({ verdict: "fail", findings: [{ text: "The API leaks the greeting", productIds: [api], severity: "important", evidence: "Read it signed out" }] })).toBe("continue");
      expect(f.task.repair).toEqual(expect.objectContaining({ products: moved === "api" ? [api] : [shop, api], kind: "review" }));
      expect(f.task.repositories!.map((work) => [work.acceptanceReturns, work.checkReturns])).toEqual([[undefined, undefined], [undefined, undefined]]);
      expect(f.task.findings[0]!.status).toBe("open");
    } finally { await f.engine.shutdown(); }
  }
});
