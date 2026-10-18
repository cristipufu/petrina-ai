// Review rounds: Petrina's tamper check and the product's checks first, then every reviewer at once, then
// fresh agents voting on Important findings, and the round closing back to the builder or on to delivery.

import { endAgentStep, findingCount, independentVotes, JOURNEY_WORDS as W, noteRoundEnd, openStep, pickStarts, portReviewerIndex, reviewRoundEnd, reviewerAt, slotUses, type ActiveAgent, type DeepMutable, type Finding, type Id, type Stage, type Task, type Vote } from "@petrina/core";
import { join } from "node:path";
import type { z } from "zod";
import * as git from "./git.js";
import { formatFindings } from "./prompts.js";
import { VerifyResult, ReviewResult } from "./roles.js";
import { Kernel, type MStage, type MTask, ScreenWait } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import type { ProductChecks } from "./product-checks.js";
import type { Learnings } from "./learnings.js";
import type { Updates } from "./update.js";

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

/** Tools that finished the whole ballot. Partial verdicts are saved, but cannot close a round alone. */
function finishedVoters(findings: readonly Finding[]): Set<Id> {
  return new Set(findings[0]?.votes?.flatMap((vote) => vote.toolId && findings.every((finding) => finding.votes?.some((entry) => entry.toolId === vote.toolId)) ? [vote.toolId] : []));
}

export class Reviews {
  constructor(
    private readonly k: Kernel,
    private readonly turns: Turns,
    private readonly context: Context,
    private readonly checks: ProductChecks,
    private readonly learnings: Learnings,
    private readonly updates: Updates,
  ) {}

  /**
   * A review round: Petrina's own checks first; then every reviewer looks at the change at once, each on
   * its own; then fresh agents vote on the Important findings no second tool has backed yet; then the round
   * ends. What each reviewer and voter hands back is saved as it arrives, so a restart only redoes the rest.
   */
  async runReview(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    // Older saved port marks did not prove the feature had completed ordinary review.
    if (task.portReview && !task.reviewedTree) {
      delete task.portReview;
      delete task.hunt;
      delete task.reviewedSha;
      // Its old conversation was briefed to look only at the port. A full review starts fresh,
      // including for a one-person review that would otherwise resume with only "continue".
      delete task.conversation;
      this.k.commitNow();
    }
    const round = task.rounds[stage.id] ?? 1;
    if (task.hunt?.stageId !== stage.id || task.hunt.round !== round) {
    // The work goes on top of the latest main before anyone reviews it: a conflict goes to the builder first,
    // so a port after the review (and a review of that port) stays the exception.
    if ((await this.updates.upToDate(task, signal)) === "conflict") return "continue";
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
    // A failed run is evidence too: it returns to the builder without spending a review round.
    if (await this.checks.failing(task, signal, await this.checks.ensureChecks(task, signal))) {
      // The check fix can reach beyond the port's conflicted files, so its review must be ordinary.
      delete task.portReview;
      delete task.reviewedTree;
      if (this.checks.backToBuilder(task, "before review")) return "continue";
      // The same delivery decision used after final checks exhaust their builder returns.
      const delivery = task.plan!.stages.findIndex((entry, index) => index > task.stageIndex && entry.gate === "delivery");
      task.stageIndex = delivery >= 0 ? delivery : task.plan!.stages.length - 1;
      task.sub = 0;
      this.k.log(task, "warn", "Checks still fail: the builder returns are used up, so the decision goes to you");
      this.k.commit();
      if (delivery >= 0) return "continue";
      this.k.gate(task, "delivery");
      return "stop";
    }
      task.hunt = { stageId: stage.id, round, reported: {}, findings: task.findings.length };
      this.k.commit();
    }
    const reviewers = this.pendingReviewers(task, stage);
    if (reviewers.length) {
      await this.hunt(task, stage, reviewers, signal);
      if (stage.profileIds.length === 1) this.k.finishStep(task);
      else this.k.clearStep(task);
      // Changes made by hand: the round's box ends, and the review starts again from the first reviewer.
      if (task.rereview) endAgentStep(task, { outcome: this.raised(task), reason: W.reviewAgain }, Date.now());
      this.k.rerun(task);
      // The voters' first slot qualifies again, maybe on another tool: back to the driver.
      return "continue";
    }
    const vote = this.pendingVote(task, stage);
    if (vote?.voters.length) {
      // The reviewers' box ends with what they raised; the voters get a box of their own.
      const roleId = openStep(task)?.roleId;
      if (roleId === stage.roleId || (roleId && stage.roleIds?.includes(roleId))) endAgentStep(task, { outcome: this.raised(task), reason: W.toCheck(vote.findings.length) }, Date.now());
      await this.vote(task, vote.findings, vote.voters, signal);
      return "continue";
    }
    const outcome = vote ? this.tally(task, vote.findings) : this.raised(task);
    delete task.hunt;
    return this.closeReviewRound(task, stage, round, outcome);
  }

  /** What this round's reviewers raised, in plain counts. */
  private raised(task: MTask): string {
    return findingCount(task.findings.slice(task.hunt?.findings ?? 0));
  }

  /** Who works on the review step next: a reviewer who has not reported yet, else a voter, else nobody. */
  nextAgent(task: MTask, stage: MStage): { roleId: Id; profileId: Id; reviewerKey?: string } | undefined {
    const reviewer = this.pendingReviewers(task, stage)[0];
    if (reviewer) return { roleId: reviewerAt(stage, Number(reviewer.key)), profileId: reviewer.profileId, reviewerKey: reviewer.key };
    const voter = this.pendingVote(task, stage)?.voters[0];
    return voter ? { roleId: "verifier", profileId: voter } : undefined;
  }

  /** The stage's reviewers who have not reported this round, by their place in the stage. */
  private pendingReviewers(task: MTask, stage: MStage): { key: string; profileId: Id }[] {
    const reported = task.hunt?.stageId === stage.id && task.hunt.round === (task.rounds[stage.id] ?? 1) ? task.hunt.reported : {};
    if (task.portReview && Object.keys(reported).length) return [];
    const planned = stage.profileIds.map((profileId, index) => ({ key: String(index), profileId }));
    // The journey and the engine share the port reviewer's position; tool choice follows the latest builder.
    const reviewers = task.portReview ? [planned[portReviewerIndex(task as unknown as Task, stage.profileIds, (id) => this.k.profile(id)?.toolId)]!] : planned;
    return reviewers.filter((entry) => !reported[entry.key]);
  }

  private rememberReviewer(task: MTask, key: string, profileId: Id): void {
    task.hunt = { ...task.hunt!, profiles: { ...task.hunt!.profiles, [key]: profileId } };
    this.k.commitNow();
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
      const roleId = reviewerAt(stage, Number(key));
      let by = profileId;
      const result = await this.turns.turn(task, roleId, profileId, () => this.context.sectionsFor(task, roleId), ReviewResult, signal, { reviewerKey: key, used: (id) => { by = id; this.rememberReviewer(task, key, id); } });
      await this.applyReview(task, stage, result, by, roleId);
      reported(key);
      return;
    }
    // Named by the reviewers looking now: a port review's one reviewer, or the whole stage's.
    const roleIds = new Set(reviewers.map(({ key }) => reviewerAt(stage, Number(key))));
    const role = roleIds.size === 1 ? this.k.role([...roleIds][0]!)?.name ?? "Reviewer" : "Reviewer";
    await this.together(
      task,
      reviewers.map(({ key, profileId }) => ({
        key: `review-${key}`,
        reviewKey: `reviewer:${key}`,
        roleId: reviewerAt(stage, Number(key)),
        profileId,
        reviewerKey: key,
        work: async (copy, room, seat, onUsed, agent, continuing, signal) => {
          let by = profileId;
          const roleId = reviewerAt(stage, Number(key));
          const used = (id: Id) => { by = id; onUsed(id); };
          const given = () => this.context.sectionsFor(task, roleId);
          const result = continuing
            ? await this.turns.turn(task, roleId, profileId, given, ReviewResult, signal, { copy, member: `review-${key}`, reviewKey: `reviewer:${key}`, used, room, reviewerKey: key })
            : await this.turns.parallel(task, roleId, profileId, copy, given, ReviewResult, signal, { key: `reviewer:${key}`, member: `review-${key}`, used, room, seat, reviewerKey: key, agent, refresh: false });
          await this.applyReview(task, stage, result, by, roleId);
          this.k.finishReviewWork(task, `reviewer:${key}`);
          reported(key);
        },
      })),
      signal,
      (running, waiting) => `${running} ${role.toLowerCase()}${running === 1 ? ` looking at the ${task.portReview ? "port" : "change"}` : "s looking at the change at once"}${waiting ? `, ${waiting} waiting for a slot` : ""}`,
    );
  }

  /** What one reviewer reported: its confirmations and disputes of earlier findings, and its own. */
  private async applyReview(task: MTask, stage: MStage, result: z.infer<typeof ReviewResult>, profileId: Id, roleId: Id): Promise<void> {
    await this.learnings.note(task, result.learnings, roleId, profileId);
    for (const id of result.confirms) {
      const finding = task.findings.find((entry) => entry.id === id);
      // A builder's claim is not proof: confirming that the bug remains reopens the same finding.
      // Native check findings remain governed by the actual check results.
      if (finding?.status === "fixed" && finding.raisedBy !== "petrina") finding.status = "open";
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
          roleId,
          confirmedBy: [],
          status: "open",
        });
      } else if ((same.status === "open" || same.status === "fixed") && same.raisedBy !== "petrina") {
        if (same.status === "fixed") same.status = "open";
        if (same.raisedBy === profileId || same.confirmedBy.includes(profileId)) continue;
        same.confirmedBy.push(profileId);
        backed += 1;
      }
    }
    const important = raised.some((finding) => finding.severity === "important");
    // A confirmed existing finding asks for fixes just as a newly raised one does. Count each once.
    const named = new Set(result.findings.map((finding) => sameFinding(finding.text)));
    const supported = task.findings.filter((finding) => finding.status === "open" && (result.confirms.includes(finding.id) || named.has(sameFinding(finding.text))));
    this.k.tracking.verdict(task, roleId, profileId, task.rounds[stage.id] ?? 1, result.verdict, supported.length, supported.filter((finding) => finding.severity === "blocking").length);
    const confirmed = result.confirms.length + backed;
    const also = [confirmed ? `confirmed ${confirmed}` : "", result.disputes.length ? `disputed ${result.disputes.length}` : ""].filter(Boolean).join(", ");
    this.k.log(task, important ? "warn" : "done", `${findingCount(raised.map((finding) => ({ severity: SEVERITY[finding.severity] })))}${also ? `; ${also}` : ""}`, roleId, profileId);
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
    // Resolve usage and model fallbacks before choosing the electorate. A capped tool is still
    // usable and waits for its seat. Older votes remain history; their nominal names do not prove
    // an actual tool voted, so only newly recorded identities cover a tool's place.
    const covered = finishedVoters(findings);
    const planned = this.voters(stage);
    const voters = planned.flatMap((id) => {
      const choice = this.k.choose(id, task, "verifier");
      return choice && choice.kind !== "none" && !covered.has(choice.profile.toolId) ? [choice.profile.id] : [];
    });
    // With no finished ballot and nobody usable, keep the review waiting for usage, never pass it.
    if (!voters.length && !covered.size && planned[0]) voters.push(planned[0]);
    return { findings: findings as Task["findings"], voters };
  }

  /**
   * One voter per tool that can run and the squad can use: the stage's own reviewer on that tool when it has
   * one, else that tool's most thorough profile.
   */
  private voters(stage: MStage): Id[] {
    const usable = this.k.usableTools() as Id[];
    const ready = new Set(this.k.s.tools.filter((tool) => tool.status === "ready" && (!usable.length || usable.includes(tool.id))).map((tool) => tool.id));
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
    // Keep each review position stable through model fallbacks and restarts.
    const planned = this.voters(task.plan!.stages[task.stageIndex]!);
    await this.together(
      task,
      voters.map((profileId) => {
        const plannedId = planned.find((id) => this.k.profile(id)?.toolId === this.k.profile(profileId)?.toolId) ?? profileId;
        const key = `vote-${profileId}`;
        const reviewKey = `verifier:${plannedId}`;
        return {
        key,
        reviewKey,
        roleId: "verifier",
        profileId,
        work: async (copy, room, seat, used, agent, continuing, signal) => {
          let by = seat;
          const missing = () => findings.filter((finding) => !task.findings.find((entry) => entry.id === finding.id)?.votes?.some((vote) => vote.toolId === this.k.profile(by)!.toolId));
          const given = async () => [...await this.context.sectionsFor(task, "verifier"), { title: "Important findings to check (a verdict on every one, by id)", body: formatFindings(missing()) }];
          const check = (value: z.infer<typeof VerifyResult>) => {
            const toolId = this.k.profile(by)!.toolId;
            for (const verdict of value.verdicts) {
              const finding = task.findings.find((entry) => entry.id === verdict.id && ids.has(entry.id));
              if (!finding) continue;
              const previous = finding.votes?.findLast((vote) => vote.toolId === toolId);
              if (previous?.by === by && previous.verdict === verdict.verdict && previous.reason === verdict.reason) continue;
              // A repair can revise an earlier verdict. Keep both reasons; the latest one counts for this tool.
              finding.votes = [...(finding.votes ?? []), { by, toolId, plannedProfileId: plannedId, verdict: verdict.verdict, reason: verdict.reason }];
            }
            // A partial report is finished work too. Keep its reasons before asking for the rest,
            // so a limit or restart only redoes the missing verdicts on this tool.
            this.k.commitNow();
            const left = missing();
            return left.length ? `give a verdict on every finding by id, and these have none:\n${formatFindings(left)}` : undefined;
          };
          const heard = (id: Id) => { by = id; used(id); };
          if (continuing) await this.turns.turn(task, "verifier", profileId, given, VerifyResult, signal, { copy, member: key, reviewKey, check, used: heard, room });
          else await this.turns.parallel(task, "verifier", profileId, copy, given, VerifyResult, signal, {
            key: reviewKey,
            room,
            seat,
            used: heard,
            member: key,
            check,
            agent,
            refresh: false,
          });
          task.hunt = { ...task.hunt!, voted: { ...task.hunt?.voted, [by]: true } };
          this.k.finishReviewWork(task, reviewKey);
          this.k.commit();
        },
      };
      }),
      signal,
      (running, waiting) => `${running} fresh agent${running === 1 ? "" : "s"} voting on ${findings.length} important finding${findings.length === 1 ? "" : "s"}${waiting ? `, ${waiting} waiting for a slot` : ""}`,
      () => finishedVoters(findings).size > 0,
    );
  }

  /** Every voter has voted: each finding stands or falls by its votes. Says how the vote went. */
  private tally(task: MTask, findings: Task["findings"]): string {
    const ids = new Set(findings.map((finding) => finding.id));
    const at = Date.now();
    let real = 0;
    for (const finding of task.findings.filter((entry) => ids.has(entry.id))) {
      // One actual tool, one vote. Do not guess an older nominal vote's missing identity.
      const votes = independentVotes(finding.votes);
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
    return W.voted(real, ids.size);
  }

  /**
   * Several agents on one step at once, each in a working copy of its own made from the task's current
   * commit, so a test one runs or a checkout one makes never disturbs another, and the task's own copy is
   * never touched. The first takes the task's own slot; each other one starts when a slot of its own is
   * free, so the pool and every tool's cap still hold. One that cannot get a slot by the time the others
   * finish is left for the driver, which waits for one. A failure stops the rest. A member whose tool and
   * every stand-in are out of usage does not: the others finish, and then the task waits for a limit to end.
   */
  private async together(task: MTask, members: readonly { key: string; reviewKey: string; roleId: Id; profileId: Id; reviewerKey?: string; work: (copy: string, room: (toolId: Id) => boolean, seat: Id, used: (profileId: Id) => void, agent: ActiveAgent, continuing: boolean, signal: AbortSignal) => Promise<void> }[], parentSignal: AbortSignal, status: (running: number, waiting: number) => string, canFinishWithoutUsage: () => boolean = () => false): Promise<void> {
    const stop = new AbortController();
    const signal = AbortSignal.any([parentSignal, stop.signal]);
    const root = this.k.repositoryOf(task)!.path!;
    const folder = join(this.k.dataDir, "worktrees", task.productId, `${task.id}.copies`);
    const sha = await git.head(task.worktree!);
    // Only saved screen conversations keep their copies; interrupted background peers start fresh.
    const keptCopies = () => Object.values(task.hunt?.screenTurns ?? {}).map((entry) => entry.copy);
    await git.removeCopies(root, folder, keptCopies());
    // One fresh pull-request read is shared by reviewers; a usage replacement reads again on its attempt.
    await this.turns.refresh(task);
    const pending = [...members];
    const running = new Map<string, { agent: ActiveAgent; done: Promise<void> }>();
    let failure: unknown;
    let noOne: WaitingForUsage | undefined;
    let wake: (() => void) | undefined;
    const show = () => {
      if (signal.aborted) return;
      this.k.selectScreen(task);
      if (task.screen?.member) task.conversation ??= task.hunt?.screenTurns?.[task.screen.member]?.conversation;
      const agents = [...running.entries()].sort(([a], [b]) => Number(b === task.screen?.member) - Number(a === task.screen?.member)).map(([, entry]) => entry.agent);
      if (agents.length) {
        task.holdsSlot = true;
        task.agent = agents[0]!;
      } else if (task.screen) {
        // Only a screen wait gives up the group's last reserved seat. Ordinary cleanup keeps it.
        task.holdsSlot = false;
        delete task.agent;
      }
      if (agents.length > 1) task.helpers = agents.slice(1);
      else delete task.helpers;
      task.state = this.k.s.inbox.some((item) => item.taskId === task.id && item.blocking) ? "needs-you" : task.screen && !task.screen.granted ? "waiting" : "running";
      if (task.state === "running") task.statusLine = status(running.size, pending.length);
      this.k.showReviewWork(task);
      this.k.syncScreen();
    };
    // A handoff replaces this member's seat; its working peers still count against every cap.
    const roomFor = (key: string) => (toolId: Id) => {
      const state = this.k.getState();
      let uses = slotUses(state);
      const agent = running.get(key)?.agent;
      if (agent) {
        const own = uses.findIndex((use) => use.taskId === task.id && use.profileId === agent.profileId && use.roleId === agent.roleId);
        uses = uses.filter((_, index) => index !== own);
      } else if (!running.size) uses = uses.filter((use) => use.taskId !== task.id);
      return pickStarts({ candidates: [{ taskId: task.id, toolId }], inUse: uses, pool: state.pool, now: state.now }).length > 0;
    };
    const startMember = (member: (typeof members)[number], copy: string, room: (toolId: Id) => boolean, seat: Id, continuing: boolean) => {
      const agent: DeepMutable<ActiveAgent> = { roleId: member.roleId, profileId: seat, since: Date.now(), step: 0, reviewKey: member.reviewKey };
      let completed = false;
      if (member.reviewerKey !== undefined) this.rememberReviewer(task, member.reviewerKey, seat);
      const used = (profileId: Id) => {
        agent.profileId = profileId;
        if (member.reviewerKey !== undefined) this.rememberReviewer(task, member.reviewerKey, profileId);
        show();
        this.k.commitNow();
      };
      const done = Promise.resolve()
        .then(() => continuing ? undefined : git.addCopy(root, copy, sha))
        .then(() => member.work(copy, room, seat, used, agent, continuing, signal))
        .then(() => {
          completed = true;
          if (task.hunt?.screenTurns) delete task.hunt.screenTurns[member.key];
        })
        .catch((error: unknown) => {
          if (error instanceof WaitingForUsage) noOne ??= error;
          else if (!(error instanceof ScreenWait)) {
            failure ??= error;
            // Stop question and permission waits too, so cleanup cannot wait on a dead peer.
            stop.abort();
          }
        })
        .finally(() => {
          running.delete(member.key);
          // Release and expose the next peer together, after its result is saved. No other task
          // can take the screen in between while learnings or other result handling awaits I/O.
          if ((!signal.aborted || completed) && failure === undefined && task.screen?.member === member.key && !task.hunt?.screenTurns?.[member.key]) this.k.finishStep(task);
          show();
          this.k.commit();
          wake?.();
          // Peers and queued tasks may use the seats that actually came free.
          if (failure === undefined) this.k.schedule();
        });
      running.set(member.key, { agent, done });
      show();
    };
    const continueScreen = () => {
      if (signal.aborted || failure !== undefined || this.k.draining) return;
      const member = members.find((entry) => entry.key === task.screen?.member);
      const saved = member && task.hunt?.screenTurns?.[member.key];
      if (!member || !saved || running.has(member.key)) return;
      const index = pending.findIndex((entry) => entry.key === member.key);
      if (index >= 0) pending.splice(index, 1);
      task.conversation ??= saved.conversation;
      startMember(member, saved.copy, roomFor(member.key), task.agent?.profileId ?? saved.conversation.profileId, true);
    };
    const start = () => {
      while (pending.length && failure === undefined && !task.screen && !Object.keys(task.hunt?.screenTurns ?? {}).length) {
        if (this.k.draining || signal.aborted) break;
        const member = pending[0]!;
        const room = roomFor(member.key);
        const choice = this.k.choose(member.profileId, task, member.roleId, room, member.reviewerKey);
        if (choice?.kind === "none") {
          noOne ??= new WaitingForUsage(choice.waiting);
          pending.shift();
          continue;
        }
        const seat = choice?.profile.id ?? member.profileId;
        if (!room(this.k.profile(seat)?.toolId ?? "unknown")) break;
        pending.shift();
        startMember(member, join(folder, member.key), room, seat, false);
      }
      this.k.commit();
    };
    this.k.screenGroups.set(task.id, { continue: continueScreen, running: (key) => running.has(key) });
    try {
      if (task.screen?.member) continueScreen();
      else start();
      while (running.size) {
        // A member reopened while its peers work must also be able to wake this group.
        await Promise.race([...running.values()].map((entry) => entry.done).concat(new Promise<void>((resolve) => { wake = resolve; })));
        if (failure !== undefined || signal.aborted) break;
        start();
      }
      if (failure !== undefined) throw failure;
      if (!signal.aborted && Object.keys(task.hunt?.screenTurns ?? {}).length) {
        show();
        this.k.commitNow();
        throw new ScreenWait();
      }
      // The rest looked at the change and reported; the ones left wait for usage, and the driver starts them again after.
      if (noOne && !canFinishWithoutUsage()) {
        this.k.waitForUsage(task, noOne.words);
        throw noOne;
      }
    } finally {
      this.k.screenGroups.delete(task.id);
      this.k.stopHelpers(task.id);
      if (failure !== undefined || signal.aborted) this.k.runs.get(task.id)?.close();
      await Promise.allSettled([...running.values()].map((entry) => entry.done));
      delete task.helpers;
      // A member who yielded the screen released its seat before its process exited.
      await this.turns.releasedStops();
      await git.removeCopies(root, folder, keptCopies());
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

  /**
   * The end of a review round: back to the builder with what is Important, or on towards delivery. `outcome`: what
   * the round's last box (its reviewers', or its voters') says.
   */
  private async closeReviewRound(task: MTask, stage: MStage, round: number, outcome: string): Promise<"continue" | "stop"> {
    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
    const end = reviewRoundEnd(task as unknown as Task, stage as Stage, round);
    noteRoundEnd(task, stage.id, open.length);
    // A port review is one round: whatever it found, the rounds after it are ordinary ones.
    const port = task.portReview !== undefined;
    delete task.portReview;
    if (end.kind !== "passed") delete task.reviewedTree;
    else if (stage.roleId === "code-reviewer") task.reviewedTree = await git.treeOf(task.worktree!);
    this.k.tracking.reviewEnd(task, round, end.kind === "send back" ? "sent-back" : end.kind === "used up" ? "rounds-used" : "passed");
    const reason = end.kind === "send back" ? { reason: W.sentBack(end.open), tone: "back" as const } : end.kind === "used up" ? { reason: W.stillOpen(end.open), tone: "back" as const } : { reason: W.reviewPassed };
    endAgentStep(task, { outcome, ...reason }, Date.now());
    if (end.kind === "send back") {
      // The next round reviews only what changed since what the reviewers looked at in this one.
      const sha = await git.head(task.worktree!).catch(() => undefined);
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
      this.k.log(task, "done", `${port ? "Port review" : "Review"} passed: ${findingCount(task.findings.filter((finding) => finding.status === "open"))}`);
    }
    this.k.commit();
    return "continue";
  }
}
