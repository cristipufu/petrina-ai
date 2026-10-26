import { requiredGapFixtures } from "../../fixtures/required-gaps.js";
import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptanceGap, type DeepMutable } from "@petrina/core";
import { git, waitFor } from "../../fixtures.js";
import { addDeliveryCheck } from "@petrina/orchestrator";

const REQUIRED = "People see the greeting on the welcome page";
const UNAVAILABLE = "The hosted preview account is unavailable, so the welcome page could not be opened.";
const TRIED = "Tried to sign in to the hosted preview twice; both attempts were refused before the page loaded.";
const blocked = (text = REQUIRED, productIds?: string[]) => ({ text, result: "blocked" as const, reason: UNAVAILABLE, evidence: TRIED, ...(productIds ? { productIds } : {}) });
const passed = (text = REQUIRED, productIds?: string[]) => ({ text, result: "pass" as const, evidence: `Opened the welcome page and saw: ${text}`, ...(productIds ? { productIds } : {}) });

const { fixture, close } = requiredGapFixtures(REQUIRED);
afterAll(close);


const SECOND = "The greeting reads well on a phone";
const failing = (text = REQUIRED, productIds?: string[]) => ({ text, result: "fail" as const, evidence: "Opened the welcome page: no greeting appears; expected it at the top.", ...(productIds ? { productIds } : {}) });
const THIRD = "The greeting matches the product's tone";
const signal = () => new AbortController().signal;

for (const role of ["built-in", "custom", "task-owned"] as const) it(`publishes nothing when delivery approval is off and a required checklist item could not be verified, and asks one delivery decision (${role} acceptance role)`, async () => {
  const f = await fixture({ role });
  try {
    f.fakes.scenario({ testerChecks: [blocked()] });
    const before = await f.mains();
    await f.drive();
    expect(f.scope.work.landed).toBeUndefined();
    expect(await f.mains()).toEqual(before);
    expect(f.decisions()).toHaveLength(1);
    // The unavailable item alone: the planned review finishes, with no Builder return, repeated testing or review.
    expect(f.fakes.openings(f.testerName)).toHaveLength(1);
    expect(f.runs("builder")).toHaveLength(0);
    expect(f.runs("code-reviewer")).toHaveLength(1);
    expect(f.task.findings.filter(finding => finding.status === "open" && finding.severity === "blocking")).toEqual([]);
    expect(f.scope.work.acceptanceReturns).toBeUndefined();
    // The plan gains the existing delivery check, and the decision names the item, why, what was tried and the versions.
    expect(f.task.plan!.stages.map(stage => stage.kind)).toEqual(["do", "do", "review-chain", "gate", "do"]);
    expect(f.task.proofDeliveryGate).toBeDefined();
    expect(f.task.timeline.some(entry => entry.text === "Added your delivery check: a required acceptance check could not be verified, so delivery waits for your decision")).toBe(true);
    const [decision] = f.decisions();
    expect(decision!.title).toBe("Your call on “Show the greeting”: 1 acceptance check could not be verified");
    expect(decision!.body).toContain(`1 acceptance check could not be verified:\n• ${REQUIRED} — ${UNAVAILABLE}\n  Tried: ${TRIED}\nWhat would ship: the same contents as tested.`);
    const run = f.runs().at(-1)!, tree = await git(f.scope.work.worktree!, "rev-parse", "HEAD^{tree}");
    const saved = f.task.journey!.findLast(step => step.kind === "you" && step.waitsFor === "delivery")!;
    expect(saved.acceptanceGap).toEqual({ stepId: run.id, reportIndex: 0, items: [{ text: REQUIRED, reason: UNAVAILABLE, evidence: TRIED }],
      tested: { [f.task.productId]: tree }, prepared: { [f.task.productId]: tree }, coverage: [{ productId: f.task.productId, state: "same-contents" }] });
    // An explicit approval ships with the recorded gap, which stays unverified.
    f.engine.approve(decision!.id);
    expect(f.task.approvedAcceptanceGap).toEqual({ stepId: run.id, reportIndex: 0, items: [{ text: REQUIRED, reason: UNAVAILABLE, evidence: TRIED }] });
    await f.drive();
    expect(f.scope.work.landed).toBeDefined();
    expect(await f.mains()).not.toEqual(before);
    expect(f.task.brief!.acceptance).toEqual([{ text: REQUIRED, verification: "blocked", reason: UNAVAILABLE }]);
    expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.acceptancePassed).toBe(false);
    expect(f.fakes.openings(f.testerName)).toHaveLength(1);
  } finally { await f.close(); }
});

it("still asks before a low-risk automatic delivery when only an extra probe could not be verified", async () => {
  const f = await fixture();
  try {
    // Delivery approval on, with the product's low-risk opt-in: its existing refusal for unverified acceptance stays.
    f.task.approveDelivery = true; f.products[0]!.shipLowRisk = true; f.task.risk = { level: "low", why: "Only copy" };
    f.task.plan!.stages.splice(3, 0, { id: "gate", title: "Delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] });
    f.fakes.scenario({ testerChecks: [passed(), blocked("The greeting also shows offline")] });
    const before = await f.mains();
    await f.drive();
    expect(f.decisions()).toHaveLength(1); expect(f.scope.work.landed).toBeUndefined(); expect(await f.mains()).toEqual(before);
    expect(f.task.proofDeliveryGate).toBeUndefined(); expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    // Only required items are a gap the decision is about.
    expect(f.task.journey!.findLast(step => step.kind === "you")!.acceptanceGap).toBeUndefined();
  } finally { await f.close(); }
});

it("repairs a shared failure on its owner, runs the planned review, then asks one shared decision naming each unavailable item's products", async () => {
  const f = await fixture({ shared: true, checklist: [REQUIRED, SECOND, THIRD] });
  try {
    const [first, second] = f.products.map(product => product.id) as [string, string];
    // A failure only the first product owns, an item unavailable on the second, and one left without any product.
    f.fakes.scenario({ builder: "plain", fixes: "change", testerChecks: [failing(REQUIRED, [first]), blocked(SECOND, [second]), blocked(THIRD, ["unknown"])],
      testerChecksFixed: [passed(REQUIRED, [first]), blocked(SECOND, [second]), blocked(THIRD, ["unknown"])] });
    const before = await f.mains();
    await f.drive();
    expect(f.task.repositories!.map(work => work.landed)).toEqual([undefined, undefined]); expect(await f.mains()).toEqual(before);
    // The failure goes to its owner once, then back to acceptance; the planned review still runs before the decision.
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.fakes.openings("tester")).toHaveLength(2);
    const testers = f.runs(), review = f.task.journey!.findIndex(step => step.stageId === f.review.id);
    expect(review).toBeGreaterThan(f.task.journey!.indexOf(testers.at(-1)!));
    expect(f.decisions()).toHaveLength(1);
    const [decision] = f.decisions();
    expect(decision!.title).toBe("Your call on “Show the greeting”: 2 acceptance checks could not be verified");
    expect(decision!.body).toContain(`2 acceptance checks could not be verified:\n• ${SECOND} (Product 2) — ${UNAVAILABLE}\n  Tried: ${TRIED}\n• ${THIRD} (no affected product was assigned) — Together: no valid affected products were assigned. The coordinator must resolve ownership.`);
    expect(decision!.body).toMatch(/What would ship: Product 1 [a-z ,]+; Product 2 [a-z ,]+\./);
    const saved = f.task.journey!.findLast(step => step.kind === "you" && step.waitsFor === "delivery")!.acceptanceGap!;
    expect(saved.items.map(item => [item.text, item.productIds])).toEqual([[SECOND, [second]], [THIRD, []]]);
    expect(Object.keys(saved.tested!).sort()).toEqual([first, second].sort()); expect(Object.keys(saved.prepared!).sort()).toEqual([first, second].sort());
    // Approval ships both products with the gap still recorded as unverified.
    f.engine.approve(decision!.id); await f.drive();
    expect(f.task.repositories!.every(work => work.landed)).toBe(true);
    expect(f.task.brief!.acceptance.map(item => item.verification)).toEqual(["passed", "blocked", "blocked"]);
  } finally { await f.close(); }
});

for (const entry of ["retried after a failure", "carried over"] as readonly string[]) it(`asks before publishing starts with an undecided required gap: ${entry}`, async () => {
  const f = await fixture();
  try {
    // A task saved before this check existed: its run left the required item unverified and it moved on to delivery unasked.
    f.fakes.scenario({ testerChecks: [blocked()] });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.kind !== "gate"); delete f.task.proofDeliveryGate;
    f.task.stageIndex = 3;
    const before = await f.mains(), head = await git(f.scope.work.worktree!, "rev-parse", "HEAD");
    if (entry !== "already at delivery" && entry !== "carried over") {
      // Your own approval from before this update carries no record of the acceptance results it covered.
      f.scope.work.approvedSha = head; f.scope.work.approvedFor = { by: entry === "approved by you before this update" ? "coordinator" : "task", mode: "local", destination: "unused" };
      expect(await f.engine["shipping"]["prepare"](f.scope, f.ship, signal())).toBe("ready");
    }
    if (entry === "decided for an earlier run") f.task.approvedAcceptanceGap = { stepId: "an-earlier-run", items: [{ text: REQUIRED, reason: UNAVAILABLE }] };
    if (entry === "carried over") {
      f.scope.work.shipping = { moves: 0, failures: 0, carriedOver: true };
      await f.drive();
      const item = f.engine.s.inbox.find(item => item.kind === "shipping")!;
      f.engine.shipAgain(item.id);
    }
    if (entry === "retried after a failure") {
      f.engine.fail(f.task.id, new Error("GitHub did not answer"));
      await f.engine.retry(f.engine.s.inbox.find(item => item.kind === "stuck")!.id);
    }
    await f.drive();
    expect(await f.mains()).toEqual(before); expect(f.scope.work.landed).toBeUndefined();
    expect(f.scope.work.shipping).toBeUndefined(); expect(f.scope.work.approvedFor).toBeUndefined();
    // The existing delivery check is added once, and asks a normal decision about the gap.
    expect(f.task.plan!.stages.map(stage => stage.kind)).toEqual(["do", "do", "review-chain", "gate", "do"]);
    // It says why it asks: no decision yet, or no record that your approval covered these items.
    const earlier = entry === "decided for an earlier run" || entry === "approved by you before this update";
    expect(f.task.timeline.filter(line => line.text.startsWith("Nothing was published:")).map(line => line.text)).toEqual([earlier
      ? "Nothing was published: Petrina has no record that your approval covered the acceptance checks that could not be verified, so it asks you about them first."
      : "Nothing was published: required acceptance could not be verified and has no decision from you yet. Petrina asks you first."]);
    expect(f.decisions()).toHaveLength(1);
    expect(f.decisions()[0]!.body).toContain(`• ${REQUIRED} — ${UNAVAILABLE}`);
    expect(f.fakes.openings("tester")).toHaveLength(1);
    f.engine.approve(f.decisions()[0]!.id); await f.drive();
    expect(f.scope.work.landed).toBeDefined(); expect(await f.mains()).not.toEqual(before);
  } finally { await f.close(); }
});

for (const decided of [false, true]) it(`${decided ? "finishes" : "holds"} an unfinished GitHub push after the local update ${decided ? "with your decision" : "until you decide"} about unavailable required acceptance`, async () => {
  const f = await fixture({ github: true });
  try {
    // Saved before this check existed: the required item stayed unverified, main moved in the main copy, and the push to GitHub was interrupted.
    f.fakes.scenario({ testerChecks: [blocked()] });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.kind !== "gate"); delete f.task.proofDeliveryGate;
    f.task.stageIndex = 3;
    if (decided) f.task.approvedAcceptanceGap = acceptanceGap(f.task)! as DeepMutable<NonNullable<ReturnType<typeof acceptanceGap>>>;
    // The work as that delivery prepared it: one commit with the task's message.
    await f.engine["updates"].fold(f.scope);
    const product = f.products[0]!, tested = await git(f.scope.work.worktree!, "rev-parse", "HEAD");
    const onGitHub = () => git(f.github!, "rev-parse", "refs/heads/main"), before = await onGitHub();
    f.scope.work.shipping = { moves: 0, failures: 0, base: f.scope.work.baseSha, start: tested, localUpdated: tested, prepared: { tested, summary: "Local placement is complete" }, step: "push", boot: "earlier-boot" };
    await git(product.path!, "reset", "-q", "--hard", tested);
    f.scope.work.localUpdate = { branch: "main", sha: tested, pushed: false };
    const result = await f.engine["shipping"].deliver(f.task, f.ship, signal());
    if (decided) {
      expect(result).toBe("stop"); expect(await onGitHub()).toBe(tested);
      expect(f.scope.work.localUpdate).toEqual({ branch: "main", sha: tested, pushed: true }); expect(f.scope.work.landed?.sha).toBe(tested.slice(0, 7));
      expect(f.decisions()).toEqual([]);
      return;
    }
    // Nothing more goes out; the completed local update stays as it is, and the decision is asked first.
    expect(result).toBe("continue"); expect(await onGitHub()).toBe(before);
    expect(f.scope.work.localUpdate).toEqual({ branch: "main", sha: tested, pushed: false });
    expect(await git(product.path!, "rev-parse", "main")).toBe(tested);
    expect(f.scope.work.landed).toBeUndefined(); expect(f.scope.work.shipping).toBeUndefined();
    expect(f.task.plan!.stages.map(stage => stage.kind)).toEqual(["do", "do", "review-chain", "gate", "do"]); expect(f.task.stageIndex).toBe(3);
    await f.drive();
    expect(f.decisions()).toHaveLength(1); expect(await onGitHub()).toBe(before);
    expect(f.decisions()[0]!.body).toContain(`• ${REQUIRED} — ${UNAVAILABLE}`);
    // Once you approve, the outstanding push goes out and the delivery is recorded.
    f.engine.approve(f.decisions()[0]!.id);
    await f.drive();
    expect(await onGitHub()).toBe(tested); expect(await git(product.path!, "rev-parse", "main")).toBe(tested);
    expect(f.scope.work.localUpdate).toEqual({ branch: "main", sha: tested, pushed: true }); expect(f.scope.work.landed?.sha).toBe(tested.slice(0, 7));
  } finally { await f.close(); }
});

it("keeps the evidence, the added check and one pending decision through a stand-in Tester and restarts", async () => {
  const f = await fixture({ native: true });
  try {
    // The planned Tester's model runs out of usage as it starts: a stand-in on another tool finishes the step.
    f.fakes.scenario({ testerChecks: [blocked()], limited: [{ model: "opus", role: "tester" }] });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    const [handedOn, finished] = f.runs();
    expect(handedOn!.profileId).toBe("opus-high"); expect(finished!.profileId).not.toBe("opus-high");
    expect(f.task.timeline.filter(entry => entry.text.startsWith("Added your delivery check"))).toHaveLength(1);
    // Petrina restarts before the review: the added check and the unavailable item stay saved.
    await f.restart();
    expect(f.task.plan!.stages.map(stage => stage.kind)).toEqual(["do", "do", "review-chain", "gate", "do"]);
    expect(f.task.brief!.acceptance).toEqual([{ text: REQUIRED, verification: "blocked", reason: UNAVAILABLE }]);
    f.fakes.scenario({ testerChecks: [blocked()] });
    await f.drive();
    expect(f.decisions()).toHaveLength(1); expect(f.fakes.openings("tester")).toHaveLength(2);
    const decision = f.decisions()[0]!, saved = f.task.journey!.findLast(step => step.kind === "you")!.acceptanceGap;
    expect(saved).toMatchObject({ stepId: finished!.id, items: [{ text: REQUIRED, reason: UNAVAILABLE, evidence: TRIED }] });
    // And again at the decision: still one question, the same record, nothing published and no further run.
    const before = await f.mains();
    await f.restart();
    expect(f.decisions().map(item => item.id)).toEqual([decision.id]); expect(f.task.state).toBe("needs-you");
    expect(f.task.journey!.findLast(step => step.kind === "you")!.acceptanceGap).toEqual(saved!);
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    f.engine.approve(decision.id); await f.drive();
    expect(f.scope.work.landed).toBeDefined(); expect(await f.mains()).not.toEqual(before);
    expect(f.fakes.openings("tester")).toHaveLength(2); expect(f.runs("builder")).toHaveLength(0);
  } finally { await f.close(); }
});

it("keeps one settled run, the added check and one pending decision when you pause during testing and again at the decision", async () => {
  const f = await fixture({ native: true });
  try {
    // The first Tester keeps working until you pause the task; the fresh one after resuming reports the unavailable item.
    f.fakes.scenario({ tester: "work", testerChecks: [blocked()] });
    const driving = f.drive();
    await waitFor(() => f.fakes.marked("tester-working"), "the first Tester to be working", undefined, { during: driving });
    f.engine.pause(f.task.id);
    await driving;
    expect(f.task.state).toBe("paused");
    // The paused attempt settled nothing: the item has no result and the plan gained no check.
    expect(f.task.brief!.acceptance).toEqual([{ text: REQUIRED }]);
    expect(f.task.plan!.stages.some(stage => stage.kind === "gate")).toBe(false);
    f.engine.resume(f.task.id);
    const before = await f.mains();
    await f.drive();
    expect(f.fakes.openings("tester")).toHaveLength(2);
    expect(f.runs().filter(run => run.acceptanceChecks?.length)).toHaveLength(1);
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    expect(f.task.timeline.filter(entry => entry.text.startsWith("Added your delivery check"))).toHaveLength(1);
    expect(f.decisions()).toHaveLength(1); expect(f.scope.work.landed).toBeUndefined();
    expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.runs("builder")).toHaveLength(0);
    // Pausing at the decision keeps it, its saved record and the hold; resuming asks nothing new.
    const decision = f.decisions()[0]!, saved = structuredClone(f.task.journey!.findLast(step => step.kind === "you")!.acceptanceGap);
    expect(saved).toMatchObject({ stepId: f.runs().at(-1)!.id, items: [{ text: REQUIRED, reason: UNAVAILABLE, evidence: TRIED }] });
    f.engine.pause(f.task.id); expect(f.task.state).toBe("paused");
    f.engine.resume(f.task.id); expect(f.task.state).toBe("needs-you");
    expect(f.decisions().map(item => item.id)).toEqual([decision.id]);
    expect(f.task.journey!.findLast(step => step.kind === "you")!.acceptanceGap).toEqual(saved!);
    expect(f.scope.work.landed).toBeUndefined(); expect(await f.mains()).toEqual(before);
    f.engine.approve(decision.id); await f.drive();
    expect(f.scope.work.landed).toBeDefined(); expect(await f.mains()).not.toEqual(before);
    expect(f.fakes.openings("tester")).toHaveLength(2);
  } finally { await f.close(); }
});

for (const changed of [true]) it(`${changed ? "tries the final code again when it changed after" : "ships on its own straight after"} a required pass with an extra probe unverified, through an added delivery check`, async () => {
  const f = await fixture();
  try {
    f.fakes.scenario({ testerChecks: [passed(), blocked("The greeting also shows offline")] });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(f.task.acceptancePassed).toBe(true); expect(f.task.proofDeliveryGate).toBeUndefined();
    // The check was added for an earlier decision; then, say, a conflict fix changes the code after this pass.
    expect(addDeliveryCheck(f.engine, f.task)).toBe(true);
    if (changed) { writeFileSync(join(f.scope.work.worktree!, "greeting.txt"), "Hello again\n"); await git(f.scope.work.worktree!, "commit", "-qam", "Resolve a conflict"); }
    f.task.stageIndex = 3;
    const before = await f.mains();
    await f.drive();
    // A pass that no longer applies never lifts the check; the extra probe alone holds nothing.
    expect(f.fakes.openings("tester")).toHaveLength(changed ? 2 : 1);
    expect(f.decisions()).toEqual([]); expect(f.scope.work.landed).toBeDefined(); expect(await f.mains()).not.toEqual(before);
    expect(f.task.testedVersions![f.task.productId]).toBe(await git(f.scope.work.worktree!, "rev-parse", "HEAD^{tree}"));
  } finally { await f.close(); }
});
