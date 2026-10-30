import { requiredGapFixtures } from "../../fixtures/required-gaps.js";
import { readRef, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { acceptanceGap, type DeepMutable } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { waitFor } from "../../fixtures.js";

const REQUIRED = "People see the greeting on the welcome page";
const UNAVAILABLE = "The hosted preview account is unavailable, so the welcome page could not be opened.";
const TRIED = "Tried to sign in to the hosted preview twice; both attempts were refused before the page loaded.";
const blocked = (text = REQUIRED, productIds?: string[]) => ({ text, result: "blocked" as const, reason: UNAVAILABLE, evidence: TRIED, ...(productIds ? { productIds } : {}) });

const { fixture, close } = requiredGapFixtures(REQUIRED);
afterAll(close);


const signal = () => new AbortController().signal;

for (const entry of ["retried after a failure", "carried over"] as readonly string[]) it(`asks before publishing starts with an undecided required gap: ${entry}`, async () => {
  const f = await fixture();
  try {
    // A task saved before this check existed: its run left the required item unverified and it moved on to delivery unasked.
    f.fakes.scenario({ testerChecks: [blocked()] });
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.kind !== "gate"); delete f.task.proofDeliveryGate;
    f.task.stageIndex = 3;
    const before = await f.mains(), head = readWorktreeCommit(f.scope.work.worktree!)!.commit;
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
    const product = f.products[0]!, tested = readWorktreeCommit(f.scope.work.worktree!)!.commit;
    const onGitHub = async () => readRef(f.github!, "refs/heads/main")!, before = await onGitHub();
    f.scope.work.shipping = { moves: 0, failures: 0, base: f.scope.work.baseSha, start: tested, localUpdated: tested, prepared: { tested, summary: "Local placement is complete" }, step: "push", boot: "earlier-boot" };
    await gitOps.resetTo(product.path!, tested);
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
    expect(readRef(join(product.path!, ".git"), "refs/heads/main")).toBe(tested);
    expect(f.scope.work.landed).toBeUndefined(); expect(f.scope.work.shipping).toBeUndefined();
    expect(f.task.plan!.stages.map(stage => stage.kind)).toEqual(["do", "do", "review-chain", "gate", "do"]); expect(f.task.stageIndex).toBe(3);
    await f.drive();
    expect(f.decisions()).toHaveLength(1); expect(await onGitHub()).toBe(before);
    expect(f.decisions()[0]!.body).toContain(`• ${REQUIRED} — ${UNAVAILABLE}`);
    // Once you approve, the outstanding push goes out and the delivery is recorded.
    f.engine.approve(f.decisions()[0]!.id);
    await f.drive();
    expect(await onGitHub()).toBe(tested); expect(readRef(join(product.path!, ".git"), "refs/heads/main")).toBe(tested);
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

