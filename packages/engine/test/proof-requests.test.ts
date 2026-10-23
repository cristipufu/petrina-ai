import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, beginPetrinaStep, endAgentStep, proofContext, proofDecision, proofGap, refreshProofs, sameVersions, type DeepMutable, type JourneyStep, type ProofRequest, type Product } from "@petrina/core";
import { Engine } from "./engine.js";
import { Fakes, git, makeProduct, removeDir, tempDir } from "./fixtures.js";
import { executionFor, scopesFor } from "../src/repository-context.js";
import { changesOf, versionsOf } from "../src/repositories.js";
import { checkProofRequests, recordReviewProofs } from "../src/proof-requests.js";
import { ReviewResult } from "../src/roles.js";
import { commandText } from "../src/checks.js";
import { Store } from "../src/store.js";
import * as gitSteps from "../src/git.js";
import { stepKey } from "../src/kernel.js";
import { expectRejection } from "./rejections.js";
import { MAY_CHANGE } from "../src/prompts.js";
import { checkpointView } from "../src/checkpoint-read.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const signal = () => new AbortController().signal;

async function fixture(shared = false, brief = false, fakes?: Fakes) {
  const root = tempDir("petrina-proof-requests-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => fakes ? [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] : undefined, terminals: () => [] });
  engine.schedule = () => {};
  await engine.waitUntilReady();
  engine.setPoolPaused(false);
  const products: DeepMutable<Product>[] = [];
  for (let i = 0; i < (shared ? 2 : 1); i++) {
    const dir = join(root, `product-${i}`); mkdirSync(dir);
    const repo = await makeProduct(dir); await git(repo, "remote", "remove", "origin");
    const id = await engine.addProduct(repo);
    engine.updateProduct(id, { name: `Product ${i + 1}`, delivery: "local", approveDelivery: true });
    engine.setProductChecks(id, [{ name: "Test", command: commandText([process.execPath, "-e", "process.exit(0)"]) }]);
    products.push(engine.s.products.find(product => product.id === id)!);
  }
  const task = engine.task(engine.addTask({ productId: products[0]!.id, title: "Keep required Linux proof current", backlog: true }))!;
  const owner = async (product: DeepMutable<Product>, i: number) => {
    const worktree = join(root, `work-${i}`), baseSha = await git(product.path!, "rev-parse", "HEAD"), branch = `proof-${i}`;
    await git(product.path!, "worktree", "add", "-q", "-b", branch, worktree, baseSha);
    writeFileSync(join(worktree, "feature.txt"), "the task's change\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Add the feature");
    return { productId: product.id, worktree, baseSha, base: baseSha, branch, delivery: "local" as const, completedStages: ["build"], preparation: "ready" as const,
      source: { product, start: { kind: "default" as const, branch: "main" }, destination: { mode: "local" as const, kind: "branch" as const, repo: product.repo, branch: "main" }, confirmed: true } };
  };
  const owners: Awaited<ReturnType<typeof owner>>[] = [];
  for (const [i, product] of products.entries()) owners.push(await owner(product, i));
  if (shared) { delete task.repository; task.repositories = owners; task.activeProductId = products[0]!.id; }
  else task.repository = owners[0];
  const build = { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
  const tester = { id: "test", title: "Acceptance", kind: "do" as const, roleId: "tester", profileIds: ["opus-high"] };
  const review = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 };
  const gate = { id: "gate", title: "Delivery", kind: "gate" as const, gate: "delivery" as const, roleId: "coordinator", profileIds: [] };
  const ship = { id: "ship", title: "Ship", kind: "do" as const, roleId: "release-manager", profileIds: ["opus-high"] };
  task.plan = { rationale: "Focused acceptance workflow", plannerProfileId: "sol-high", stages: [build, tester, review, gate, ship] };
  if (brief) task.brief = { summary: "Try it", areas: [], forUsers: [], risks: [], acceptance: [{ text: "Linux recovery works" }] };
  task.state = "running"; task.stageIndex = 3; task.risk = { level: "low", why: "Only copy" };
  const scope = executionFor(task);
  let sequence = 0;
  const advance = async (index = 0) => {
    const product = products[index]!;
    writeFileSync(join(product.path!, `incoming-${++sequence}.txt`), `main ${sequence}\n`);
    await git(product.path!, "add", "."); await git(product.path!, "commit", "-q", "-m", "Main advances");
  };
  const request = async (text = "Run Linux recovery", ids = products.map(product => product.id)): Promise<DeepMutable<ProofRequest>> => {
    const reviewedVersions: Record<string, string> = {};
    for (const owner of owners) reviewedVersions[owner.productId] = await git(owner.worktree, "rev-parse", "HEAD^{tree}");
    const item: DeepMutable<ProofRequest> = { id: `proof-${(task.proofRequests?.length ?? 0) + 1}`, text, reason: "Required on final code", productIds: ids, source: `source-${task.proofRequests?.length ?? 0}`, requestedBy: { stageId: review.id, round: 1, seat: "0", roleId: "code-reviewer", profileId: "sol-high" }, ownerStageId: tester.id, reviewedVersions, status: "pending" };
    task.proofRequests ??= []; task.proofRequests.push(item); return item;
  };
  const recordPass = async (requests = task.proofRequests ?? []) => {
    const versions = await versionsOf(task);
    const node: DeepMutable<JourneyStep> = { id: `saved-test-${task.journey?.length ?? 0}`, kind: "agent", stageId: tester.id, roleId: "tester", profileId: "opus-high", round: 1, sub: 0, startedAt: 10, endedAt: 20, end: "done", proofChecks: requests.map(item => ({ id: item.id, result: "pass", evidence: "Private Ubuntu capacity and nearby recovery passed" })), acceptanceChecks: [{ text: "Linux recovery works", result: "pass", evidence: "Private Ubuntu recovery passed" }], agentResults: [{ roleId: "tester", profileId: "opus-high", at: 20, value: {}, versions }] };
    task.journey ??= []; task.journey.push(node);
    for (const item of requests) item.proof = { stepId: node.id, versions, result: "pass", evidence: "Private Ubuntu recovery passed" };
    refreshProofs(task, versions);
    task.testedVersions = versions; task.testedChanges = await changesOf(task);
    task.testedPatch = await engine["checks"].acceptanceVersion(scope, versions);
    task.acceptancePassed = true;
    return node;
  };
  const drive = async () => {
    const admit = spyOn(engine["driver"] as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockResolvedValue(true);
    try { task.state = "running"; await engine["driver"]["drive"](task.id); if (engine.task(task.id)?.state === "failed") throw new Error(task.error); }
    finally { admit.mockRestore(); }
  };
  return { root, engine, task, scope, owners, products, build, tester, review, gate, ship, advance, request, recordPass, drive };
}

/** Controls result handling and external code changes; replaces the turn, including its edit cleanup.
 * Use the real turn with Fakes when testing an agent's permissions or changes. */
function testerReply(f: Awaited<ReturnType<typeof fixture>>, answers: (ids: readonly string[]) => unknown[], before?: () => void | Promise<void>, checklist?: unknown[]) {
  return spyOn(f.engine["turns"], "turn").mockImplementation(async (scope, roleId, profileId, _given, schema, _signal, options) => {
    expect(roleId).toBe("tester");
    before && await before();
    const value = schema.parse({ summary: "Tried required proof", checks: checklist ?? (f.task.brief ? [{ text: "Linux recovery works", result: "pass", evidence: "Recovery worked" }] : []), proofAnswers: answers(f.task.acceptanceRun!.requestIds) });
    const error = await options?.check?.(value);
    expect(error).toBeUndefined();
    options?.used?.(profileId);
    const node = beginAgentStep(scope.task, roleId, profileId, Date.now(), f.engine.s.roles, undefined, scope.work);
    node.proofRun = structuredClone(scope.task.acceptanceRun);
    node.agentResults = [{ roleId, profileId, at: Date.now(), value }];
    return value;
  });
}
const passes = (ids: readonly string[]) => ids.map(id => ({ id, result: "pass" as const, evidence: "Ubuntu capacity 30/30 and recovery 71/71 passed on this prepared copy" }));

for (const proof of [false, true]) for (const committed of [false, true]) it(`finishes final acceptance once despite an editing role's ${committed ? "commit" : "uncommitted write"}, with requested proof ${proof}`, async () => {
  const fakeRoot = tempDir("petrina-proof-read-only-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const role = { ...f.engine.role("tester")!, id: "acceptance-specialist", canEdit: true };
    f.engine.s.roles.push(role); f.tester.roleId = role.id;
    const request = proof ? await f.request() : undefined;
    const worktree = f.scope.work.worktree!;
    if (committed) {
      // The stand-in commits on every subsequent run, so a lost read-only boundary would repeat.
      writeFileSync(join(fakeRoot, "tester-passed-once"), "");
      writeFileSync(join(worktree, "tester-edit.txt"), "Before the review\n");
      await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Keep the permitted earlier edit");
    }
    const earlier = await f.recordPass();
    earlier.roleId = role.id; earlier.agentResults![0]!.roleId = role.id;
    writeFileSync(join(worktree, "feature.txt"), "The builder's final change\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Prepare the reviewed final change");
    const versions = await versionsOf(f.task);
    fakes.scenario({ tester: "writes", ...(request ? { testerProofAnswers: passes([request.id]) } : {}) });

    // Keep the actual turn, access restriction and cleanup: only the external coding tool is a stand-in.
    await f.drive();

    expect(fakes.openings("tester")).toHaveLength(1);
    expect(fakes.openings("tester")[0]).toContain(MAY_CHANGE.afterReview);
    expect(f.task.stageIndex).toBe(3); expect(f.engine.s.inbox.find(item => item.kind === "delivery")).toBeDefined();
    expect(f.task.journey!.filter(step => step.kind === "agent" && step.roleId === role.id)).toHaveLength(2);
    expect(f.task.acceptancePassed).toBe(true); expect(f.task.acceptanceBlocked).toBeUndefined();
    expect(f.task.acceptanceUnverified).toBe(false); expect(f.task.testedVersions).toEqual(versions);
    expect(await versionsOf(f.task)).toEqual(versions);
    expect(await git(worktree, "log", "--format=%s")).not.toContain("Tester commits after the review");
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    if (committed) {
      expect(readFileSync(join(worktree, "tester-edit.txt"), "utf8")).toBe("Before the review\n");
      expect(f.task.timeline.some(entry => entry.text === "Undid commits from Tester, which is read-only")).toBe(true);
    } else {
      expect(existsSync(join(worktree, "tester-edit.txt"))).toBe(false);
      expect(f.task.timeline.some(entry => entry.text === "Undid changes from Tester, which is read-only")).toBe(true);
    }
    if (request) { expect(request.status).toBe("proved"); expect(request.proof!.versions).toEqual(versions); }
    expect(f.task.findings).toEqual([]); expect(f.task.rounds.review).toBeUndefined();
    expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.task.proofRefreshes).toBeUndefined(); expect(f.engine.role(role.id)!.canEdit).toBe(true);
  } finally { await f.engine.shutdown(); }
});

it("validates structured requests, deduplicates replay by seat position and reuses only readable exact Tester evidence", async () => {
  const f = await fixture(false, true);
  try {
    const { engine, task, review } = f;
    task.hunt = { stageId: review.id, round: 1, reported: {}, findings: 0, input: { file: "unused", digest: "unused", heads: {}, trees: await versionsOf(task) } };
    const item = { text: "Run Linux recovery", reason: "Final Linux proof is required", productIds: [task.productId], checklistText: "Linux recovery works" };
    expect(checkProofRequests(engine, task, [item])).toBeUndefined();
    for (const changed of [{ productIds: [] }, { productIds: ["wrong"] }, { checklistText: "Different wording" }]) expect(checkProofRequests(engine, task, [{ ...item, ...changed }])).toBeDefined();
    expect(ReviewResult.safeParse({ verdict: "pass", proofRequests: [{ ...item, reason: "" }] }).success).toBe(false);
    expect(ReviewResult.safeParse({ verdict: "pass", proofRequests: [{ ...item, text: "" }] }).success).toBe(false);
    await f.recordPass([]);
    recordReviewProofs(engine, task, review, [item], "sol-high", "code-reviewer", "0");
    expect(task.proofRequests).toHaveLength(1); expect(task.proofRequests![0]!.status).toBe("already-current");
    recordReviewProofs(engine, task, review, [item], "sol-high", "code-reviewer", "0");
    expect(task.proofRequests).toHaveLength(1);
    recordReviewProofs(engine, task, review, [item], "opus-high", "security-reviewer", "1");
    expect(task.proofRequests).toHaveLength(2);
    task.journey = [];
    refreshProofs(task, await versionsOf(task));
    expect(task.proofRequests!.map(item => item.status)).toEqual(["stale", "stale"]);
    task.plan!.stages = task.plan!.stages.filter(stage => stage.id !== "test");
    expect(checkProofRequests(engine, task, [item])).toContain("no acceptance testing step");
  } finally { await f.engine.shutdown(); }
});

for (const brief of [false, true]) it(`forces exact-version proof after unchanged-patch main advances, with brief ${brief}, then bounds main-only reruns across restart`, async () => {
  const f = await fixture(false, brief);
  const reply = testerReply(f, passes);
  try {
    const request = await f.request(); await f.recordPass(); const oldPatch = f.task.testedPatch;
    await f.advance();
    await f.drive();
    expect(reply).toHaveBeenCalledTimes(1); expect(f.task.proofRefreshes).toBe(1);
    expect(request.status).toBe("proved"); expect(f.task.testedPatch).toBe(oldPatch);
    expect(f.task.testedVersions).toEqual(await versionsOf(f.task));
    const node = f.task.journey!.find(step => step.id === request.proof!.stepId)!;
    expect(node.acceptancePatch).toBe(oldPatch);
    const inspect = async () => {
      const checkpoint = await checkpointView(f.engine, f.engine.taskDetails(f.task.id)!, f.engine.s.inbox.find(item => item.kind === "delivery")!);
      if (!("proofRequests" in checkpoint)) throw new Error("Expected a delivery check with proof requests");
      return checkpoint;
    };
    let checkpoint = await inspect();
    expect(checkpoint.proofRequests).toEqual(f.task.proofRequests!);
    expect(checkpoint.proofRequests![0]!.status).toBe("proved");
    const evidence = checkpoint.acceptance!.evidence;
    if (!("nodeId" in evidence) || !("report" in evidence)) throw new Error("Expected the recorded acceptance report");
    expect(evidence.nodeId).toBe(node.id);
    expect(evidence.report).toMatchObject({ operation: "journey.result", nodeId: node.id });
    expect(checkpoint.acceptance!.evidence.products[0]!.state).toBe("same-contents");
    expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.task.rounds.review).toBeUndefined(); expect(f.task.stageIndex).toBe(3);
    f.engine.s.inbox = []; await f.advance(); await f.drive();
    expect(reply).toHaveBeenCalledTimes(2); expect(f.task.proofRefreshes).toBe(2);
    expect(f.task.timeline.some(line => line.text === "Final acceptance testing: main moved since the proof was recorded")).toBe(true);
    f.engine.s.inbox = []; await f.advance(); await f.drive();
    expect(reply).toHaveBeenCalledTimes(2); expect(request.status).toBe("stale");
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("earlier version");
    checkpoint = await inspect();
    expect(checkpoint.proofRequests![0]!.status).toBe("stale");
    expect(checkpoint.proofRefreshes).toBe(2);
    expect(checkpoint.acceptance!.evidence.products[0]!.state).toBe("same-change");
    const id = f.task.id; f.engine.setPoolPaused(true); await f.engine.shutdown();
    const restored = new Engine(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] }); restored.schedule = () => {};
    try { expect(restored.task(id)!.proofRefreshes).toBe(2); expect(restored.task(id)!.proofRequests![0]!.status).toBe("stale"); }
    finally { await restored.shutdown(); }
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

for (const refreshes of [0, 1]) it(`refreshes proof after main moves during final testing, with ${2 - refreshes} main refreshes available`, async () => {
  const f = await fixture(); const request = await f.request(); await f.recordPass(); f.task.proofRefreshes = refreshes;
  let runs = 0;
  const reply = testerReply(f, passes, async () => {
    if (++runs === 1) { await f.advance(); await f.engine["updates"].upToDate(f.scope, signal()); }
  });
  try {
    await f.advance(); await f.drive();
    expect(reply).toHaveBeenCalledTimes(2 - refreshes); expect(f.task.proofRefreshes).toBe(2);
    expect(request.proof!.result).toBe("pass"); expect(f.task.acceptanceUnverified).toBe(false);
    expect(f.task.acceptanceBlocked).toBeUndefined(); expect(f.task.findings).toEqual([]);
    expect(request.status).toBe(refreshes ? "stale" : "proved");
    expect(f.task.proofRefreshBlocked).toBe(!!refreshes);
    expect(f.task.stageIndex).toBe(3);
    f.engine.s.inbox = []; await f.drive(); expect(reply).toHaveBeenCalledTimes(2 - refreshes);
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("passes proof-only review without votes or Builder work, freezes peer context and tests once after both main advances", async () => {
  const f = await fixture(); const reply = testerReply(f, passes);
  try {
    await f.recordPass([]); await f.advance(); await f.engine["updates"].upToDate(f.scope, signal());
    const snapshot = await f.engine["context"].captureReview(f.scope);
    f.task.hunt = { stageId: "review", round: 1, reported: { "0": true }, findings: 0, input: { file: "unused", digest: "unused", heads: {}, trees: await versionsOf(f.task) } };
    const value = ReviewResult.parse({ verdict: "pass", proofRequests: [{ text: "Required Ubuntu proof", reason: "Linux must cover the final code", productIds: [f.task.productId] }] });
    recordReviewProofs(f.engine, f.task, f.review, value.proofRequests, "sol-high", "code-reviewer", "0");
    const peer = await f.engine["context"].sectionsFor(f.scope, "security-reviewer", undefined, undefined, undefined, snapshot);
    expect(peer.find(section => section.title === "Proof requests for final acceptance testing")!.body).not.toContain("Required Ubuntu proof");
    f.task.stageIndex = 2;
    beginAgentStep(f.task, "code-reviewer", "sol-high", 1, f.engine.s.roles, undefined, f.scope.work);
    expect(f.engine["reviews"]["pendingVote"](f.task, f.review)).toBeUndefined();
    await f.engine["reviews"]["closeReviewRound"](f.task, f.review, 1, "Nothing to fix", await versionsOf(f.task));
    expect(f.task.stageIndex).toBe(3); expect(f.task.fixing).toBe(false); expect(f.task.findings).toEqual([]);
    expect(f.task.journey!.at(-1)!.reason).toContain("review passed; 1 proof request");
    await f.advance(); await f.drive();
    expect(reply).toHaveBeenCalledTimes(1); expect(f.task.proofRequests![0]!.status).toBe("proved");
    expect(f.task.journey!.filter(step => step.roleId === "builder")).toHaveLength(0);
    expect(f.task.rounds.review).toBeUndefined();
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("keeps ordinary unchanged-patch reuse and already-current proof without an additional Tester", async () => {
  const f = await fixture(); const reply = testerReply(f, passes);
  try {
    await f.recordPass([]); await f.advance(); await f.drive(); expect(reply).not.toHaveBeenCalled();
    f.engine.s.inbox = []; await f.request(); await f.recordPass(); await f.drive(); expect(reply).not.toHaveBeenCalled();
    expect(f.task.proofRequests![0]!.status).toBe("proved");
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("keeps unavailable platform proof unverified, never auto-ships and never retries unchanged", async () => {
  const f = await fixture(); const reply = testerReply(f, ids => ids.map(id => ({ id, result: "blocked", reason: "Ubuntu runner unavailable" })));
  try {
    await f.request(); f.products[0]!.shipLowRisk = true;
    await f.drive(); expect(reply).toHaveBeenCalledTimes(1);
    expect(f.task.proofRequests![0]!.status).toBe("unverified"); expect(f.task.findings).toEqual([]);
    expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.task.stageIndex).toBe(3);
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("could not be verified");
    f.engine.s.inbox = []; await f.drive(); expect(reply).toHaveBeenCalledTimes(1);
    expect(f.task.approvedProofDecision).toBeUndefined();
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("routes reproduced proof failures by request id even with identical text and an unavailable peer", async () => {
  const f = await fixture(true); const a = await f.request("Same wording", [f.products[0]!.id]); const b = await f.request("Same wording", [f.products[1]!.id]); const c = await f.request("Unavailable platform");
  const reply = testerReply(f, ids => ids.map(id => ({ id, result: id === a.id ? "fail" : id === b.id ? "pass" : "blocked", evidence: id === c.id ? undefined : "The failing scenario reproduced; the passing control worked", reason: id === c.id ? "Runner unavailable" : undefined })));
  try {
    f.task.retest = true; f.task.stageIndex = 1;
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(f.task.stageIndex).toBe(0); expect(f.task.repair?.products).toEqual([f.products[0]!.id]);
    expect(scopesFor(f.task).map(({ work }) => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.task.findings).toHaveLength(1); expect(f.task.findings[0]!.proofRequestId).toBe(a.id); expect(f.task.findings[0]!.status).toBe("open");
    expect(b.status).toBe("proved"); expect(c.status).toBe("unverified");
    // The completed Builder/reviewer repair rejoins final preparation; the failed request must be tried again.
    delete f.task.repair; f.task.fixing = false; f.task.stageIndex = 3;
    const stop = spyOn(f.engine["work"], "runDo").mockImplementation(async () => { f.task.state = "paused"; return "stop"; });
    await f.drive();
    expect(stop).toHaveBeenCalled(); expect(f.task.retest).toBe(true);
    stop.mockRestore();
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("never starts a Tester while configured checks fail and preserves the existing Builder return", async () => {
  const f = await fixture(); const reply = testerReply(f, passes);
  try {
    await f.request(); f.engine.setProductChecks(f.task.productId, [{ name: "Tests", command: commandText([process.execPath, "-e", "console.error('reproduced check failure');process.exit(1)"]) }]);
    const admit = spyOn(f.engine["driver"] as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockResolvedValue(false);
    await f.engine["driver"]["drive"](f.task.id); admit.mockRestore();
    expect(reply).not.toHaveBeenCalled(); expect(f.task.stageIndex).toBe(0); expect(f.scope.work.checkReturns).toBe(1);
    expect(f.task.findings[0]!.raisedBy).toBe("petrina"); expect(f.task.proofRequests![0]!.status).toBe("pending");
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("keeps real and mixed code findings on their normal review repair route", async () => {
  for (const mixed of [false, true]) {
    const f = await fixture();
    try {
      if (mixed) await f.request();
      f.task.stageIndex = 2;
      f.task.findings.push({ id: "defect", text: "Current recovery loses the saved message", severity: "blocking", raisedBy: "sol-high", confirmedBy: ["opus-high"], status: "open" });
      beginAgentStep(f.task, "code-reviewer", "sol-high", 1, f.engine.s.roles, undefined, f.scope.work);
      await f.engine["reviews"]["closeReviewRound"](f.task, f.review, 1, "One Important finding");
      expect(f.task.stageIndex).toBe(0); expect(f.task.fixing).toBe(true); expect(f.task.rounds.review).toBe(2);
      expect(f.task.findings[0]!.status).toBe("open");
      if (mixed) { expect(f.task.proofRequests![0]!.status).toBe("pending"); expect(proofContext(f.task.proofRequests!)).toContain("final acceptance"); }
    } finally { await f.engine.shutdown(); }
  }
});

it("retains one interrupted Tester run across restart and binds a stand-in's proof to its actual completed step", async () => {
  const f = await fixture(); await f.request();
  f.task.retest = true; f.task.proofRefreshes = 1; f.task.stageIndex = 1;
  const first = spyOn(f.engine["turns"], "turn").mockImplementation(async () => {
    beginAgentStep(f.task, "tester", "opus-high", 1, f.engine.s.roles, undefined, f.scope.work);
    f.task.state = "paused";
    throw new Error("controlled interruption before acceptance result");
  });
  try {
    try { await f.engine["work"].runDo(f.scope, f.tester, signal()); throw new Error("Expected interruption"); }
    catch (error) { expect(String(error)).toContain("controlled interruption"); }
    expect(f.task.proofRequests![0]!.proof).toBeUndefined(); expect(f.task.acceptanceRun!.requestIds).toHaveLength(1);
    const run = structuredClone(f.task.acceptanceRun);
    f.engine.setPoolPaused(true); await f.engine.shutdown(); first.mockRestore();
    f.engine = new Engine(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    expect(f.task.acceptanceRun).toEqual(run); expect(f.task.proofRefreshes).toBe(1);
    const resumed = spyOn(f.engine["turns"], "turn").mockImplementation(async (scope, roleId, _profileId, _given, schema, _signal, options) => {
      endAgentStep(scope.task, { outcome: "Tester handed over", reason: "Another tool continues" }, 2);
      options?.used?.("sol-high");
      const step = beginAgentStep(scope.task, roleId, "sol-high", 3, f.engine.s.roles, undefined, scope.work);
      const value = schema.parse({ summary: "The stand-in verified it", proofAnswers: passes(scope.task.acceptanceRun!.requestIds) });
      step.agentResults = [{ roleId, profileId: "sol-high", at: 4, value }];
      return value;
    });
    await f.engine["work"].runDo(f.scope, f.tester, signal()); resumed.mockRestore();
    const request = f.task.proofRequests![0]!;
    expect(request.status).toBe("proved"); expect(request.proof!.stepId).toBe(f.task.journey!.at(-1)!.id);
    expect(f.task.journey!.at(-1)!.profileId).toBe("sol-high"); expect(f.task.proofRefreshes).toBe(1);
    expect(f.task.acceptanceRun).toBeUndefined();
  } finally { first.mockRestore(); await f.engine.shutdown(); }
});

it("repairs missing or duplicate proof answers in the same Tester turn and never trusts evidence-free passes", async () => {
  const f = await fixture(); await f.request(); f.task.retest = true; f.task.stageIndex = 1;
  const turn = spyOn(f.engine["turns"], "turn").mockImplementation(async (scope, roleId, profileId, _given, schema, _signal, options) => {
    const missing = schema.parse({ summary: "Incomplete answer" });
    expect(await options?.check?.(missing)).toContain("exactly once by id");
    const id = scope.task.acceptanceRun!.requestIds[0]!;
    expect(await options?.check?.(schema.parse({ summary: "Duplicate answer", proofAnswers: [...passes([id]), ...passes([id])] }))).toContain("exactly once");
    const value = schema.parse({ summary: "No receipt was obtained", proofAnswers: [{ id, result: "pass" }] });
    expect(await options?.check?.(value)).toBeUndefined();
    const node = beginAgentStep(scope.task, roleId, profileId, 1, f.engine.s.roles, undefined, scope.work);
    node.agentResults = [{ roleId, profileId, at: 2, value }]; return value;
  });
  try {
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(turn).toHaveBeenCalledTimes(1); expect(f.task.proofRequests![0]!.status).toBe("unverified");
    expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined();
  } finally { turn.mockRestore(); await f.engine.shutdown(); }
});

it("requires every affected shared product version and bounds main-only shared refreshes", async () => {
  const f = await fixture(true); const request = await f.request(); const reply = testerReply(f, passes);
  try {
    await f.recordPass();
    for (let i = 0; i < 3; i++) {
      f.engine.s.inbox = []; await f.advance(i % 2); await f.drive();
      expect(f.task.stageIndex).toBe(3);
    }
    expect(reply).toHaveBeenCalledTimes(2); expect(f.task.proofRefreshes).toBe(2); expect(request.status).toBe("stale");
    expect(sameVersions(request.proof!.versions, await versionsOf(f.task), request.productIds)).toBe(false);
    expect(f.task.repair).toBeUndefined(); expect(f.task.findings).toEqual([]);
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("binds an explicit decision about A's proof on version B to B, blocks publishing C, and keeps the refresh limit after restart", async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  try {
    f.task.proofRefreshes = 2; await f.advance(); await f.drive();
    const viewed = structuredClone(f.task.checkedProofDecision)!;
    expect(Object.values(viewed.statuses)).toEqual(["stale"]);
    f.engine.approve(f.engine.s.inbox.find(item => item.kind === "delivery")!.id);
    expect(f.task.approvedProofDecision).toEqual(viewed); expect(f.task.stageIndex).toBe(4);
    f.engine.setPoolPaused(true); await f.engine.shutdown();
    const saved = new Store(join(f.engine.dataDir, "petrina.db")); expect(saved.load()!.tasks.find(task => task.id === f.task.id)!.approvedProofDecision).toEqual(viewed); saved.close();
    f.engine = new Engine(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    f.engine.setPoolPaused(false); await f.advance();
    const destinationBefore = await git(f.products[0]!.path!, "rev-parse", "main");
    expect(await f.engine["shipping"]["readyToShip"](f.scope, signal())).toBe("back");
    expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined(); expect(f.task.proofRefreshes).toBe(2);
    expect(await git(f.products[0]!.path!, "rev-parse", "main")).toBe(destinationBefore);
    f.task.state = "running"; await f.engine["driver"]["drive"](f.task.id); expect(f.task.proofRefreshes).toBe(2); expect(f.task.checkedProofDecision).not.toEqual(viewed);
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("earlier version");
    f.engine.requestChanges(f.engine.s.inbox.find(item => item.kind === "delivery")!.id, "Obtain the required proof after the next fix");
    expect(f.task.proofRefreshes).toBeUndefined();
  } finally { await f.engine.shutdown(); }
});

it("checks a saved prepared delivery again after main moves and retains the publishing return reason", async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  try {
    const versions = await versionsOf(f.task); f.task.approvedProofDecision = proofDecision(f.task, versions);
    f.scope.work.shipping = { moves: 0, failures: 0, base: f.scope.work.baseSha, start: await git(f.scope.work.worktree!, "rev-parse", "HEAD"), prepared: { tested: await git(f.scope.work.worktree!, "rev-parse", "HEAD"), summary: "Prepared" } };
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(true);
    await f.advance();
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(false);
    await f.engine["shipping"]["prepareAgain"](f.scope, "Main moved during publishing");
    expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined();
    expect(f.task.timeline.at(-1)!.text).toContain("Nothing more was published");
  } finally { await f.engine.shutdown(); }
});

it("requires explicit release-gap approval and permits only Petrina's verified version commit, including the pushed restart and shared continuation", async () => {
  const f = await fixture(true); await f.request(); await f.recordPass();
  try {
    const release = f.task.repositories![0]!; release.delivery = "release";
    writeFileSync(join(release.worktree!, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" })); await git(release.worktree!, "add", "."); await git(release.worktree!, "commit", "-q", "-m", "Declare the fixture version");
    await f.recordPass();
    f.task.checkedProofDecision = proofDecision(f.task, await versionsOf(f.task));
    expect(proofGap(f.task)).toContain("release version"); expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    f.engine.gate(f.task, "delivery"); f.engine.approve(f.engine.s.inbox.find(item => item.kind === "delivery")!.id);
    const start = await git(release.worktree!, "rev-parse", "HEAD");
    release.shipping = { moves: 0, failures: 0, base: release.baseSha, start, version: "0.2.0", tag: "v0.2.0" };
    const releaseScope = executionFor(f.task, release.productId);
    const versions = await f.engine["shipping"].releases["declaredVersions"](release.worktree!, start);
    const tested = await f.engine["shipping"].releases.setVersion(releaseScope, versions);
    expect(tested).not.toBe(start);
    release.shipping.prepared = { tested, summary: "Version only" };
    release.proofRelease = { start, tested };
    // The exact atomic push has completed; resuming release metadata must retain this preparation.
    release.shipping.pushed = true;
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(true);
    release.release = { tag: "v0.2.0", url: "https://example.test/release" };
    const preparedRelease = release.shipping; delete release.shipping;
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(true);
    delete release.release; release.shipping = preparedRelease; delete release.shipping.pushed;
    writeFileSync(join(release.worktree!, "unexpected.txt"), "unreviewed edit"); await git(release.worktree!, "add", "."); await git(release.worktree!, "commit", "-q", "-m", "Unexpected change");
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(false);
  } finally { await f.engine.shutdown(); }
});

it("adds final preparation to a plan that omitted delivery approval, while current proof keeps its authorized automatic route", async () => {
  const f = await fixture();
  try {
    f.task.approveDelivery = false; f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.id !== "gate"); f.task.stageIndex = 2;
    f.task.hunt = { stageId: "review", round: 1, reported: { "0": true }, findings: 0, input: { file: "unused", digest: "unused", heads: {}, trees: await versionsOf(f.task) } };
    recordReviewProofs(f.engine, f.task, f.review, [{ text: "Required Linux proof", reason: "Exact final version required", productIds: [f.task.productId] }], "sol-high", "code-reviewer", "0");
    expect(f.task.plan!.stages.map(stage => stage.kind)).toEqual(["do", "do", "review-chain", "gate", "do"]);
    expect(f.task.proofDeliveryGate).toBeDefined(); expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    await f.recordPass(); f.task.risk = { level: "medium", why: "Existing task opted out of approval" };
    expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(true);
    f.scope.work.delivery = "release";
    expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    expect(proofGap(f.task)).toContain("release version");
  } finally { await f.engine.shutdown(); }
});

it("retains acceptance failure limits and does not charge main-only refreshes for actual task edits", async () => {
  const f = await fixture(); await f.request(); await f.recordPass(); f.task.proofRefreshes = 2;
  const reply = testerReply(f, ids => ids.map(id => ({ id, result: "fail", evidence: "Recovery reproduced a lost message on this code; nearby recovery succeeded" })));
  try {
    writeFileSync(join(f.scope.work.worktree!, "feature.txt"), "a changed task patch\n"); await git(f.scope.work.worktree!, "add", "."); await git(f.scope.work.worktree!, "commit", "-q", "-m", "Change the implementation");
    const stop = spyOn(f.engine["work"], "runDo").mockResolvedValue("stop");
    await f.drive(); expect(f.task.stageIndex).toBe(1); expect(f.task.retest).toBe(true); expect(f.task.proofRefreshes).toBe(2); stop.mockRestore();
    for (let turn = 1; turn <= 3; turn++) {
      f.task.retest = true; f.task.stageIndex = 1;
      await f.engine["work"].runDo(f.scope, f.tester, signal());
      expect(f.scope.work.acceptanceReturns).toBe(Math.min(turn, 2));
      expect(f.task.stageIndex).toBe(turn < 3 ? 0 : 3);
    }
    expect(reply).toHaveBeenCalledTimes(3); expect(f.task.findings).toHaveLength(1); expect(f.task.acceptanceBlocked).toBe(true);
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("tries a newly pending request despite an earlier unavailable acceptance result", async () => {
  const f = await fixture();
  const reply = testerReply(f, passes);
  try {
    const earlier = await f.recordPass([]); earlier.acceptanceChecks = [{ text: "An unavailable account", result: "blocked", reason: "Account unavailable" }];
    f.task.acceptancePassed = false; f.task.acceptanceUnverified = true;
    await f.request(); await f.drive();
    expect(reply).toHaveBeenCalledTimes(1); expect(f.task.proofRequests![0]!.status).toBe("proved");
    expect(f.scope.work.acceptanceReturns).toBeUndefined();
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("keeps an ordinary reproduced checklist failure's Builder retries when requested platform proof is unavailable", async () => {
  const f = await fixture(false, true); await f.request(); f.task.retest = true; f.task.stageIndex = 1;
  const reply = testerReply(f, ids => ids.map(id => ({ id, result: "blocked", reason: "Ubuntu runner unavailable" })), undefined, [{ text: "Linux recovery works", result: "fail", evidence: "The recovery scenario lost the saved message, while the nearby case passed" }]);
  try {
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(f.task.stageIndex).toBe(0); expect(f.scope.work.acceptanceReturns).toBe(1);
    expect(f.task.findings).toHaveLength(1); expect(f.task.findings[0]!.proofRequestId).toBeUndefined();
    expect(f.task.proofRequests![0]!.proof!.reason).toBe("Ubuntu runner unavailable");
    f.task.stageIndex = 3; f.task.fixing = false;
    const boundary = spyOn(f.engine["work"], "runDo").mockResolvedValue("stop");
    await f.drive(); expect(f.task.stageIndex).toBe(1); expect(f.task.retest).toBe(true); boundary.mockRestore();
    for (let turn = 2; turn <= 3; turn++) {
      f.task.stageIndex = 1; f.task.retest = true;
      await f.engine["work"].runDo(f.scope, f.tester, signal());
      expect(f.scope.work.acceptanceReturns).toBe(2); expect(f.task.stageIndex).toBe(turn === 2 ? 0 : 3);
    }
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("asks after the shared refresh limit even when main moved only outside a request's product subset", async () => {
  const f = await fixture(true); const request = await f.request("Prove only the first product", [f.products[0]!.id]); await f.recordPass();
  const reply = testerReply(f, passes); const publish = spyOn(f.engine["shipping"], "deliver").mockResolvedValue("stop");
  try {
    for (let move = 0; move < 3; move++) {
      f.engine.s.inbox = []; await f.advance(1);
      if (move === 2) { f.task.proofDeliveryGate = "gate"; f.task.approveDelivery = false; }
      await f.drive();
    }
    expect(reply).toHaveBeenCalledTimes(2); expect(publish).not.toHaveBeenCalled();
    expect(request.status).toBe("proved"); expect(f.task.proofRefreshBlocked).toBe(true);
    expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined();
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("two refreshes from main");
  } finally { reply.mockRestore(); publish.mockRestore(); await f.engine.shutdown(); }
});

it("discards an unpublished release identity before proving and preparing a newly approved version", async () => {
  const f = await fixture(); await f.request(); f.scope.work.delivery = "release";
  const release = f.engine["shipping"].releases;
  const notes = spyOn(f.engine["turns"], "turn").mockImplementation(async (_scope, roleId, _profileId, _given, schema) => {
    expect(roleId).toBe("release-manager"); return schema.parse({ summary: "Release ready", notes: "The recovery change is ready." });
  });
  const choose = spyOn(release, "chooseVersion").mockImplementation(async scope => {
    scope.work.shipping!.version = "0.3.0"; scope.work.shipping!.tag = "v0.3.0";
    return release["declaredVersions"](scope.work.worktree!, await git(scope.work.worktree!, "rev-parse", "HEAD"));
  });
  try {
    writeFileSync(join(f.scope.work.worktree!, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" })); await git(f.scope.work.worktree!, "add", "."); await git(f.scope.work.worktree!, "commit", "-q", "-m", "Declare fixture version");
    await f.recordPass();
    const start = await git(f.scope.work.worktree!, "rev-parse", "HEAD");
    f.scope.work.shipping = { moves: 0, failures: 0, start, base: f.scope.work.baseSha, version: "0.2.0", tag: "v0.2.0" };
    const tested = await release.setVersion(f.scope, await release["declaredVersions"](f.scope.work.worktree!, start));
    f.scope.work.proofRelease = { start, tested }; f.scope.work.shipping.prepared = { tested, summary: "Earlier release preparation" };
    await f.advance();
    await f.engine["shipping"]["prepareAgain"](f.scope, "Main moved before publishing");
    expect(f.scope.work.proofRelease).toBeUndefined(); expect(f.scope.work.shipping).toBeUndefined();
    await f.engine["updates"].upToDate(f.scope, signal()); await f.recordPass();
    f.task.checkedProofDecision = proofDecision(f.task, await versionsOf(f.task));
    f.engine.gate(f.task, "delivery"); f.engine.approve(f.engine.s.inbox.find(item => item.kind === "delivery")!.id);
    expect(await f.engine["shipping"]["readyToShip"](f.scope, signal())).toBe("ready");
    expect(await f.engine["shipping"]["prepare"](f.scope, f.ship, signal())).toBe("ready");
    expect(f.scope.work.proofRelease!.start).not.toBe(start); expect(f.scope.work.shipping!.prepared!.tested).not.toBe(tested);
  } finally { choose.mockRestore(); notes.mockRestore(); await f.engine.shutdown(); }
});

it("retains an exact local update awaiting its push while rejecting a newer destination version", async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  try {
    f.task.approvedProofDecision = proofDecision(f.task, await versionsOf(f.task));
    const tested = await git(f.scope.work.worktree!, "rev-parse", "HEAD");
    f.scope.work.shipping = { moves: 0, failures: 0, base: f.scope.work.baseSha, start: tested, localUpdated: tested, prepared: { tested, summary: "Local update awaits its push" } };
    await git(f.products[0]!.path!, "reset", "--hard", tested);
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(true);
    await f.advance();
    expect(await f.engine["shipping"]["proofApprovalCurrent"](f.task, signal(), true)).toBe(false);
    expect(f.scope.work.shipping.localUpdated).toBe(tested);
  } finally { await f.engine.shutdown(); }
});

it("guards a pending local push through interrupted delivery recovery while preserving an already published result", async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  const connections = f.engine["connections"], verifier = f.engine["shipping"].verifier;
  const product = f.products[0]!; product.repo = "acme/proof"; product.remote = "https://github.com/acme/proof.git";
  const remote = { url: product.remote };
  const connection = spyOn(connections, "connection").mockResolvedValue({ ok: true, remote });
  const contains = spyOn(verifier, "remoteContains").mockResolvedValue(false);
  const refs = spyOn(gitSteps, "remoteRefs").mockResolvedValue({ ok: true, value: new Map() });
  const push = spyOn(gitSteps, "push").mockResolvedValue({ ok: true, value: undefined });
  try {
    const tested = await git(f.scope.work.worktree!, "rev-parse", "HEAD");
    f.task.stageIndex = 4; f.task.approvedProofDecision = proofDecision(f.task, await versionsOf(f.task));
    f.scope.work.shipping = { moves: 0, failures: 0, base: f.scope.work.baseSha, start: tested, localUpdated: tested, prepared: { tested, summary: "Local placement is complete" }, step: "push", boot: "earlier-boot" };
    await git(product.path!, "reset", "--hard", tested);
    f.scope.work.localUpdate = { branch: "main", sha: tested, pushed: false };
    // A changed proof status is part of the bound decision even when the placed code is identical.
    delete f.task.proofRequests![0]!.proof;
    expect(await f.engine["shipping"].deliver(f.task, f.ship, signal())).toBe("continue");
    expect(push).not.toHaveBeenCalled(); expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined();
    expect(f.scope.work.localUpdate).toEqual({ branch: "main", sha: tested, pushed: false });
    // The same historical delivery can be recorded after a later remote observation, without pushing again.
    f.scope.work.shipping = { moves: 0, failures: 0, base: f.scope.work.baseSha, start: tested, localUpdated: tested, prepared: { tested, summary: "Already published" }, step: "push" };
    contains.mockResolvedValue(true);
    expect(await f.engine["shipping"].deliver(f.task, f.ship, signal())).toBe("stop");
    expect(push).not.toHaveBeenCalled(); expect(f.scope.work.landed?.sha).toBe(tested.slice(0, 7));
    expect(f.scope.work.confirmedDelivery?.sha).toBe(tested);
  } finally { push.mockRestore(); refs.mockRestore(); contains.mockRestore(); connection.mockRestore(); await f.engine.shutdown(); }
});

it("retains an earlier pass and refreshes it when an affected product changes during acceptance", async () => {
  const f = await fixture(true); const request = await f.request();
  const before = await versionsOf(f.task);
  f.task.retest = true; f.task.stageIndex = 1;
  const reply = testerReply(f, passes, async () => {
    const companion = f.owners[1]!.worktree;
    writeFileSync(join(companion, "changed-during-acceptance.txt"), "A different companion version\n");
    await git(companion, "add", "."); await git(companion, "commit", "-q", "-m", "Change the companion during acceptance");
  });
  try {
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(f.task.testedVersions).toEqual(before);
    expect(request.proof!.versions).toEqual(before);
    expect(request.proof!.result).toBe("pass");
    expect(request.status).toBe("stale");
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(false);
    expect(f.task.findings).toEqual([]); expect(f.task.repair).toBeUndefined();
    expect(f.task.acceptanceBlocked).toBeUndefined();
    reply.mockRestore();
    const refresh = testerReply(f, passes);
    try {
      await f.drive();
      expect(refresh).toHaveBeenCalledTimes(1); expect(request.status).toBe("proved");
      expect(f.task.testedVersions).toEqual(await versionsOf(f.task));
      expect(f.task.proofRefreshes).toBeUndefined();
      expect(f.task.timeline.some(line => line.text === "Final acceptance testing: the task's code changed since acceptance testing")).toBe(true);
    } finally { refresh.mockRestore(); }
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

it("keeps new requests from a reopened passing review, while replay and restart keep each request once", async () => {
  const f = await fixture();
  try {
    const apply = async (text: string) => f.engine["reviews"]["applyReview"](f.scope, f.review, ReviewResult.parse({ verdict: "pass", proofRequests: [{ text, reason: "Required on the final version", productIds: [f.task.productId] }] }), "sol-high", "code-reviewer", "0");
    const start = async () => {
      f.task.stageIndex = 2;
      f.task.hunt = { stageId: "review", round: 1, reported: {}, findings: 0, input: { file: "unused", digest: "unused", heads: {}, trees: await versionsOf(f.task) } };
      beginAgentStep(f.task, "code-reviewer", "sol-high", 1, f.engine.s.roles, undefined, f.scope.work);
    };
    await start(); await apply("Run Linux capacity");
    await f.engine["reviews"]["closeReviewRound"](f.task, f.review, 1, "Nothing to fix"); delete f.task.hunt;
    f.engine.gate(f.task, "delivery");
    f.engine.requestChanges(f.engine.s.inbox.find(item => item.kind === "delivery")!.id, "Also cover the Windows case");
    expect(f.task.rounds.review).toBeUndefined();
    await start(); await apply("Run Windows paths");
    const sources = f.task.proofRequests!.map(request => request.source);
    expect(new Set(sources).size).toBe(2);
    f.engine.setPoolPaused(true); await f.engine.shutdown();
    f.engine = new Engine(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    await apply("Run Windows paths");
    expect(f.task.proofRequests!.map(request => request.text)).toEqual(["Run Linux capacity", "Run Windows paths"]);
    expect(f.task.proofRequests!.map(request => request.source)).toEqual(sources);
    expect(f.task.proofRequests!.every(request => request.status === "pending")).toBe(true);
    expect(f.task.findings).toEqual([]); expect(f.task.rounds.review).toBeUndefined();
  } finally { await f.engine.shutdown(); }
});

for (const proof of [false, true]) it(`takes a new prepared snapshot after a failed Tester attempt, with requested proof ${proof}`, async () => {
  const f = await fixture(); if (proof) await f.request(); f.task.stageIndex = 1;
  const broken = spyOn(f.engine["turns"], "turn").mockRejectedValue(new Error("Controlled tool failure"));
  const review = spyOn(f.engine["reviews"], "runReview").mockResolvedValue("stop");
  try {
    await expectRejection(f.drive(), "Controlled tool failure");
    const old = structuredClone(f.task.acceptanceRun!.versions);
    expect(f.scope.work.conversation).toBeUndefined();
    broken.mockRestore(); await f.advance();
    await f.engine.retry(f.engine.s.inbox.find(item => item.kind === "stuck")!.id);
    const reply = testerReply(f, passes);
    try {
      await f.drive();
      expect(reply).toHaveBeenCalledTimes(1); expect(review).toHaveBeenCalledTimes(1);
      expect(f.task.testedVersions).toEqual(await versionsOf(f.task)); expect(f.task.testedVersions).not.toEqual(old);
      expect(f.task.acceptancePassed).toBe(true); expect(f.task.acceptanceRun).toBeUndefined();
      if (proof) expect(f.task.proofRequests![0]!.status).toBe("proved");
      expect(f.task.proofRefreshes).toBeUndefined();
    } finally { reply.mockRestore(); }
  } finally { broken.mockRestore(); review.mockRestore(); await f.engine.shutdown(); }
});

for (const savedConversation of [false, true]) it(`binds a restarted Tester to its ${savedConversation ? "saved conversation" : "newly prepared copy"}`, async () => {
  const f = await fixture(); await f.request(); f.task.stageIndex = 1;
  const versions = await versionsOf(f.task);
  f.task.acceptanceRun = { versions, changes: await changesOf(f.task), requestIds: [f.task.proofRequests![0]!.id] };
  if (savedConversation) f.scope.work.conversation = { step: stepKey(f.task), roleId: "tester", profileId: "opus-high", toolId: "claude", model: "opus", sessionId: "saved-tester", startedAt: 1 };
  f.engine.setPoolPaused(true); await f.engine.shutdown();
  f.engine = new Engine(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] }); f.engine.schedule = () => {};
  await f.engine.waitUntilReady(); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task); f.engine.setPoolPaused(false);
  const reply = testerReply(f, passes); const review = spyOn(f.engine["reviews"], "runReview").mockResolvedValue("stop");
  try {
    await f.advance(); f.task.state = "running";
    const admit = spyOn(f.engine["driver"] as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockResolvedValue(true);
    try { await f.engine["driver"]["drive"](f.task.id); } finally { admit.mockRestore(); }
    expect(reply).toHaveBeenCalledTimes(1); expect(f.task.acceptancePassed).toBe(true);
    expect(f.task.testedVersions).toEqual(await versionsOf(f.task));
    expect(sameVersions(f.task.testedVersions, versions)).toBe(savedConversation);
    expect(f.task.proofRequests![0]!.status).toBe("proved"); expect(f.task.proofRefreshes).toBeUndefined();
  } finally { reply.mockRestore(); review.mockRestore(); await f.engine.shutdown(); }
});

for (const shared of [false, true]) for (const unrelated of shared ? [false, true] : [false]) for (const result of ["pass", "fail"] as const) it(`preserves ${result} for ${shared ? "shared" : "single"} proof when ${unrelated ? "another" : "an affected"} product changes during testing`, async () => {
  const f = await fixture(shared); const request = await f.request("Prove the first product", [f.products[0]!.id]);
  f.task.retest = true; f.task.stageIndex = 1;
  const before = await versionsOf(f.task);
  const reply = testerReply(f, ids => ids.map(id => ({ id, result, evidence: "The scoped scenario and its nearby control were tried" })), async () => {
    const work = f.owners[unrelated ? 1 : 0]!.worktree;
    writeFileSync(join(work, "during.txt"), "A new task change\n"); await git(work, "add", "."); await git(work, "commit", "-q", "-m", "Change during acceptance");
  });
  try {
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(request.proof!.versions).toEqual(before); expect(request.proof!.result).toBe(result);
    expect(request.status).toBe(unrelated ? result === "pass" ? "proved" : "failed" : "stale");
    expect(f.task.acceptanceUnverified).toBe(false); expect(f.task.acceptanceBlocked).toBeUndefined();
    if (result === "fail") {
      expect(f.task.stageIndex).toBe(0); expect(f.task.findings).toHaveLength(1);
      expect(f.task.findings[0]!.proofRequestId).toBe(request.id); expect(f.task.findings[0]!.status).toBe("open");
      expect(f.scope.work.acceptanceReturns).toBe(1);
      if (shared) expect(f.task.repair!.products).toEqual([f.products[0]!.id]);
    } else {
      expect(f.task.stageIndex).toBe(3); expect(f.task.acceptancePassed).toBe(false);
      reply.mockRestore(); const refresh = testerReply(f, passes);
      try { await f.drive(); expect(refresh).toHaveBeenCalledTimes(1); expect(request.status).toBe("proved"); expect(f.task.acceptancePassed).toBe(true); }
      finally { refresh.mockRestore(); }
    }
    expect(f.task.proofRefreshes).toBeUndefined();
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});

for (const started of [false, true]) it(`records the publishing return with ${started ? "an open" : "no open"} publishing step`, async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  try {
    await f.drive(); f.engine.approve(f.engine.s.inbox.find(item => item.kind === "delivery")!.id);
    if (started) beginPetrinaStep(f.task, "delivery", Date.now());
    await f.advance();
    if (started) await f.engine["shipping"]["returnForProofDecision"](f.task);
    else expect(await f.engine["shipping"]["readyToShip"](f.scope, signal())).toBe("back");
    const steps = f.task.journey!.filter(step => step.kind === "petrina" && step.work === "delivery");
    expect(steps).toHaveLength(1); expect(steps[0]!.outcome).toBe("Nothing published; a new delivery decision is needed");
    expect(steps[0]!.endedAt).toBeDefined(); expect(steps[0]!.reason).toContain("differ from your delivery decision");
    expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined();
  } finally { await f.engine.shutdown(); }
});
