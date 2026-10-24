import { expectRejection } from "@petrina/test-support/rejections";
import { executionFor } from "@petrina/orchestrator";
import type { RepositoryContext } from "@petrina/orchestrator";
import { checkDecisionLabel, decisionEvidence, createDemoState, draftOf, independentVotes, reviewRoundEnd, type InboxItem, type Product } from "@petrina/core";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Engine, type EngineOptions } from "./engine.js";
import type { Scenario } from "./fake-agent.js";
import { ScriptedAgents, scriptedResult } from "./scripted-agents.js";
import { answersTo, findingIds } from "./scripted-findings.js";
import { addCopy, ensureWorktree } from "../src/git.js";
import { Sources } from "../src/sources.js";
import type { Connections } from "../src/connection.js";
import { Kernel, type MTask } from "../src/kernel.js";
import { invalidateAcceptance, versionsOf } from "../src/repositories.js";
import { beginRepair } from "@petrina/orchestrator";
import { checkReviewEvidence } from "@petrina/core";
import { ReviewResult } from "../src/roles.js";
import { Coordination } from "../src/coordination.js";
import { Fakes, coordinator, finish, git, headNow, itemOf, makeWorld, removeDir, taskOf, tempDir, until, waitFor, type World } from "./support.js";

const worlds: World[] = [];
const recordRoots: string[] = [];
afterAll(() => { worlds.forEach((world) => removeDir(world.dir)); recordRoots.forEach(removeDir); });
async function setup(name: string) {
  const shop = await makeWorld(`shared-shop-${name}`), api = await makeWorld(`shared-api-${name}`);
  worlds.push(shop, api);
  await git(api.clone, "remote", "set-url", "origin", "https://github.com/acme/api.git");
  api.setGitHub((state) => { state.repo = "acme/api"; });
  const mapping = join(shop.dir, "portfolio.json");
  writeFileSync(mapping, JSON.stringify({ "acme/demo": { state: join(shop.dir, "github.json"), remote: shop.remote }, "acme/api": { state: join(api.dir, "github.json"), remote: api.remote } }));
  const fakes = new Fakes(join(shop.dir, "agents"));
  fakes.scenario({ planner: "short", builder: "plain", reopen: "resume" });
  const remotes = { "acme/demo": shop.remote, "acme/api": api.remote };
  const sourceRemotes: Record<string, string> = {};
  const start = (options: Partial<EngineOptions> = {}) => shop.start({ ...options, agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, `--script=${join(shop.dir, "agents.json")}`], gh: [process.execPath, join(import.meta.dir, "fake-portfolio-gh.ts"), mapping], remotes, sourceRemotes });
  return { shop, api, start, fakes, remotes, sourceRemotes };
}

/** Real shared-task records and restart storage, without unrelated Git, planning or agent execution. */
async function sharedRecords() {
  const root = tempDir("petrina-review-records-"); recordRoots.push(root);
  const start = () => new Engine(root);
  const engine = start(); engine.setPoolPaused(true);
  try {
    await engine.waitUntilReady();
    const first = "first", second = "second";
    engine.s.products.push(...[first, second].map(id => ({ id, name: id, repo: `acme/${id}`, tone: "blue" as const })));
    const task = engine.task(engine.addTask({ productId: first, title: "Keep the shared task records", backlog: true }))!;
    task.repositories = [first, second].map(productId => ({ productId, delivery: "pull-request", completedStages: [] }));
    const stage = { id: "review", kind: "review-chain" as const, title: "Review both products", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 };
    task.plan = { rationale: "Only review recording is under test", plannerProfileId: "sonnet-medium", stages: [stage] };
    task.stageIndex = 0;
    return { engine, start, first, second, task, stage };
  } catch (error) { await engine.shutdown(); throw error; }
}

/**
 * The pull-request poll this test asks for. The engine also polls at start and every minute, and a poll skips a task
 * its driver or another poll still holds: wait until neither does, so this one reads every open pull request itself.
 */
async function pollPullRequests(engine: ReturnType<Awaited<ReturnType<typeof setup>>["start"]>, taskId: string) {
  const monitor = engine["shipping"].monitor;
  await waitFor(() => !engine.drivers.has(taskId) && !monitor["following"].has(taskId), "the task's pull requests to be free to read");
  await monitor.pollPullRequests();
}

/** The whole task's delivery as coordinator inspection and immediate waits report it. */
async function coordinatorDelivery(engine: ConstructorParameters<typeof Coordination>[0], taskId: string) {
  const coordination = new Coordination(engine);
  const { landing, deliveryConfirmed } = (await coordination.call("task.inspect", { taskId })).task as { landing: string; deliveryConfirmed: boolean };
  const [delivered, landed] = await Promise.all(["delivered", "landed"].map(async (condition): Promise<string> => (await coordination.call("watch.wait", { target: "task", taskId, condition, timeoutMs: 0 })).outcome));
  return { landing, deliveryConfirmed, delivered, landed };
}

describe.concurrent("one task across products", () => {
  for (const shared of [false, true]) it(`updates each product once before the Tester (${shared ? "shared" : "single"} task)`, async () => {
    const { shop, api, start, fakes } = await setup(`tester-updates-${shared}`);
    const engine = start();
    const updates = engine["updates"], original = updates.upToDate.bind(updates), prepared: string[] = [];
    updates.upToDate = (scope, signal) => {
      const task = scope.task, stage = task.plan?.stages[task.stageIndex];
      if (stage?.roleId === "tester" && !task.retest) prepared.push(scope.work.productId);
      return original(scope, signal);
    };
    try {
      const first = await engine.addProduct(shop.clone), second = shared ? await engine.addProduct(api.clone, "API") : undefined;
      const products = second ? [first, second] : [first];
      fakes.scenario({ planner: "tester-with-design", builder: "plain", affectedProducts: products });
      const id = engine.addTask({ productId: first, worksOn: products.map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Give the Tester current product checks" });
      const state = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      expect(taskOf(state, id).error).toBeUndefined();
      expect(fakes.openings("tester").length).toBeGreaterThan(0);
      expect(prepared).toEqual(products);
    } finally { updates.upToDate = original; await engine.shutdown(); }
  });

  it("routes an incompletely repeated finding to its saved owner after restart and keeps ownership in History", async () => {
    const { shop, api, start, fakes } = await setup("finding-owner-restart");
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const id = engine.addTask({ productId: first, title: "Keep routing the reported API repair", worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })) });
      await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      engine.setPoolPaused(true);
      const task = engine.task(id)!;
      expect(task.error).toBeUndefined();
      const stage = task.plan!.stages.find((stage) => stage.kind === "review-chain")!;
      const report = { text: "The API drops the greeting after signing out.", severity: "important", evidence: "The current API guest request omits the greeting; a signed-in request includes it." };
      for (const [index, productIds] of [[second], undefined].entries()) {
        await engine["reviews"]["applyReview"](executionFor(task), stage, ReviewResult.parse({ verdict: "fail", findings: [{ ...report, productIds }] }), index ? "sol-high" : "opus-high", "code-reviewer", String(index));
      }
      const findingId = task.findings.find((finding) => finding.text === report.text)!.id;
      task.findings.push({ id: "unknown-owner", text: "A separate finding has no known owner.", productIds: [], severity: "blocking", raisedBy: "sol-high", confirmedBy: [], status: "open" });
      engine.save();
      await engine.shutdown();
      engine = start();
      const restored = engine.task(id)!;
      expect(restored.findings.find((finding) => finding.id === findingId)?.productIds).toEqual([second]);
      engine.requestChanges(itemOf(engine.getState(), id, "delivery")!.id, "Repair the known API finding.");
      expect(restored.repair?.products).toEqual([second]);
      engine.setPoolPaused(false);
      const repaired = taskOf(await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator([])), id);
      expect(repaired.error).toBeUndefined();
      const repairs = fakes.received("builder").filter((entry) => entry.text.includes("You are fixing the review findings"));
      expect(repairs).toHaveLength(1);
      expect(repairs[0]!.text).toContain(`You own only product ${second}`);
      expect(repairs[0]!.text).toContain(report.text);
      expect(repairs[0]!.text).toContain(report.evidence);
      expect(repaired.findings.find((finding) => finding.id === findingId)?.answers?.[second]?.fixed).toBe(true);
      expect(repaired.findings.find((finding) => finding.id === "unknown-owner")?.status).toBe("open");
      engine.cancel(id);
      engine.save();
      const archived = engine.store.history.get(id)!;
      expect(archived.findings.find((finding) => finding.id === findingId)?.productIds).toEqual([second]);
      expect(archived.findings.find((finding) => finding.id === "unknown-owner")?.productIds).toEqual([]);
      expect(shop.github().prs).toHaveLength(0);
      expect(api.github().prs).toHaveLength(0);
    } finally { await engine.shutdown(); }
  });

  it("previews companion repositories and their readers in the shared delivery check", () => {
    const state = createDemoState(1_000_000_000);
    const task = structuredClone(state.tasks[0]) as MTask;
    task.repositories = state.products.slice(0, 2).map((product, index) => ({ productId: product.id, delivery: "pull-request", completedStages: [], source: { product: { ...product, repo: index ? "private/api" : "acme/shop" }, start: { kind: "default", branch: "main" }, destination: { kind: "new-pr", mode: "pull-request", repo: index ? "private/api" : "acme/shop", branch: "main" }, confirmed: true } }));
    const requests: Pick<InboxItem, "kind" | "body">[] = [];
    const kernel = { commitNow() {}, raise(_task: MTask, kind: InboxItem["kind"], _title: string, _blocking: boolean, extra: { body?: string }) { requests.push({ kind, body: extra.body }); } } as unknown as Kernel;
    Kernel.prototype.gate.call(kernel, task, "delivery");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.kind).toBe("delivery");
    expect(requests[0]!.body).toContain("acme/shop; link pending");
    expect(requests[0]!.body).toContain("private/api; link pending");
    expect(requests[0]!.body).toContain("every companion pull request, visible to anyone who can read it.");
    expect(requests[0]!.body).toContain("Pending links will become the resulting pull request or release addresses in these approved repositories.");
  });

  for (const mode of ["local", "release", "mixed", "unchanged-pr"] as const) it(`omits pull-request publication wording when ${mode} deliveries publish no pull requests`, () => {
    const state = createDemoState(1_000_000_000);
    const task = structuredClone(state.tasks[0]) as MTask;
    task.repositories = state.products.slice(0, mode === "unchanged-pr" ? 3 : 2).map((product, index) => {
      const delivery = mode === "unchanged-pr" && index === 2 ? "pull-request" : mode === "release" || (mode === "mixed" && index === 1) ? "release" : "local";
      return { productId: product.id, delivery, completedStages: [], ...(delivery === "pull-request" ? { nothingToPublish: true } : {}), source: { product, start: { kind: "default", branch: "main" }, destination: { kind: delivery === "pull-request" ? "new-pr" : delivery === "release" ? "release" : "branch", mode: delivery, repo: product.repo, branch: "main" }, confirmed: true } };
    });
    const requests: Pick<InboxItem, "kind" | "body">[] = [];
    const kernel = { commitNow() {}, raise(_task: MTask, kind: InboxItem["kind"], _title: string, _blocking: boolean, extra: { body?: string }) { requests.push({ kind, body: extra.body }); } } as unknown as Kernel;
    Kernel.prototype.gate.call(kernel, task, "delivery");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.kind).toBe("delivery");
    for (const work of task.repositories) expect(requests[0]!.body).toContain(work.source!.product.repo);
    // This remains a factual summary of the related deliveries; only PR-specific copy is omitted.
    expect(requests[0]!.body).toContain("Part of a change across:");
    expect(requests[0]!.body).not.toContain("every companion pull request");
    expect(requests[0]!.body).not.toContain("Pending links");
  });

  for (const mode of ["local", "release"] as const) it(`previews companion wording on an existing pull request beside a ${mode} delivery`, () => {
    const state = createDemoState(1_000_000_000);
    const task = structuredClone(state.tasks[0]) as MTask;
    task.repositories = state.products.slice(0, 2).map((product, index) => ({ productId: product.id, delivery: index ? mode : "local", completedStages: [], source: { product, start: index ? { kind: "default", branch: "main" } : { kind: "pull-request", number: 7, url: `https://github.com/${product.repo}/pull/7`, headRepo: product.repo, branch: "feature" }, destination: { kind: index ? mode === "release" ? "release" : "branch" : "update-pr", mode: index ? mode : "local", repo: product.repo, branch: index ? "main" : "feature" }, confirmed: true } }));
    const requests: Pick<InboxItem, "kind" | "body">[] = [];
    const kernel = { commitNow() {}, raise(_task: MTask, kind: InboxItem["kind"], _title: string, _blocking: boolean, extra: { body?: string }) { requests.push({ kind, body: extra.body }); } } as unknown as Kernel;
    Kernel.prototype.gate.call(kernel, task, "delivery");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.kind).toBe("delivery");
    expect(requests[0]!.body).toContain("Part of a change across:");
    expect(requests[0]!.body).toContain("visible to anyone who can read it");
    expect(requests[0]!.body).toContain("Pending links will become");
  });

  for (const count of [1, 2]) it(`settles completed objections before waiting for voting usage across ${count} products`, async () => {
    const { shop, api, start, fakes } = await setup(`objection-usage-${count}`);
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone);
      const products = count === 1 ? [first] : [first, await engine.addProduct(api.clone, "API")];
      const id = engine.addTask({ productId: first, ...(count > 1 ? { worksOn: products.map((productId) => ({ productId, startFrom: { kind: "default" as const }, delivery: "pull-request" as const })) } : {}), title: "Settle saved review objections" });
      await until(engine, (state) => !!itemOf(state, id, "delivery"), coordinator(["plan", "design"]));
      engine.setPoolPaused(true);
      const task = engine.task(id)!;
      task.stageIndex = task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");
      const stage = task.plan!.stages[task.stageIndex]!;
      task.state = "waiting";
      task.holdsSlot = false;
      task.hunt = { stageId: stage.id, round: task.rounds[stage.id] ?? 1, reported: Object.fromEntries(stage.profileIds.map((_, index) => [String(index), true])), findings: 1 };
      task.findings = [{ id: "objected", text: "An objection nobody confirmed", ...(count > 1 ? { productIds: products } : {}), severity: "blocking", status: "open", raisedBy: "earlier-reviewer", confirmedBy: [], disputes: [{ by: stage.profileIds[0]!, reason: "The current code already handles this case.", at: Date.now() }] }];
      engine.s.inbox = engine.s.inbox.filter((item) => item.taskId !== id);
      engine.s.pool.limited = [...new Set(engine.s.profiles.map((profile) => profile.toolId))].map((toolId) => ({ toolId, until: Date.now() + 120_000, reason: "No voting usage left" }));
      engine.save();
      await engine.shutdown();
      engine = start();
      await engine.waitUntilReady();
      const resumed = engine.task(id)!;
      // Scheduling must settle the saved reports before deciding whether an agent is needed.
      engine.setPoolPaused(false);
      expect(resumed.statusLine).not.toStartWith("Waiting for usage");
      expect(resumed.findings[0]!.status).toBe("dismissed");
      await until(engine, (state) => !!itemOf(state, id, "delivery"), coordinator([]));
      expect(fakes.openings("verifier")).toHaveLength(0);
      expect(engine.getState().pool.limited?.length).toBeGreaterThan(0);
    } finally { await engine.shutdown(); }
  });

  it("reopens dismissed reports with fresh proof while keeping classification, ownership and review history", async () => {
    const { shop, api, start } = await setup("dismissed-proof"); const engine = start();
    try {
      engine.setPoolPaused(true);
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const task = engine.task(engine.addTask({ productId: first, title: "Recheck a closed report", backlog: true }))!;
      task.repositories = [first, second].map((productId) => ({ productId, delivery: "pull-request", completedStages: [] }));
      const stage = { id: "review", kind: "review-chain" as const, title: "Review both products", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 };
      task.plan = { rationale: "Review both products", plannerProfileId: "sonnet-medium", stages: [stage] };
      task.stageIndex = 0;
      const proof = "The current guest state fails after signing out; the signed-in control and original case pass.";
      for (const severity of ["blocking", "suggestion", "pre-existing"] as const) for (const by of ["sol-high", "opus-high"]) {
        task.hunt = { stageId: stage.id, round: 2, reported: {}, findings: 1 };
        task.findings = [{ id: "dismissed", text: "The greeting is missing.", productIds: [first, second], severity, raisedBy: "opus-high", status: "dismissed", confirmedBy: ["opus-xhigh"], evidence: "The original welcome path passed.", disputes: [{ by: "sol-high", reason: "The original path works on current code.", at: 1 }], verification: { by: "sol-high", verdict: "not-a-bug", reason: "The old reproduction does not fail.", at: 1 }, votes: [{ by: "sol-high", toolId: "codex", verdict: "not-a-bug", reason: "The original path passes." }] }];
        const before = JSON.parse(JSON.stringify(task.findings[0]!));
        const result = ReviewResult.parse({ verdict: "fail", confirms: [{ id: "dismissed", evidence: proof }] });
        expect(checkReviewEvidence(task.findings, result, task)).toBeUndefined();
        await engine["reviews"]["applyReview"](executionFor(task), stage, result, by, "code-reviewer", "0");
        expect(task.findings).toHaveLength(1);
        const current = task.findings[0]!;
        expect(current.status).toBe("open");
        expect(current.severity).toBe(severity);
        expect(current.productIds).toEqual([first, second]);
        expect(current.evidence).toBe(proof);
        expect(current.confirmedBy).toEqual([by]);
        expect(current.verification).toBeUndefined();
        expect(current.votes).toBeUndefined();
        expect(current.disputes).toBeUndefined();
        expect(current.earlierReviews).toHaveLength(1);
        expect(current.earlierReviews![0]!).toEqual({ at: current.reopenedAt!, evidence: before.evidence, confirmedBy: before.confirmedBy, disputes: before.disputes, verification: before.verification, votes: before.votes });
        task.hunt.reported = { "0": true };
        engine["reviews"]["settleReviews"](task, stage);
        expect(current.status).toBe("open");
        task.hunt.reported["1"] = true;
        engine["reviews"]["settleReviews"](task, stage);
        expect(current.status).toBe("open");
        const ballot = engine["reviews"]["pendingVote"](task, stage);
        expect(ballot?.findings.map((finding) => finding.id)).toEqual(severity === "blocking" ? ["dismissed"] : undefined);
        if (ballot) expect(ballot.voters.length).toBeGreaterThan(0);
      }
      // A new independently owned report cannot reuse a dismissed peer product's proof or identity.
      task.findings = [{ id: "dismissed-api", text: "The greeting is missing.", productIds: [second], severity: "blocking", raisedBy: "opus-high", status: "dismissed", confirmedBy: [], evidence: "API's old case passed." }];
      const independent = ReviewResult.parse({ verdict: "fail", findings: [{ text: "The GREETING is missing!", productIds: [first], severity: "important" }] });
      expect(checkReviewEvidence(task.findings, independent, task)).toBeUndefined();
      await engine["reviews"]["applyReview"](executionFor(task), stage, independent, "sol-high", "code-reviewer", "0");
      expect(task.findings).toHaveLength(2);
      expect(task.findings[0]!.status).toBe("dismissed");
      expect(task.findings[0]!.evidence).toBe("API's old case passed.");
      expect(task.findings[1]!.productIds).toEqual([first]);
      // Native checks remain closed until their actual commands say otherwise.
      task.findings = [{ id: "native", text: "A product check failed.", productIds: [first], severity: "blocking", raisedBy: "petrina", status: "fixed", confirmedBy: [], evidence: "The actual check now passes." }];
      const native = ReviewResult.parse({ verdict: "fail", confirms: [{ id: "native", evidence: proof }] });
      await engine["reviews"]["applyReview"](executionFor(task), stage, native, "sol-high", "code-reviewer", "0");
      expect(task.findings[0]!).toMatchObject({ status: "fixed", evidence: "The actual check now passes." });
      expect(task.findings[0]!.earlierReviews).toBeUndefined();
    } finally { await engine.shutdown(); }
  });

  it("does not reopen another product's claimed fix for independently reported equal wording", async () => {
    const { shop, api, start } = await setup("independent-finding-proof"); const engine = start();
    try {
      engine.setPoolPaused(true);
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const id = engine.addTask({ productId: first, title: "Review independent product failures", backlog: true });
      const task = engine.task(id)!;
      task.repositories = [first, second].map((productId) => ({ productId, delivery: "pull-request", completedStages: [] }));
      const stage = { id: "review", kind: "review-chain" as const, title: "Review both products", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 };
      task.plan = { rationale: "Review both products", plannerProfileId: "sonnet-medium", stages: [stage] };
      task.findings = [{ id: "fixed-api", text: "The greeting is missing.", productIds: [second], evidence: "The old API guest case failed.", severity: "blocking", raisedBy: "earlier-reviewer", status: "fixed", confirmedBy: [], answer: { fixed: true, at: 1, text: "The API guest case now passes." } }];
      const report = { text: "The GREETING is missing!", productIds: [first], severity: "important", evidence: "The shop guest case fails on current code." };
      const result = ReviewResult.parse({ verdict: "fail", findings: [report] });
      expect(checkReviewEvidence(task.findings, ReviewResult.parse({ verdict: "fail", findings: [{ ...report, evidence: undefined }] }), task)).toBeUndefined();
      await engine["reviews"]["applyReview"](executionFor(task), stage, result, "opus-high", "code-reviewer", "0");
      expect(task.findings).toHaveLength(2);
      expect(task.findings.find((finding) => finding.id === "fixed-api")).toMatchObject({ status: "fixed", productIds: [second], evidence: "The old API guest case failed." });
      const shopFinding = task.findings.find((finding) => finding.id !== "fixed-api")!;
      expect(shopFinding).toMatchObject({ status: "open", productIds: [first], evidence: report.evidence });
      expect(shopFinding.earlierReviews).toBeUndefined();
      expect(checkReviewEvidence(task.findings, ReviewResult.parse({ verdict: "fail", findings: [{ ...report, evidence: undefined }] }), task)).toBeUndefined();
      const moment = engine.tracking.log.moments({ taskId: id, kinds: ["verdict"] }).at(-1)!;
      expect(moment).toMatchObject({ count: 1, blocking: 1 });

      // Similar prose never combines independently reported owners or invents agreement.
      task.findings = [{ id: "open-api", text: "The greeting is missing.", productIds: [second], evidence: "The API guest case fails.", severity: "blocking", raisedBy: "earlier-reviewer", status: "open", confirmedBy: [] }];
      expect(checkReviewEvidence(task.findings, ReviewResult.parse({ verdict: "fail", findings: [{ ...report, evidence: undefined }] }), task)).toBeUndefined();
      await engine["reviews"]["applyReview"](executionFor(task), stage, result, "opus-high", "code-reviewer", "0");
      expect(task.findings).toHaveLength(2);
      expect(task.findings[0]!.productIds).toEqual([second]);
      expect(task.findings[1]!.productIds).toEqual([first]);
      expect(task.findings[0]!.evidence).toBe("The API guest case fails.");
      expect(task.findings[1]!.evidence).toBe(report.evidence);
      expect(task.findings.every((finding) => finding.confirmedBy.length === 0)).toBe(true);

      // An explicit id identifies a shared claimed fix and still needs new proof.
      task.findings = [{ id: "shared-fixed", text: "The greeting is missing.", productIds: [second, first], evidence: "The original shared case.", severity: "blocking", raisedBy: "earlier-reviewer", status: "fixed", confirmedBy: [], answer: { fixed: true, at: 1, text: "Both owners repaired it." } }];
      expect(checkReviewEvidence(task.findings, ReviewResult.parse({ verdict: "fail", confirms: ["shared-fixed"] }), task)).toContain("shared-fixed");
      const confirmation = ReviewResult.parse({ verdict: "fail", confirms: [{ id: "shared-fixed", evidence: report.evidence }] });
      expect(checkReviewEvidence(task.findings, confirmation, task)).toBeUndefined();
      await engine["reviews"]["applyReview"](executionFor(task), stage, confirmation, "opus-high", "code-reviewer", "0");
      expect(task.findings).toHaveLength(1);
      expect(task.findings[0]!).toMatchObject({ id: "shared-fixed", status: "open", productIds: [second, first], evidence: report.evidence });
      expect(task.findings[0]!.earlierReviews![0]!.evidence).toBe("The original shared case.");

      // A new report never erases a prior owner. Invalid new assignments stay Together.
      for (const [prior, incoming, expected] of [[[second], undefined, []], [undefined, [first], [first]], [[second], ["not-a-product"], []], [undefined, ["not-a-product"], []]] as [string[] | undefined, string[] | undefined, string[]][]) {
        task.findings = [{ id: "ownership-unknown", text: "The greeting is missing.", productIds: prior, severity: "blocking", raisedBy: "earlier-reviewer", status: "fixed", confirmedBy: [], answer: { fixed: true, at: 1, text: "Claimed repaired." } }];
        const unknown = ReviewResult.parse({ verdict: "fail", findings: [{ ...report, productIds: incoming }] });
        expect(checkReviewEvidence(task.findings, ReviewResult.parse({ verdict: "fail", findings: [{ ...report, productIds: incoming, evidence: undefined }] }), task)).toBeUndefined();
        await engine["reviews"]["applyReview"](executionFor(task), stage, unknown, "opus-high", "code-reviewer", "0");
        expect(task.findings).toHaveLength(2);
        expect(task.findings[0]!).toMatchObject({ id: "ownership-unknown", status: "fixed" });
        expect(task.findings[0]!.productIds).toEqual(prior);
        expect(task.findings[1]!).toMatchObject({ status: "open", productIds: expected, evidence: report.evidence });
      }
    } finally { await engine.shutdown(); }
  });

  it("keeps cleanup awake until every product copy is removed without starting a system process", async () => {
    const { shop, api, start } = await setup("cleanup-awake");
    const paths: string[] = [];
    const activity: { active: boolean; copies: number }[] = [];
    const engine = start({ awakeObserver: (active) => activity.push({ active, copies: paths.filter((path) => existsSync(path)).length }) });
    try {
      engine.setPoolPaused(true);
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const id = engine.addTask({ productId: first, title: "Saved shared cleanup", backlog: true });
      const task = engine.task(id)!;
      task.repositories = [];
      for (const productId of [first, second]) {
        const product = engine.getState().products.find((entry) => entry.id === productId)!;
        const worktree = join(shop.data, "worktrees", productId, id);
        const branch = `petrina/${id}`;
        await ensureWorktree(product.path!, worktree, branch, "main");
        paths.push(worktree);
        task.repositories.push({ productId, worktree, branch, delivery: "local", completedStages: [], source: { product: { ...product, path: product.path! }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true } });
      }
      task.activeProductId = first;
      // A crash can remove a review folder before its Git registration is cleaned up.
      for (const work of task.repositories) {
        const copy = join(shop.data, "worktrees", work.productId, `${id}.copies`, "review-0");
        await addCopy(work.source!.product.path!, copy, await git(work.worktree!, "rev-parse", "HEAD"));
        rmSync(copy, { recursive: true });
      }
      task.state = "cancelled";
      task.repositories[0]!.report = { summary: "Saved before cleanup", changes: [], tests: "Not run" };
      engine.commitNow();
      expect(task.repositories[0]!.report?.summary).toBe("Saved before cleanup");
      expect(activity).toEqual([]);
      await engine["cleanup"].removeCopy(id);
      expect(task.repositories.every((work) => work.cleanup?.removedAt !== undefined)).toBe(true);
      expect(paths.some((path) => existsSync(path))).toBe(false);
      expect(activity).toEqual([{ active: true, copies: 2 }, { active: false, copies: 0 }]);
      expect(engine.cleanupJobs.size).toBe(0);
      for (const world of [shop, api]) expect(await git(world.clone, "worktree", "list", "--porcelain")).not.toContain(`${id}.copies`);
    } finally { await engine.shutdown(); }
  });

  it("retires shared local deliveries into paged history and removes them only with their last product", async () => {
    const { shop, api, start, fakes } = await setup("shared-history");
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "local" })), title: "A shared local delivery", clientId: "shared-history-request", backlog: true });
      engine.schedule();
      expect(engine.task(id)?.state).toBe("backlog");
      expect(fakes.openings("planner")).toHaveLength(0);
      await engine.shutdown();
      engine = start();
      expect(engine.task(id)?.selectedProducts?.map((choice) => choice.productId)).toEqual([first, second]);
      expect(engine.task(id)?.startedAt).toBeUndefined();
      engine.queueTask(id);
      await finish(engine, id);
      await until(engine, () => !engine.activeState().tasks.some((task) => task.id === id), coordinator([]));
      expect(engine.windowState().tasks).toEqual([]);
      expect(engine.windowState().history?.total).toBe(1);
      for (const productId of [first, second]) expect(engine.historyPage({ productId }).items.map((item) => item.id)).toEqual([id]);
      expect(engine.taskDetails(id)?.repositories?.every((work) => work.cleanup?.removedAt && work.cleanup.reviewCopiesRemovedAt)).toBe(true);
      await engine.shutdown();
      engine = start();
      expect(engine.activeState().tasks).toEqual([]);
      const before = engine.taskDetails(id)!;
      const deliveries = before.repositories!.map((work) => work.landed);
      expect(engine.addTask({ productId: first, title: "Lost reply", clientId: "shared-history-request" })).toBe(id);
      engine.removeProduct(first);
      engine.save();
      expect(engine.historyPage({ productId: second }).items.map((item) => item.id)).toEqual([id]);
      expect(engine.taskDetails(id)?.repositories?.map((work) => work.landed)).toEqual(deliveries);
      expect(engine.taskDetails(id)?.repositories?.[0]?.removed).toBe(true);
      expect(engine.taskDetails(id)?.session).toEqual(before.session);
      engine.removeProduct(second);
      engine.save();
      expect(engine.historyPage({}).total).toBe(0);
      expect(engine.taskDetails(id)).toBeUndefined();
    } finally { await engine.shutdown(); }
  });

  for (const choice of [
    { name: "all products opted in and shared acceptance passed", ask: false, secondOptedIn: true, acceptance: true, ships: true },
    { name: "the shared task asks before shipping", ask: true, secondOptedIn: true, acceptance: true, ships: false },
    { name: "one product did not opt in", ask: false, secondOptedIn: false, acceptance: true, ships: false },
    { name: "shared acceptance has not run", ask: false, secondOptedIn: true, acceptance: false, ships: false },
  ]) it(`${choice.ships ? "ships" : "asks about"} low-risk shared work when ${choice.name}`, async () => {
    const { shop, api, start, fakes } = await setup(`low-risk-${choice.name.replaceAll(" ", "-")}`);
    const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      for (const productId of [first, second]) {
        const product = engine.getState().products.find((entry) => entry.id === productId)!;
        engine.updateProduct(productId, { name: product.name, delivery: "pull-request", approveDelivery: true, shipLowRisk: productId === first || choice.secondOptedIn });
      }
      fakes.scenario({ planner: choice.acceptance ? "tester-with-design" : "short", risk: "low", builder: "plain", affectedProducts: [first, second] });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "A low-risk shared greeting", approveDelivery: choice.ask });
      const state = await until(engine, (state) => ["pr-open", "done", "failed"].includes(taskOf(state, id).state) || !!itemOf(state, id, "delivery"), coordinator(["plan", "design"]));
      const task = taskOf(state, id);
      expect(task.error).toBeUndefined();
      expect(task.approveDelivery).toBe(choice.ask);
      expect(task.state).toBe(choice.ships ? "pr-open" : "needs-you");
      expect(!!itemOf(state, id, "delivery")).toBe(!choice.ships);
      expect(shop.github().prs).toHaveLength(choice.ships ? 1 : 0);
      expect(api.github().prs).toHaveLength(choice.ships ? 1 : 0);
      if (choice.acceptance) {
        expect(task.acceptancePassed).toBe(true);
        expect(Object.keys(task.brief!.acceptance[0]!.versions!).sort()).toEqual([first, second].sort());
      } else expect(task.acceptancePassed).toBeUndefined();
    } finally { await engine.shutdown(); }
  });

  it("keeps each parallel reviewer's complete snapshot map and queued coordinator message", async () => {
    const { shop, api, start, fakes } = await setup("review-messages");
    const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      fakes.scenario({ planner: "parallel", builder: "plain", controlled: true });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Review the shared greeting" });
      await until(engine, () => fakes.received("code reviewer").length >= 2, (engine, state) => {
        coordinator(["plan", "design"])(engine, state);
        for (const entry of fakes.received()) if (entry.role !== "code reviewer") writeFileSync(join(fakes.dir, `release-${entry.session}`), "go");
      });
      engine.setPoolPaused(true);
      const reviews = fakes.received("code reviewer");
      const copies = reviews.flatMap((review) => [...review.text.matchAll(/Product id: ([^;]+); copy: ([^;]+); base version: ([^\n]+)/g)]);
      expect(reviews).toHaveLength(2);
      expect(copies).toHaveLength(4);
      expect(new Set(copies.map((match) => match[2])).size).toBe(4);
      for (const review of reviews) for (const productId of [first, second]) expect(review.text).toContain(`Product id: ${productId}; copy:`);
      for (const work of taskOf(engine.getState(), id).repositories!) {
        expect(copies.filter((match) => match[1] === work.productId).map((match) => match[3])).toEqual([`${work.baseSha}; last completed review: none; inspect the full change`, `${work.baseSha}; last completed review: none; inspect the full change`]);
        expect(copies.some((match) => match[2] === work.worktree)).toBe(false);
        for (const match of copies.filter((entry) => entry[1] === work.productId)) expect(dirname(match[2]!)).toBe(join(shop.data, "worktrees", work.productId, `${id}.copies`));
      }
      engine.sendMessage(id, "Check the guest journey across both products", "queue");
      for (const review of reviews) writeFileSync(join(fakes.dir, `release-${review.session}`), "go");
      const state = await until(engine, (state) => taskOf(state, id).state === "waiting" && !taskOf(state, id).holdsSlot, coordinator([]));
      const heard = fakes.received("code reviewer").filter((entry) => entry.text.includes("Check the guest journey across both products"));
      expect(heard.map((entry) => entry.session).sort()).toEqual(reviews.map((entry) => entry.session).sort());
      expect(taskOf(state, id).queued).toEqual([]);
      for (const match of copies) expect(existsSync(match[2]!)).toBe(false);
      for (const world of [shop, api]) expect(await git(world.clone, "worktree", "list", "--porcelain")).not.toContain(`${id}.copies`);
    } finally { await engine.shutdown(); }
  });

  for (const decision of ["pause", "cancel"] as const) it(`cleans every product's saved review copies after restart and ${decision}`, async () => {
    const { shop, api, start, fakes } = await setup(`screen-copy-${decision}`);
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      fakes.scenario({ planner: "parallel", builder: "plain", screenRoles: ["code reviewer"], screenRoleHold: true, reopen: "resume" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Keep each review copy with its product" });
      await until(engine, (state) => !!taskOf(state, id).screen && !engine.drivers.has(id), coordinator(["plan", "design"]));
      engine.setPoolPaused(true);
      const saved = Object.values(engine.task(id)!.hunt!.screenTurns!);
      expect(saved.length).toBeGreaterThan(0);
      const copies = saved.flatMap((entry) => Object.entries(entry.copies!));
      for (const [productId, copy] of copies) {
        expect(dirname(copy)).toBe(join(shop.data, "worktrees", productId, `${id}.copies`));
        expect(existsSync(copy)).toBe(true);
      }
      await engine.shutdown();
      engine = start();
      expect(Object.values(engine.task(id)!.hunt!.screenTurns!).flatMap((entry) => Object.entries(entry.copies!))).toEqual(copies);
      engine[decision](id);
      await Promise.all(engine.copyCleanups.values());
      for (const [, copy] of copies) expect(existsSync(copy)).toBe(false);
      for (const world of [shop, api]) expect(await git(world.clone, "worktree", "list", "--porcelain")).not.toContain(`${id}.copies`);
      expect(engine.task(id)!.hunt?.screenTurns).toBeUndefined();
    } finally { await engine.shutdown(); }
  });

  it("gives a third answer its own portable copy in every product and resumes it there after a screen wait and restart", async () => {
    const { shop, api, start, fakes } = await setup("third-answer-copies");
    let engine = start();
    try {
      await engine.checkTools();
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      // Both initial verifiers say the Important finding does not block, so Antigravity gives the third answer, on the screen.
      const scenario: Scenario = { planner: "parallel", builder: "plain", reviewer: "important", verifier: "not-a-bug", screenRoles: ["verifier"], screenModels: ["gemini-4-argon"], screenRoleHold: true, reopen: "resume", affectedProducts: [first, second] };
      fakes.scenario(scenario);
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Check the shared greeting three ways" });
      await until(engine, (state) => !!taskOf(state, id).screen && !engine.drivers.has(id), coordinator(["plan", "design"]));
      const member = "vote-third:argon-high";
      const copies = (name: string) => ({ [first]: join(shop.data, "worktrees", first, `${id}.copies`, name), [second]: join(shop.data, "worktrees", second, `${id}.copies`, name) });
      const kept = copies("vote-third_3aargon-high");
      const saved = engine.task(id)!.hunt!.screenTurns![member]!;
      expect(Object.keys(engine.task(id)!.hunt!.screenTurns!)).toEqual([member]);
      expect(saved.copy).toBe(kept[first]!);
      expect(saved.copies).toEqual(kept);
      for (const copy of Object.values(kept)) expect(existsSync(copy)).toBe(true);
      // Every verifier place was given its own copy of each product, the third one's beside the initial pair's.
      const mapOf = (text: string) => Object.fromEntries([...text.matchAll(/Product id: ([^;]+); copy: ([^;]+);/g)].map((match) => [match[1]!, match[2]!]));
      const opened = new Map<string, Record<string, string>>();
      for (const entry of fakes.received("verifier")) if (!opened.has(entry.session)) opened.set(entry.session, mapOf(entry.text));
      const session = saved.conversation.sessionId;
      expect(opened.size).toBe(3);
      expect(opened.get(session)).toEqual(kept);
      expect([...opened.values()]).toEqual(expect.arrayContaining([copies("vote-sol-high"), copies("vote-grok-high"), kept]));
      // A companion copy saved under another folder name, as an earlier version named it, is still the one reopened.
      const earlier = join(shop.data, "worktrees", second, `${id}.copies`, "saved-earlier");
      await git(api.clone, "worktree", "move", kept[second]!, earlier);
      const resumed = { ...kept, [second]: earlier };
      const turn = engine.task(id)!.hunt!.screenTurns![member]!;
      turn.copies = resumed;
      turn.conversation.repositoryCopies = resumed;
      for (const copy of Object.values(resumed)) writeFileSync(join(copy, "held.txt"), "Kept through the restart\n");
      engine.commitNow();
      await engine.shutdown();
      engine = start();
      expect(engine.task(id)!.hunt!.screenTurns![member]!.copies).toEqual(resumed);
      engine.allowScreen(id);
      await until(engine, () => existsSync(join(fakes.dir, `on-screen-${session}`)), coordinator([]));
      // The same place reopens its own conversation in the copies it kept, in both products.
      expect(fakes.opens().filter((entry) => entry.session === session).map((entry) => entry.how)).toEqual(["new", "resume"]);
      expect(engine.task(id)!.hunt!.screenTurns![member]!.conversation.repositoryCopies).toEqual(resumed);
      for (const copy of Object.values(resumed)) expect(readFileSync(join(copy, "held.txt"), "utf8")).toBe("Kept through the restart\n");
      expect(existsSync(kept[second]!)).toBe(false);
      fakes.scenario({ ...scenario, screenRoleHold: false });
      writeFileSync(join(fakes.dir, `screen-release-${session}`), "go");
      const state = await until(engine, (state) => !!itemOf(state, id, "delivery") || ["pr-open", "done", "failed"].includes(taskOf(state, id).state), coordinator([]));
      expect(taskOf(state, id).error).toBeUndefined();
      const task = engine.task(id)!;
      const finding = task.findings.find((entry) => entry.text === "The greeting is missing on the welcome page.")!;
      // The third answer counts on its logical place: three answers settle the finding instead of leaving it unresolved.
      expect(finding.votes!.filter((vote) => vote.toolId === "antigravity")).toEqual([expect.objectContaining({ by: "argon-high", plannedProfileId: "argon-high", verdict: "not-a-bug", ballot: expect.objectContaining({ seat: "third:argon-high" }) })]);
      expect(finding.unresolved).toBeUndefined();
      expect(finding.status).toBe("dismissed");
      expect(task.journey!.filter((step) => step.roleId === "verifier").map((step) => step.seats)).toEqual([["verifier:sol-high", "verifier:grok-high"], ["verifier:third:argon-high"]]);
      expect(new Set(fakes.received("verifier").map((entry) => entry.session)).size).toBe(3);
      for (const map of [resumed, kept, copies("vote-sol-high"), copies("vote-grok-high")]) for (const copy of Object.values(map)) expect(existsSync(copy)).toBe(false);
      for (const world of [shop, api]) expect(await git(world.clone, "worktree", "list", "--porcelain")).not.toContain(`${id}.copies`);
    } finally { await engine.shutdown(); }
  });

  it("prepares two separate copies only after approval, builds both and opens mutually linked PRs", async () => {
    const { shop, api, start, fakes } = await setup("two");
    const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request", reason: "Both sides need the greeting." })) });
      const id = engine.addTask({ productId: first, title: "A shared greeting", approvePlan: false });
      const state = await until(engine, (state) => !!itemOf(state, id, "plan") || taskOf(state, id).state === "failed", coordinator([]));
      expect(taskOf(state, id).error).toBeUndefined();
      expect(taskOf(state, id).workRows).toHaveLength(2);
      expect(taskOf(state, id).worktree).toBeUndefined();
      engine.approve(itemOf(state, id, "plan")!.id);
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["design"]));
      expect(taskOf(ready, id).error).toBeUndefined();
      const approval = itemOf(ready, id, "delivery")!;
      expect(approval.body).toContain("acme/demo; link pending");
      expect(approval.body).toContain("acme/api; link pending");
      expect(approval.body).toContain("visible to anyone who can read it");
      expect(ready.inbox.filter((item) => item.taskId === id && item.kind === "delivery")).toHaveLength(1);
      engine.approve(approval.id);
      // Completing generated links uses this decision, with no second delivery approval.
      const task = taskOf(await finish(engine, id, coordinator([])), id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("pr-open");
      expect(task.repositories).toHaveLength(2);
      expect(task.repositories!.every((work) => work.report && work.checks?.results.every((result) => result.ok) && work.pr?.state === "open")).toBe(true);
      expect(task.plan!.stages.filter((stage) => stage.roleId === "builder")).toHaveLength(1);
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);
      expect(shop.github().prs[0]!.body).toContain(api.github().prs[0]!.url);
      expect(api.github().prs[0]!.body).toContain(shop.github().prs[0]!.url);
      expect(shop.github().prs[0]!.body).toContain("Part of a change across:");
      expect(task.repositories!.every((work) => work.companion?.state === "done")).toBe(true);
      expect(task.timeline.filter((entry) => entry.text === "You approved the delivery")).toHaveLength(1);
      expect(await git(shop.clone, "branch", "--show-current")).toBe("main");
      expect(await git(api.clone, "branch", "--show-current")).toBe("main");
    } finally { await engine.shutdown(); }
  });

  it("clones a proposed product into the confirmed folder only after the complete plan is approved", async () => {
    const { shop, api, start, fakes } = await setup("addition");
    const engine = start();
    try {
      const first = await engine.addProduct(shop.clone);
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: "acme/api", repo: "acme/api", startFrom: { kind: "default" }, delivery: "pull-request", reason: "The API also needs to greet people." }] });
      const id = engine.addTask({ productId: first, title: "A greeting in both places" });
      const state = await until(engine, (state) => !!itemOf(state, id, "plan") || taskOf(state, id).state === "failed", coordinator([]));
      const folder = join(shop.dir, "confirmed-api");
      expect(taskOf(state, id).workRows![1]!.error).toContain("Needs adding");
      expect(() => engine.approve(itemOf(state, id, "plan")!.id)).toThrow();
      await engine.setTaskAddition(id, "acme/api", "Shop API", folder);
      expect(existsSync(folder)).toBe(false);
      engine.approve(itemOf(engine.getState(), id, "plan")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(existsSync(join(folder, ".git"))).toBe(true);
      expect(await git(folder, "branch", "--show-current")).toBe("main");
      expect(task.repositories!.every((work) => work.worktree !== folder)).toBe(true);
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });
  for (const recovery of ["unchanged", "fresh", "retry", "restart"] as const) it(`delivers to an addition's approved local branch after remote default changes: ${recovery}`, async () => {
    const { shop, api, start, fakes, remotes } = await setup(`local-default-${recovery}`);
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone);
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "local" }, { productId: "acme/api", repo: "acme/api", startFrom: { kind: "default" }, delivery: "local", reason: "The API also needs the greeting." }] });
      const id = engine.addTask({ productId: first, title: "A local greeting in both places" });
      await until(engine, (state) => !!itemOf(state, id, "plan") || !!taskOf(state, id).error, coordinator([]));
      const folder = join(shop.dir, "confirmed-local-api");
      await engine.setTaskAddition(id, "acme/api", "API", folder);
      expect(taskOf(engine.getState(), id).workRows![1]!.source!.product.defaultBranch).toBe("main");
      let trunk: string | undefined;
      if (recovery !== "unchanged") {
        await git(api.clone, "switch", "-q", "-c", "trunk");
        writeFileSync(join(api.clone, "TRUNK_ONLY.md"), "Unapproved new default\n");
        await git(api.clone, "add", "."); await git(api.clone, "commit", "-qm", "A distinct new default");
        await git(api.clone, "push", "-q", api.remote, "trunk");
        trunk = await git(api.clone, "rev-parse", "trunk");
        await git(api.remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
      }
      if (recovery === "retry" || recovery === "restart") remotes["acme/api"] = join(api.dir, "unavailable.git");
      engine.approve(itemOf(engine.getState(), id, "plan")!.id);
      if (recovery === "retry" || recovery === "restart") {
        await until(engine, (state) => !!taskOf(state, id).error);
        expect(taskOf(engine.getState(), id).workRows![1]!.addition?.created).toBe(true);
        remotes["acme/api"] = api.remote;
        await git(shop.dir, "clone", "-q", api.remote, folder);
        expect(await git(folder, "branch", "--list", "main")).toBe("");
        writeFileSync(join(folder, "keep.txt"), "Preserved completed clone\n");
        if (recovery === "restart") { await engine.shutdown(); engine = start(); }
        engine.retry(itemOf(engine.getState(), id, "stuck")!.id);
      }
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      const work = task.repositories!.find((entry) => entry.source?.product.repo === "acme/api")!;
      expect(work.source!.initialSha).toBe(api.initial);
      expect(work.source!.product.defaultBranch).toBe("main");
      expect(work.source!.start.branch).toBe("main");
      expect(work.source!.destination.branch).toBe("main");
      expect(work.landed?.branch).toBe("main");
      expect(work.nothingToPublish).not.toBe(true);
      const landed = await git(folder, "rev-parse", "refs/heads/main");
      expect(await git(folder, "rev-parse", `refs/heads/${work.branch}`)).toBe(landed);
      expect(await git(api.remote, "rev-parse", "refs/heads/main")).toBe(landed);
      expect(await git(folder, "show", `${landed}:greeting.txt`)).toContain("Hello");
      expect(await git(folder, "ls-tree", "--name-only", landed, "TRUNK_ONLY.md")).toBe("");
      if (trunk) {
        expect(await git(api.remote, "rev-parse", "refs/heads/trunk")).toBe(trunk);
        expect(await git(folder, "rev-parse", "refs/heads/trunk")).toBe(trunk);
        expect(await git(folder, "branch", "--show-current")).toBe("trunk");
      }
      if (recovery === "retry" || recovery === "restart") expect(await git(folder, "status", "--short")).toContain("keep.txt");
      expect(api.github().prs).toHaveLength(0);
    } finally { await engine.shutdown(); }
  });

  for (const invalid of ["branch", "pull-request", "release"] as const) it(`requires a confirmed folder after correcting a proposed repository's invalid ${invalid} choice`, async () => {
    const { shop, api, start, fakes } = await setup(`invalid-addition-${invalid}`);
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone);
      fakes.scenario({ worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: "acme/api", repo: "acme/api", startFrom: invalid === "pull-request" ? { kind: "pull-request", value: "999" } : { kind: "branch", name: "missing-branch" }, delivery: invalid === "release" ? "release" : "pull-request" }] });
      const id = engine.addTask({ productId: first, title: "Correct the proposed API source" });
      const state = await until(engine, (state) => !!itemOf(state, id, "plan") || taskOf(state, id).state === "failed", coordinator([]));
      expect(taskOf(state, id).error).toBeUndefined();
      const before = taskOf(state, id).workRows![1]!;
      expect(before.error).toBeTruthy();
      expect(before.addition).toBeUndefined();
      await engine.setTaskStart(id, { ...before.choice, startFrom: { kind: "default" }, delivery: "pull-request" });
      const corrected = taskOf(engine.getState(), id).workRows![1]!;
      expect(corrected.error).toContain("Needs adding");
      expect(corrected.addition).toBeUndefined();
      expect(() => engine.approve(itemOf(engine.getState(), id, "plan")!.id)).toThrow();
      expect(engine.task(id)!.repositories).toBeUndefined();
      await engine.shutdown(); engine = start();
      expect(() => engine.approve(itemOf(engine.getState(), id, "plan")!.id)).toThrow();
      // Guard older saved validation placeholders too: an empty folder is never coordinator approval.
      const row = engine.task(id)!.workRows![1]!;
      delete row.error;
      row.addition = { name: "Shop API", path: "", productId: row.source!.product.id };
      row.source!.product.path = "";
      expect(() => engine.approve(itemOf(engine.getState(), id, "plan")!.id)).toThrow();
      const folder = join(shop.dir, "confirmed-api");
      await engine.setTaskAddition(id, "acme/api", "Shop API", folder);
      expect(existsSync(folder)).toBe(false);
      engine.approve(itemOf(engine.getState(), id, "plan")!.id);
      const finished = taskOf(await finish(engine, id), id);
      expect(finished.error).toBeUndefined();
      expect(finished.state).toBe("pr-open");
      expect(await git(folder, "branch", "--show-current")).toBe("main");
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });

  it("keeps a confirmed PR when another repository fails, then resumes after restart without publishing twice", async () => {
    const { shop, api, start } = await setup("partial");
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      api.setGitHub((state) => { state.fail = { "pr create": 1 }; });
      const worksOn = [first, second].map((productId) => ({ productId, startFrom: { kind: "default" as const }, delivery: "pull-request" as const }));
      const id = engine.addTask({ productId: first, worksOn, title: "A partial delivery" });
      const partial = await until(engine, (state) => !!taskOf(state, id).error || !!itemOf(state, id, "shipping"));
      expect({ state: taskOf(partial, id).state, error: taskOf(partial, id).error, deliveries: taskOf(partial, id).repositories?.map((work) => ({ product: work.productId, pr: work.pr, shipping: work.shipping })) }).toMatchObject({ state: "needs-you" });
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(0);
      expect(taskOf(partial, id).repositories![0]!.pr?.number).toBe(1);
      // The open pull request cannot stand in for the interrupted companion, whichever product is shown.
      const interrupted = engine.task(id)!.activeProductId;
      for (const shown of [first, second]) {
        engine.task(id)!.activeProductId = shown;
        expect(await coordinatorDelivery(engine, id)).toEqual({ landing: "open", deliveryConfirmed: false, delivered: "timed-out", landed: "timed-out" });
      }
      engine.task(id)!.activeProductId = interrupted;
      await engine.shutdown();
      engine = start();
      const retry = engine.getState().inbox.find((item) => item.taskId === id && ["shipping", "stuck"].includes(item.kind))!;
      if (retry.kind === "shipping") engine.checkShipping(retry.id); else engine.retry(retry.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined(); expect(done.state).toBe("pr-open");
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);
      expect(shop.github().calls.filter((args) => args[0] === "pr" && args[1] === "create")).toHaveLength(1);
      expect(done.repositories!.every((work) => work.companion?.state === "done")).toBe(true);
      expect(await coordinatorDelivery(engine, id)).toEqual({ landing: "awaiting-merge", deliveryConfirmed: true, delivered: "completed", landed: "timed-out" });
    } finally { await engine.shutdown(); }
  });

  for (const closed of [false, true]) it(`keeps dependents blocked with one merged PR and one ${closed ? "closed" : "open"} PR`, async () => {
    const { shop, api, start } = await setup(`landing-${closed}`);
    const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "A shared change" });
      const completed = taskOf(await finish(engine, id), id);
      expect(completed.error).toBeUndefined();
      expect(completed.state).toBe("pr-open");
      const dependent = engine.addTask({ productId: first, title: "Follow-up", after: [id] });
      // Merge the product the task shows, so its own outcome cannot speak for the companion.
      const shown = engine.task(id)!.activeProductId === first ? 0 : 1;
      const [merging, other] = shown === 0 ? [shop, api] : [api, shop];
      if (!closed) merging.setGitHub((state) => { state.prs[0]!.state = "MERGED"; });
      if (closed) api.setGitHub((state) => { state.prs[0]!.state = "CLOSED"; });
      // Use the normal poll through its timer, without waiting a minute.
      await pollPullRequests(engine, id);
      const task = taskOf(engine.getState(), id);
      expect(task.state).toBe(closed ? "needs-you" : "pr-open");
      expect(engine.blockers(engine.task(dependent)!)).toHaveLength(1);
      if (closed) expect(task.repositories!.map((work) => work.pr!.state)).toEqual(["open", "closed"]);
      else expect(task.repositories!.map((work) => work.pr!.state)).toEqual(shown === 0 ? ["merged", "open"] : ["open", "merged"]);
      expect(await coordinatorDelivery(engine, id)).toEqual(closed ? { landing: "closed", deliveryConfirmed: false, delivered: "timed-out", landed: "timed-out" } : { landing: "awaiting-merge", deliveryConfirmed: true, delivered: "completed", landed: "timed-out" });
      if (closed) {
        const decision = itemOf(engine.getState(), id, "shipping")!;
        expect(decision.title).toContain("API");
        engine.markDone(decision.id);
        expect(engine.task(id)!.state).toBe("pr-open");
        expect(engine.blockers(engine.task(dependent)!)).toHaveLength(1);
        shop.setGitHub((state) => { state.prs[0]!.state = "MERGED"; });
        await pollPullRequests(engine, id);
        expect(engine.task(id)!.state).toBe("done");
      } else {
        other.setGitHub((state) => { state.prs[0]!.state = "MERGED"; });
        await pollPullRequests(engine, id);
        expect(engine.task(id)!.state).toBe("done");
      }
      // Accepting the closed companion releases the dependent work too, without proving it landed.
      expect(engine.blockers(engine.task(dependent)!)).toHaveLength(0);
      const final = closed ? { landing: "closed", deliveryConfirmed: false, delivered: "timed-out", landed: "timed-out" } : { landing: "landed", deliveryConfirmed: true, delivered: "completed", landed: "completed" };
      expect(await coordinatorDelivery(engine, id)).toEqual(final);
      const coordination = new Coordination(engine);
      for (const productId of [first, second]) expect((await coordination.call("task.history", { productId, taskId: id })).items).toEqual([expect.objectContaining({ landing: final.landing, deliveryConfirmed: final.deliveryConfirmed })]);
    } finally { await engine.shutdown(); }
  });

  it("charges only affected products once per repair pass and preserves independent allowances at restart", async () => {
    const fixture = await sharedRecords(), { start, first, second, task } = fixture;
    let engine = fixture.engine;
    try {
      const id = task.id;
      task.state = "paused";
      task.plan = { rationale: "Separate owners with shared verification", plannerProfileId: "sonnet-medium", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        { id: "acceptance", kind: "do", title: "Try it", roleId: "tester", profileIds: ["opus-high"] },
        { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
      ] };
      task.stageIndex = 2;
      task.repositories = [first, second].map((productId) => ({ productId, delivery: "pull-request", completedStages: [] }));
      task.leadProductId = first;
      task.activeProductId = first;
      task.findings = [{ id: "check", text: "Check failed: API", productIds: [second], severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" }];
      expect(beginRepair(engine, task, "checks", 2)).toBe(true);
      expect(task.repair!.products).toEqual([second]);
      expect(task.repositories[0]!.checkReturns ?? 0).toBe(0);
      expect(task.repositories[1]!.checkReturns).toBe(1);
      task.stageIndex = 2; delete task.repair;
      expect(beginRepair(engine, task, "checks", 2)).toBe(true);
      expect(task.repositories[1]!.checkReturns).toBe(2);
      await engine.shutdown(); engine = start();
      const restored = engine.task(id)!;
      expect(beginRepair(engine, restored, "checks", 2)).toBe(false);
      expect(restored.repositories![1]!.checkReturns).toBe(2);
      restored.findings = [{ id: "shared", text: "Failed acceptance check: Shared behaviour", productIds: [second, first], severity: "blocking", raisedBy: "tester", confirmedBy: [], status: "open" }];
      expect(beginRepair(engine, restored, "acceptance", 1)).toBe(true);
      expect(restored.repair!.products).toEqual([first, second]);
      expect(restored.repositories!.map((work) => work.acceptanceReturns)).toEqual([1, 1]);
      expect(restored.repositories![1]!.checkReturns).toBe(2);
      expect(restored.rounds).toEqual({});
    } finally { await engine.shutdown(); }
  });

  for (const kind of ["checks", "acceptance"] as const) for (const shared of [false, true]) it(`uses remaining ${kind} tries despite an exhausted owner of ${shared ? "a shared failure" : "a separate failure"}, including restart`, async () => {
    const fixture = await sharedRecords(), { start, first, second } = fixture;
    let engine = fixture.engine, task = fixture.task;
    try {
      const id = task.id;
      task.plan = { rationale: "Independent repairs", plannerProfileId: "sonnet-medium", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        { id: "test", kind: "do", title: "Try it", roleId: "tester", profileIds: ["opus-high"] },
      ] };
      const field = kind === "checks" ? "checkReturns" : "acceptanceReturns";
      task.repositories = [{ productId: first, delivery: "pull-request", completedStages: [], [field]: 2 }, { productId: second, delivery: "pull-request", completedStages: [] }];
      task.leadProductId = first;
      task.activeProductId = first;
      const text = kind === "checks" ? "Check failed: " : "Failed acceptance check: ";
      task.findings = (shared ? [[first, second]] : [[first], [second]]).map((productIds, index) => ({ id: `failure-${index}`, text: `${text}${index}`, productIds, severity: "blocking", raisedBy: kind === "checks" ? "petrina" : "tester", confirmedBy: [], status: "open" }));
      for (const tries of [1, 2]) {
        expect(beginRepair(engine, task, kind, 1)).toBe(true);
        expect(task.repair).toEqual({ products: [second], index: 0, returnStage: 1, kind });
        expect(task.activeProductId).toBe(second);
        expect(task.repositories!.map((work) => work[field] ?? 0)).toEqual([2, tries]);
        expect(task.findings.every((finding) => finding.status === "open")).toBe(true);
        // The first product remains exhausted regardless of which product the next step addresses.
        delete task.repair;
        task.activeProductId = first;
        engine.commitNow();
        await engine.shutdown(); engine = start(); task = engine.task(id)!;
      }
      expect(beginRepair(engine, task, kind, 1)).toBe(false);
      expect(task.repositories!.map((work) => work[field])).toEqual([2, 2]);
      expect(task.findings.every((finding) => finding.status === "open")).toBe(true);
    } finally { await engine.shutdown(); }
  });

  it("retains a coordinator row omitted by the planner until the coordinator removes it", async () => {
    const { shop, api, start, fakes } = await setup("omitted"); const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const worksOn = [first, second].map((productId) => ({ productId, startFrom: { kind: "default" as const }, delivery: "pull-request" as const }));
      fakes.scenario({ planner: "short", builder: "plain", worksOn: [worksOn[0]!] });
      const id = engine.addTask({ productId: first, worksOn, title: "Keep my choices", approveDelivery: false });
      const state = await until(engine, (state) => !!itemOf(state, id, "plan"), coordinator([]));
      expect(taskOf(state, id).workRows).toHaveLength(2);
      expect(taskOf(state, id).workRows![1]!.change).toBe("omitted");
      expect(taskOf(state, id).workRows![1]!.choice.startFrom).toEqual({ kind: "default" });
      expect(taskOf(state, id).approveDelivery).toBe(false);
      await engine.setTaskProducts(id, [worksOn[0]!]);
      expect(taskOf(engine.getState(), id).workRows).toHaveLength(1);
      expect(taskOf(engine.getState(), id).approveDelivery).toBe(false);
    } finally { await engine.shutdown(); }
  });

  it("retries an interrupted clone in its saved folder and leaves an unrelated occupied folder untouched", async () => {
    const { shop, api, start, fakes, remotes } = await setup("clone-retry"); let engine = start();
    try {
      const first = await engine.addProduct(shop.clone);
      fakes.scenario({ planner: "short", builder: "plain", worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: "acme/api", repo: "acme/api", reason: "Both repositories need the greeting", startFrom: { kind: "default" }, delivery: "pull-request" }] });
      const id = engine.addTask({ productId: first, title: "Resume an addition" });
      await until(engine, (state) => !!itemOf(state, id, "plan"), coordinator([]));
      await expectRejection(engine.setTaskAddition(id, "acme/api", "API", shop.clone), "already exists");
      const folder = join(shop.dir, "api-addition");
      await engine.setTaskAddition(id, "acme/api", "API", folder);
      remotes["acme/api"] = join(api.dir, "unavailable.git");
      engine.approve(itemOf(engine.getState(), id, "plan")!.id);
      const failed = await until(engine, (state) => !!taskOf(state, id).error);
      const firstCopy = taskOf(failed, id).repositories![0]!.worktree;
      expect(taskOf(failed, id).repositories![0]!.preparation).toBe("ready");
      expect(taskOf(failed, id).workRows![1]!.addition?.created).toBe(true);
      mkdirSync(join(folder, ".git"), { recursive: true }); writeFileSync(join(folder, ".git", "interrupted"), "unfinished clone");
      remotes["acme/api"] = api.remote;
      await engine.shutdown(); engine = start();
      engine.retry(itemOf(engine.getState(), id, "stuck")!.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined();
      expect(done.repositories![0]!.worktree).toBe(firstCopy);
      expect(await git(folder, "branch", "--show-current")).toBe("main");
      expect(await git(shop.clone, "show", "HEAD:README.md")).toContain("Demo");
      expect(api.github().prs).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });

  for (const saved of ["approved", "approved SSH", "other repository", "other GitHub repository", "no origin", "empty other repository"] as const) it(`checks the saved clone's remote before retrying an addition with ${saved}`, async () => {
    const { shop, api, remotes } = await setup(`clone-identity-${saved.replaceAll(" ", "-")}`);
    if (saved === "approved SSH" || saved === "other GitHub repository") delete (remotes as Record<string, string>)["acme/api"];
    const products: Product[] = [];
    const sources = new Sources({ options: { remotes }, s: { products }, dataDir: shop.dir, commitNow() {}, tracking: { product() {} } } as unknown as Kernel, {} as Connections);
    const folder = join(shop.dir, "saved-addition");
    if (saved === "empty other repository") {
      await git(shop.dir, "init", "-q", "--initial-branch=main", folder);
      await git(folder, "remote", "add", "origin", shop.remote);
    } else {
      await git(shop.dir, "clone", "-q", saved === "other repository" ? shop.remote : api.remote, folder);
      if (saved === "no origin") await git(folder, "remote", "remove", "origin");
      if (saved === "approved SSH" || saved === "other GitHub repository") await git(folder, "remote", "set-url", "origin", saved === "approved SSH" ? "git@github.com:acme/api.git" : "https://github.com/other/repository.git");
    }
    writeFileSync(join(folder, ".git", "keep.txt"), "Keep this repository metadata");
    const before = await git(folder, "config", "--local", "--list");
    const task = { workRows: [{ choice: { productId: "addition", repo: "acme/api", startFrom: { kind: "default" }, delivery: "pull-request" }, source: { product: { id: "addition", name: "API", repo: "acme/api", path: folder, defaultBranch: "main", remote: "https://github.com/acme/api.git" }, start: { kind: "default", branch: "main" }, destination: { kind: "new-pr", mode: "pull-request", repo: "acme/api", branch: "main" }, confirmed: true }, addition: { productId: "addition", name: "API", path: folder, created: true } }] } as MTask;
    const add = () => sources.addApproved(task, "addition", new AbortController().signal);
    if (saved === "approved" || saved === "approved SSH") {
      await add();
      expect(task.workRows![0]!.addition!.ready).toBe(true);
      expect(products.some((product) => product.id === "addition")).toBe(true);
    } else {
      await expectRejection(add(), "different repository. Change folder");
      expect(task.workRows![0]!.addition!.ready).not.toBe(true);
      expect(products.some((product) => product.id === "addition")).toBe(false);
    }
    expect(await git(folder, "config", "--local", "--list")).toBe(before);
    expect(existsSync(join(folder, ".git", "keep.txt"))).toBe(true);
  });

  it("retries companion linking alone after both publications are confirmed", async () => {
    const { shop, api, start } = await setup("links"); const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      api.setGitHub((state) => { state.fail = { "pr edit": 1 }; });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Finish links" });
      const waiting = await until(engine, (state) => taskOf(state, id).statusLine === "Deliveries saved. Finish links");
      expect(taskOf(waiting, id).repositories!.every((work) => work.pr)).toBe(true);
      engine.retry(itemOf(waiting, id, "stuck")!.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined(); expect(done.repositories!.every((work) => work.companion?.state === "done")).toBe(true);
      for (const world of [shop, api]) expect(world.github().calls.filter((args) => args[0] === "pr" && args[1] === "create")).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });

  it("visits both affected saved builders in one shared repair pass and keeps separate answers", async () => {
    const { shop, api, start, fakes } = await setup("shared-repair"); const engine = start();
    const reviewedHeads = new Map<string, string>();
    // A failed read is reported by the test, not thrown into the engine's announcement.
    let captureFailure: unknown;
    let unsubscribe = () => {};
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      fakes.scenario({ builder: "plain", reopen: "resume", reviewer: "important-twice", affectedProducts: [first, second], fixes: "change" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Repair the shared greeting" });
      unsubscribe = engine.subscribe(() => {
        const current = engine.task(id);
        const review = current?.plan?.stages.find((stage) => stage.kind === "review-chain");
        if (!current || !review || current.rounds[review.id] !== 2 || reviewedHeads.size) return;
        const builder = current.plan!.stages.findIndex((stage) => stage.kind === "do" && stage.roleId === "builder");
        if (current.stageIndex !== builder) return;
        // Announcements stay synchronous: read each copy's HEAD from Git's files as the fix round starts.
        try { for (const work of current.repositories ?? []) reviewedHeads.set(work.productId, headNow(work.worktree!)); }
        catch (error) { captureFailure ??= error; }
      });
      const task = taskOf(await finish(engine, id), id);
      if (captureFailure) throw captureFailure;
      expect(task.error).toBeUndefined();
      const finding = task.findings.find((finding) => finding.severity === "blocking")!;
      expect(finding.productIds).toEqual([first, second]);
      expect(Object.keys(finding.answers!)).toEqual([first, second]);
      expect(finding.status).toBe("fixed");
      // One bounded pair checked the shared finding in round one, each answer bound to both products' reviewed versions.
      const votes = independentVotes(finding.earlierReviews?.[0]?.votes);
      expect(votes.length).toBeGreaterThan(0);
      expect(votes.length).toBeLessThanOrEqual(2);
      for (const vote of votes) expect(Object.keys(vote.ballot!.versions!).sort()).toEqual([first, second].sort());
      const earlier = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!.result!.findings!.find((entry) => entry.id === finding.id)!;
      expect(earlier.status).toBe("open");
      expect(earlier.productIds).toEqual([first, second]);
      expect(earlier.answers).toBeUndefined();
      expect(task.repositories!.every((work) => !!work.builderSession)).toBe(true);
      const fixes = fakes.received("builder").filter((entry) => entry.text.includes("You are fixing the review findings"));
      expect(fixes).toHaveLength(2);
      expect(fixes[0]!.text).toContain(`You own only product ${first}`);
      expect(fixes[1]!.text).toContain(`You own only product ${second}`);
      expect(task.rounds[task.plan!.stages.find((stage) => stage.kind === "review-chain")!.id]).toBe(2);
      expect(reviewedHeads.size).toBe(2);
      const roundTwoReviews = fakes.received("code reviewer").map((entry) => entry.text).filter((text) => text.includes("This is review round 2"));
      expect(roundTwoReviews.length).toBeGreaterThan(0);
      for (const [productId, sha] of reviewedHeads) for (const review of roundTwoReviews) {
        expect(review).toContain(`Product id: ${productId}; copy:`);
        expect(review).toContain(`last completed review: ${sha}`);
        expect(review).toContain(`git diff ${sha}..HEAD`);
      }
    } finally { unsubscribe(); await engine.shutdown(); }
  });

  it("keeps unassigned Important findings under Together and sends them to no builder", async () => {
    const { shop, api, start, fakes } = await setup("unassigned"); const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      fakes.scenario({ builder: "plain", reviewer: "important-twice" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Resolve ownership" });
      const state = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      const task = taskOf(state, id);
      expect(task.error).toBeUndefined();
      expect(task.findings.some((finding) => finding.severity === "blocking" && finding.status === "open" && !finding.productIds?.length)).toBe(true);
      expect(fakes.received("builder").filter((entry) => entry.text.includes("You are fixing the review findings"))).toHaveLength(0);
      expect(shop.github().prs).toHaveLength(0); expect(api.github().prs).toHaveLength(0);
      expect(task.plan!.stages[task.stageIndex]!.gate).toBe("delivery");
      const reviews = fakes.received("code reviewer").length;
      const decision = itemOf(engine.getState(), id, "delivery")!;
      expect(engine.task(id)!.reviewDecision?.accepted).toBe(false);
      engine.approve(decision.id);
      const verified = await until(engine, state => !!itemOf(state, id, "delivery"), coordinator([]));
      expect(itemOf(verified, id, "delivery")!.id).not.toBe(decision.id);
      expect(shop.github().prs).toHaveLength(0); expect(api.github().prs).toHaveLength(0);
      engine.approve(itemOf(verified, id, "delivery")!.id);
      const delivered = await until(engine, (state) => taskOf(state, id).state === "pr-open" || !!taskOf(state, id).error || !!itemOf(state, id, "delivery"), coordinator([]));
      expect(taskOf(delivered, id).error).toBeUndefined();
      expect(taskOf(delivered, id).state).toBe("pr-open");
      expect(fakes.received("code reviewer")).toHaveLength(reviews);
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });

  it("invalidates shared evidence when one named version changes while retaining unrelated current checks", async () => {
    const { shop, api, start } = await setup("evidence"); const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Keep evidence honest" });
      await until(engine, (state) => !!itemOf(state, id, "delivery"), coordinator(["plan", "design"]));
      engine.setPoolPaused(true);
      const task = engine.task(id)!;
      const versions = await versionsOf(task);
      task.brief = { summary: "Shared behaviour", forUsers: [], areas: [], risks: [], acceptance: [
        { text: "First product works", productIds: [first], versions: { [first]: versions[first]! }, met: true, verification: "passed" },
        { text: "The products work together", productIds: [first, second], versions, met: true, verification: "passed" },
      ] };
      task.acceptancePassed = true;
      const copy = task.repositories![1]!.worktree!;
      writeFileSync(join(copy, "api-repair.txt"), "A repair changes this product\n");
      await git(copy, "add", "."); await git(copy, "commit", "-qm", "Repair API");
      await invalidateAcceptance(task);
      expect(task.brief.acceptance[0]!.verification).toBe("passed");
      expect(task.brief.acceptance[1]!.verification).toBe("stale");
      expect(task.brief.acceptance[1]!.met).toBeUndefined();
      expect(task.acceptancePassed).toBe(false);
      expect(task.repositories![0]!.checks!.current).toBe(true);
      expect(task.repositories![1]!.checks!.current).toBe(false);
    } finally { await engine.shutdown(); }
  });

  it("previews a release without a version commit and waits for the companion open PR after publishing", async () => {
    const { shop, api, start } = await setup("mixed-release");
    writeFileSync(join(api.clone, "package.json"), JSON.stringify({ name: "api", version: "1.0.0" }));
    await git(api.clone, "add", "."); await git(api.clone, "commit", "-qm", "Record the version"); await git(api.clone, "push", "-q", api.remote, "main");
    const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const id = engine.addTask({ productId: first, worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: second, startFrom: { kind: "default" }, delivery: "release" }], title: "Release the shared greeting" });
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      const preview = taskOf(ready, id);
      expect(preview.error).toBeUndefined();
      expect(preview.repositories![1]!.releasePreview?.notes).toBeTruthy();
      expect(JSON.parse(await git(preview.repositories![1]!.worktree!, "show", "HEAD:package.json")).version).toBe("1.0.0");
      expect(shop.github().prs).toHaveLength(0); expect(api.github().releases).toHaveLength(0);
      engine.approve(itemOf(ready, id, "delivery")!.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined(); expect(done.state).toBe("pr-open");
      expect(done.repositories![0]!.pr?.state).toBe("open"); expect(done.repositories![1]!.release).toBeDefined();
      expect(api.github().releases).toHaveLength(1);
      expect(shop.github().prs[0]!.body).toContain(api.github().releases[0]!.url);
    } finally { await engine.shutdown(); }
  });

  it("keeps a PR fork within its original product and retries its companion comment without duplicates", async () => {
    const { shop, api, start, sourceRemotes } = await setup("fork-links");
    const fork = join(shop.dir, "fork.git"); await git(shop.dir, "clone", "-q", "--bare", shop.remote, fork);
    sourceRemotes["contributor/demo"] = fork;
    await git(shop.clone, "switch", "-q", "-c", "review-work");
    writeFileSync(join(shop.clone, "existing.txt"), "Existing PR work");
    await git(shop.clone, "add", "."); await git(shop.clone, "commit", "-qm", "Existing PR work");
    const initial = await git(shop.clone, "rev-parse", "HEAD");
    await git(shop.clone, "push", "-q", fork, "review-work");
    await git(shop.clone, "push", "-q", shop.remote, `${initial}:refs/pull/7/head`);
    await git(shop.clone, "switch", "-q", "main");
    shop.setGitHub((state) => { state.forks = { "contributor/demo": fork }; state.lose = { "pr comment": 1 }; state.prs.push({ number: 7, url: "https://github.com/acme/demo/pull/7", state: "OPEN", title: "Original title", body: "Original description", headRefName: "review-work", baseRefName: "main", headRefOid: initial, headRepository: { nameWithOwner: "contributor/demo" }, isCrossRepository: true }); });
    const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const id = engine.addTask({ productId: first, worksOn: [{ productId: first, startFrom: { kind: "pull-request", value: "7" }, delivery: "pull-request" }, { productId: second, startFrom: { kind: "default" }, delivery: "pull-request" }], title: "Update the shared PR" });
      const plan = await until(engine, (state) => !!itemOf(state, id, "plan"), coordinator([]));
      expect(taskOf(plan, id).workRows).toHaveLength(2);
      expect(taskOf(plan, id).workRows!.every((row) => !row.addition)).toBe(true);
      expect(taskOf(plan, id).workRows![0]!.source!.destination.repo).toBe("contributor/demo");
      engine.approve(itemOf(plan, id, "plan")!.id);
      const links = await until(engine, (state) => taskOf(state, id).statusLine === "Deliveries saved. Finish links" || !!taskOf(state, id).error);
      expect(taskOf(links, id).error).toBeUndefined();
      engine.retry(itemOf(links, id, "stuck")!.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined(); expect(done.repositories![0]!.pr!.number).toBe(7);
      expect(shop.github().prs).toHaveLength(1);
      expect(shop.github().prs[0]!.title).toBe("Original title"); expect(shop.github().prs[0]!.body).toBe("Original description");
      expect(shop.github().calls.filter((args) => args[0] === "pr" && args[1] === "comment")).toHaveLength(1);
      expect(shop.github().pages!["issues/7/comments?per_page=100"]!.flat()).toHaveLength(1);
      expect(api.github().prs).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });

  it("saves an editing architect's work separately in each product before the shared review", async () => {
    const { shop, api, start, fakes } = await setup("editing-design"); const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const architect = engine.getState().roles.find((role) => role.result === "brief")!;
      engine.saveRole(architect.id, { ...draftOf(architect), canEdit: true });
      fakes.scenario({ builder: "plain", architect: "writes" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Keep each design's edits" });
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.repositories!.every((work) => work.completedStages.some((stage) => stage.includes(":author:")))).toBe(true);
      for (const work of task.repositories!) expect(await git(work.worktree!, "show", "HEAD:architecture.txt")).toContain("Before the design review");
    } finally { await engine.shutdown(); }
  });

});

describe.concurrent("shared-task repair regressions", () => {
  it("stops at exhausted acceptance allowances, keeps them after restart and renews every product on send-back", async () => {
    const { shop, api, start } = await setup("acceptance-exhausted");
    let owners: string[] = [], builds = 0;
    const agents = new ScriptedAgents(({ result, cwd, text }) => {
      switch (result) {
        case "plan": return scriptedResult({ rationale: "Build it, try it, then two reviewers.", stages: [
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-xhigh"] },
          { kind: "do", title: "Try it like a user", roleId: "tester", profileIds: ["opus-high"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-xhigh", "sol-xhigh"], maxRounds: 2 },
        ] });
        case "check-discovery": return scriptedResult({ summary: "Git is the fixture's check.", checks: [{ name: "Version", argv: ["git", "--version"], why: "A real passing check" }] });
        case "build":
          writeFileSync(join(cwd, "greeting.txt"), "Hello\n");
          if (text.includes("You are fixing the review findings")) writeFileSync(join(cwd, "welcome.txt"), `Repair ${++builds}\n`);
          return scriptedResult({ summary: "Added a greeting.", changes: ["People see a greeting"], answers: answersTo(text) });
        case "checks": return scriptedResult({ summary: "The greeting still does not appear.", checks: [{ text: "A greeting file exists", result: "fail", productIds: owners, evidence: "The guest welcome page has no greeting." }] });
        case "findings": return scriptedResult({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit", productIds: owners, evidence: "The welcome page's greeting is terse." }], confirms: [], disputes: [] });
        case "votes": return scriptedResult({ verdicts: findingIds(text, "Important findings to check (a verdict on every one, by id)").map(id => ({ id, verdict: "real", reason: "The welcome page has no greeting." })) });
        case "guide": return scriptedResult({ missed: true, line: "Every greeting also shows on the welcome page.", why: "The reviewers checked the greeting only where it was added." });
        default: throw new Error(`Unexpected participant in the acceptance repair fixture: ${result}`);
      }
    });
    const restart = () => start({ startAgentSession: agents.start });
    let engine = restart();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      owners = [first, second];
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Acceptance needs a decision" });
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      expect(taskOf(ready, id).error).toBeUndefined();
      expect(taskOf(ready, id).acceptanceBlocked).toBe(true);
      expect(taskOf(ready, id).repositories!.map((work) => work.acceptanceReturns)).toEqual([2, 2]);
      // The planned review still runs before the decision, and the held failure starts no review fix round.
      expect(agents.received("findings")).toHaveLength(2);
      expect(agents.received("build")).toHaveLength(6);
      expect(agents.received("brief")).toHaveLength(0);
      expect(agents.received("objections")).toHaveLength(0);
      await engine.shutdown(); engine = restart();
      expect(engine.task(id)!.repositories!.map((work) => work.acceptanceReturns)).toEqual([2, 2]);
      expect(agents.received("build")).toHaveLength(6);
      // An asymmetric saved allowance must be renewed too, rather than blocking the next shared pass.
      engine.setPoolPaused(true);
      const current = engine.task(id)!;
      const inactive = current.repositories!.find((work) => work.productId !== current.productId)!;
      inactive.acceptanceReturns = 1;
      engine.requestChanges(itemOf(engine.getState(), id, "delivery")!.id, "Try a new approach across both products");
      expect(current.repositories!.map((work) => work.acceptanceReturns ?? 0)).toEqual([0, 0]);
      engine.setPoolPaused(false);
      // An unresolved review can now ask before final verification. Accept that risk explicitly;
      // it must neither renew nor bypass the acceptance allowance being exercised here.
      const again = await until(engine, (state) => (!!itemOf(state, id, "delivery") && taskOf(state, id).reviewDecision?.accepted !== false) || !!taskOf(state, id).error, (current, state) => {
        if (taskOf(state, id).reviewDecision?.accepted === false) {
          const decision = itemOf(state, id, "delivery");
          if (decision) current.approve(decision.id);
        }
      });
      expect(taskOf(again, id).error).toBeUndefined();
      expect(taskOf(again, id).repositories!.map((work) => work.acceptanceReturns)).toEqual([2, 2]);
      expect(taskOf(again, id).acceptancePassed).toBe(false);
      expect(shop.github().prs).toHaveLength(0); expect(api.github().prs).toHaveLength(0);
    } finally { await engine.shutdown(); }
  });

  it("repairs assigned review problems while leaving unassigned problems for the coordinator", async () => {
    const { shop, api, start, fakes } = await setup("mixed-ownership"); const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      fakes.scenario({ builder: "plain", reviewer: "important-twice", affectedProducts: [second], unassignedFinding: true, fixes: "change", reopen: "resume" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Repair only the assigned problem" });
      const state = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      const task = taskOf(state, id);
      expect(task.error).toBeUndefined();
      const fixes = fakes.received("builder").filter((entry) => entry.text.includes("You are fixing the review findings"));
      expect(fixes).toHaveLength(1);
      expect(fixes[0]!.text).toContain(`You own only product ${second}`);
      const assigned = task.findings.find((finding) => finding.severity === "blocking" && finding.productIds?.length)!;
      expect(assigned.status).toBe("fixed");
      expect(assigned.answers?.[second]?.fixed).toBe(true);
      expect(task.findings.find((finding) => finding.text.includes("ownership needs"))?.status).toBe("open");
      expect(shop.github().prs).toHaveLength(0); expect(api.github().prs).toHaveLength(0);
      expect(task.plan!.stages[task.stageIndex]!.gate).toBe("delivery");
      const reviews = fakes.received("code reviewer").length;
      const decision = itemOf(engine.getState(), id, "delivery")!;
      expect(engine.task(id)!.reviewDecision?.accepted).toBe(false);
      engine.approve(decision.id);
      const verified = await until(engine, state => !!itemOf(state, id, "delivery"), coordinator([]));
      expect(itemOf(verified, id, "delivery")!.id).not.toBe(decision.id);
      expect(shop.github().prs).toHaveLength(0); expect(api.github().prs).toHaveLength(0);
      engine.approve(itemOf(verified, id, "delivery")!.id);
      const delivered = await until(engine, (state) => taskOf(state, id).state === "pr-open" || !!taskOf(state, id).error || !!itemOf(state, id, "delivery"), coordinator([]));
      expect(taskOf(delivered, id).error).toBeUndefined();
      expect(taskOf(delivered, id).state).toBe("pr-open");
      expect(fakes.received("code reviewer")).toHaveLength(reviews);
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });

  for (const order of ["pass-first", "confirmation-first", "dispute-first", "confirmation-before-dispute", "repeated-finding-after-dispute", "repeated-finding-before-dispute", "dispute-without-confirmation", "both-pass"] as const) it(`combines shared fix reviews regardless of completion order, including restart: ${order}`, async () => {
    const fixture = await sharedRecords(), { first, second, start, stage } = fixture;
    let engine = fixture.engine, task = fixture.task;
    const id = task.id;
    try {
      // Two independent reviewers assess the same saved repaired finding.
      task.hunt = { stageId: stage.id, round: 2, reported: {}, findings: 1 };
      task.rounds[stage.id] = 2;
      task.findings = [{ id: "shared-fix", text: "The journey still fails across both products", productIds: [first, second], severity: "blocking", raisedBy: "earlier-reviewer", status: "open", confirmedBy: [], answer: { at: Date.now(), fixed: true, text: "Repaired" }, answers: Object.fromEntries([first, second].map((id) => [id, { at: Date.now(), fixed: true, text: "Repaired my part" }])) }];
      for (const key of ["0", "1"]) {
        const confirmationFirst = order === "confirmation-first" || order === "confirmation-before-dispute" || order === "repeated-finding-before-dispute";
        const confirms = !["both-pass", "dispute-without-confirmation"].includes(order) && (confirmationFirst ? key === "0" : key === "1");
        const disputes = order.includes("dispute") && (confirmationFirst ? key === "1" : key === "0");
        const repeats = confirms && order.startsWith("repeated-finding");
        const result = ReviewResult.parse({
          verdict: confirms || repeats ? "fail" : "pass",
          findings: repeats ? [{ text: task.findings[0]!.text, productIds: [first, second], severity: "important", evidence: "The combined journey still fails on the current product versions." }] : [],
          confirms: confirms && !repeats ? [{ id: "shared-fix", evidence: "The combined journey still fails on the current product versions." }] : [],
          disputes: disputes ? [{ id: "shared-fix", reason: "I could not reproduce this problem on the changed code." }] : [],
          learnings: [],
        });
        await engine["reviews"]["applyReview"](executionFor(task), stage, result, stage.profileIds[Number(key)]!, "code-reviewer", key);
        task.hunt!.reported[key] = true;
        if (key === "0") {
          engine["reviews"]["settleReviews"](task, stage);
          expect(task.findings[0]!.status).toBe("open");
          engine.save(); await engine.shutdown(); engine = start(); task = engine.task(id)!;
        }
      }
      engine["reviews"]["settleReviews"](task, stage);
      const expected = order === "both-pass" ? "fixed" : order === "dispute-without-confirmation" || order.startsWith("repeated-finding") ? "dismissed" : "open";
      expect(task.findings[0]!.status).toBe(expected);
      expect(reviewRoundEnd(task, stage, 2, engine.s.roles).kind === "passed").toBe(expected !== "open" && !order.startsWith("repeated-finding"));
      if (order.startsWith("repeated-finding")) {
        expect(task.findings).toHaveLength(2);
        expect(task.findings[1]!.status).toBe("open");
        expect(task.findings[1]!.confirmedBy).toEqual([]);
      }
      if (expected === "open") expect(task.findings[0]!.confirmedBy).toHaveLength(1);
      if (order.includes("dispute")) expect(task.findings[0]!.disputes).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });

  it("settles single-product objections with the whole group and preserves checks and unresolved ownership", async () => {
    const { engine, first, second, task, stage } = await sharedRecords();
    try {
      task.hunt = { stageId: stage.id, round: 1, reported: {}, findings: 5 };
      task.findings = [
        { id: "single", text: "Single-product problem", productIds: [first] },
        { id: "unopposed", text: "Unopposed single-product objection", productIds: [second] },
        { id: "native", text: "Check failed: Product tests", raisedBy: "petrina", productIds: [second] },
        { id: "acceptance", text: "Failed acceptance check: Shared behaviour", productIds: [first, second] },
        { id: "unassigned", text: "Ownership not yet resolved" },
      ].map((finding) => ({ severity: "blocking", raisedBy: "earlier-reviewer", confirmedBy: [], status: "open", ...finding }));
      const result = ReviewResult.parse({ verdict: "pass", findings: [], confirms: [], disputes: task.findings.map((finding) => ({ id: finding.id, reason: "I disagree with this finding." })), learnings: [] });
      await engine["reviews"]["applyReview"](executionFor(task), stage, result, "opus-high", "code-reviewer", "0");
      task.hunt.reported = { "0": true };
      engine["reviews"]["settleReviews"](task, stage);
      expect(task.findings.every((finding) => finding.status === "open")).toBe(true);
      await engine["reviews"]["applyReview"](executionFor(task), stage, ReviewResult.parse({ ...result, verdict: "fail", disputes: [], confirms: ["single"] }), "sol-high", "code-reviewer", "1");
      task.hunt.reported = { "0": true, "1": true };
      engine["reviews"]["settleReviews"](task, stage);
      expect(task.findings.map((finding) => [finding.id, finding.status])).toEqual([["single", "open"], ["unopposed", "dismissed"], ["native", "open"], ["acceptance", "open"], ["unassigned", "open"]]);
      expect(task.findings[0]!.disputes).toHaveLength(1);
      expect(task.findings[0]!.confirmedBy).toEqual(["sol-high"]);
    } finally { await engine.shutdown(); }
  });

  it("keeps each editing role's product report available to the next product and the combined reviewers", async () => {
    const { shop, api, start, fakes } = await setup("editing-notes"); const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      engine.addRole({ ...draftOf(engine.getState().roles.find((role) => role.result === "notes")!), name: "Copywriter", result: "notes", canEdit: true });
      fakes.scenario({ planner: "copy", builder: "plain" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Keep both copy reports" });
      const task = taskOf(await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"])), id);
      expect(task.error).toBeUndefined();
      const reports = task.handedBack!.filter((entry) => entry.roleName === "Copywriter");
      expect(reports.map((entry) => entry.productId)).toEqual([first, second]);
      const names = task.repositories!.map((work) => work.source!.product.name);
      const reviews = fakes.received("code reviewer");
      expect(reviews.length).toBeGreaterThan(0);
      for (const review of reviews) for (const name of names) expect(review.text).toContain(`Copywriter · ${name}`);
      expect(fakes.received("copywriter")[1]!.text).toContain(`Copywriter · ${names[0]}`);
    } finally { await engine.shutdown(); }
  });
});

describe.concurrent("shared delivery and hand-back regressions", () => {
  it("attributes both products' reused failures after a shared unchanged repair", async () => {
    const { shop, api, start, fakes } = await setup("unchanged-shared-check-repair");
    const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const products = [first, second];
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", affectedProducts: products });
      const log = join(shop.dir, "checks-ran.txt"), script = join(shop.dir, "fails.cjs");
      writeFileSync(script, 'require("node:fs").appendFileSync(process.argv[2], process.argv[3] + "\\n"); process.exit(1);');
      const check = (productId: string) => [{ name: "Tests", command: `${process.execPath} ${script} ${log} ${productId}` }];
      for (const productId of products) engine.setProductChecks(productId, check(productId));
      const id = engine.addTask({ productId: first, worksOn: products.map(productId => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Investigate both products' failed checks" });
      const state = await until(engine, state => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan"]));
      const task = taskOf(state, id);
      expect(task.error).toBeUndefined();
      expect(readFileSync(log, "utf8").trim().split("\n").sort()).toEqual([...products].sort());
      expect(task.repositories!.map(work => work.checkReturns)).toEqual([2, 2]);
      const evidence = decisionEvidence(task);
      expect(evidence.map(check => [check.productId, check.result, check.reusedAt !== undefined])).toEqual([[first, "fail", true], [second, "fail", true]]);
      for (const check of evidence) expect(task.journey!.find(step => step.id === check.run!.source!.stepId)?.work).toBe("checks");
      expect(itemOf(state, id, "delivery")!.body!.match(/Previous check evidence reused; no new execution\./g)).toHaveLength(2);
      // Editing a definition leaves these unresolved results and their coordinator actions intact.
      engine.setProductChecks(first, check(first));
      expect(checkDecisionLabel(taskOf(engine.getState(), id))).toBe("Your call: checks still failing");
      expect(taskOf(engine.getState(), id).statusLine).toBe("Checks still fail. Your call");
      expect(task.findings.filter(finding => finding.text.startsWith("Check failed"))).toHaveLength(2);
    } finally { await engine.shutdown(); }
  });

  it("returns a shared check repair started right before shipping through review, acceptance and the delivery check", async () => {
    const { shop, api, start, fakes } = await setup("check-repair-before-shipping");
    const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const products = [first, second];
      fakes.scenario({ planner: "tester-first", builder: "plain", reopen: "resume", affectedProducts: products, fixes: "change" });
      const script = (name: string, body: string) => { const path = join(api.dir, name); writeFileSync(path, body); return `${process.execPath} ${path}`; };
      engine.setProductChecks(second, [{ name: "Welcome", command: script("welcome-passes.cjs", "process.exit(0)") }]);
      const id = engine.addTask({ productId: first, worksOn: products.map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Welcome people in both products" });
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      expect(taskOf(ready, id).error).toBeUndefined();
      const reviewers = fakes.received("code reviewer").length, testers = fakes.openings("tester").length, builders = fakes.received("builder").length;
      expect(testers).toBe(1);
      // The API's checks change after approval and fail on what was about to ship.
      engine.setProductChecks(second, [{ name: "Welcome", command: script("welcome-file.cjs", "process.exit(require('node:fs').existsSync('welcome.txt') ? 0 : 1)") }]);
      const approved = itemOf(ready, id, "delivery")!.id;
      engine.approve(approved);
      const again = await until(engine, (state) => (!!itemOf(state, id, "delivery") && itemOf(state, id, "delivery")!.id !== approved) || !!taskOf(state, id).error || taskOf(state, id).state === "pr-open", coordinator(["plan", "design"]));
      const task = taskOf(again, id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("needs-you");
      const lines = task.timeline.map((line) => line.text);
      expect(lines.some((line) => line.startsWith("Checks: 1 of 1 failed (Welcome)"))).toBe(true);
      // Only the API's Builder repaired it; the fix was reviewed again and acceptance tried on the final code.
      expect(fakes.received("builder").length).toBeGreaterThan(builders);
      expect(fakes.received("code reviewer").length).toBeGreaterThan(reviewers);
      expect(fakes.openings("tester")).toHaveLength(2);
      const repaired = task.repositories!.find((work) => work.productId === second)!;
      expect(repaired.checks!.results.every((run) => run.ok)).toBe(true);
      expect(task.repositories!.map((work) => work.checkReturns)).toEqual([undefined, undefined]);
      expect(task.repositories!.every((work) => !work.pr && !work.approvedFor)).toBe(true);
      expect(itemOf(again, id, "delivery")!.title).toBe("Ready to ship “Welcome people in both products”");
    } finally { await engine.shutdown(); }
  });

  for (const decision of ["approve-again", "send-back"] as const) it(`cleans earlier unpublished release versions before shared ${decision} after a later preview mismatch`, async () => {
    const { shop, api, start, fakes } = await setup(`release-preview-mismatch-${decision}`);
    for (const world of [shop, api]) {
      writeFileSync(join(world.clone, "package.json"), JSON.stringify({ name: world === shop ? "shop" : "api", version: "1.0.0" }));
      await git(world.clone, "add", "package.json"); await git(world.clone, "commit", "-qm", "Record the release version"); await git(world.clone, "push", "-q", world.remote, "main");
      await git(world.remote, "update-ref", "refs/tags/v1.0.0", await git(world.clone, "rev-parse", "HEAD"));
      world.setGitHub((state) => state.releases.push({ tagName: "v1.0.0", url: `https://github.com/${state.repo}/releases/tag/v1.0.0`, publishedAt: "2025-01-01T00:00:00Z", isDraft: false, name: "v1.0.0", body: "Previous release" }));
    }
    const peerState = join(api.dir, "github.json");
    writeFileSync(join(shop.clone, "mutate-peer-release.cjs"), `
      const fs = require('node:fs');
      if (JSON.parse(fs.readFileSync('package.json', 'utf8')).version === '1.0.1') {
        const path = ${JSON.stringify(peerState)};
        const state = JSON.parse(fs.readFileSync(path, 'utf8'));
        state.releases[0].tagName = '1.0.0';
        state.releases[0].url = 'https://github.com/acme/api/releases/tag/1.0.0';
        fs.writeFileSync(path, JSON.stringify(state));
      }
    `);
    await git(shop.clone, "add", "mutate-peer-release.cjs"); await git(shop.clone, "commit", "-qm", "Add a check helper"); await git(shop.clone, "push", "-q", shop.remote, "main");
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      engine.setProductChecks(first, [{ name: "Update peer release record", command: `${process.execPath} mutate-peer-release.cjs` }]);
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "release" })), title: "Prepare two releases" });
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      expect(taskOf(ready, id).error).toBeUndefined();
      expect(taskOf(ready, id).repositories!.every((work) => work.releasePreview?.version === "1.0.1")).toBe(true);
      const approved = taskOf(ready, id).repositories!.map((work) => work.checkedSha!);
      const shipping = (engine as unknown as { shipping: { prepare: (...args: unknown[]) => Promise<unknown> } }).shipping;
      const prepare = shipping.prepare.bind(shipping);
      shipping.prepare = async (...args: unknown[]) => {
        const result = await prepare(...args);
        if ((args[0] as RepositoryContext).work.productId === second && result === "continue") engine.setPoolPaused(true);
        return result;
      };
      engine.approve(itemOf(ready, id, "delivery")!.id);
      const paused = await until(engine, (state) => (state.pool.paused && taskOf(state, id).state === "waiting") || !!taskOf(state, id).error, coordinator([]));
      const waiting = taskOf(paused, id);
      expect(waiting.error).toBeUndefined();
      expect(waiting.repositories!.map((work) => work.checkedSha)).toEqual(approved);
      expect(waiting.plan!.stages[waiting.stageIndex]!.gate).toBe("delivery");
      expect(api.github().releases[0]!.tagName).toBe("1.0.0");
      // B's preview changes after A's version check; pausing at the gate must not preserve A's version commit.
      for (const work of waiting.repositories!) {
        expect(work.shipping?.prepared).toBeUndefined();
        expect(await git(work.worktree!, "rev-parse", "HEAD")).toBe(work.checkedSha!);
        expect(JSON.parse(await git(work.worktree!, "show", "HEAD:package.json")).version).toBe("1.0.0");
      }
      expect(shop.github().releases).toHaveLength(1);
      expect(api.github().releases).toHaveLength(1);
      engine.setPoolPaused(false);
      const mismatch = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator([]));
      expect(taskOf(mismatch, id).error).toBeUndefined();
      await engine.shutdown(); engine = start();
      const restored = engine.task(id)!;
      expect(await Promise.all(restored.repositories!.map((work) => git(work.worktree!, "rev-parse", "HEAD")))).toEqual(approved);
      const decisionItem = itemOf(engine.getState(), id, "delivery")!;
      if (decision === "send-back") {
        engine.requestChanges(decisionItem.id, "Revisit the shared release before trying again");
        const revised = await until(engine, (state) => fakes.received("builder").length >= 4 || !!taskOf(state, id).error, coordinator([]));
        expect(taskOf(revised, id).error).toBeUndefined();
        expect(fakes.received("builder").slice(-2)).toHaveLength(2);
        for (const prompt of fakes.received("builder").slice(-2)) {
          expect(prompt.text).toContain("Revisit the shared release before trying again");
          expect(prompt.text).not.toContain("1.0.1");
        }
        expect(shop.github().releases).toHaveLength(1);
        expect(api.github().releases).toHaveLength(1);
      } else {
        engine.approve(decisionItem.id);
        const again = await until(engine, (state) => taskOf(state, id).state === "done" || !!taskOf(state, id).error || !!itemOf(state, id, "delivery"), coordinator([]));
        expect(taskOf(again, id).error).toBeUndefined();
        expect(taskOf(again, id).state).toBe("done");
        expect(shop.github().releases).toHaveLength(2);
        expect(api.github().releases).toHaveLength(2);
      }
    } finally { await engine.shutdown(); }
  });

  for (const decision of ["retry", "send-back"] as const) it(`keeps shared approval and offers ${decision} when release-version checks fail`, async () => {
    const { shop, api, start, fakes } = await setup(`release-version-failure-${decision}`);
    const allow = join(api.dir, "allow-release");
    writeFileSync(join(api.clone, "package.json"), JSON.stringify({ name: "api", version: "1.0.0" }));
    writeFileSync(join(api.clone, "version-check.cjs"), `if (require('./package.json').version !== '1.0.0' && !require('node:fs').existsSync(${JSON.stringify(allow)})) process.exit(1);`);
    await git(api.clone, "add", "."); await git(api.clone, "commit", "-qm", "Record the version"); await git(api.clone, "push", "-q", api.remote, "main");
    await git(api.remote, "update-ref", "refs/tags/v1.0.0", await git(api.clone, "rev-parse", "HEAD"));
    api.setGitHub((state) => state.releases.push({ tagName: "v1.0.0", url: "https://github.com/acme/api/releases/tag/v1.0.0", publishedAt: "2025-01-01T00:00:00Z", isDraft: false, name: "v1.0.0", body: "Previous release" }));
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      engine.setProductChecks(second, [{ name: "Release version", command: `${process.execPath} version-check.cjs` }]);
      const id = engine.addTask({ productId: first, worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: second, startFrom: { kind: "default" }, delivery: "release" }], title: "Check release preparation" });
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery"), coordinator(["plan", "design"]));
      engine.approve(itemOf(ready, id, "delivery")!.id);
      const approval = engine.task(id)!.repositories!.map((work) => ({ sha: work.approvedSha, patch: work.approvedPatch, destination: { ...work.approvedFor! } }));
      const waiting = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error || taskOf(state, id).state === "pr-open", coordinator([]));
      const failed = taskOf(waiting, id);
      expect(failed.error).toBeUndefined();
      expect(failed.state).toBe("needs-you");
      expect(itemOf(waiting, id, "stuck")).toBeUndefined();
      expect(itemOf(waiting, id, "delivery")!.body).toContain("API: getting the release ready failed");
      expect(itemOf(waiting, id, "delivery")!.body).toContain("send it back with a note");
      expect(failed.repositories!.map((work) => ({ sha: work.approvedSha, patch: work.approvedPatch, destination: { ...work.approvedFor! } }))).toEqual(approval);
      expect(failed.plan!.stages[failed.stageIndex]!.gate).toBe("delivery");
      for (const work of failed.repositories!) {
        expect(work.shipping?.prepared).toBeUndefined();
        expect(await git(work.worktree!, "rev-parse", "HEAD")).toBe(work.approvedSha!);
      }
      expect(JSON.parse(await git(failed.repositories![1]!.worktree!, "show", "HEAD:package.json")).version).toBe("1.0.0");
      expect(failed.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking")).toEqual([]);
      expect(failed.repositories![1]!.checks!.results.every((run) => run.ok)).toBe(true);
      expect(fakes.received("builder")).toHaveLength(2);
      expect(shop.github().prs).toHaveLength(0); expect(api.github().releases).toHaveLength(1);
      await engine.shutdown(); engine = start();
      expect(engine.task(id)!.repositories!.map((work) => work.approvedSha)).toEqual(approval.map((work) => work.sha));
      const decisionItem = itemOf(engine.getState(), id, "delivery")!;
      expect(decisionItem.body).toContain("API: getting the release ready failed");
      writeFileSync(allow, "Release preparation is ready");
      if (decision === "send-back") {
        engine.requestChanges(decisionItem.id, "Reconsider the shared greeting before release");
        const revised = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator([]));
        expect(taskOf(revised, id).error).toBeUndefined();
        expect(fakes.received("builder")).toHaveLength(4);
        const repairs = fakes.received("builder").slice(2);
        for (const repair of repairs) {
          expect(repair.text).toContain("Reconsider the shared greeting before release");
          expect(repair.text).not.toContain("Check failed: Release version");
        }
        for (const work of taskOf(revised, id).repositories!) expect(work.checks!.results.every((run) => run.ok)).toBe(true);
        expect(shop.github().prs).toHaveLength(0); expect(api.github().releases).toHaveLength(1);
        engine.approve(itemOf(revised, id, "delivery")!.id);
      } else engine.approve(decisionItem.id);
      const done = taskOf(await until(engine, (state) => taskOf(state, id).state === "pr-open" || !!taskOf(state, id).error || !!itemOf(state, id, "delivery"), coordinator([])), id);
      expect(done.error).toBeUndefined();
      expect(done.state).toBe("pr-open");
      expect(shop.github().prs).toHaveLength(1); expect(api.github().releases).toHaveLength(2);
      expect(fakes.received("builder")).toHaveLength(decision === "send-back" ? 4 : 2);
    } finally { await engine.shutdown(); }
  });

  for (const peerOnly of [false, true]) it(`checks and routes deleted tests in ${peerOnly ? "only the other review snapshot" : "every changed review snapshot"} on hand-back`, async () => {
    const { shop, api, start, fakes } = await setup(`hand-back-${peerOnly}`);
    for (const world of [shop, api]) {
      mkdirSync(join(world.clone, "test"));
      writeFileSync(join(world.clone, "test", "greeting.test.ts"), 'import { test, expect } from "bun:test"; test("greeting", () => expect(true).toBe(true));\n');
      await git(world.clone, "add", "."); await git(world.clone, "commit", "-qm", "Keep the greeting test"); await git(world.clone, "push", "-q", world.remote, "main");
    }
    // Copying the launch command never starts a terminal or app.
    const engine = start({ toolPath: () => process.execPath });
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      fakes.scenario({ planner: "short", builder: "plain", screenRoles: ["code reviewer"], screenRoleHold: true, reopen: "resume" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Preserve hand-back ownership" });
      // Screen requests are scripted stand-ins: this exercises saved review conversations without a window.
      await until(engine, (state) => !!taskOf(state, id).screen && !engine.drivers.has(id), coordinator(["plan", "design"]));
      const session = engine.taskDetails(id)!.conversation!.sessionId;
      engine.allowScreen(id);
      await until(engine, () => fakes.marked(`on-screen-${session}`), coordinator([]));
      await engine.takeOver(id, "copy");
      const task = engine.task(id)!;
      const active = task.productId;
      const changed = peerOnly ? [first, second].filter((id) => id !== active) : [first, second];
      const untouched = task.repositories!.find((work) => !changed.includes(work.productId));
      const original = untouched && await git(untouched.worktree!, "rev-parse", "HEAD");
      for (const productId of changed) {
        const snapshot = task.driving!.repositoryCopies![productId]!.path;
        await git(snapshot, "rm", "test/greeting.test.ts");
        await git(snapshot, "commit", "-qm", "Coordinator removes a test");
      }
      engine.setPoolPaused(true);
      // Inspect the saved hand-back before the resumed review can move the active product again.
      engine.startDriver = () => {};
      await engine.handBack(id, "Keep every product's changes", true);
      expect(task.productId).toBe(active);
      const findings = task.findings.filter((finding) => finding.raisedBy === "petrina" && finding.severity === "blocking" && finding.status === "open");
      expect(findings).toHaveLength(changed.length);
      expect(findings.flatMap((finding) => finding.productIds ?? []).sort()).toEqual([...changed].sort());
      for (const work of task.repositories!) {
        if (changed.includes(work.productId)) {
          expect(work.tamper?.problems.length).toBe(1);
          expect(existsSync(join(work.worktree!, "test/greeting.test.ts"))).toBe(false);
          expect(work.checks?.current).toBe(false);
        } else expect(await git(work.worktree!, "rev-parse", "HEAD")).toBe(original!);
      }
      // Routing selects exactly the affected saved builders, even when the driven product was untouched.
      expect(beginRepair(engine, task, "review", task.stageIndex)).toBe(true);
      expect(task.repair!.products).toEqual(peerOnly ? changed : [first, second]);
    } finally { await engine.shutdown(); }
  });
});
