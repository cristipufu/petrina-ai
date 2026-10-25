import { ReviewRoundCompletion } from "@petrina/orchestrator";
import { createVerifierBallots } from "./verifier-host.js";
import { executionFor, scopesFor, repositoryView, ReviewReports, type VerifierBallots, type PendingVerification, type RepositoryContext } from "@petrina/orchestrator";
import { changesOf, versionsOf } from "./repositories.js";
import { refreshProofs } from "@petrina/core";
// Review rounds: Petrina's tamper check and the product's checks first, then every reviewer at once, then
// fresh agents voting on Important findings, and the round closing back to the builder or on to delivery.

import { checkReviewEvidence, reopenFinding, runtimeWaitHolds, endAgentStep, exhaustedAcceptanceFailure, findingCount, inBallot, JOURNEY_WORDS as W, openStep, pickStarts, portReviewerIndex, reviewerAt, seatAnswered, slotUses, type ActiveAgent, type AgentProfile, type ConversationNote, type DeepMutable, type Id, type ReadinessRecheck, type Role, type Stage, type Task } from "@petrina/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import * as git from "@petrina/repositories/git";
import { formatFindings } from "./prompts.js";
import { contractFor, VerifyResult, ReviewResult } from "./roles.js";
import { Kernel, type MStage, type MTask, ScreenWait, SourceRefreshRequired } from "./kernel.js";
import { WaitingForCapacity, waitingFor, WaitingForUsage } from "./usage.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import { CheckPreparationChanged, type ProductChecks } from "./product-checks.js";
import type { Learnings } from "./learnings.js";
import { finishMessageGroup, routeMessages } from "@petrina/core";
import type { Updates } from "./update.js";
import { prepareReviewInput, readReviewInput, reviewBases, reviewBaseUpdates, reviewContextIntact, reviewScopeKey, type ReviewInput } from "./review-context.js";
import { participantConversation, ParticipantUnavailable } from "./participant-conversation.js";
import { completeAll } from "@petrina/core";
import { checkProofRequests, recordReviewProofs } from "@petrina/orchestrator";
import type { ReadinessNeed } from "./readiness.js";

/** What admission decided for a parallel seat: the words on its start, why a saved conversation was not kept, and its readiness recheck. */
type SeatSelection = { selectionReason?: string; freshReason?: string; readiness?: ReadinessRecheck };

export class Reviews {
  private readonly ballots: VerifierBallots;
  private readonly reports: ReviewReports;
  private readonly rounds: ReviewRoundCompletion;
  private readonly inputs = new WeakMap<MTask, { digest: string; input: ReviewInput }>();
  constructor(
    private readonly k: Kernel,
    private readonly turns: Turns,
    private readonly context: Context,
    private readonly checks: ProductChecks,
    private readonly learnings: Learnings,
    private readonly updates: Updates,
  ) {
    this.reports = new ReviewReports({ roles: () => k.s.roles,
      hasPendingReviewers: (task, stage) => this.pendingReviewers(task, stage).length > 0,
      id: task => k.id(task.id), now: () => Date.now(),
      verdict: (...args) => k.tracking.verdict(...args), note: (...args) => k.log(...args),
    });
    this.ballots = createVerifierBallots(k);
    this.rounds = new ReviewRoundCompletion({
      role: (id, task) => k.role(id, task), roles: () => k.s.roles,
      incrementalReview: id => { const role = k.role(id); return role && contractFor(role).incrementalReview; },
      ownChanges: task => this.ownChanges(task),
      anchor: async ({ work }, observation) => observation.incremental
        ? git.commitVersion(work.worktree!) : { tree: await git.treeOf(work.worktree!) },
      reviewEnd: (task, round, result) => k.tracking.reviewEnd(task, round, result),
      releaseInput: task => this.releaseRoundInput(task),
      note: (task, tone, text) => k.log(task, tone, text),
      commitNow: task => k.commitNow(task), changed: () => k.commit(),
      openDeliveryDecision: task => k.gate(task, "delivery"), now: () => Date.now(),
    });
  }

  /** Bring review checks onto their current source and reconcile Petrina's own findings. */
  private async prepareChecks(scope: RepositoryContext, signal: AbortSignal): Promise<boolean> {
    const { task, work } = scope;
    if (await this.updates.upToDate(scope, signal) === "conflict") return false;
    // Repeat the whole review preflight on the code actually admitted, including Petrina's own findings.
    delete task.handChanges;
    const [problems, sha] = await Promise.all([
      git.tamperCheck(work.worktree!, work.baseSha ?? work.base!), git.head(work.worktree!),
    ]);
    work.tamper = { at: Date.now(), sha, problems };
    for (const finding of task.findings) {
      if (finding.raisedBy === "petrina" && finding.status === "open" && !finding.text.startsWith("Check failed") && (!task.repositories || finding.productIds?.includes(work.productId)) && !problems.includes(finding.text)) finding.status = "fixed";
    }
    for (const problem of problems) {
      if (!task.findings.some(finding => finding.text === problem && finding.status === "open" && (!task.repositories || finding.productIds?.includes(work.productId)))) {
        task.findings.push({ ...(task.repositories ? { productIds: [work.productId] } : {}), id: this.k.id(task.id), text: problem, severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
      }
    }
    this.k.log(scope, problems.length ? "warn" : "done", problems.length ? `Tamper check: ${problems.length} problem${problems.length === 1 ? "" : "s"}` : "Tamper check passed: no tests removed or skipped");
    return true;
  }

  /**
   * A review round: Petrina's own checks first; then every reviewer looks at the change at once, each on
   * its own; then fresh agents vote on the Important findings no second tool has backed yet; then the round
   * ends. What each reviewer and voter hands back is saved as it arrives, so a restart only redoes the rest.
   */
  async runReview(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const scope = executionFor(task);
    // Older saved tasks could reopen a fix while retaining the verdict on its previous code. An acceptance failure held for
    // the delivery decision is no review's to reopen: acceptance testing already tested its claims.
    for (const finding of task.findings) {
      if (finding.raisedBy !== "petrina" && finding.status === "open" && finding.answer?.fixed && (finding.reopenedAt ?? -Infinity) < finding.answer.at && (!finding.verification || finding.verification.at < finding.answer.at) && !exhaustedAcceptanceFailure(task as unknown as Task, finding)) reopenFinding(finding, Date.now());
    }
    // Older saved port marks did not prove the feature had completed ordinary review.
    if (scope.work.portReview && !scope.work.reviewedTree) {
      delete scope.work.portReview;
      delete task.hunt;
      delete scope.work.reviewedSha;
      // Its old conversation was briefed to look only at the port. A full review starts fresh,
      // including for a one-person review that would otherwise resume with only "continue".
      delete scope.work.conversation;
      this.k.commitNow();
    }
    const round = task.rounds[stage.id] ?? 1;
    if (task.hunt?.stageId !== stage.id || task.hunt.round !== round) {
      // The work goes on top of the latest main before anyone reviews it: a conflict goes to the builder first,
      // so a port after the review (and a review of that port) stays the exception.
      let failedChecks = false;
      for (const scope of scopesFor(task)) {
        if (task.repositories) task.activeProductId = scope.work.productId;
        if (!await this.prepareChecks(scope, signal)) return "continue";
        // The product's checks run before any reviewer spends time: an agent's word never counts as passing.
        // A failed run is evidence too: it returns to the builder without spending a review round.
        try {
          failedChecks = await this.checks.failing(scope, signal, await this.checks.ensureChecks(scope, signal), "review", () => this.prepareChecks(scope, signal)) || failedChecks;
        } catch (error) { if (error instanceof CheckPreparationChanged) return "continue"; throw error; }
      }
      if (failedChecks) {
        // The check fix can reach beyond the port's conflicted files, so its review must be ordinary.
        for (const { work } of scopesFor(task)) {
          delete work.portReview;
          delete work.reviewedTree;
        }
        if (this.checks.backToBuilder(scope, "before review")) return "continue";
        // The round has not started: it waits here with its number, its reviewers' conversations and its
        // incremental anchor, and runs once the checks pass. No review is assumed from the Builder's answers.
        return this.checks.blocked(task);
      }
      if (task.repositories) task.activeProductId = task.leadProductId ?? task.repositories[0]!.productId;
      task.statusLine = "Preparing the review";
      refreshProofs(task, await versionsOf(task));
      this.k.commit();
      const snapshot = await this.context.captureReview(executionFor(task));
      const input = await prepareReviewInput(this.k.dataDir, executionFor(task), snapshot, signal);
      this.inputs.set(task, { digest: input.digest, input: snapshot });
      signal.throwIfAborted();
      task.hunt = { id: this.k.id(task.id), stageId: stage.id, round, reported: {}, findings: task.findings.length, input };
      this.k.commit();
      // Checks use their own bounded lane. Re-enter the driver to admit the first real reviewer.
      return "continue";
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
      await this.vote(task, vote, signal);
      return "continue";
    }
    const outcome = vote ? this.ballots.finish(task, vote) : this.raised(task);
    const reviewedVersions = task.hunt?.input?.trees;
    delete task.hunt;
    return this.closeReviewRound(task, stage, round, outcome, reviewedVersions);
  }

  /** What this round's reviewers raised, in plain counts. An acceptance failure held for the delivery decision is no review finding. */
  private raised(task: MTask): string {
    const recorded = openStep(task)?.result?.findings;
    return findingCount((recorded ? recorded.filter((finding) => finding.status === "open") : task.findings.slice(task.hunt?.findings ?? 0)).filter((finding) => !exhaustedAcceptanceFailure(task as unknown as Task, finding)));
  }

  /** Who works on the review step next: a reviewer who has not reported yet, else a voter, else nobody. */
  nextAgent(task: MTask, stage: MStage): { roleId: Id; profileId: Id; reviewerKey?: string; requiredToolId?: Id } | undefined {
    const reviewer = this.pendingReviewers(task, stage)[0];
    if (reviewer) return { roleId: reviewerAt(stage, Number(reviewer.key)), profileId: reviewer.profileId, reviewerKey: reviewer.key };
    const voter = this.pendingVote(task, stage)?.voters[0];
    return voter ? { roleId: "verifier", profileId: voter, requiredToolId: this.k.profile(voter)?.toolId } : undefined;
  }

  /** The stage's reviewers who have not reported this round, by their place in the stage. */
  private pendingReviewers(task: MTask, stage: Stage): { key: string; profileId: Id }[] {
    const scope = executionFor(task);
    const reported = task.hunt?.stageId === stage.id && task.hunt.round === (task.rounds[stage.id] ?? 1) ? task.hunt.reported : {};
    if (scope.work.portReview && Object.keys(reported).length) return [];
    return this.plannedReviewers(task, stage).filter((entry) => !reported[entry.key]);
  }

  /** Every reviewer place the round waits for: the whole stage, or a port review's one reviewer. */
  private plannedReviewers(task: MTask, stage: Stage): { key: string; profileId: Id }[] {
    const scope = executionFor(task);
    const planned = stage.profileIds.map((profileId, index) => ({ key: String(index), profileId }));
    // The journey and the engine share the port reviewer's position; tool choice follows the latest builder.
    return scope.work.portReview ? [planned[portReviewerIndex(repositoryView(scope), stage.profileIds, (id) => this.k.profile(id)?.toolId, this.k.s.roles)]!] : planned;
  }

  /** The positions the round's step expects a result from, recorded on the step as its participants are admitted. */
  private plannedSeats(task: MTask, stage: Stage): string[] {
    return this.plannedReviewers(task, stage).map(({ key }) => `reviewer:${key}`);
  }

  private rememberReviewer(task: MTask, key: string, profileId: Id): void {
    task.hunt = { ...task.hunt!, profiles: { ...task.hunt!.profiles, [key]: profileId } };
    this.k.commitNow();
  }

  private releaseRoundInput(task: MTask): void {
    this.inputs.delete(task);
    // Keep one completed conversation per stage seat for later check/coordinator returns,
    // including the same numbered round. Scope, context and ancestry are checked on reuse.
    // Pause/cancellation and final context cleanup release these bounded references.
  }

  /** A seat returns only to its own completed conversation, with unchanged role and approved scope. */
  private participant(scope: RepositoryContext, stage: MStage, seat: Id, plannedId: Id) {
    const { task } = scope;
    const round = task.rounds[stage.id] ?? 1;
    const planned = structuredClone(this.k.profile(plannedId));
    return {
      reviewContext: true,
      resume: async (actual: AgentProfile, role: Role) => {
        if (!planned) return;
        const saved = participantConversation(this.k, scope, role, planned, seat);
        if (!saved || saved.reason || saved.actual?.id !== actual.id) return;
        const prior = task.reviewSessions?.[stage.id]?.[seat];
        if (!prior) return;
        if (!prior.bases) throw new ParticipantUnavailable("its saved repository bases are unavailable");
        if (!(await reviewContextIntact(prior.context))) throw new ParticipantUnavailable("its saved context is unavailable");
        const updates = await reviewBaseUpdates(scope, prior.bases, task.hunt?.input?.heads ?? {});
        if (updates.reason) throw new ParticipantUnavailable(updates.reason);
        return { ...prior, reselect: true, continuedSections: updates.sections };
      },
      started: () => {
        // An interrupted parallel attempt starts fresh unless it saved a screen conversation.
        // Never return to an older round's reference after that native session has begun new work.
        const saved = task.reviewSessions?.[stage.id];
        const dropped = task.reviewFreshReasons?.[stage.id];
        if (!saved?.[seat] && !dropped?.[seat]) return;
        delete saved?.[seat];
        // This start has said why it is fresh. A later start of the seat gives its own reason, not this one.
        if (dropped?.[seat]) {
          delete dropped[seat];
          if (!Object.keys(dropped).length) delete task.reviewFreshReasons![stage.id];
          if (!Object.keys(task.reviewFreshReasons!).length) delete task.reviewFreshReasons;
        }
        this.k.commitNow();
      },
      completed: (note: ConversationNote, actual: AgentProfile, role: Role) => {
        task.reviewSessions = { ...task.reviewSessions, [stage.id]: {
          ...task.reviewSessions?.[stage.id],
          [seat]: { scope: reviewScopeKey(scope, stage.id, seat, role, planned, actual), bases: reviewBases(scope), round, plannedProfileId: plannedId, profileId: actual.id, toolId: note.toolId, model: note.model, sessionId: note.sessionId, ...(note.context ? { context: note.context } : {}) },
        } };
        this.k.commitNow();
      },
    };
  }

  private async input(task: MTask, signal: AbortSignal): Promise<ReviewInput> {
    const cached = this.inputs.get(task);
    if (cached && cached.digest === task.hunt?.input?.digest) return cached.input;
    if (!task.hunt?.input) {
      if (Object.keys(task.hunt?.reported ?? {}).length) throw new Error("The review's saved inputs are missing. Start this review again before continuing.");
      const scope = executionFor(task);
      const input = await prepareReviewInput(this.k.dataDir, scope, await this.context.captureReview(scope), signal);
      signal.throwIfAborted();
      task.hunt!.input = input;
      this.k.commitNow();
    }
    const input = await readReviewInput(task.hunt!.input!);
    this.inputs.set(task, { digest: task.hunt!.input!.digest, input });
    return input;
  }

  /**
   * Every reviewer at once, each blind to what the others find this round, so they find things on their own.
   * A stage with one reviewer runs it as usual instead: it can pick up its conversation, or be taken over.
   */
  private async hunt(task: MTask, stage: MStage, reviewers: readonly { key: string; profileId: Id }[], signal: AbortSignal): Promise<void> {
    const scope = executionFor(task);
    const input = await this.input(task, signal);
    const check = (result: z.infer<typeof ReviewResult>) => checkReviewEvidence(input.findings, result, task) ?? checkProofRequests(this.k, task, result.proofRequests);
    const reported = (key: string) => {
      task.hunt = { ...task.hunt!, reported: { ...task.hunt!.reported, [key]: true } };
      this.k.commitNow();
    };
    // What the step waits for: every planned place, not only the participants that happen to start.
    const seats = this.plannedSeats(task, stage);
    if (stage.profileIds.length === 1 && !task.repositories) {
      const { key, profileId } = reviewers[0]!;
      const roleId = reviewerAt(stage, Number(key));
      const participant = { ...this.participant(scope, stage, key, profileId), reviewFindings: input.findings };
      let by = profileId;
      const result = await this.turns.turn(scope, roleId, profileId, () => this.context.sectionsFor(scope, roleId, undefined, undefined, `review-${key}`, input), ReviewResult, signal, { ...participant, check, reviewerKey: key, seats, used: (id) => { by = id; this.rememberReviewer(task, key, id); } });
      await this.applyReview(scope, stage, result, by, roleId, key);
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
        work: async (copy, room, seat, onUsed, agent, continuing, signal, selection) => {
          let by = profileId;
          const roleId = reviewerAt(stage, Number(key));
          const participant = { ...this.participant(scope, stage, key, profileId), reviewFindings: input.findings };
          const used = (id: Id) => { by = id; onUsed(id); };
          const given = () => this.context.sectionsFor(scope, roleId, `review-${key}`, this.turns.repositoryCopies.get(copy), undefined, input);
          const result = continuing
            ? await this.turns.turn(scope, roleId, profileId, given, ReviewResult, signal, { ...participant, check, copy, member: `review-${key}`, reviewKey: `reviewer:${key}`, used, room, reviewerKey: key, seats })
            : await this.turns.parallel(scope, roleId, profileId, copy, given, ReviewResult, signal, { ...participant, check, key: `reviewer:${key}`, member: `review-${key}`, used, room, seat, ...selection, reviewerKey: key, seats, agent, refresh: false });
          await this.applyReview(scope, stage, result, by, roleId, key);
          this.k.finishReviewWork(task, `reviewer:${key}`);
          reported(key);
        },
      })),
      signal,
      (running, waiting) => `${running} ${role.toLowerCase()}${running === 1 ? ` looking at the ${scope.work.portReview ? "port" : "change"}` : "s looking at the change at once"}${waiting ? `, ${waiting} waiting for a slot` : ""}`,
    );
  }

  /** What one reviewer reported: its confirmations and disputes of earlier findings, and its own. */
  private async applyReview(scope: RepositoryContext, stage: MStage, result: z.infer<typeof ReviewResult>, profileId: Id, roleId: Id, reviewerKey: string): Promise<void> {
    recordReviewProofs(this.k, scope.task, stage, result.proofRequests, profileId, roleId, reviewerKey);
    const { task } = scope;
    await this.learnings.note(scope, result.learnings, roleId, profileId);
    this.reports.apply(task, stage, result, profileId, roleId, reviewerKey);
  }

  /** Settle reviewer reports before asking which saved ballot phase needs work. */
  private pendingVote(task: MTask, stage: MStage): PendingVerification | undefined {
    this.settleReviews(task, stage);
    return this.ballots.next(task, stage);
  }

  /**
   * Fresh agents check their place's findings, all at once, each blind to its peers' answers. Every answer is saved
   * as it arrives with its place, so a limit or restart only asks for what that place still owes.
   */
  private async vote(task: MTask, pending: PendingVerification, signal: AbortSignal): Promise<void> {
    const scope = executionFor(task);
    const input = task.hunt?.input ? await this.input(task, signal) : undefined;
    // Every voter sees the same original claims and evidence, never a peer's ballot.
    const claims = structuredClone(pending.findings).map(({ votes: _votes, verification: _verification, unresolved: _unresolved, ...finding }) => finding);
    // The step waits for every place of its phase, finished or not, whoever stands in on each tool.
    const seats = (pending.phase ?? pending.seats).map((seat) => `verifier:${seat.key}`);
    // The live status counts only the findings these places were given.
    const findings = new Set(pending.seats.flatMap((seat) => seat.findingIds).filter((id) => claims.some((finding) => finding.id === id))).size;
    await this.together(
      task,
      pending.seats.map((planned, index) => {
        const profileId = pending.voters[index]!;
        const plannedId = planned.profileId;
        const assigned = new Set(planned.findingIds);
        // The member is named after its place, never its tool: a replacement saves its conversation and retry count
        // there, a later start of this place finds them under the same name, and a reused tool never shares them.
        const key = `vote-${planned.key}`;
        const reviewKey = `verifier:${planned.key}`;
        return {
        key,
        reviewKey,
        roleId: "verifier",
        profileId,
        work: async (copy, room, seat, used, agent, continuing, signal, selection) => {
          let by = seat;
          const place = () => task.hunt?.panel?.seats.find((entry) => entry.key === planned.key) ?? planned;
          const answered = (id: Id) => {
            const finding = task.findings.find((entry) => entry.id === id);
            const panel = task.hunt?.panel;
            if (!finding) return true;
            return panel ? seatAnswered(panel, place(), finding, task.hunt!) : (finding.votes ?? []).some((vote) => vote.toolId === this.k.profile(by)!.toolId && inBallot(vote, task.hunt!));
          };
          const missing = () => claims.filter((finding) => assigned.has(finding.id) && !answered(finding.id));
          const given = async () => [...await this.context.sectionsFor(scope, "verifier", key, this.turns.repositoryCopies.get(copy), undefined, input), { title: "Important findings to check (a verdict on every one, by id)", body: formatFindings(missing(), { complete: true }) }];
          const check = (value: z.infer<typeof VerifyResult>) => {
            this.ballots.recordAnswers(task, { profileId: by, plannedProfileId: plannedId, place: place(), findingIds: [...assigned] }, value.verdicts);
            const left = missing();
            return left.length ? `give a verdict on every finding by id, and these have none:\n${formatFindings(left, { complete: true })}` : undefined;
          };
          const heard = (id: Id) => { by = id; used(id); };
          const why = [place().replaced?.reason ?? place().reason, selection?.selectionReason].filter(Boolean).join(" ");
          if (continuing) await this.turns.turn(scope, "verifier", plannedId, given, VerifyResult, signal, { copy, member: key, reviewKey, check, used: heard, room, seats, place: planned.key });
          else await this.turns.parallel(scope, "verifier", plannedId, copy, given, VerifyResult, signal, {
            key: reviewKey,
            room,
            seat, ...selection,
            ...(why ? { selectionReason: why } : {}),
            used: heard,
            member: key,
            check,
            seats,
            place: planned.key,
            agent,
            refresh: false,
          });
          task.hunt = { ...task.hunt!, voted: { ...task.hunt?.voted, [by]: true } };
          const own = openStep(task)?.agentResults?.findLast((entry) => entry.roleId === "verifier" && entry.profileId === by);
          if (own) own.findings = structuredClone(task.findings.filter((finding) => assigned.has(finding.id)));
          this.k.finishReviewWork(task, reviewKey);
          this.k.commit();
        },
      };
      }),
      signal,
      (running, waiting) => `${running} fresh agent${running === 1 ? "" : "s"} ${pending.third ? "giving a third answer on" : "voting on"} ${findings} important finding${findings === 1 ? "" : "s"}${waiting ? `, ${waiting} waiting for a slot` : ""}`,
    );
  }

  /**
   * Several agents on one step at once, each in a working copy of its own made from the task's current
   * commit, so a test one runs or a checkout one makes never disturbs another, and the task's own copy is
   * never touched. The first takes the task's own slot; each other one starts when a slot of its own is
   * free, so the pool and every tool's cap still hold. One that cannot get a slot by the time the others
   * finish is left for the driver, which waits for one. A failure stops the rest. A member whose tool and
   * every stand-in are out of usage does not: the others finish, and then the task waits for a limit to end.
   * A member whose model is full waits aside with its copy, conversation and retry count. When its own wait
   * ends while peers still work, the scheduler offers it a seat like other work in progress and it rejoins;
   * the task waits for it only once every peer has finished first.
   */
  private async together(task: MTask, members: readonly { key: string; reviewKey: string; roleId: Id; profileId: Id; reviewerKey?: string; work: (copy: string, room: (toolId: Id, profile: AgentProfile) => boolean, seat: Id, used: (profileId: Id) => void, agent: ActiveAgent, continuing: boolean, signal: AbortSignal, selection?: SeatSelection) => Promise<void> }[], parentSignal: AbortSignal, status: (running: number, waiting: number) => string): Promise<void> {
    const scope = executionFor(task);
    const stop = new AbortController();
    const signal = AbortSignal.any([parentSignal, stop.signal]);
    const root = this.k.repositoryOf(scope)!.path!;
    const copyFolder = (productId: Id) => join(this.k.dataDir, "worktrees", productId, `${task.id}.copies`);
    const folder = copyFolder(scope.work.productId);
    // Pin all repositories before any reviewer starts. Every peer receives its own complete map.
    const versions = task.repositories ? await Promise.all(task.repositories.map(async (work) => {
      const restoreSha = await git.head(work.worktree!);
      return { productId: work.productId, root: work.source!.product.path!, path: work.worktree!, restoreSha, sha: task.hunt?.input?.heads[work.productId] ?? restoreSha };
    })) : [];
    const restoreSha = versions.find((work) => work.productId === scope.work.productId)?.restoreSha ?? await git.head(scope.work.worktree!);
    const sha = task.hunt?.input?.heads[scope.work.productId] ?? restoreSha;
    const copyOwners = versions.length ? versions.map((work) => ({ root: work.root, folder: copyFolder(work.productId) })) : [{ root, folder }];
    // Only saved screen conversations keep their copies; interrupted background peers start fresh.
    const keptCopies = () => Object.values(task.hunt?.screenTurns ?? {}).flatMap((entry) => [entry.copy, ...Object.values(entry.copies ?? {})]);
    await completeAll(copyOwners.map((owner) => git.removeCopies(owner.root, owner.folder, keptCopies())));
    // Each member's own copy in each product, fixed for the group once chosen, so a member coming back reopens it.
    // Its folder name encodes the member's name, which may hold characters a file system refuses (a third answer's
    // `third:` place). A folder already held is never shared, including one a screen wait saved under an earlier
    // version's naming: the member takes the next free `.1`, `.2`… folder instead, a form no encoded name has.
    const chosen = new Map<string, string>();
    const memberCopy = (productId: Id, member: string) => {
      const key = JSON.stringify([productId, member]);
      const known = chosen.get(key);
      if (known !== undefined) return known;
      // Compared without case too: a disk that ignores case treats two such folders as one.
      const held = new Set([...chosen.values(), ...keptCopies()].map((path) => path.toLowerCase()));
      const base = join(copyFolder(productId), git.copyFolderName(member));
      let path = base;
      for (let next = 1; held.has(path.toLowerCase()) || existsSync(path); next += 1) path = `${base}.${next}`;
      chosen.set(key, path);
      return path;
    };
    // One fresh pull-request read is shared by reviewers; a usage replacement reads again on its attempt.
    await this.turns.refresh(scope);
    // An unopened group must return through ordinary source updates and snapshot preparation.
    if (this.k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
    const pending = [...members];
    const accepted = new Set<string>();
    const running = new Map<string, { agent: ActiveAgent; done: Promise<void> }>();
    const yielded = new Set<string>();
    // Members whose saved conversation waits for its tool's bounded readiness decision: the group stays open until
    // each settles, and later members keep their order behind it.
    const deciding = new Map<string, { need: ReadinessNeed; done: Promise<void> }>();
    // Members waiting out a full model beside working peers. Each keeps its own wait, so one that rejoined
    // and reported never leaves the task waiting after everyone has reported.
    const paused = new Set<string>();
    const waits = new Map<string, WaitingForUsage>();
    // Members whose working copies exist: a member coming back reuses its own.
    const made = new Set<string>();
    let failure: unknown;
    let closing = false;
    let wake: (() => void) | undefined;
    const wait = (key: string, waiting: WaitingForUsage) => {
      waits.delete(key);
      waits.set(key, waiting);
    };
    // A full model's wait wins over a usage wait, as the latest one recorded.
    const noOne = () => [...waits.values()].findLast((entry) => entry instanceof WaitingForCapacity) ?? waits.values().next().value;
    // A member stopped by a full model waits aside, whatever its next start waits for: the model, a free seat for the
    // model that takes over, or its account. The usual choice then decides when it can start again.
    const asideFor = (key: string, waiting: WaitingForUsage) => waiting instanceof WaitingForCapacity || !!task.capacityRetries?.some((entry) => entry.member === key);
    const show = () => {
      if (signal.aborted) return;
      this.k.selectScreen(task);
      if (task.screen?.member) scope.work.conversation ??= task.hunt?.screenTurns?.[task.screen.member]?.conversation;
      const agents = [...running.entries()].filter(([key]) => !yielded.has(key)).sort(([a], [b]) => Number(b === task.screen?.member) - Number(a === task.screen?.member)).map(([, entry]) => entry.agent);
      const [waitingOn, decision] = [...deciding.entries()][0] ?? [];
      if (agents.length) {
        task.holdsSlot = true;
        task.agent = agents[0]!;
      } else if (task.screen || runtimeWaitHolds(task)) {
        // A screen wait or prerequisite hold releases the group's last place. Ordinary cleanup keeps it.
        task.holdsSlot = false;
        delete task.agent;
      } else if (decision && task.holdsSlot && !this.k.readiness.charge(task, decision.need, members.find((member) => member.key === waitingOn)?.reviewKey)) {
        // The last working reviewer finished during a readiness decision. Its one main place stays with the group,
        // charged to the waiting reviewer's saved tool; where that tool has no room, the place is let go.
        task.holdsSlot = false;
        delete task.agent;
      }
      if (agents.length > 1) task.helpers = agents.slice(1);
      else delete task.helpers;
      const held = !agents.length && runtimeWaitHolds(task);
      task.state = this.k.s.inbox.some((item) => item.taskId === task.id && item.blocking) ? "needs-you" : held || task.screen && !task.screen.granted ? "waiting" : "running";
      if (held && task.state === "waiting") task.statusLine = this.k.taskAdmissionWait(task);
      else if (task.state === "running") task.statusLine = !agents.length && decision ? decision.need.words : status(running.size, pending.length);
      this.k.showReviewWork(task);
      this.k.syncScreen();
    };
    // A handoff replaces this member's seat; its working peers still count against every cap.
    const roomFor = (key: string) => (toolId: Id, profile: AgentProfile) => {
      const member = members.find(member => member.key === key);
      if (member && this.k.role(member.roleId)?.result === "votes" && this.k.profile(member.profileId)?.toolId !== toolId) return false;
      const state = this.k.activeState();
      let uses = slotUses(state);
      const agent = running.get(key)?.agent;
      if (agent) {
        const own = uses.findIndex((use) => use.taskId === task.id && use.profileId === agent.profileId && use.roleId === agent.roleId);
        uses = uses.filter((_, index) => index !== own);
      } else if (!running.size) uses = uses.filter((use) => use.taskId !== task.id);
      return pickStarts({ candidates: [{ ...profile, taskId: task.id, toolId }], inUse: uses, pool: state.pool, now: state.now }).length > 0;
    };
    // The screen member's step ends with its result. Peers still working or waiting out a full model keep their own
    // retry counts and conversations to continue.
    const finishScreenStep = (key: string) => {
      const peers = <T extends { member?: string }>(entries: T[] | undefined) => entries?.filter((entry) => entry.member !== undefined && entry.member !== key) ?? [];
      const resume = peers(task.capacityResume), retries = peers(task.capacityRetries), waiting = peers(task.capacityPaused);
      this.k.finishStep(task);
      if (resume.length) task.capacityResume = resume;
      if (retries.length) task.capacityRetries = retries;
      if (waiting.length) task.capacityPaused = waiting;
    };
    const startMember = (member: (typeof members)[number], copy: string, room: (toolId: Id, profile: AgentProfile) => boolean, seat: Id, continuing: boolean, selection?: SeatSelection) => {
      yielded.delete(member.key);
      paused.delete(member.key);
      waits.delete(member.key);
      const agent: DeepMutable<ActiveAgent> = { roleId: member.roleId, profileId: seat, since: Date.now(), step: 0, reviewKey: member.reviewKey };
      let completed = false;
      // A continued member reopens the companion copies its screen turn kept, as it reopens its primary one.
      const kept = continuing ? task.hunt?.screenTurns?.[member.key]?.copies : undefined;
      const used = (profileId: Id) => {
        agent.profileId = profileId;
        if (member.reviewerKey !== undefined) this.rememberReviewer(task, member.reviewerKey, profileId);
        show();
        this.k.commitNow();
      };
      // A screen continuation or a member back from a full model works in the copies it already has.
      const reuse = continuing || made.has(member.key);
      const done = Promise.resolve()
        .then(async () => {
          const copies: Record<string, string> = { [scope.work.productId]: copy };
          await completeAll([
            reuse ? Promise.resolve() : git.addCopy(root, copy, sha),
            ...versions.filter((work) => work.productId !== scope.work.productId).map(async (work) => {
              const peer = kept?.[work.productId] ?? memberCopy(work.productId, member.key);
              if (!reuse) await git.addCopy(work.root, peer, work.sha);
              copies[work.productId] = peer;
            }),
          ]);
          made.add(member.key);
          if (versions.length) this.turns.repositoryCopies.set(copy, copies);
          try { await member.work(copy, room, seat, used, agent, continuing, signal, selection); }
          finally {
            const saved = task.hunt?.screenTurns?.[member.key];
            if (saved && versions.length) { saved.copies = copies; saved.conversation.repositoryCopies = copies; this.k.commitNow(); }
            // Primary and companion copies are reclaimed together by their owning repositories
            // when the group settles; saved screen turns retain their complete map.
            this.turns.repositoryCopies.delete(copy);
          }
        })
        .then(() => {
          completed = true;
          if (task.hunt?.screenTurns) delete task.hunt.screenTurns[member.key];
        })
        .catch((error: unknown) => {
          // Usage and capacity waits keep the missing seat; partners finish and keep their ballots.
          if (error instanceof WaitingForUsage) {
            wait(member.key, error);
            // A full model waits aside to rejoin. A member that holds the screen keeps its own path.
            if (asideFor(member.key, error) && !continuing && task.screen?.member !== member.key) paused.add(member.key);
          } else if (!(error instanceof ScreenWait)) {
            failure ??= error;
            // Stop question and permission waits too, so cleanup cannot wait on a dead peer.
            stop.abort();
          }
        })
        .finally(() => {
          running.delete(member.key);
          // Release and expose the next peer together, after its result is saved. No other task
          // can take the screen in between while learnings or other result handling awaits I/O.
          if ((!signal.aborted || completed) && failure === undefined && task.screen?.member === member.key && !task.hunt?.screenTurns?.[member.key]) finishScreenStep(member.key);
          show();
          this.k.commit();
          wake?.();
          // Peers and queued tasks may use the seats that actually came free.
          if (failure === undefined) this.k.schedule();
        });
      running.set(member.key, { agent, done });
      show();
      // Saving the profile notifies listeners, which may change permissions and schedule again.
      // Expose its reservation first so that reentrant scheduling counts every seat and cannot admit it twice.
      if (member.reviewerKey !== undefined) this.rememberReviewer(task, member.reviewerKey, seat);
    };
    const continueScreen = () => {
      if (signal.aborted || failure !== undefined || this.k.taskAdmissionsClosed(task) || this.k.taskSourceRefreshDue(task)) return;
      const member = members.find((entry) => entry.key === task.screen?.member);
      const saved = member && task.hunt?.screenTurns?.[member.key];
      if (!member || !saved || running.has(member.key)) return;
      const index = pending.findIndex((entry) => entry.key === member.key);
      if (index >= 0) pending.splice(index, 1);
      scope.work.conversation ??= saved.conversation;
      startMember(member, saved.copy, roomFor(member.key), task.agent?.profileId ?? saved.conversation.profileId, true);
    };
    // Nobody starts or comes back while admission is closed for this task, a peer owns or waits
    // for the screen, or the group is ending. The same rule covers model returns and readiness probes.
    const mayStart = () => !closing && failure === undefined && !signal.aborted && !this.k.taskAdmissionsClosed(task) && !this.k.taskSourceRefreshDue(task) && !task.screen && !Object.keys(task.hunt?.screenTurns ?? {}).length;
    /** Who would start for this member now, by the usual choice, or why it waits and whether only its saved tool's readiness stands in the way. */
    const admission = (member: (typeof members)[number]) => {
      const room = roomFor(member.key);
      const choice = this.k.choose(member.profileId, task, member.roleId, room, member.reviewerKey);
      if (choice?.kind === "none") return { room, waiting: waitingFor(choice.waiting), readiness: choice.readiness };
      const seat = choice?.profile.id ?? member.profileId;
      const selection: SeatSelection | undefined = choice ? { ...(choice.reason ? { selectionReason: choice.reason } : {}), ...(choice.freshReason ? { freshReason: choice.freshReason } : {}), ...(choice.readiness ? { readiness: choice.readiness } : {}) } : undefined;
      return { room, seat, profile: this.k.profile(seat)!, selection };
    };
    /**
     * A member set aside, by the usual choice: who would start for it now, or why it still waits. Its saved tool's
     * readiness recheck starts or is joined meanwhile, without a place and without waiting for working peers.
     */
    const due = (member: (typeof members)[number]) => {
      const next = admission(member);
      if (next.waiting) {
        wait(member.key, next.waiting);
        if (next.readiness) void this.k.readiness.resolve(next.readiness);
      }
      return next;
    };
    /**
     * Members whose own wait ended come back in their stable order, each only into a free seat, at most `limit`.
     * A member's reservation is visible before anything is saved, so a schedule during its start cannot admit it twice.
     */
    const rejoin = (limit = Infinity) => {
      for (const member of members) {
        if (limit <= 0 || !mayStart()) return;
        if (!paused.has(member.key) || running.has(member.key)) continue;
        const next = due(member);
        if (next.waiting) continue;
        if (!next.room(next.profile.toolId, next.profile)) continue;
        startMember(member, memberCopy(scope.work.productId, member.key), next.room, next.seat, false, next.selection);
        limit -= 1;
      }
    };
    const start = () => {
      while (pending.length && mayStart()) {
        const member = pending[0]!;
        // Its decision is still open: no peer is moved ahead of it.
        if (deciding.has(member.key)) break;
        const next = admission(member);
        if (next.readiness && this.k.readiness.open(next.readiness)) {
          // The group owns this member's decision: the check starts or is joined now, without waiting for working
          // peers, and the member stays pending without a place of its own until the check answers or its limit passes.
          // Places are settled first: with no peer working, the group's main place moves to the saved tool.
          const decision = { need: next.readiness, done: Promise.resolve() };
          deciding.set(member.key, decision);
          show();
          decision.done = this.k.readiness.resolveHeld(next.readiness, signal, () => {
            // A hold ends only the group's admission decision, never the shared tool check or
            // a peer already working. Reconcile those owners before the driver frees a place.
            show();
            return !task.holdsSlot;
          }).then(() => {
            deciding.delete(member.key);
            wake?.();
          });
          break;
        }
        if (next.waiting) {
          pending.shift();
          wait(member.key, next.waiting);
          // A full model waits aside too, and joins its peers once that wait ends.
          if (asideFor(member.key, next.waiting)) paused.add(member.key);
          continue;
        }
        if (!next.room(next.profile.toolId, next.profile)) break;
        pending.shift();
        startMember(member, memberCopy(scope.work.productId, member.key), next.room, next.seat, false, next.selection);
      }
      rejoin();
      this.k.commit();
    };
    this.k.screenGroups.set(task.id, {
      continue: continueScreen,
      running: (key) => running.has(key),
      yield: (key) => { yielded.add(key); show(); },
      recipients: () => members.filter((member) => !accepted.has(member.key)).map((member) => member.key),
      finished: (key) => { accepted.add(key); },
      // The scheduler weighs a member whose wait ended against other work in progress, then brings it back.
      returning: () => mayStart() ? members.flatMap((member) => {
        if (!paused.has(member.key) || running.has(member.key)) return [];
        const next = due(member);
        return next.waiting ? [] : [{ ...next.profile, taskId: task.id, toolId: next.profile.toolId }];
      }) : [],
      rejoin: () => rejoin(1),
    });
    routeMessages(task, members.map((member) => member.key));
    try {
      if (task.screen?.member) continueScreen();
      else start();
      while (running.size || deciding.size) {
        // A member reopened while its peers work, or a settled readiness decision, must also be able to wake this group.
        await Promise.race([...running.values()].map((entry) => entry.done).concat([...deciding.values()].map((entry) => entry.done), new Promise<void>((resolve) => { wake = resolve; })));
        if (failure !== undefined || signal.aborted) break;
        start();
      }
      // Every peer has finished: a member still waiting stays with the task's wait, not this group.
      closing = true;
      if (failure !== undefined) throw failure;
      // Readiness can settle after a wait ended. Unwind and clean the old copies before catch-up;
      // returning normally would let runReview treat this unopened group as finished.
      if (!signal.aborted && this.k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
      const waiting = noOne();
      if (!signal.aborted && !(waiting instanceof WaitingForCapacity) && Object.keys(task.hunt?.screenTurns ?? {}).length) {
        show();
        this.k.commitNow();
        throw new ScreenWait();
      }
      // Admitted members keep their reports. Missing seats remain on this same group after release.
      if (pending.length && this.k.taskAdmissionsClosed(task)) {
        const words = this.k.taskAdmissionWait(task);
        this.k.waitForUsage(task, words);
        throw new WaitingForUsage(words);
      }
      // The rest looked at the change and reported; the ones left wait, and the driver starts them again after.
      // A required seat waits even when a partner already voted.
      if (waiting) {
        this.k.waitForUsage(task, waiting.words);
        throw waiting;
      }
      if (!signal.aborted && !this.k.draining && !pending.length) finishMessageGroup(task, members.map((member) => member.key));
    } finally {
      closing = true;
      this.k.screenGroups.delete(task.id);
      this.k.stopHelpers(task.id);
      if (failure !== undefined || signal.aborted) this.k.runs.get(task.id)?.close();
      await Promise.allSettled([...running.values()].map((entry) => entry.done));
      delete task.helpers;
      // A member who yielded the screen released its seat before its process exited.
      await this.turns.releasedStops();
      // Every independent cleanup settles before failure is propagated. The primary copy's
      // read-only recovery also supplies its status, rather than inspecting it twice.
      const readOnly = members.every((member) => !this.k.role(member.roleId)?.canEdit);
      await completeAll([
        ...copyOwners.map(async (owner) => {
          try { await git.removeCopies(owner.root, owner.folder, keptCopies()); }
          catch (error) {
            // Disposable-copy cleanup must not discard an accepted report or hide the
            // agent's original failure. The normal cleanup sweep can reclaim it later.
            this.k.log(task, "warn", `Could not remove a review copy: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
        ...versions.filter((work) => !readOnly || work.path !== scope.work.worktree).map(async (work) => {
          const state = await git.worktreeStatus(work.path);
          if (state.head !== work.restoreSha) await git.resetTo(work.path, work.restoreSha);
          if (!state.clean) await git.discardChanges(work.path);
        }),
        // Copies share branches: recover the original task copy too, after every agent stopped.
        ...(scope.work.worktree && readOnly ? [(async () => {
          const state = await git.worktreeStatus(scope.work.worktree!);
          if (state.head !== restoreSha) {
            await git.resetTo(scope.work.worktree!, restoreSha);
            this.k.log(task, "warn", `Undid commits from ${this.k.role(members[0]!.roleId)?.name ?? "a reviewer"}, which is read-only`);
          }
          await this.k.undoReadOnly(scope, members[0]!.roleId, scope.work.worktree!, state.clean);
        })()] : []),
      ]);
    }
  }

  /** Settle objections and shared repairs together, only after the whole reviewer group reports. */
  private settleReviews(task: MTask, stage: MStage): void {
    this.reports.settle(task, stage);
  }

  /** The task's own change per product, without main's; one that cannot be read is unavailable. */
  private async ownChanges(task: MTask): Promise<Record<Id, string>> {
    return changesOf(task).catch(() => ({}));
  }

  /**
   * The end of a review round: back to the builder with what is Important, or on towards delivery. `outcome`: what
   * the round's last box (its reviewers', or its voters') says.
   */
  private async closeReviewRound(task: MTask, stage: MStage, round: number, outcome: string, reviewedVersions?: Readonly<Record<Id, string>>): Promise<"continue" | "stop"> {
    return this.rounds.finish(task, stage, round, outcome, reviewedVersions);
  }
}
