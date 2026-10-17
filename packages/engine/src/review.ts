// Review rounds: Petrina's tamper check and the product's checks first, then every reviewer at once, then
// fresh agents voting on Important findings, and the round closing back to the builder or on to delivery.

import { extraSlot, findingCount, noteRoundEnd, reviewRoundEnd, slotWait, type ActiveAgent, type DeepMutable, type Finding, type Id, type Stage, type Task, type Vote } from "@petrina/core";
import { join } from "node:path";
import type { z } from "zod";
import * as git from "./git.js";
import { formatFindings } from "./prompts.js";
import { VerifyResult, ReviewResult } from "./roles.js";
import { Kernel, type MStage, type MTask } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import type { ProductChecks } from "./product-checks.js";
import type { Learnings } from "./learnings.js";

/**
 * A later reviewer thinks findings are wrong: each dispute is kept with who and why. One reviewer's
 * dispute dismisses a finding nobody else backed; Petrina's own checks and confirmed findings stay open.
 */
export function recordDisputes(findings: DeepMutable<Finding>[], disputes: readonly { id: string; reason: string }[], by: Id, at: number): void {
  for (const dispute of disputes) {
    const finding = findings.find((entry) => entry.id === dispute.id);
    if (!finding || finding.status !== "open") continue;
    finding.disputes = [...(finding.disputes ?? []), { by, reason: dispute.reason, at }];
    if (finding.raisedBy !== "petrina" && finding.confirmedBy.length === 0) finding.status = "dismissed";
  }
}

/** What a reviewer's tag means for the finding. */
const SEVERITY = { important: "blocking", nit: "suggestion", "pre-existing": "pre-existing" } as const;

/** The verdict most voters gave, the mildest first on a tie: a nit, then older than the change, then not a bug. */
function mostCommon(votes: readonly Vote[]): Vote | undefined {
  const order: Vote["verdict"][] = ["nit", "pre-existing", "not-a-bug"];
  const count = (verdict: Vote["verdict"]) => votes.filter((vote) => vote.verdict === verdict).length;
  const best = [...order].sort((a, b) => count(b) - count(a) || order.indexOf(a) - order.indexOf(b))[0]!;
  return votes.find((vote) => vote.verdict === best);
}

/** The same finding, however it is spaced or capitalised. */
function sameFinding(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export class Reviews {
  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context, private readonly checks: ProductChecks, private readonly learnings: Learnings) {}

  /**
   * A review round: Petrina's own checks first; then every reviewer looks at the change at once, each on
   * its own; then fresh agents vote on the Important findings no second tool has backed yet; then the round
   * ends. What each reviewer and voter hands back is saved as it arrives, so a restart only redoes the rest.
   */
  async runReview(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const round = task.rounds[stage.id] ?? 1;
    if (task.hunt?.stageId !== stage.id || task.hunt.round !== round) {
    // The chain starts again from its first reviewer: changes made by hand are in what it reviews.
    delete task.handChanges;
    const problems = await git.tamperCheck(task.worktree!, task.baseSha ?? task.base!);
    // Petrina's own findings settle on what it sees now, whatever anyone answered.
    for (const finding of task.findings) {
      if (finding.raisedBy === "petrina" && finding.status === "open" && !finding.text.startsWith("Check failed") && !problems.includes(finding.text)) finding.status = "fixed";
    }
    for (const problem of problems) {
      if (!task.findings.some((finding) => finding.text === problem && finding.status === "open")) {
        task.findings.push({ id: this.k.id(task.id), text: problem, severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
      }
    }
    this.k.log(task, problems.length ? "warn" : "done", problems.length ? `Tamper check: ${problems.length} problem${problems.length === 1 ? "" : "s"}` : "Tamper check passed: no tests removed or skipped");
    // The product's checks run before any reviewer spends time: an agent's word never counts as passing.
    // A later chain on the same code (a security review) goes by the run that just passed.
    const passed = (await this.checks.ranOn(task)) && task.checks!.results.every((run) => run.ok);
    if (!passed && (await this.checks.runProductChecks(task, await this.checks.ensureChecks(task, signal), signal)) > 0) {
      this.k.log(task, "warn", "Reviewers wait until the checks pass");
      return this.closeReviewRound(task, stage, round, false);
    }
      task.hunt = { stageId: stage.id, round, reported: {} };
      this.k.commit();
    }
    const reviewers = this.pendingReviewers(task, stage);
    if (reviewers.length) {
      await this.hunt(task, stage, reviewers, signal);
      this.k.finishStep(task);
      this.k.rerun(task);
      // The voters' first slot qualifies again, maybe on another tool: back to the driver.
      return "continue";
    }
    const vote = this.pendingVote(task, stage);
    if (vote?.voters.length) {
      await this.vote(task, vote.findings, vote.voters, signal);
      return "continue";
    }
    if (vote) this.tally(task, vote.findings);
    delete task.hunt;
    return this.closeReviewRound(task, stage, round, true);
  }

  /** Who works on the review step next: a reviewer who has not reported yet, else a voter, else nobody. */
  nextAgent(task: MTask, stage: MStage): { roleId: Id; profileId: Id } | undefined {
    const reviewer = this.pendingReviewers(task, stage)[0];
    if (reviewer) return { roleId: stage.roleId, profileId: reviewer.profileId };
    const voter = this.pendingVote(task, stage)?.voters[0];
    return voter ? { roleId: "verifier", profileId: voter } : undefined;
  }

  /** The stage's reviewers who have not reported this round, by their place in the stage. */
  private pendingReviewers(task: MTask, stage: MStage): { key: string; profileId: Id }[] {
    const reported = task.hunt?.stageId === stage.id && task.hunt.round === (task.rounds[stage.id] ?? 1) ? task.hunt.reported : {};
    return stage.profileIds.map((profileId, index) => ({ key: String(index), profileId })).filter((entry) => !reported[entry.key]);
  }

  /**
   * Every reviewer at once, each blind to what the others find this round, so they find things on their own.
   * A stage with one reviewer runs it as usual instead: it can pick up its conversation, or be taken over.
   */
  private async hunt(task: MTask, stage: MStage, reviewers: readonly { key: string; profileId: Id }[], signal: AbortSignal): Promise<void> {
    const reported = (key: string) => {
      task.hunt = { ...task.hunt!, reported: { ...task.hunt!.reported, [key]: true } };
      this.k.commit();
    };
    if (stage.profileIds.length === 1) {
      const { key, profileId } = reviewers[0]!;
      let by = profileId;
      const result = await this.turns.turn(task, stage.roleId, profileId, () => this.context.sectionsFor(task, stage.roleId), ReviewResult, signal, { used: (id) => (by = id) });
      this.applyReview(task, stage, result, by);
      reported(key);
      return;
    }
    const role = this.k.role(stage.roleId)?.name ?? "Reviewer";
    await this.together(
      task,
      reviewers.map(({ key, profileId }) => ({
        roleId: stage.roleId,
        profileId,
        work: async (copy) => {
          let by = profileId;
          const result = await this.turns.parallel(task, stage.roleId, profileId, copy, () => this.context.sectionsFor(task, stage.roleId), ReviewResult, signal, { used: (id) => (by = id) });
          this.applyReview(task, stage, result, by);
          reported(key);
        },
      })),
      (running, waiting) => `${running} ${role.toLowerCase()}${running === 1 ? " looking at the change" : "s looking at the change at once"}${waiting ? `, ${waiting} waiting for a slot` : ""}`,
    );
  }

  /** What one reviewer reported: its confirmations and disputes of earlier findings, and its own. */
  private applyReview(task: MTask, stage: MStage, result: z.infer<typeof ReviewResult>, profileId: Id): void {
    this.learnings.note(task, result.learnings, stage.roleId, profileId);
    for (const id of result.confirms) {
      const finding = task.findings.find((entry) => entry.id === id);
      if (finding && !finding.confirmedBy.includes(profileId)) finding.confirmedBy.push(profileId);
    }
    recordDisputes(task.findings, result.disputes, profileId, Date.now());
    // A finding is raised once. Another reviewer raising an open one backs it; a repeat of a settled one is dropped.
    const raised: typeof result.findings = [];
    let backed = 0;
    for (const finding of result.findings) {
      const same = task.findings.find((entry) => sameFinding(entry.text) === sameFinding(finding.text));
      if (!same) {
        raised.push(finding);
        task.findings.push({
          id: this.k.id(task.id),
          text: finding.text,
          ...(finding.where ? { where: finding.where } : {}),
          ...(finding.evidence ? { evidence: finding.evidence } : {}),
          severity: SEVERITY[finding.severity],
          raisedBy: profileId,
          confirmedBy: [],
          status: "open",
        });
      } else if (same.status === "open" && same.raisedBy !== profileId && !same.confirmedBy.includes(profileId)) {
        same.confirmedBy.push(profileId);
        backed += 1;
      }
    }
    const important = raised.some((finding) => finding.severity === "important");
    const confirmed = result.confirms.length + backed;
    const also = [confirmed ? `confirmed ${confirmed}` : "", result.disputes.length ? `disputed ${result.disputes.length}` : ""].filter(Boolean).join(", ");
    this.k.log(task, important ? "warn" : "done", `${findingCount(raised.map((finding) => ({ severity: SEVERITY[finding.severity] })))}${also ? `; ${also}` : ""}`, stage.roleId, profileId);
  }

  /**
   * The Important findings still to vote on (raised by a reviewer, and not yet backed on a second tool),
   * and the voters who have not voted yet: one fresh agent per tool.
   */
  private pendingVote(task: MTask, stage: MStage): { findings: Task["findings"]; voters: Id[] } | undefined {
    const toolOf = (profileId: Id) => this.k.profile(profileId)?.toolId;
    const findings = task.findings.filter(
      (finding) => finding.status === "open" && finding.severity === "blocking" && finding.raisedBy !== "petrina" && !finding.verification && new Set([finding.raisedBy, ...finding.confirmedBy].map(toolOf)).size < 2,
    );
    if (!findings.length) return undefined;
    const voted = task.hunt?.voted ?? {};
    const voters = this.voters(stage).filter((profileId) => !voted[profileId]);
    return { findings: findings as Task["findings"], voters };
  }

  /** One voter per tool that can run: the stage's own reviewer on that tool when it has one, else that tool's most thorough profile. */
  private voters(stage: MStage): Id[] {
    const ready = new Set(this.k.s.tools.filter((tool) => tool.status === "ready").map((tool) => tool.id));
    // With no tool found ready (tests stand in for the tools), the tools the stage's reviewers use.
    const tools = ready.size ? [...ready] : [...new Set(stage.profileIds.map((id) => this.k.profile(id)?.toolId).filter((id): id is Id => !!id))];
    return tools
      .map((toolId) => {
        const own = stage.profileIds.find((id) => this.k.profile(id)?.toolId === toolId);
        const profiles = this.k.s.profiles.filter((profile) => profile.toolId === toolId);
        return own ?? (profiles.find((profile) => profile.effort === "xhigh") ?? profiles[0])?.id;
      })
      .filter((id): id is Id => !!id);
  }

  /**
   * Fresh agents vote on each Important finding, all at once. A finding stands when at least half of them
   * say it is real; otherwise the most common other verdict settles it (see tally). Every vote is kept.
   */
  private async vote(task: MTask, findings: Task["findings"], voters: readonly Id[], signal: AbortSignal): Promise<void> {
    const ids = new Set(findings.map((finding) => finding.id));
    await this.together(
      task,
      voters.map((profileId) => ({
        roleId: "verifier",
        profileId,
        work: async (copy) => {
          const result = await this.turns.parallel(task, "verifier", profileId, copy, () => [...this.context.sectionsFor(task, "verifier"), { title: "Important findings to check (a verdict on every one, by id)", body: formatFindings(findings) }], VerifyResult, signal, {
            check: (value) => {
              const missing = findings.filter((finding) => !value.verdicts.some((verdict) => verdict.id === finding.id));
              return missing.length ? `give a verdict on every finding by id, and these have none:\n${formatFindings(missing)}` : undefined;
            },
          });
          for (const verdict of result.verdicts) {
            const finding = task.findings.find((entry) => entry.id === verdict.id && ids.has(entry.id));
            if (finding) finding.votes = [...(finding.votes ?? []).filter((vote) => vote.by !== profileId), { by: profileId, verdict: verdict.verdict, reason: verdict.reason }];
          }
          task.hunt = { ...task.hunt!, voted: { ...task.hunt?.voted, [profileId]: true } };
          this.k.commit();
        },
      })),
      (running, waiting) => `${running} fresh agent${running === 1 ? "" : "s"} voting on ${findings.length} important finding${findings.length === 1 ? "" : "s"}${waiting ? `, ${waiting} waiting for a slot` : ""}`,
    );
  }

  /** Every voter has voted: each finding stands or falls by its votes. */
  private tally(task: MTask, findings: Task["findings"]): void {
    const ids = new Set(findings.map((finding) => finding.id));
    const at = Date.now();
    let real = 0;
    for (const finding of task.findings.filter((entry) => ids.has(entry.id))) {
      const votes = finding.votes ?? [];
      const yes = votes.filter((vote) => vote.verdict === "real");
      const outcome = yes.length * 2 >= votes.length ? (yes[0] ?? votes[0]) : mostCommon(votes.filter((vote) => vote.verdict !== "real"));
      if (!outcome) continue;
      const verdict = yes.length * 2 >= votes.length ? "real" : outcome.verdict;
      finding.verification = { by: outcome.by, verdict, reason: outcome.reason, at };
      if (verdict === "real") real += 1;
      else if (verdict === "not-a-bug") finding.status = "dismissed";
      else if (verdict === "nit") finding.severity = "suggestion";
      else finding.severity = "pre-existing";
    }
    this.k.log(task, real ? "warn" : "done", `${ids.size} checked: ${real} real${ids.size > real ? `, ${ids.size - real} not holding the work back` : ""}`);
    this.k.commit();
  }

  /**
   * Several agents on one step at once, each in a working copy of its own made from the task's current
   * commit, so a test one runs or a checkout one makes never disturbs another, and the task's own copy is
   * never touched. The first takes the task's own slot; each other one starts when a slot of its own is
   * free, so the pool and every tool's cap still hold. One that cannot get a slot by the time the others
   * finish is left for the driver, which waits for one. A failure stops the rest. A member whose tool and
   * every stand-in are out of usage does not: the others finish, and then the task waits for a limit to end.
   */
  private async together(task: MTask, members: readonly { roleId: Id; profileId: Id; work: (copy: string) => Promise<void> }[], status: (running: number, waiting: number) => string): Promise<void> {
    const root = this.k.productOf(task)!.path!;
    const folder = join(this.k.dataDir, "worktrees", task.productId, `${task.id}.copies`);
    const sha = await git.head(task.worktree!);
    // Copies a crash left behind go first.
    await git.removeCopies(root, folder);
    const pending = [...members];
    const running = new Map<number, { agent: ActiveAgent; done: Promise<void> }>();
    let failure: unknown;
    let noOne: WaitingForUsage | undefined;
    let next = 0;
    const show = () => {
      const agents = [...running.values()].map((entry) => entry.agent);
      if (agents.length) task.agent = agents[0]!;
      if (agents.length > 1) task.helpers = agents.slice(1);
      else delete task.helpers;
      task.statusLine = status(running.size, pending.length);
    };
    const start = () => {
      while (pending.length && failure === undefined) {
        const member = pending[0]!;
        // Whoever would really work it: its planned profile, or a stand-in while that one is out of usage.
        const choice = this.k.choose(member.profileId, task, member.roleId);
        if (choice?.kind === "none") {
          noOne ??= new WaitingForUsage(choice.waiting);
          pending.shift();
          continue;
        }
        const seat = choice?.profile.id ?? member.profileId;
        const toolId = this.k.profile(seat)?.toolId ?? "unknown";
        // The task's own slot was taken for one tool: another agent qualifies for it like anyone else.
        const free = running.size === 0 ? !slotWait(this.k.getState(), { taskId: task.id, toolId }) : extraSlot(this.k.getState(), toolId);
        if (!free) break;
        pending.shift();
        const id = next++;
        const agent = { roleId: member.roleId, profileId: seat, since: Date.now(), step: 0 };
        const copy = join(folder, `${member.roleId}-${id}-${member.profileId}`);
        const done = git
          .addCopy(root, copy, sha)
          .then(() => member.work(copy))
          .catch((error: unknown) => {
            if (error instanceof WaitingForUsage) noOne ??= error;
            else failure ??= error;
          })
          .finally(() => {
            running.delete(id);
            show();
            this.k.commit();
            // A slot came free: other tasks may start in it.
            this.k.schedule();
          });
        running.set(id, { agent, done });
        show();
      }
      this.k.commit();
    };
    try {
      start();
      while (running.size) {
        await Promise.race([...running.values()].map((entry) => entry.done));
        if (failure !== undefined) break;
        start();
      }
      if (failure !== undefined) throw failure;
      // The rest looked at the change and reported; the ones left wait for usage, and the driver starts them again after.
      if (noOne) {
        this.k.waitForUsage(task, noOne.words);
        throw noOne;
      }
    } finally {
      this.k.stopHelpers(task.id);
      delete task.helpers;
      await git.removeCopies(root, folder);
      // Copies share the repository's branches, so a read-only agent could still have moved the task's
      // branch or written into its copy by path: the task's copy goes back to how the group found it.
      if (task.worktree && members.every((member) => !this.k.role(member.roleId)?.canEdit)) {
        if ((await git.head(task.worktree).catch(() => sha)) !== sha) {
          await git.resetTo(task.worktree, sha);
          this.k.log(task, "warn", `Undid commits from ${this.k.role(members[0]!.roleId)?.name ?? "a reviewer"}, which is read-only`);
        }
        await this.k.undoReadOnly(task, members[0]!.roleId);
      }
    }
  }

  /** The end of a review round: back to the builder with what is Important, or on towards delivery. */
  private async closeReviewRound(task: MTask, stage: MStage, round: number, reviewed: boolean): Promise<"continue" | "stop"> {
    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
    const end = reviewRoundEnd(task as unknown as Task, stage as Stage, round);
    noteRoundEnd(task, stage.id, open.length);
    if (end.kind === "send back") {
      // The next round reviews only what changed since what the reviewers looked at in this one.
      const sha = reviewed ? await git.head(task.worktree!).catch(() => undefined) : undefined;
      if (sha) task.reviewedSha = sha;
      task.rounds[stage.id] = round + 1;
      task.stageIndex = end.builder;
      task.sub = 0;
      task.fixing = true;
      this.k.log(task, "warn", `Sent back to the builder: ${findingCount(open)}`);
      this.k.commit();
      return "continue";
    }
    task.stageIndex += 1;
    task.sub = 0;
    if (end.kind === "used up") {
      this.k.log(task, "warn", `Review rounds used up: ${findingCount(open)} still open`);
      // With blocking findings left, the coordinator always looks before anything ships.
      const next = task.plan?.stages[task.stageIndex];
      if (next && next.kind !== "gate") {
        this.k.gate(task, "delivery");
        return "stop";
      }
    } else {
      this.k.log(task, "done", `Review passed: ${findingCount(task.findings.filter((finding) => finding.status === "open"))}`);
    }
    this.k.commit();
    return "continue";
  }
}
