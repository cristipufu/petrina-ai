import { acceptanceAgents } from "./fixtures/acceptance-agents.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyView, nextLine, type DeepMutable, type Product, type Task, type WorkflowEvent } from "@petrina/core";
import { Engine } from "./engine.js";
import { git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";
import { commandText } from "../src/checks.js";
import { Coordination } from "../src/coordination.js";

/** The parts of a review's completion report these cases read. */
type ReviewReport = WorkflowEvent & { openImportant: string[]; stillOpen: string[]; reopened: unknown[]; heldForDecision?: string[]; reportCounts: { closing: { open: { important: number } } } };

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const GREETING = "People see the greeting on the welcome page";
const PHONE = "The greeting reads well on a phone";
const UNAVAILABLE = "The phone simulator is unavailable, so the page could not be opened on a phone.";
const failing = (productIds: string[], text = GREETING) => ({ text, result: "fail" as const, evidence: "Opened the welcome page: no greeting appears; expected it at the top.", productIds });
const passed = (productIds: string[], text = GREETING) => ({ text, result: "pass" as const, evidence: `Opened the welcome page and saw: ${text}`, productIds });
const blocked = (productIds: string[], text = PHONE) => ({ text, result: "blocked" as const, reason: UNAVAILABLE, evidence: "Tried to start the phone simulator twice; it never opened.", productIds });

const REPAIR_CHECK = "Checking the builder's repair of the failed acceptance checks; the planned reviews follow";
const FINAL_TEST = "Final acceptance testing after review: the final code needs current acceptance evidence";
const STILL_FAILS = "Acceptance still fails: the builder returns are unavailable or used up. The remaining reviews run first, then the decision goes to you at your delivery check";
/** Every planned review seat, once: the code review's two seats and the security review. */
const ALL_SEATS = ["review:1:code-reviewer:opus-high", "review:1:code-reviewer:sol-high", "security:1:security-reviewer:opus-high"];

/**
 * A shared task past its build, on two products: acceptance testing, a code review with two seats, a security review,
 * then publishing, with or without a delivery check planned from the start. The coding tools are the scripted stand-ins.
 */
async function fixture(options: { gate: boolean; checklist?: readonly string[]; custom?: boolean }) {
  const root = tempDir("petrina-acceptance-repair-"); roots.push(root);
  const responses = acceptanceAgents();
  const engineOptions = { agentCommand: () => [process.execPath, join(import.meta.dir, "unconfigured-service.ts"), "acceptance fixture"], startAgentSession: responses.start, terminals: () => [] };
  const engine = new Engine(join(root, "data"), engineOptions);
  engine.schedule = () => {};
  await engine.waitUntilReady();
  engine.setPoolPaused(false);
  const products: DeepMutable<Product>[] = [];
  for (let i = 0; i < 2; i++) {
    const dir = join(root, `product-${i}`); mkdirSync(dir);
    const repo = await makeProduct(dir); await git(repo, "remote", "remove", "origin");
    const id = await engine.addProduct(repo);
    engine.updateProduct(id, { name: `Product ${i + 1}`, delivery: "local", approveDelivery: options.gate });
    engine.setProductChecks(id, [{ name: "Test", command: commandText([process.execPath, "-e", "process.exit(0)"]) }]);
    products.push(engine.s.products.find(product => product.id === id)!);
  }
  const task = engine.task(engine.addTask({ productId: products[0]!.id, title: "Show the greeting", backlog: true }))!;
  const owners = [];
  for (const [i, product] of products.entries()) {
    const worktree = join(root, `work-${i}`), baseSha = await git(product.path!, "rev-parse", "HEAD"), branch = `greeting-${i}`;
    await git(product.path!, "worktree", "add", "-q", "-b", branch, worktree, baseSha);
    writeFileSync(join(worktree, "greeting.txt"), "Hello\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "Add the greeting");
    owners.push({ productId: product.id, worktree, baseSha, base: baseSha, branch, delivery: "local" as const, completedStages: ["build"], preparation: "ready" as const,
      source: { product, start: { kind: "default" as const, branch: "main" }, destination: { mode: "local" as const, kind: "branch" as const, repo: product.repo, branch: "main" }, confirmed: true } });
  }
  delete task.repository; task.repositories = owners; task.activeProductId = products[0]!.id;
  const build = { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
  const tester = { id: "test", title: "Acceptance", kind: "do" as const, roleId: "tester", profileIds: ["opus-high"] };
  // Petrina finds the acceptance role by its checks result, whatever it is called.
  if (options.custom) { engine.s.roles.push({ ...engine.role("tester")!, id: "quality-partner", name: "Quality partner" }); tester.roleId = "quality-partner"; }
  const review = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"], maxRounds: 2 };
  const security = { id: "security", title: "Security review", kind: "review-chain" as const, roleId: "security-reviewer", profileIds: ["opus-high"], maxRounds: 2 };
  const gate = { id: "gate", title: "Your delivery check", kind: "gate" as const, gate: "delivery" as const, roleId: "release-manager", profileIds: [] };
  const ship = { id: "ship", title: "Ship", kind: "do" as const, roleId: "release-manager", profileIds: ["opus-high"] };
  task.plan = { rationale: "Focused shared acceptance workflow", plannerProfileId: "sol-high", stages: [build, tester, review, security, ...(options.gate ? [gate] : []), ship] };
  task.approveDelivery = options.gate;
  task.brief = { summary: "Show the greeting", areas: [], forUsers: [], risks: [], acceptance: (options.checklist ?? [GREETING]).map(text => ({ text })) };
  task.state = "running"; task.stageIndex = 1;
  const f = {
    root, responses, engine, task, products, ids: products.map(product => product.id) as [string, string], review, security, tester: tester.roleId,
    mains: () => Promise.all(products.map(product => git(product.path!, "rev-parse", "main"))),
    /** Runs the task until it waits, stops, or (with `stop`) is about to admit an agent while `stop` holds. */
    drive: async (stop?: (task: Task) => boolean) => {
      const admit = spyOn(f.engine["driver"] as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockImplementation(async () => !stop?.(f.task as Task));
      try { f.task.state = "running"; await f.engine["driver"]["drive"](f.task.id); if (f.engine.task(f.task.id)?.state === "failed") throw new Error(f.task.error); }
      finally { admit.mockRestore(); }
    },
    decisions: () => f.engine.s.inbox.filter(item => item.taskId === f.task.id && item.kind === "delivery"),
    /** Finished agent steps of one role, in the order they ran. */
    runs: (roleId: string) => f.task.journey!.filter(step => step.kind === "agent" && step.roleId === roleId && step.endedAt !== undefined),
    /** Which planned review seats actually handed back a result: review stage, round, role and profile. */
    seats: () => f.task.journey!.filter(step => step.kind === "agent" && (step.stageId === review.id || step.stageId === security.id))
      .flatMap(step => (step.agentResults ?? []).filter(result => result.roleId === "code-reviewer" || result.roleId === "security-reviewer").map(result => `${step.stageId}:${step.round}:${result.roleId}:${result.profileId}`)).sort(),
    /** The work as it happened: each agent step's stage (with the Builder's product) and each delivery decision. */
    order: () => f.task.journey!.flatMap(step => step.kind === "agent" && step.roleId !== "verifier" ? [step.builderReturn ? `build:${f.ids.indexOf(step.builderReturn.productId) + 1}` : step.stageId!]
      : step.kind === "you" && step.waitsFor === "delivery" ? ["decision"] : []),
    heldFailure: () => f.task.findings.filter(finding => finding.text === `Failed acceptance check: ${GREETING}`),
    /** The reviews' completion reports, as a coordinator watching the task reads them. */
    reviewReports: async () => ((await new Coordination(f.engine).call("watch.events", { taskIds: [f.task.id], kinds: ["review.finished"], from: "oldest", timeoutMs: 0 })).events as WorkflowEvent[]).filter(event => event.kind === "review.finished") as unknown as ReviewReport[],
    /** Petrina quits and starts again on the same saved state. */
    restart: async () => {
      f.engine.setPoolPaused(true); await f.engine.shutdown();
      f.engine = new Engine(f.engine.dataDir, engineOptions);
      f.engine.schedule = () => {};
      await f.engine.waitUntilReady(); f.engine.setPoolPaused(false);
      // A returning Builder waits for its tool's check, which a start runs again.
      await waitFor(() => !f.engine.s.setup?.checks.some(check => check.checking), "the tool checks after the restart");
      f.task = f.engine.task(task.id)!;
    },
  };
  return f;
}

for (const [gate, custom] of [[true, false], [false, false], [true, true]] as const) it(`runs every owed review after a successful early acceptance repair, then ${gate ? "asks at the planned delivery check" : "ships on its own as the task's settings allow"}${custom ? " (custom acceptance role)" : ""}`, async () => {
  const f = await fixture({ gate, custom });
  try {
    const [first] = f.ids;
    // The first product fails acceptance; the Builder's repair (it adds the welcome page) passes.
    f.responses.configure({ builder: "plain", fixes: "change", testerChecks: [failing([first])], testerChecksFixed: [passed([first])] });
    const before = await f.mains();
    await f.drive();
    // Only the affected product went back to the Builder, once; ordinary acceptance testing then checked the repair,
    // and both code review seats and the security review ran after it, in plan order.
    expect(f.order()).toEqual(["test", "build:1", "test", "review", "security", ...(gate ? ["decision"] : [])]);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.runs(f.tester)[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.heldFailure().map(finding => finding.status)).toEqual(["fixed"]);
    // Acceptance testing settled the repaired failure; the reviews record neither the Builder's claim nor that fix as theirs.
    const results = f.task.journey!.filter(step => step.kind === "agent" && (step.stageId === f.review.id || step.stageId === f.security.id));
    expect(results.map(step => step.outcome)).toEqual(["2 nits", "Nothing to fix"]);
    expect(results.flatMap(step => [...step.result?.findingChanges?.claimedFixed ?? [], ...step.result?.findingChanges?.fixed ?? []])).toEqual([]);
    // No final retest of unchanged work, and no checkpoint the plan did not have.
    expect(f.task.timeline.some(entry => entry.text === "Trying the acceptance list once more on the final code")).toBe(false);
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(gate ? 1 : 0);
    if (gate) {
      expect(f.decisions()).toHaveLength(1);
      expect(await f.mains()).toEqual(before);
      f.engine.approve(f.decisions()[0]!.id);
      await f.drive();
    } else expect(f.decisions()).toEqual([]);
    expect(f.task.repositories!.every(work => work.landed)).toBe(true);
    expect((await f.mains()).every((sha, index) => sha !== before[index])).toBe(true);
    expect(f.runs(f.tester)).toHaveLength(2);
  } finally { await f.engine.shutdown(); }
});

for (const gate of [true, false]) it(`repairs a real failure while another required item stays unavailable, runs every owed review, then asks one decision at ${gate ? "the planned" : "an added"} delivery check`, async () => {
  const f = await fixture({ gate, checklist: [GREETING, PHONE] });
  try {
    const [first, second] = f.ids;
    f.responses.configure({ builder: "plain", fixes: "change", testerChecks: [failing([first]), blocked([second])], testerChecksFixed: [passed([first]), blocked([second])] });
    const before = await f.mains();
    await f.drive();
    // The unavailable item alone sends nothing back: only the failure's product is repaired, and checked once more.
    expect(f.order()).toEqual(["test", "build:1", "test", "review", "security", "decision"]);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.findings.some(finding => finding.text.includes(PHONE))).toBe(false);
    // One checkpoint, reused or added once, and one decision naming the unavailable item.
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    expect(f.task.proofDeliveryGate === undefined).toBe(gate);
    expect(f.task.timeline.filter(entry => entry.text.startsWith("Added your delivery check"))).toHaveLength(gate ? 0 : 1);
    expect(f.decisions()).toHaveLength(1);
    const [decision] = f.decisions();
    expect(decision!.title).toBe("Your call on “Show the greeting”: 1 acceptance check could not be verified");
    expect(decision!.body).toContain(`• ${PHONE} (Product 2) — ${UNAVAILABLE}`);
    expect(await f.mains()).toEqual(before);
    f.engine.approve(decision!.id);
    await f.drive();
    expect(f.task.repositories!.every(work => work.landed)).toBe(true);
    expect(f.task.brief!.acceptance.map(item => item.verification)).toEqual(["passed", "blocked"]);
    expect(f.runs("tester")).toHaveLength(2);
  } finally { await f.engine.shutdown(); }
});

// The controller owns the failure-only added-gate variant. Keep full planned-gate and mixed-evidence journeys.
for (const [gate, mixed] of [[true, false], [false, true]] as const) it(`keeps used-up acceptance failures open for one decision after every owed review, at ${gate ? "the planned" : "an added"} delivery check${mixed ? ", beside an unavailable item" : ""}`, async () => {
  const f = await fixture({ gate, checklist: mixed ? [GREETING, PHONE] : [GREETING] });
  try {
    const [first, second] = f.ids;
    // The failure is reproduced on every run: both of the first product's returns are used.
    f.responses.configure({ builder: "plain", fixes: "change", testerChecks: [failing([first]), ...(mixed ? [blocked([second])] : [])] });
    const before = await f.mains();
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "test", "build:1", "test", "review", "security", "decision"]);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, undefined]);
    expect(f.task.acceptanceBlocked).toBe(true);
    expect(f.task.timeline.filter(entry => entry.text === STILL_FAILS)).toHaveLength(1);
    // Every planned seat reviewed once: the held failure started no fix round, and no Builder claim closed it.
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.rounds[f.review.id] ?? 1).toBe(1);
    expect(f.heldFailure().map(finding => finding.status)).toEqual(["open"]);
    // Each review's saved result holds only what that review looked at: the Builder's earlier claims about the held
    // failure were already tested by acceptance, and the failure is no review finding.
    const [held] = f.heldFailure();
    const results = f.task.journey!.filter(step => step.kind === "agent" && (step.stageId === f.review.id || step.stageId === f.security.id));
    expect(results.map(step => step.outcome)).toEqual(["2 nits", "Nothing to fix"]);
    expect(results.flatMap(step => step.result?.findings ?? []).some(finding => finding.id === held!.id)).toBe(false);
    expect(results.flatMap(step => step.result?.findingChanges?.claimedFixed ?? [])).toEqual([]);
    // Reviewers are not asked about it and never reopen it. Each review's completion report keeps its task-wide counts,
    // where the failure really is still open and Important, and names it as held for your decision rather than review work.
    for (const role of ["code-reviewer", "security-reviewer"]) expect(f.responses.prompts(role).some(text => text.includes(held!.id))).toBe(false);
    expect(held!.reopenedAt).toBeUndefined();
    const reports = await f.reviewReports();
    expect(reports.map(report => [report.openImportant, report.stillOpen, report.reopened, report.heldForDecision, report.reportCounts.closing.open.important]))
      .toEqual([[[held!.id], [held!.id], [], [held!.id], 1], [[held!.id], [held!.id], [], [held!.id], 1]]);
    expect(reports[0]!.summary).toContain("3 open reports (1 Important, 2 nits, 0 pre-existing follow-ups); 1 of the Important is an acceptance failure held for your delivery decision, not review work;");
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    expect(f.task.proofDeliveryGate === undefined).toBe(gate);
    expect(f.task.timeline.filter(entry => entry.text.startsWith("Added your delivery check")).map(entry => entry.text)).toEqual(gate ? [] : [mixed
      ? "Added your delivery check: a required acceptance check could not be verified, so delivery waits for your decision"
      : "Added your delivery check: acceptance still fails, so delivery waits for your decision"]);
    expect(f.decisions()).toHaveLength(1);
    const [decision] = f.decisions();
    expect(decision!.title).toBe("Your call on “Show the greeting”: 1 blocking finding still open");
    expect(f.task.statusLine).toBe("Acceptance still fails after the builder's returns. Your call");
    if (mixed) expect(decision!.body).toContain(`• ${PHONE} (Product 2) — ${UNAVAILABLE}`);
    expect(await f.mains()).toEqual(before);
    expect(f.task.repositories!.every(work => !work.landed)).toBe(true);
    // A restart keeps the used returns, the hold and the one pending decision.
    await f.restart();
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, undefined]);
    expect(f.decisions().map(item => item.id)).toEqual([decision!.id]);
    // Your explicit approval ships both products, with no further acceptance run, Builder return or review.
    f.engine.approve(decision!.id);
    await f.drive();
    expect(f.task.repositories!.every(work => work.landed)).toBe(true);
    expect((await f.mains()).every((sha, index) => sha !== before[index])).toBe(true);
    expect(f.order()).toEqual(["test", "build:1", "test", "build:1", "test", "review", "security", "decision"]);
  } finally { await f.engine.shutdown(); }
});

it("never asks reviewers to confirm a used-up acceptance failure, so reviewers who confirm what they are shown neither answer twice nor count it", async () => {
  const f = await fixture({ gate: true });
  try {
    const [first] = f.ids;
    // These reviewers confirm every finding they are shown in their first round.
    f.responses.configure({ builder: "plain", fixes: "change", reviewer: "confirm", testerChecks: [failing([first])] });
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "test", "build:1", "test", "review", "security", "decision"]);
    const [held] = f.heldFailure();
    // Each code reviewer answered once: nothing it was shown needed fresh proof, and the held failure gained no support.
    expect(f.responses.prompts("code-reviewer").filter(text => text.includes("Current evidence is required"))).toEqual([]);
    expect(f.responses.prompts("code-reviewer").filter(text => text.includes(held!.id))).toEqual([]);
    expect(held!.confirmedBy).toEqual([]);
    const review = f.task.journey!.filter(step => step.kind === "agent" && step.stageId === f.review.id);
    expect(review.flatMap(step => [...step.result?.findings ?? [], ...(step.agentResults ?? []).flatMap(result => result.findings ?? [])]).some(finding => finding.id === held!.id)).toBe(false);
    expect(f.task.timeline.some(entry => /confirmed \d/.test(entry.text))).toBe(false);
    expect(f.decisions()).toHaveLength(1);
  } finally { await f.engine.shutdown(); }
});

for (const continued of [false, true]) it(`repairs an independent review finding on its own product only, without handing over a used-up acceptance failure${continued ? " to a Builder continuing its conversation" : ""}`, async () => {
  const f = await fixture({ gate: true });
  try {
    const [first, second] = f.ids;
    // A failure owned by both products uses up both returns; then a reviewer raises an Important finding on the first product.
    f.responses.configure({ builder: "plain", reviewer: "important", affectedProducts: [first], testerChecks: [failing([first, second])], ...(continued ? { reopen: "resume" as const } : {}) });
    await f.drive(task => task.repair?.kind === "review");
    expect(f.task.repair?.kind).toBe("review");
    const review = f.task.findings.find(finding => finding.text === "The greeting is missing on the welcome page.")!;
    const nit = f.task.findings.find(finding => finding.text === "Consider a friendlier greeting.")!;
    expect(nit.severity).toBe("suggestion");
    // Parallel reviewers may finish in either order. Exercise a leading Important report for the fresh Builder
    // and a leading nit for the continuing Builder, without relying on process timing or changing worker counts.
    const leading = continued ? nit : review;
    f.task.findings = [leading, ...f.task.findings.filter(finding => finding.id !== leading.id)];
    await f.drive();
    expect(f.order().slice(0, 7)).toEqual(["test", "build:1", "build:2", "test", "build:1", "build:2", "test"]);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, 2]);
    const [held] = f.heldFailure();
    expect(review.productIds).toEqual([first]);
    // The review's repair visited only its finding's product, and asked only about that finding.
    expect(f.order().slice(7)).toEqual(["review", "build:1", "review", "security", "decision"]);
    expect(f.runs("builder").at(-1)!.findingIds).toContain(review.id); expect(f.runs("builder").at(-1)!.findingIds).not.toContain(held!.id);
    // Fresh or continued, the Builder's instructions and the saved context it is told to read leave the held failure out.
    // A continuing Builder, which was given it in an earlier repair, is told it is no longer in its list.
    const prompt = f.responses.prompts("builder").at(-1)!;
    expect(prompt).toContain(review.text); expect(prompt).not.toContain(held!.text);
    expect(prompt).not.toContain(`[${held!.id}]`); expect(prompt).not.toContain(`${held!.id}: open`);
    if (continued) {
      const index = prompt.split("## Current finding status index\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
      expect(index).toContain(`- ${review.id}: open, important`);
      expect(index).toContain(`- ${nit.id}: open, nit`);
      expect(index).toContain(`No longer present: ${held!.id}.`);
    } else expect(prompt).not.toContain(held!.id);
    const packet = readFileSync(f.task.repositories![0]!.builderSession!.context!.file, "utf8");
    expect(packet).toContain(review.id); expect(packet).not.toContain(held!.id); expect(packet).not.toContain(held!.text);
    expect(review.status).toBe("fixed");
    // The held failure counted toward neither round, and the Builder's answer about the other finding did not close it.
    expect(f.task.blockingFindingsAfter![f.review.id]).toEqual([[review.id], []]);
    expect(held!.status).toBe("open");
    expect(f.seats()).toEqual([...ALL_SEATS, "review:2:code-reviewer:opus-high", "review:2:code-reviewer:sol-high"].sort());
    expect(f.decisions()).toHaveLength(1);
    expect(f.task.statusLine).toBe("Acceptance still fails after the builder's returns. Your call");
  } finally { await f.engine.shutdown(); }
});

it("keeps an early acceptance repair on its route through the owed reviews across a restart and a retry", async () => {
  const f = await fixture({ gate: true });
  try {
    const [first] = f.ids;
    f.responses.configure({ builder: "plain", fixes: "change", testerChecks: [failing([first])], testerChecksFixed: [passed([first])] });
    // Petrina stops before the Builder starts its repair; the saved repair is an early one, as is one saved before this mark existed.
    await f.drive(task => task.repair?.kind === "acceptance");
    expect(f.task.repair).toEqual({ products: [first], index: 0, returnStage: 1, kind: "acceptance" });
    await f.restart();
    expect(f.task.repair).toEqual({ products: [first], index: 0, returnStage: 1, kind: "acceptance" });
    // The step gets stuck and you retry it.
    f.engine.fail(f.task.id, new Error("The Builder's tool stopped answering"));
    await f.engine.retry(f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "stuck")!.id);
    // The repair is finished; you pause before its acceptance test starts. That test still shows as next, then the reviews.
    await f.drive(task => task.repairCheck === true);
    expect(f.order()).toEqual(["test", "build:1"]);
    f.engine.pause(f.task.id);
    const state = f.engine.getState(), shown = state.tasks.find(task => task.id === f.task.id)!;
    expect(nextLine(state, shown)).toBe("Next: acceptance testing of the repair (Claude Code · Opus 5.5), then code review (Codex · sol and Claude Code · Opus 5.5)");
    expect(journeyView(shown, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox }).nodes.filter(node => ["next", "ahead"].includes(node.state)).map(node => `${node.name}: ${node.state}`))
      .toEqual(["Tester (again): next", "Code reviewers: ahead", "Security reviewer: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]);
    f.engine.resume(f.task.id);
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "test", "review", "security", "decision"]);
    expect(f.runs("tester")[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    // The Tester is told it checks the repair before review, not that this is final testing after review.
    const told = f.responses.openings("tester").at(-1)!;
    expect(told).toContain("This acceptance run checks the builder's repair of an earlier run that did not pass, before review.");
    expect(told).toContain("This run checks the builder's repair of the prior acceptance run, which did not pass; the planned reviews follow.");
    expect(told).not.toContain("final acceptance");
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.decisions()).toHaveLength(1);
  } finally { await f.engine.shutdown(); }
});

for (const repaired of [true, false]) it(`still runs the owed reviews for a task the previous version saved between an early repair and its test, at an added delivery check, ${repaired ? "when the repair passes" : "when its repairs are then used up"}`, async () => {
  const f = await fixture({ gate: false, checklist: [GREETING, PHONE] });
  try {
    const [first, second] = f.ids;
    f.responses.configure({ builder: "plain", fixes: "change", testerChecks: [failing([first]), blocked([second])], ...(repaired ? { testerChecksFixed: [passed([first]), blocked([second])] } : {}) });
    await f.drive(task => task.repairCheck === true);
    expect(f.order()).toEqual(["test", "build:1"]);
    expect(f.task.proofDeliveryGate).toBeDefined();
    // Saved as the previous version saved a finished repair: marked as final testing, with no record of its route.
    delete f.task.repairCheck; f.task.retest = true;
    f.engine.commitNow();
    await f.restart();
    expect(f.task.retest).toBe(true);
    // Before its test starts, the plan and Next line already show the reviews after it, as Petrina routes it.
    f.engine.pause(f.task.id);
    const state = f.engine.getState(), shown = state.tasks.find(task => task.id === f.task.id)!;
    expect(nextLine(state, shown)).toBe("Next: acceptance testing of the repair (Claude Code · Opus 5.5), then code review (Codex · sol and Claude Code · Opus 5.5)");
    f.engine.resume(f.task.id);
    await f.drive();
    // The added check does not skip the reviews that never ran, also when the repaired test keeps failing until the
    // returns are used up: all three seats, then one decision.
    expect(f.order()).toEqual(repaired ? ["test", "build:1", "test", "review", "security", "decision"] : ["test", "build:1", "test", "build:1", "test", "review", "security", "decision"]);
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([repaired ? 1 : 2, undefined]);
    // That test checks the repair before review, as its step and the Tester's instructions say.
    expect(f.runs("tester")[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    expect(f.responses.openings("tester")[1]!).toContain("This acceptance run checks the builder's repair of an earlier run that did not pass, before review.");
    expect(f.responses.openings("tester")[1]!).not.toContain("final acceptance");
    if (!repaired) {
      expect(f.heldFailure().map(finding => finding.status)).toEqual(["open"]);
      expect(f.task.timeline.filter(entry => entry.text === STILL_FAILS)).toHaveLength(1);
    }
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    expect(f.decisions()).toHaveLength(1);
    expect(f.decisions()[0]!.body).toContain(`• ${PHONE} (Product 2) — ${UNAVAILABLE}`);
    expect(f.task.repositories!.every(work => !work.landed)).toBe(true);
  } finally { await f.engine.shutdown(); }
});

it("shows the repair's acceptance test next while product checks run before it and while a failed check is repaired first", async () => {
  const f = await fixture({ gate: true });
  const held = join(f.root, "check-held"), release = join(f.root, "check-release"), failed = join(f.root, "check-failed");
  try {
    const [first] = f.ids;
    f.responses.configure({ builder: "plain", fixes: "change", testerChecks: [failing([first])], testerChecksFixed: [passed([first])] });
    // The first product's check, once its repair is in place, waits for the test's release and then fails once.
    const script = join(f.root, "check.js");
    writeFileSync(script, `const fs = require("fs");
if (fs.existsSync("welcome.txt") && !fs.existsSync(${JSON.stringify(failed)})) {
  fs.writeFileSync(${JSON.stringify(held)}, "");
  const started = Date.now();
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() - started < 60000) Bun.sleepSync(20);
  fs.writeFileSync(${JSON.stringify(failed)}, "");
  process.exit(1);
}
`);
    f.engine.setProductChecks(first, [{ name: "Test", command: commandText([process.execPath, script]) }]);
    const read = () => {
      const state = f.engine.getState(), shown = state.tasks.find(task => task.id === f.task.id)!;
      return [nextLine(state, shown), journeyView(shown, { roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox }).nodes.filter(node => ["now", "next", "ahead"].includes(node.state)).map(node => `${node.name}: ${node.state}`)];
    };
    const driving = f.drive(task => task.repair?.kind === "checks");
    await waitFor(() => existsSync(held), "the product check before the repair's acceptance test");
    // Petrina's own checks run before the repair's test: that test is still next, then the owed reviews.
    expect(f.task.repairCheck).toBe(true);
    expect(read()).toEqual(["Next: acceptance testing of the repair (Claude Code · Opus 5.5), then code review (Codex · sol and Claude Code · Opus 5.5)",
      ["Automated checks (again): now", "Tester (again): next", "Code reviewers: ahead", "Security reviewer: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]]);
    writeFileSync(release, "");
    await driving;
    // The check failed, so the Builder repairs it first; the repair's test still follows, before the reviews.
    expect(f.task.repair?.kind).toBe("checks");
    expect(f.task.repairCheck).toBe(true);
    f.engine.pause(f.task.id);
    expect(read()).toEqual(["Next: fixes by the builder (Codex · sol), then acceptance testing of the repair (Claude Code · Opus 5.5)",
      ["Builder (fixes 2): next", "Tester (again): ahead", "Code reviewers: ahead", "Security reviewer: ahead", "Your delivery check: ahead", "Publish delivery: ahead"]]);
    f.engine.resume(f.task.id);
    await f.drive();
    expect(f.order()).toEqual(["test", "build:1", "build:1", "test", "review", "security", "decision"]);
    expect(f.runs("tester")[1]!.trigger?.reason).toBe(REPAIR_CHECK);
    expect(f.seats()).toEqual(ALL_SEATS);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.decisions()).toHaveLength(1);
  } finally { writeFileSync(release, ""); await f.engine.shutdown(); }
});

it("returns final testing's repair straight to the same delivery check after the reviews, across a restart, without another review round", async () => {
  const f = await fixture({ gate: true });
  try {
    const [first] = f.ids;
    // Acceptance passes first; a review fix changes the code; final testing then finds a failure, and its repair passes.
    f.responses.configure({ builder: "plain", fixes: "change", reviewer: "important", affectedProducts: [first], testerRuns: [[passed([first])], [failing([first])], [passed([first])]] });
    await f.drive(task => task.repair?.kind === "acceptance");
    expect(f.order()).toEqual(["test", "review", "build:1", "review", "security", "test"]);
    expect(f.runs("tester")[1]!.trigger?.reason).toBe(FINAL_TEST);
    expect(f.task.repair).toEqual({ products: [first], index: 0, returnStage: 1, kind: "acceptance", final: true });
    await f.restart();
    expect(f.task.repair?.final).toBe(true);
    const reviewed = f.seats();
    await f.drive();
    // The repaired final code gets its final test, then the same delivery check: no review repeats, one decision.
    expect(f.order()).toEqual(["test", "review", "build:1", "review", "security", "test", "build:1", "test", "decision"]);
    expect(f.runs("tester")[2]!.trigger?.reason).toBe(FINAL_TEST);
    expect(f.responses.openings("tester").at(-1)!).toContain("This is final acceptance testing after review.");
    expect(f.seats()).toEqual(reviewed);
    expect(f.task.rounds[f.review.id]).toBe(2);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.heldFailure().map(finding => finding.status)).toEqual(["fixed"]);
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    expect(f.decisions()).toHaveLength(1);
    expect(f.decisions()[0]!.title).toBe("Ready to ship “Show the greeting”");
  } finally { await f.engine.shutdown(); }
});
