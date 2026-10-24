import { afterAll, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ACCEPTANCE_RESTORED, ACCEPTANCE_UNACCOUNTED, acceptanceSummary, beginAgentStep, beginPetrinaStep, endAgentStep, proofContext, proofDecision, proofGap, refreshProofs, sameVersions, type DeepMutable, type JourneyStep, type ProofRequest, type Product, type Task } from "@petrina/core";
import { Engine, type EngineOptions } from "./engine.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";
import { executionFor, scopesFor } from "@petrina/orchestrator";
import { changesOf, versionsOf } from "../src/repositories.js";
import { checkProofRequests, recordReviewProofs } from "../src/proof-requests.js";
import { ReviewResult } from "../src/roles.js";
import { commandText } from "../src/checks.js";
import { Store } from "@petrina/storage/store";
import * as gitSteps from "../src/git.js";
import { stepKey } from "../src/kernel.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { MAY_CHANGE } from "../src/prompts.js";
import { checkpointView } from "../src/checkpoint-read.js";
import { checkpointAcceptance } from "../src/checkpoint-acceptance.js";
import { Coordination } from "../src/coordination.js";
import type { ExtraValidation } from "@petrina/core";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const signal = () => new AbortController().signal;

async function fixture(shared = false, brief = false, fakes?: Fakes, options: EngineOptions = {}) {
  const root = tempDir("petrina-proof-requests-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => fakes ? [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] : undefined, terminals: () => [], ...options });
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

/** Steps the scripted tools record for one acceptance role, oldest first. */
const testerSteps = (f: Awaited<ReturnType<typeof fixture>>, roleId = "tester") => f.task.journey!.filter(step => step.kind === "agent" && step.roleId === roleId);
const restoredLine = (what: string, product: string, files: string) => `This acceptance run cannot verify the restored product: Petrina is undoing ${what} from Tester in ${product} (${files})`;

for (const proof of [false, true]) for (const committed of [false, true]) it(`keeps final acceptance unverified once when Petrina undoes an editing role's ${committed ? "commit" : "tracked edit"}, with requested proof ${proof}`, async () => {
  const fakeRoot = tempDir("petrina-proof-read-only-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const role = { ...f.engine.role("tester")!, id: "acceptance-specialist", canEdit: true };
    f.engine.s.roles.push(role); f.tester.roleId = role.id;
    const request = proof ? await f.request() : undefined;
    const worktree = f.scope.work.worktree!;
    // A saved project file: the stand-in rewrites it, and on a later pass also commits it. Different text
    // makes the uncommitted rewrite a real tracked edit rather than new output.
    if (committed) writeFileSync(join(fakeRoot, "tester-passed-once"), "");
    writeFileSync(join(worktree, "tester-edit.txt"), committed ? "Before the review\n" : "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Keep the permitted earlier edit");
    const earlier = await f.recordPass();
    earlier.roleId = role.id; earlier.agentResults![0]!.roleId = role.id;
    writeFileSync(join(worktree, "feature.txt"), "The builder's final change\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Prepare the reviewed final change");
    const versions = await versionsOf(f.task);
    // Approval is normally skipped for this low-risk product.
    f.products[0]!.shipLowRisk = true;
    fakes.scenario({ tester: "writes", ...(request ? { testerProofAnswers: passes([request.id]) } : {}) });

    // Keep the actual turn, access restriction and cleanup: only the external coding tool is a stand-in.
    await f.drive();

    expect(fakes.openings("tester")).toHaveLength(1);
    expect(fakes.openings("tester")[0]).toContain(MAY_CHANGE.afterReview);
    const delivery = f.engine.s.inbox.find(item => item.kind === "delivery")!;
    expect(f.task.stageIndex).toBe(3); expect(delivery.title).toContain(proof ? "requested proof could not be verified" : "acceptance could not be verified");
    if (!proof) expect(delivery.body).toContain(ACCEPTANCE_RESTORED);
    const steps = testerSteps(f, role.id), final = steps.at(-1)!;
    expect(steps).toHaveLength(2);
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.acceptanceBlocked).toBe(true);
    // Restored version equality is no proof: the run's versions are recorded, and still settle nothing.
    expect(f.task.testedVersions).toEqual(versions); expect(await versionsOf(f.task)).toEqual(versions);
    expect(await git(worktree, "log", "--format=%s")).not.toContain("Tester commits after the review");
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(worktree, "tester-edit.txt"), "utf8")).toBe(committed ? "Before the review\n" : "Saved before acceptance\n");
    expect(f.task.timeline.some(entry => entry.text === `Undid ${committed ? "commits" : "changes"} from Tester, which is read-only`)).toBe(true);
    expect(f.task.timeline.some(entry => entry.text === restoredLine(committed ? "commits" : "changes to project files", "Product 1", "tester-edit.txt"))).toBe(true);
    expect(final.proofRun!.restored!.products).toEqual([{ productId: f.task.productId, ...(committed ? { commits: true } : { edits: true }), files: ["tester-edit.txt"] }]);
    // Saved results say unverified; the agent's own report keeps its answers and evidence.
    const report = final.agentResults!.at(-1)!.value as { checks: { result: string; evidence: string }[]; proofAnswers: unknown[] };
    expect(report.checks[0]!.result).toBe("pass");
    expect(final.acceptanceChecks).toEqual([{ text: "A greeting file exists", result: "blocked", evidence: report.checks[0]!.evidence, reason: ACCEPTANCE_RESTORED },
      ...(request ? [{ text: request.text, result: "blocked" as const, evidence: passes([request.id])[0]!.evidence, reason: ACCEPTANCE_RESTORED }] : [])]);
    if (request) {
      expect(report.proofAnswers).toEqual(passes([request.id]));
      expect(final.proofChecks).toEqual([{ ...passes([request.id])[0]!, result: "blocked", reason: ACCEPTANCE_RESTORED }]);
      expect(request.status).toBe("unverified");
      expect(request.proof).toEqual({ stepId: final.id, versions, result: "blocked", evidence: passes([request.id])[0]!.evidence, reason: ACCEPTANCE_RESTORED });
    }
    expect(f.task.findings).toEqual([]); expect(f.task.rounds.review).toBeUndefined();
    expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.task.proofRefreshes).toBeUndefined(); expect(f.engine.role(role.id)!.canEdit).toBe(true);
    // The delivery check reads this run rather than the earlier pass.
    const checkpoint = await checkpointView(f.engine, f.engine.taskDetails(f.task.id)!, delivery);
    if (!("acceptance" in checkpoint) || !checkpoint.acceptance) throw new Error("Expected acceptance details at the delivery check");
    expect(checkpoint.acceptance.unverified).toBe(true);
    expect(checkpoint.acceptance.evidence).toMatchObject({ nodeId: final.id, counts: { passed: 0, couldNotVerify: 1 + (proof ? 1 : 0) }, restored: { reason: ACCEPTANCE_RESTORED } });
    // Unavailable evidence is not tested again unchanged, and never ships unasked, even where the task's own setting would.
    f.engine.s.inbox = []; await f.drive();
    expect(fakes.openings("tester")).toHaveLength(1); expect(f.task.stageIndex).toBe(3);
    expect(f.task.approvedProofDecision).toBeUndefined(); expect(f.scope.work.landed).toBeUndefined();
    expect(f.engine["driver"]["shipsUnasked"]({ ...f.task, proofDeliveryGate: "gate", approveDelivery: false })).toBe(false);
    if (request) {
      // The coordinator's explicit decision is bound to these versions and the unverified status.
      f.engine.approve(f.engine.s.inbox.find(item => item.kind === "delivery")!.id);
      expect(f.task.approvedProofDecision).toEqual({ versions, statuses: { [request.id]: "unverified" } });
    }
  } finally { await f.engine.shutdown(); }
});

for (const output of ["checks", "tester"] as const) it(`settles requested proof when only ${output === "checks" ? "the automated checks" : "the final Tester"} left new output files`, async () => {
  const fakeRoot = tempDir("petrina-proof-output-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    if (output === "checks") f.engine.setProductChecks(f.task.productId, [{ name: "Test", command: commandText([process.execPath, "-e", "require('node:fs').writeFileSync('check-output.log', 'ran\\n')"]) }]);
    const versions = await versionsOf(f.task);
    fakes.scenario({ ...(output === "tester" ? { tester: "writes" as const } : {}), testerProofAnswers: passes([request.id]) });
    await f.drive();
    expect(fakes.openings("tester")).toHaveLength(1);
    expect(request.status).toBe("proved"); expect(request.proof!.versions).toEqual(versions);
    expect(f.task.acceptancePassed).toBe(true); expect(f.task.acceptanceUnverified).toBe(false);
    expect(testerSteps(f).at(-1)!.proofRun!.restored).toBeUndefined();
    expect(f.task.timeline.some(entry => entry.text === "Undid changes from Tester, which is read-only")).toBe(true);
    expect(f.task.timeline.some(entry => entry.text.startsWith("This acceptance run cannot verify"))).toBe(false);
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toBe("Ready to ship “Keep required Linux proof current”");
  } finally { await f.engine.shutdown(); }
});

for (const committed of [false, true]) it(`keeps the first read-only acceptance run unverified after Petrina undoes its ${committed ? "commit" : "tracked edit"}, without a repair or an unchanged retry`, async () => {
  const fakeRoot = tempDir("petrina-first-acceptance-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const worktree = f.scope.work.worktree!;
    f.task.brief = { summary: "Try it", areas: [], forUsers: [], risks: [], acceptance: [{ text: "A greeting file exists" }] };
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    const before = await git(worktree, "rev-parse", "HEAD"), versions = await versionsOf(f.task);
    // An older pass on the same code: the invalidated run is later, so it must not shine through.
    f.task.journey = [{ id: "older-pass", kind: "agent", stageId: f.tester.id, roleId: "tester", profileId: "opus-high", round: 1, sub: 0, startedAt: 1, endedAt: 2, end: "done", acceptanceChecks: [{ text: "A greeting file exists", result: "pass", evidence: "An earlier run saw the greeting" }], agentResults: [{ roleId: "tester", profileId: "opus-high", at: 2, value: {}, versions }] }];
    f.task.stageIndex = 1;
    fakes.scenario({ testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Changed during acceptance\n", commit: committed }] });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    // Restored versions equal the reviewed ones, yet a checklist-linked request cannot reuse this run or the older pass.
    f.task.hunt = { stageId: f.review.id, round: 1, reported: {}, findings: 0, input: { file: "unused", digest: "unused", heads: {}, trees: versions } };
    recordReviewProofs(f.engine, f.task, f.review, [{ text: "Show the greeting", reason: "Needed on the final code", productIds: [f.task.productId], checklistText: "A greeting file exists" }], "sol-high", "code-reviewer", "0");
    expect(f.task.proofRequests![0]).toMatchObject({ status: "pending" }); expect(f.task.proofRequests![0]!.proof).toBeUndefined();
    expect(acceptanceSummary(f.task as Task, id => f.engine.role(id!)).items[0]!.current).toBe(false);
    delete f.task.proofRequests; delete f.task.hunt;
    expect(fakes.openings("tester")[0]).toContain(MAY_CHANGE.readOnly);
    expect(f.task.stageIndex).toBe(2);
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(before); expect(await git(worktree, "status", "--porcelain")).toBe("");
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.acceptanceBlocked).toBeUndefined();
    expect(f.task.brief.acceptance[0]).toEqual({ text: "A greeting file exists", verification: "blocked", reason: ACCEPTANCE_RESTORED });
    expect(f.task.timeline.some(entry => entry.text === restoredLine(committed ? "commits" : "changes to project files", "Product 1", "tester-edit.txt"))).toBe(true);
    expect(f.task.timeline.some(entry => entry.text === `Acceptance could not be verified: ${ACCEPTANCE_RESTORED}`)).toBe(true);
    expect(testerSteps(f).at(-1)!).toMatchObject({ outcome: "1 check could not be verified", reason: "Petrina undid changes during acceptance testing" });
    expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined();
    // A later code change alone keeps today's path: the coordinator decides at delivery.
    writeFileSync(join(worktree, "feature.txt"), "A reviewed fix\n"); await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Fix after review");
    f.task.stageIndex = 3;
    await f.drive();
    expect(fakes.openings("tester")).toHaveLength(1); expect(f.task.stageIndex).toBe(3);
    const delivery = f.engine.s.inbox.find(item => item.kind === "delivery")!;
    expect(delivery.title).toContain("1 acceptance check could not be verified"); expect(delivery.body).toContain(ACCEPTANCE_RESTORED);
  } finally { await f.engine.shutdown(); }
});

// The single-product matrix above covers an undone commit in the active product's own copy.
for (const edited of [false, true]) it(`${edited ? "waits for your decision" : "still delivers on its own"} with delivery approval off and no requested proof after a ${edited ? "first acceptance run Petrina had to undo" : "clean first acceptance run"}`, async () => {
  const fakeRoot = tempDir("petrina-approval-off-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const worktree = f.scope.work.worktree!, product = f.products[0]!;
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    // Delivery approval is off for this task and product, so its plan has no delivery check.
    f.task.approveDelivery = false; product.approveDelivery = false;
    f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.gate !== "delivery");
    f.task.stageIndex = 1;
    const main = await git(product.path!, "rev-parse", "main");
    fakes.scenario(edited ? { testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited during acceptance\n" }] } : {});
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(f.task.acceptanceUnverified).toBe(edited);
    expect(f.task.plan!.stages.map(stage => stage.kind)).toEqual(edited ? ["do", "do", "review-chain", "gate", "do"] : ["do", "do", "review-chain", "do"]);
    expect(f.task.proofDeliveryGate !== undefined).toBe(edited); expect(f.task.stageIndex).toBe(2);
    // Past the unrelated review, on to delivery.
    f.task.stageIndex = 3;
    await f.drive();
    const delivery = f.engine.s.inbox.find(item => item.kind === "delivery");
    expect(fakes.openings("tester")).toHaveLength(1);
    if (!edited) {
      expect(delivery).toBeUndefined(); expect(f.scope.work.landed).toBeDefined();
      expect(await git(product.path!, "rev-parse", "main")).not.toBe(main);
      return;
    }
    expect(f.task.timeline.some(entry => entry.text === "Added your delivery check: this acceptance run cannot verify the product, so delivery waits for your decision")).toBe(true);
    expect(f.task.stageIndex).toBe(3); expect(delivery!.title).toBe("Your call on “Keep required Linux proof current”: acceptance could not be verified");
    expect(delivery!.body).toContain(ACCEPTANCE_RESTORED); expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    expect(f.scope.work.landed).toBeUndefined(); expect(await git(product.path!, "rev-parse", "main")).toBe(main);
    // The coordinator's explicit decision still ships it.
    f.engine.approve(delivery!.id); await f.drive();
    expect(f.scope.work.landed).toBeDefined(); expect(await git(product.path!, "rev-parse", "main")).not.toBe(main);
  } finally { await f.engine.shutdown(); }
});

for (const [where, change] of [["active", "edit"], ["companion", "edit"], ["companion", "commit"], ["companion", "output"]] as const) it(`${change === "output" ? "keeps" : "invalidates"} the whole shared acceptance run when the Tester leaves ${change === "output" ? "new output" : change === "edit" ? "a tracked edit" : "a commit"} in the ${where} product`, async () => {
  const fakeRoot = tempDir("petrina-shared-acceptance-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(true, false, fakes);
  try {
    const touched = f.owners[where === "active" ? 0 : 1]!, other = f.products[where === "active" ? 1 : 0]!;
    // The request and the checklist item name only the product Petrina did not restore.
    const request = await f.request("Prove the untouched product", [other.id]);
    const file = change === "output" ? "new-output.txt" : "shared-edit.txt";
    if (change !== "output") { writeFileSync(join(touched.worktree, file), "Saved before acceptance\n"); await git(touched.worktree, "add", "."); await git(touched.worktree, "commit", "-q", "-m", "Save a shared file"); }
    const before = await versionsOf(f.task);
    f.task.brief = { summary: "Try it", areas: [], forUsers: [], risks: [], acceptance: [{ text: "A greeting file exists", productIds: [other.id], versions: { [other.id]: before[other.id]! }, verification: "passed", met: true }] };
    f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ testerProofAnswers: passes([request.id]), testerFiles: [{ dir: touched.worktree, file, text: "Written during acceptance\n", commit: change === "commit" }] });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(await versionsOf(f.task)).toEqual(before);
    expect(await git(touched.worktree, "status", "--porcelain")).toBe("");
    const final = testerSteps(f).at(-1)!;
    expect(f.task.findings).toEqual([]); expect(f.task.repair).toBeUndefined(); expect(f.task.stageIndex).toBe(3);
    if (change === "output") {
      expect(request.status).toBe("proved"); expect(final.proofRun!.restored).toBeUndefined();
      expect(f.task.timeline.some(entry => entry.text.startsWith("This acceptance run cannot verify") || entry.text.startsWith("Undid changes in"))).toBe(false);
      return;
    }
    const name = where === "active" ? "Product 1" : "Product 2";
    expect(request.status).toBe("unverified"); expect(request.proof).toMatchObject({ versions: before, result: "blocked", reason: ACCEPTANCE_RESTORED });
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.acceptanceBlocked).toBe(true);
    expect(final.proofRun!.restored!.products).toEqual([{ productId: touched.productId, ...(change === "commit" ? { commits: true } : { edits: true }), files: [file] }]);
    expect(f.task.timeline.some(entry => entry.text === restoredLine(change === "commit" ? "commits" : "changes to project files", name, file))).toBe(true);
    if (where === "companion") expect(f.task.timeline.some(entry => entry.text === `Undid ${change === "commit" ? "commits" : "changes"} in ${name} from Tester, which is read-only`)).toBe(true);
    // The invalid run keeps the item's ownership and versions rather than reassigning them, and any earlier unavailable reason.
    expect(f.task.brief.acceptance[0]).toEqual({ text: "A greeting file exists", productIds: [other.id], versions: { [other.id]: before[other.id]! }, verification: "blocked", reason: `${ACCEPTANCE_RESTORED} Together: no valid affected products were assigned. The coordinator must resolve ownership.` });
  } finally { await f.engine.shutdown(); }
});

it("keeps an invalidated run's reported failures as history, without a defect, a Builder return or changed check evidence", async () => {
  const fakeRoot = tempDir("petrina-invalid-failure-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    // A failure found and repaired in an earlier run keeps its own result.
    const earlier = { id: "earlier-failure", text: "Failed acceptance check: A greeting file exists", severity: "blocking" as const, raisedBy: "opus-high", confirmedBy: [], status: "fixed" as const, answer: { fixed: true, text: "Added the greeting", at: 1 } };
    f.task.findings.push(structuredClone(earlier));
    f.scope.work.checks = { at: 1, sha: await git(worktree, "rev-parse", "HEAD"), tree: await git(worktree, "rev-parse", "HEAD^{tree}"), current: true, results: [{ name: "Test", command: "test", ok: true, output: "passed", ms: 1 }] };
    const checks = structuredClone(f.scope.work.checks);
    f.task.retest = true; f.task.stageIndex = 1;
    const failing = { id: request.id, result: "fail" as const, evidence: "The recovery scenario lost the saved message; the nearby case passed" };
    fakes.scenario({ tester: "always-fail", testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Changed during acceptance\n" }], testerProofAnswers: [failing] });
    // The real turn and cleanup run; only the product checks before it are skipped, to keep their saved evidence in view.
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    const final = testerSteps(f).at(-1)!, report = final.agentResults!.at(-1)!.value as { checks: { result: string }[]; proofAnswers: unknown[] };
    expect(report.checks.map(check => check.result)).toEqual(["fail"]); expect(report.proofAnswers).toEqual([failing]);
    expect(final.acceptanceChecks!.map(check => check.result)).toEqual(["blocked", "blocked"]);
    expect(request.status).toBe("unverified"); expect(request.proof).toMatchObject({ result: "blocked", evidence: failing.evidence, reason: ACCEPTANCE_RESTORED });
    expect(f.task.findings).toEqual([earlier]);
    expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.task.fixing).toBeFalsy(); expect(f.task.stageIndex).toBe(3);
    expect(f.task.acceptanceBlocked).toBe(true); expect(f.scope.work.checks).toEqual(checks);
  } finally { await f.engine.shutdown(); }
});

it("starts a genuinely fresh acceptance run after a pause, keeping the paused attempt's undone change as history", async () => {
  const fakeRoot = tempDir("petrina-acceptance-pause-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ tester: "work", testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited before the pause\n" }], testerProofAnswers: passes([request.id]) });
    const driving = f.drive();
    await waitFor(() => fakes.marked("tester-worked") && f.scope.work.conversation?.briefed, "the Tester to be at work");
    f.engine.pause(f.task.id); await driving;
    const paused = testerSteps(f).at(-1)!;
    expect(paused.proofRun!.restored!.products).toEqual([{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }]);
    expect(request.proof).toBeUndefined();
    // The paused attempt settled nothing. A fresh conversation tests the restored code on its own versions.
    fakes.scenario({ tester: "work", testerProofAnswers: passes([request.id]) });
    f.engine.resume(f.task.id); await f.drive();
    const fresh = testerSteps(f).at(-1)!;
    expect(fresh.id).not.toBe(paused.id); expect(fresh.proofRun!.restored).toBeUndefined();
    expect(request.status).toBe("proved"); expect(request.proof!.stepId).toBe(fresh.id); expect(request.proof!.versions).toEqual(await versionsOf(f.task));
    expect(paused).toMatchObject({ outcome: "Stopped before a result", reason: "Petrina undid changes during this attempt; the next run starts fresh" });
    expect(paused.proofRun!.restored).toBeDefined(); expect(paused.acceptanceChecks).toBeUndefined();
    expect(f.task.acceptanceUnverified).toBe(false); expect(f.task.acceptancePassed).toBe(true);
  } finally { await f.engine.shutdown(); }
});

for (const extra of [false, true]) it(`recovers Tester restoration once after shutdown${extra ? " with late extra-validation settlement" : " without extra validation"}`, async () => {
  const fakeRoot = tempDir("petrina-acceptance-extra-close-"); roots.push(fakeRoot);
  const service = join(fakeRoot, "container-service"); mkdirSync(service);
  const fakes = new Fakes(fakeRoot);
  const settings: EngineOptions = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], terminals: () => [],
    containerTool: [process.execPath, join(import.meta.dir, "fake-extra-container.ts"), service], extraCleanupEveryMs: 60_000 };
  const f = await fixture(false, false, fakes, settings);
  const released = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let stopping: Promise<void> | undefined, driving: Promise<void> | undefined;
  try {
    const request = await f.request(), worktree = f.scope.work.worktree!;
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    await f.engine.rememberVersion(f.scope);
    f.products[0]!.shipLowRisk = true; f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ reopen: "resume", tester: "work", testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited before Petrina closes\n" }], testerProofAnswers: passes([request.id]) });
    driving = f.drive();
    await waitFor(() => fakes.marked("tester-worked") && f.scope.work.conversation?.briefed, "the real Tester to be at work");
    let record: ExtraValidation | undefined;
    if (extra) {
      const reply = await new Coordination(f.engine).call("validation.run", { taskId: f.task.id, requestId: "late-shutdown-extra", name: "Required platform check", reason: "Verify shutdown evidence isolation", image: "local:ready", argv: ["probe", "hold"] });
      expect(reply.outcome).toBe("pending"); record = reply.validation as ExtraValidation;
      // This fixture disables automatic drivers; still use the product's real queue admission.
      f.engine.extraValidations.pump();
      await waitFor(() => existsSync(join(service, "started", record!.id)), "the owned extra workload to start");
      const container = f.engine.extraValidations["container"], cleanup = container.cleanup.bind(container);
      container.cleanup = async owned => { entered.resolve(); await released.promise; return cleanup(owned); };
    }
    f.engine.setPoolPaused(true); stopping = f.engine.shutdown();
    if (extra) await entered.promise;
    await driving;
    const cleanup = f.task.acceptanceCleanupPending!, marker = join(f.engine.dataDir, "acceptance-restorations", `${cleanup}.json`);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(join(worktree, "tester-edit.txt"), "utf8")).toBe("Saved before acceptance\n");
    const warning = restoredLine("changes to project files", "Product 1", "tester-edit.txt");
    expect(f.task.timeline.filter(line => line.text === warning)).toHaveLength(1);
    released.resolve(); await stopping;
    const saved = new Store(join(f.engine.dataDir, "petrina.db"));
    try {
      const task = saved.load()!.tasks.find(task => task.id === f.task.id)!;
      expect(task.acceptanceCleanupPending).toBe(cleanup); expect(task.acceptanceRun!.restored).toBeUndefined();
      expect(task.timeline.filter(line => line.text === warning)).toHaveLength(0);
      if (record) {
        expect(saved.load()!.extraValidations).toEqual([]);
        const evidence = task.journey!.find(node => node.id === record!.nodeId)!.extraValidations![0]!;
        expect(evidence.state).toBe("finished"); expect(evidence.result).toBe("stopped");
        expect(task.timeline.filter(line => line.text.includes("Extra validation") && line.text.includes("seconds"))).toHaveLength(1);
      }
    } finally { saved.close(); }
    f.engine = new Engine(f.engine.dataDir, settings); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.engine.setPoolPaused(false); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    expect(f.task.timeline.filter(line => line.text === warning)).toHaveLength(1);
    expect(f.task.acceptanceCleanupPending).toBeUndefined(); expect(existsSync(marker)).toBe(false);
    expect(f.task.acceptanceRun!.restored!.products).toEqual([{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }]);
    if (record) {
      const result = f.engine.extraValidations.get(record.requestId)!;
      expect(result.outcome).toBe("completed"); expect((result.validation as ExtraValidation).state).toBe("finished");
      expect(result.validation as ExtraValidation).toEqual(f.task.journey!.find(node => node.id === record!.nodeId)!.extraValidations![0]!);
      expect(f.engine.s.extraValidations).toEqual([]); expect(existsSync(record.snapshot)).toBe(false);
      expect(fs.readdirSync(join(service, "containers"))).toEqual([]);
    }
    fakes.scenario({ reopen: "resume", tester: "work", testerProofAnswers: passes([request.id]) });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(f.task.timeline.filter(line => line.text === warning)).toHaveLength(1);
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true);
    expect(f.task.proofRequests![0]).toMatchObject({ status: "unverified", proof: { result: "blocked", reason: ACCEPTANCE_RESTORED } });
    expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
  } finally { released.resolve(); await stopping; await driving; await f.engine.shutdown(); }
});

// Closing saves the state before the Tester's step has cleaned up. "kept": the cleanup's record of the undone edit
// arrives; "clean": the Tester changed nothing; "unwritable"/"unreadable": the record of the undone edit is lost.
for (const outcome of ["kept", "clean", "unwritable", "unreadable"] as const) it(`${outcome === "clean" ? "settles" : "keeps unverified"} a run resumed after Petrina closed mid-test when the cleanup's record is ${outcome}`, async () => {
  const fakeRoot = tempDir("petrina-acceptance-quit-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  const reopen = async () => {
    f.engine = new Engine(f.engine.dataDir, { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.engine.setPoolPaused(false); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
  };
  const saved = () => { const store = new Store(join(f.engine.dataDir, "petrina.db")); try { return store.load()!.tasks.find(task => task.id === f.task.id)!; } finally { store.close(); } };
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    const folder = join(f.engine.dataDir, "acceptance-restorations");
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    f.products[0]!.shipLowRisk = true; f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ reopen: "resume", tester: "work", ...(outcome === "clean" ? {} : { testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited before Petrina closes\n" }] }), testerProofAnswers: passes([request.id]) });
    const driving = f.drive();
    await waitFor(() => fakes.marked("tester-worked") && f.scope.work.conversation?.briefed, "the Tester to be at work");
    expect(f.task.acceptanceRun!.restored).toBeUndefined();
    // A file where the record's folder belongs makes the record impossible to write.
    if (outcome === "unwritable") writeFileSync(folder, "Not a folder\n");
    f.engine.setPoolPaused(true); await f.engine.shutdown(); await driving;
    expect(readFileSync(join(worktree, "tester-edit.txt"), "utf8")).toBe("Saved before acceptance\n");
    // The last save marked the run with its cleanup's identity before the cleanup could look; only that cleanup's record can clear it.
    const cleanup = saved().acceptanceCleanupPending!, record = join(folder, `${cleanup}.json`);
    expect(cleanup).toMatch(/^[0-9a-f]{24}$/); expect(saved().acceptanceRun!.restored).toBeUndefined();
    expect(existsSync(record)).toBe(outcome !== "unwritable");
    if (outcome === "unwritable") rmSync(folder);
    if (outcome === "unreadable") writeFileSync(record, "{ not a record");
    await reopen();
    const restored = outcome === "kept" ? [{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }] : [];
    expect(f.task.acceptanceCleanupPending).toBeUndefined(); expect(saved().acceptanceCleanupPending).toBeUndefined();
    expect(existsSync(record)).toBe(false);
    if (outcome === "clean") expect(f.task.acceptanceRun!.restored).toBeUndefined();
    else { expect(f.task.acceptanceRun!.restored!.products).toEqual(restored); expect(saved().acceptanceRun!.restored!.products).toEqual(restored); }
    expect(f.task.timeline.some(entry => entry.text === restoredLine("changes to project files", "Product 1", "tester-edit.txt"))).toBe(outcome === "kept");
    expect(f.task.timeline.some(entry => entry.text === "This acceptance run cannot verify the product: Petrina closed during it and could not read what its cleanup undid")).toBe(outcome === "unwritable" || outcome === "unreadable");
    // The same conversation reopens and answers with a pass, without editing again.
    fakes.scenario({ reopen: "resume", tester: "work", testerProofAnswers: passes([request.id]) });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    const proof = f.task.proofRequests![0]!, final = testerSteps(f).at(-1)!;
    expect(fakes.openings("tester")).toHaveLength(1);
    if (outcome === "clean") {
      expect(proof.status).toBe("proved"); expect(f.task.acceptancePassed).toBe(true); expect(final.proofRun!.restored).toBeUndefined();
      return;
    }
    // Without a record nothing shows that Petrina undid anything, and the reason says so.
    const reason = outcome === "kept" ? ACCEPTANCE_RESTORED : ACCEPTANCE_UNACCOUNTED;
    expect(proof.status).toBe("unverified"); expect(proof.proof).toMatchObject({ stepId: final.id, result: "blocked", reason });
    expect(final.proofRun!.restored!.products).toEqual(restored);
    expect(final.reason).toBe(outcome === "kept" ? "Petrina undid changes during acceptance testing" : "Petrina could not confirm what its cleanup undid");
    expect(f.task.timeline.some(entry => entry.text === `Acceptance could not be verified: ${reason}`)).toBe(true);
    expect(checkpointAcceptance(f.task, f.engine.s.roles).evidence).toMatchObject({ nodeId: final.id, checks: [{ result: "blocked", reason }, { result: "blocked", reason }], restored: { reason, products: outcome === "kept" ? [{ productId: f.task.productId, edits: true }] : [] } });
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true);
    expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    if (outcome !== "kept") return;
    // A record no marked run names, such as one an earlier start could not remove, changes nothing and goes.
    const lines = f.task.timeline.length;
    f.engine.setPoolPaused(true); await f.engine.shutdown();
    mkdirSync(folder, { recursive: true });
    writeFileSync(record, JSON.stringify({ taskId: f.task.id, cleanup, restored: { at: 1, products: restored }, lines: ["An unrelated record"] }));
    await reopen();
    expect(existsSync(record)).toBe(false); expect(f.task.acceptanceRun).toBeUndefined(); expect(f.task.timeline).toHaveLength(lines);
  } finally { await f.engine.shutdown(); }
});

/**
 * Stands in for a cleanup records folder that cannot change, alike on every platform: Petrina's removal of the kept
 * record, and its writing of any record in the folder, are refused and noted. Every other path goes through.
 */
function lockRecords(folder: string, kept: string) {
  const refused: string[] = [];
  const refuse = (path: unknown, only?: string) => {
    if (typeof path !== "string" || dirname(resolve(path)) !== resolve(folder) || (only !== undefined && resolve(path) !== resolve(only))) return undefined;
    refused.push(basename(path));
    return Object.assign(new Error(`EACCES: permission denied, '${path}'`), { code: "EACCES", path });
  };
  const remove = fs.rmSync as (...args: unknown[]) => void, write = fs.writeFileSync as (...args: unknown[]) => void;
  const spies = [
    spyOn(fs, "rmSync").mockImplementation(((path: unknown, ...rest: unknown[]) => { const error = refuse(path, kept); if (error) throw error; return remove(path, ...rest); }) as never),
    spyOn(fs, "writeFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => { const error = refuse(path); if (error) throw error; return write(path, ...rest); }) as never),
  ];
  let restored = false;
  return { refused, restore: () => { if (!restored) for (const spy of spies) spy.mockRestore(); restored = true; } };
}

// Petrina closes twice during one run: first while the Tester changes nothing, then after it edits a saved project file.
// "locked": the next start cannot remove the first cleanup's record, and the second cleanup cannot leave its own.
// "writable": the control, whose second record arrives.
for (const folderState of ["locked", "writable"] as const) it(`keeps a run unverified after a second close ${folderState === "locked" ? "when only an earlier cleanup's record of it remains" : "whose cleanup's record arrives"}`, async () => {
  const fakeRoot = tempDir("petrina-acceptance-stale-record-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  const reopen = async () => {
    f.engine = new Engine(f.engine.dataDir, { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.engine.setPoolPaused(false); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
  };
  const saved = () => { const store = new Store(join(f.engine.dataDir, "petrina.db")); try { return store.load()!.tasks.find(task => task.id === f.task.id)!; } finally { store.close(); } };
  const folder = join(f.engine.dataDir, "acceptance-restorations");
  let locked: ReturnType<typeof lockRecords> | undefined;
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!, edited = join(worktree, "tester-edit.txt");
    writeFileSync(edited, "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    f.products[0]!.shipLowRisk = true; f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ reopen: "resume", tester: "work", testerProofAnswers: passes([request.id]) });
    const driving = f.drive();
    await waitFor(() => fakes.marked("tester-worked") && f.scope.work.conversation?.briefed, "the Tester to be at work");
    f.engine.setPoolPaused(true); await f.engine.shutdown(); await driving;
    // A genuine record that this cleanup undid nothing, for this same task and run.
    const first = saved().acceptanceCleanupPending!, earlier = join(folder, `${first}.json`);
    expect(JSON.parse(readFileSync(earlier, "utf8"))).toEqual({ taskId: f.task.id, cleanup: first, lines: [] });
    if (folderState === "locked") locked = lockRecords(folder, earlier);
    await reopen();
    expect(f.task.acceptanceRun!.restored).toBeUndefined(); expect(existsSync(earlier)).toBe(folderState === "locked");
    expect(locked?.refused ?? []).toEqual(folderState === "locked" ? [`${first}.json`] : []);
    // The same conversation goes on, edits the saved file and is still working when Petrina closes again.
    rmSync(join(fakes.dir, "tester-worked"));
    fakes.scenario({ reopen: "resume", tester: "work", testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited after the first close\n" }], testerProofAnswers: passes([request.id]) });
    const working = f.engine["work"].runDo(f.scope, f.tester, signal()).then(() => undefined, (error: unknown) => error);
    await waitFor(() => fakes.marked("tester-worked") && readFileSync(edited, "utf8") === "Edited after the first close\n", "the resumed Tester to edit");
    f.engine.setPoolPaused(true); await f.engine.shutdown(); await working;
    expect(readFileSync(edited, "utf8")).toBe("Saved before acceptance\n");
    const second = saved().acceptanceCleanupPending!;
    expect(second).not.toBe(first); expect(existsSync(join(folder, `${second}.json`))).toBe(folderState === "writable");
    expect(existsSync(earlier)).toBe(folderState === "locked");
    expect(locked?.refused ?? []).toEqual(folderState === "locked" ? [`${first}.json`, `${second}.json.tmp`] : []);
    locked?.restore();
    await reopen();
    expect(existsSync(earlier)).toBe(false); expect(f.task.acceptanceCleanupPending).toBeUndefined();
    const restored = folderState === "writable" ? [{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }] : [];
    expect(f.task.acceptanceRun!.restored!.products).toEqual(restored);
    expect(f.task.timeline.some(entry => entry.text === "This acceptance run cannot verify the product: Petrina closed during it and could not read what its cleanup undid")).toBe(folderState === "locked");
    // The same conversation answers with a pass, without editing again.
    fakes.scenario({ reopen: "resume", tester: "work", testerProofAnswers: passes([request.id]) });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    const proof = f.task.proofRequests![0]!, final = testerSteps(f).at(-1)!;
    expect(fakes.openings("tester")).toHaveLength(1);
    expect(final.proofRun!.restored!.products).toEqual(restored);
    expect(proof.status).toBe("unverified"); expect(proof.proof).toMatchObject({ stepId: final.id, result: "blocked", reason: folderState === "writable" ? ACCEPTANCE_RESTORED : ACCEPTANCE_UNACCOUNTED });
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true);
    expect(f.task.findings).toEqual([]); expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
  } finally { locked?.restore(); await f.engine.shutdown(); }
});

// The Tester has answered and left the running list; its cleanup is held at one point while Petrina closes, then released.
// "answered": before it looks at the copy; "detected": while it notes the edit; "restoring": while it undoes the noted edit;
// "commit": while it undoes a commit; "companion": while it undoes a commit in a shared task's other product;
// "approval-off": a first run without requested proof in a plan that skips the delivery check.
const cleanupHolds = { answered: "worktreeStatus", detected: "trackedChangesSince", restoring: "discardChanges", commit: "resetTo", companion: "resetTo", "approval-off": "worktreeStatus" } as const;
for (const phase of Object.keys(cleanupHolds) as (keyof typeof cleanupHolds)[]) it(`keeps the resumed run unverified when Petrina closes after the Tester answered, with its cleanup ${phase === "approval-off" ? "starting in a plan without the delivery check" : `held when ${phase}`}`, async () => {
  const fakeRoot = tempDir("petrina-acceptance-cleanup-close-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const shared = phase === "companion", gated = phase !== "approval-off", committed = phase === "commit" || phase === "companion";
  const f = await fixture(shared, false, fakes);
  const reopen = async () => {
    f.engine = new Engine(f.engine.dataDir, { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.engine.setPoolPaused(false); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
  };
  const saved = () => { const store = new Store(join(f.engine.dataDir, "petrina.db")); try { return store.load()!.tasks.find(task => task.id === f.task.id)!; } finally { store.close(); } };
  const release = Promise.withResolvers<void>();
  let holding = false, spy: { mockRestore(): void } | undefined;
  try {
    const request = gated ? await f.request() : undefined;
    const touched = f.owners[shared ? 1 : 0]!;
    writeFileSync(join(touched.worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await git(touched.worktree, "add", "."); await git(touched.worktree, "commit", "-q", "-m", "Save a project file");
    if (gated) { f.products[0]!.shipLowRisk = true; f.task.retest = true; }
    else { f.task.approveDelivery = false; f.products[0]!.approveDelivery = false; f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.gate !== "delivery"); }
    f.task.stageIndex = 1;
    const name = cleanupHolds[phase], original = gitSteps[name] as (path: string, ...rest: unknown[]) => Promise<unknown>;
    spy = spyOn(gitSteps, name).mockImplementation((async (path: string, ...rest: unknown[]) => {
      if (!holding && path === touched.worktree && fakes.marked("tester-passed-once") && !f.engine.runs.has(f.task.id)) { holding = true; await release.promise; }
      return original(path, ...rest);
    }) as never);
    fakes.scenario({ reopen: "resume", testerFiles: [{ dir: touched.worktree, file: "tester-edit.txt", text: "Changed during acceptance\n", commit: committed }], ...(request ? { testerProofAnswers: passes([request.id]) } : {}) });
    const running = f.engine["work"].runDo(f.scope, f.tester, signal()).then(() => undefined, (error: unknown) => error);
    await waitFor(() => holding, `the cleanup to reach the ${phase} point`);
    const stopping = f.engine.shutdown(); release.resolve(); await stopping; await running;
    spy.mockRestore(); spy = undefined;
    expect(readFileSync(join(touched.worktree, "tester-edit.txt"), "utf8")).toBe("Saved before acceptance\n");
    expect(await git(touched.worktree, "status", "--porcelain")).toBe("");
    // The last save kept the run marked; a fact noted before the close was saved with it.
    expect(saved().acceptanceCleanupPending).toMatch(/^[0-9a-f]{24}$/);
    expect(saved().acceptanceRun!.restored !== undefined).toBe(["restoring", "commit", "companion"].includes(phase));
    await reopen();
    const restored = [{ productId: touched.productId, ...(committed ? { commits: true } : { edits: true }), files: ["tester-edit.txt"] }];
    expect(f.task.acceptanceCleanupPending).toBeUndefined(); expect(f.task.acceptanceRun!.restored!.products).toEqual(restored);
    expect(f.task.timeline.some(entry => entry.text === restoredLine(committed ? "commits" : "changes to project files", shared ? "Product 2" : "Product 1", "tester-edit.txt"))).toBe(true);
    // The same conversation reopens and answers with a pass, without editing again.
    fakes.scenario({ reopen: "resume", ...(request ? { testerProofAnswers: passes([request.id]) } : {}) });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(fakes.openings("tester")).toHaveLength(1);
    expect(testerSteps(f).at(-1)!.proofRun!.restored!.products).toEqual(restored);
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true);
    expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined();
    expect(f.engine["driver"]["shipsUnasked"](f.task)).toBe(false);
    if (request) expect(f.task.proofRequests![0]).toMatchObject({ status: "unverified", proof: { result: "blocked", reason: ACCEPTANCE_RESTORED } });
    else expect(f.task.plan!.stages.some(stage => stage.kind === "gate" && stage.gate === "delivery")).toBe(true);
  } finally { release.resolve(); spy?.mockRestore(); await f.engine.shutdown(); }
});

it("keeps an undone change with its acceptance run through a stand-in and a restart, then settles it unverified once", async () => {
  const fakeRoot = tempDir("petrina-acceptance-continuation-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    f.task.retest = true; f.task.stageIndex = 1;
    // The first Tester edits and runs out of usage; its stand-in edits nothing and works until Petrina restarts.
    fakes.scenario({ tester: "work", limited: [{ model: "opus", role: "tester" }], testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited before running out\n", model: "opus" }], testerProofAnswers: passes([request.id]) });
    const first = f.engine["work"].runDo(f.scope, f.tester, signal()).then(() => undefined, (error: unknown) => error);
    await waitFor(() => fakes.marked("tester-worked"), "the stand-in Tester to be at work");
    const restored = [{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }];
    expect(f.task.acceptanceRun!.restored!.products).toEqual(restored);
    expect(testerSteps(f)).toHaveLength(2);
    expect(testerSteps(f).every(step => step.proofRun?.restored?.products.length === 1)).toBe(true);
    expect(readFileSync(join(worktree, "tester-edit.txt"), "utf8")).toBe("Saved before acceptance\n");
    const run = structuredClone(f.task.acceptanceRun);
    f.engine.setPoolPaused(true); await f.engine.shutdown(); await first;
    f.engine = new Engine(f.engine.dataDir, { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.engine.setPoolPaused(false); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    expect(f.task.acceptanceRun).toEqual(run);
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    const saved = f.task.proofRequests![0]!, final = testerSteps(f).at(-1)!;
    expect(saved.status).toBe("unverified"); expect(saved.proof).toMatchObject({ stepId: final.id, versions: run!.versions, result: "blocked", reason: ACCEPTANCE_RESTORED });
    expect(final.profileId).not.toBe("opus-high"); expect(final.proofRun!.restored!.products).toEqual(restored);
    expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.acceptanceRun).toBeUndefined();
    expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined();
  } finally { await f.engine.shutdown(); }
});

it("saves a take-over's undone tracked edit with the acceptance run, while new output alone stays harmless", async () => {
  const f = await fixture();
  try {
    const worktree = f.scope.work.worktree!;
    f.task.stageIndex = 1; f.task.acceptanceRun = { versions: await versionsOf(f.task), changes: await changesOf(f.task), requestIds: [] };
    f.scope.work.conversation = { step: stepKey(f.task), roleId: "tester", profileId: "opus-high", toolId: "claude-code", model: "opus", sessionId: "tester", startedAt: 1, access: { canEdit: false } };
    writeFileSync(join(worktree, "output.log"), "New output\n");
    await f.engine.undoReadOnly(f.task, "tester", worktree);
    expect(f.task.acceptanceRun.restored).toBeUndefined(); expect(await git(worktree, "status", "--porcelain")).toBe("");
    writeFileSync(join(worktree, "feature.txt"), "Edited before the take-over\n"); writeFileSync(join(worktree, "output.log"), "New output\n");
    await f.engine.undoReadOnly(f.task, "tester", worktree);
    expect(f.task.acceptanceRun.restored!.products).toEqual([{ productId: f.task.productId, edits: true, files: ["feature.txt"] }]);
    expect(await git(worktree, "status", "--porcelain")).toBe(""); expect(readFileSync(join(worktree, "feature.txt"), "utf8")).toBe("the task's change\n");
    expect(f.task.timeline.some(entry => entry.text === restoredLine("changes to project files", "Product 1", "feature.txt"))).toBe(true);
  } finally { await f.engine.shutdown(); }
});

it("keeps an undone change with its acceptance run through the coordinator's take-over and hand back", async () => {
  const fakeRoot = tempDir("petrina-acceptance-takeover-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  // The take-over only writes its launcher: the tool's path answers its help check, and no terminal opens.
  const f = await fixture(false, false, fakes, { toolPath: () => process.execPath });
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    writeFileSync(join(worktree, "tester-edit.txt"), "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    f.task.retest = true; f.task.stageIndex = 1;
    fakes.scenario({ tester: "work", testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Edited before the take-over\n" }], testerProofAnswers: passes([request.id]) });
    const driving = f.drive();
    await waitFor(() => fakes.marked("tester-worked") && f.scope.work.conversation?.briefed, "the Tester to be at work");
    await f.engine.takeOver(f.task.id, "copy"); await driving;
    const restored = [{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }];
    expect(f.task.driving).toBeDefined(); expect(f.task.acceptanceRun!.restored!.products).toEqual(restored);
    expect(readFileSync(join(worktree, "tester-edit.txt"), "utf8")).toBe("Saved before acceptance\n");
    expect(f.task.timeline.some(entry => entry.text === restoredLine("changes to project files", "Product 1", "tester-edit.txt"))).toBe(true);
    // After the hand back the same run continues, without editing again, and answers with a pass.
    fakes.scenario({ tester: "work", testerProofAnswers: passes([request.id]) });
    await f.engine.handBack(f.task.id, "", true);
    await waitFor(() => f.engine.s.inbox.find(item => item.kind === "delivery"), "the delivery check after the hand back");
    expect(request.status).toBe("unverified"); expect(request.proof).toMatchObject({ result: "blocked", reason: ACCEPTANCE_RESTORED });
    expect(testerSteps(f).at(-1)!.proofRun!.restored!.products).toEqual(restored);
    expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined();
    expect(fakes.openings("tester")).toHaveLength(2);
  } finally { await f.engine.shutdown(); }
});

// Git converts a restored file's line endings when its repository asks for that, as Git for Windows' own settings do;
// fixture repositories keep files as written. Only the bytes tell the two apart: Git sees no change either way.
for (const converted of [false, true]) for (const committed of [false, true]) it(`restores the file behind an undone ${committed ? "commit" : "tracked edit"} ${converted ? "with the line endings its repository converts to" : "exactly as written"}`, async () => {
  const fakeRoot = tempDir("petrina-acceptance-line-endings-"); roots.push(fakeRoot);
  const fakes = new Fakes(fakeRoot);
  const f = await fixture(false, false, fakes);
  try {
    const worktree = f.scope.work.worktree!, edited = join(worktree, "tester-edit.txt");
    // The task's linked working copy shares the product's settings.
    if (converted) await git(f.products[0]!.path!, "config", "core.autocrlf", "true");
    writeFileSync(edited, "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Save a project file");
    f.task.stageIndex = 1;
    fakes.scenario({ testerFiles: [{ dir: worktree, file: "tester-edit.txt", text: "Changed during acceptance\n", commit: committed }] });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(testerSteps(f).at(-1)!.proofRun!.restored!.products).toEqual([{ productId: f.task.productId, ...(committed ? { commits: true } : { edits: true }), files: ["tester-edit.txt"] }]);
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    const restored = readFileSync(edited, "utf8"), expected = converted ? "Saved before acceptance\r\n" : "Saved before acceptance\n";
    // Bun's diff shows both line endings alike: the escaped text gets a line of its own.
    if (restored !== expected) console.error(`Restored ${JSON.stringify(restored)} where ${JSON.stringify(expected)} was expected`);
    expect(restored).toBe(expected);
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

it("refreshes a released prerequisite before publishing and retains exact-version proof approval", async () => {
  const f = await fixture(); const request = await f.request(); await f.recordPass();
  try {
    f.task.startedAt = 1; f.task.stageIndex = 4; f.task.proofRefreshes = 2;
    f.task.approvedProofDecision = proofDecision(f.task, await versionsOf(f.task));
    const approved = structuredClone(f.task.approvedProofDecision);
    expect(await f.engine["shipping"]["prepare"](f.scope, f.ship, signal())).toBe("ready");
    const prerequisite = f.engine.addTask({ productId: f.products[0]!.id, title: "Land the required fix", backlog: true });
    f.engine.setRuntimeWait(f.task.id, [prerequisite], "Publishing needs this fix", "proof-wait");
    await f.advance();
    const destination = await git(f.products[0]!.path!, "rev-parse", "main");
    f.engine.setRuntimeWait(f.task.id, [], "The required source is ready", "proof-clear");
    expect(await f.engine["shipping"].deliver(f.task, f.ship, signal())).toBe("continue");
    expect(f.task.runtimeWait?.refreshPending).toBe(true);
    expect(await f.engine["driver"]["refreshAfterWait"](f.task, signal())).toBe(false);
    expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
    expect(f.task.approvedProofDecision).toEqual(approved);
    expect(await f.engine["shipping"].deliver(f.task, f.ship, signal())).toBe("continue");
    expect(f.task.stageIndex).toBe(3);
    expect(f.task.approvedProofDecision).toBeUndefined();
    expect(request.status).toBe("stale");
    expect(f.task.proofRefreshes).toBe(2);
    expect(f.task.findings).toEqual([]);
    expect(await git(f.products[0]!.path!, "rev-parse", "main")).toBe(destination);
    await f.drive();
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("earlier version");
    expect(f.task.checkedProofDecision).not.toEqual(approved);
    expect(f.task.proofRefreshes).toBe(2);
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
    if (started) await f.engine["shipping"]["returnForDecision"](f.task, "proof");
    else expect(await f.engine["shipping"]["readyToShip"](f.scope, signal())).toBe("back");
    const steps = f.task.journey!.filter(step => step.kind === "petrina" && step.work === "delivery");
    expect(steps).toHaveLength(1); expect(steps[0]!.outcome).toBe("Nothing published; a new delivery decision is needed");
    expect(steps[0]!.endedAt).toBeDefined(); expect(steps[0]!.reason).toContain("differ from your delivery decision");
    expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined();
  } finally { await f.engine.shutdown(); }
});
