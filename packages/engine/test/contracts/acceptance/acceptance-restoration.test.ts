import { afterAll, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_RESTORED, acceptanceSummary, type Task } from "@petrina/core";
import { Fakes, git, tempDir } from "../../fixtures.js";
import { acceptanceAgents } from "../../fixtures/acceptance-agents.js";
import { versionsOf } from "../../../src/repositories.js";
import { recordReviewProofs } from "@petrina/orchestrator";
import { commandText } from "../../../src/checks.js";
import { MAY_CHANGE } from "../../../src/prompts.js";
import { checkpointView } from "../../../src/checkpoint-read.js";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { roots, signal, fixture, passes, greetingPass, testerSteps, restoredLine, close } = proofRequestFixtures();
afterAll(close);
for (const proof of [false, true]) for (const committed of [false, true]) it(`keeps final acceptance unverified once when Petrina undoes an editing role's ${committed ? "commit" : "tracked edit"}, with requested proof ${proof}`, async () => {
  const fakes = acceptanceAgents({ beforeChecks: async ({ cwd }) => {
    writeFileSync(join(cwd, "tester-edit.txt"), committed ? "After the review\n" : "Before the review\n");
    if (committed) { await git(cwd, "add", "tester-edit.txt"); await git(cwd, "commit", "--quiet", "-m", "Tester commits after the review"); }
  } });
  const f = await fixture(false, false, undefined, { startAgentSession: fakes.start });
  try {
    const role = { ...f.engine.role("tester")!, id: "acceptance-specialist", canEdit: true };
    f.engine.s.roles.push(role); f.tester.roleId = role.id;
    const request = proof ? await f.request() : undefined;
    const worktree = f.scope.work.worktree!;
    // A saved project file distinguishes a tracked rewrite from new output. The commit variant
    // also changes history, so both real Git restoration paths remain covered.
    writeFileSync(join(worktree, "tester-edit.txt"), committed ? "Before the review\n" : "Saved before acceptance\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Keep the permitted earlier edit");
    const earlier = await f.recordPass();
    earlier.roleId = role.id; earlier.agentResults![0]!.roleId = role.id;
    writeFileSync(join(worktree, "feature.txt"), "The builder's final change\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Prepare the reviewed final change");
    const versions = await versionsOf(f.task);
    // Approval is normally skipped for this low-risk product.
    f.products[0]!.shipLowRisk = true;
    fakes.configure({ builder: "plain", testerChecks: [greetingPass], ...(request ? { testerProofAnswers: passes([request.id]) } : {}) });

    // Keep the actual turn, final-pass restriction and real Git cleanup; the provider uses its session port.
    await f.drive();

    expect(fakes.openings(role.id)).toHaveLength(1);
    expect(fakes.openings(role.id)[0]).toContain(MAY_CHANGE.afterReview);
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
    expect(fakes.openings(role.id)).toHaveLength(1); expect(f.task.stageIndex).toBe(3);
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
  const fakes = acceptanceAgents({ beforeChecks: ({ cwd }) => {
    if (output === "tester") writeFileSync(join(cwd, "tester-edit.txt"), "Before the review\n");
  } });
  const f = await fixture(false, false, undefined, { startAgentSession: fakes.start });
  try {
    const request = await f.request(); const worktree = f.scope.work.worktree!;
    if (output === "checks") f.engine.setProductChecks(f.task.productId, [{ name: "Test", command: commandText([process.execPath, "-e", "require('node:fs').writeFileSync('check-output.log', 'ran\\n')"]) }]);
    const versions = await versionsOf(f.task);
    fakes.configure({ builder: "plain", testerChecks: [greetingPass], testerProofAnswers: passes([request.id]) });
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
