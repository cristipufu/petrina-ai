import { ReviewConversations, nextReviewPlace, pendingReviewPlaces, plannedReviewPlaces, rememberReviewProfile } from "@petrina/orchestrator";
import { ReviewRoundCompletion, ReviewWorkflow } from "@petrina/orchestrator";
import { createVerifierBallots } from "./verifier-host.js";
import { executionFor, ReviewReports, type VerifierBallots, type PendingVerification, type RepositoryContext } from "@petrina/orchestrator";
import { changesOf, versionsOf } from "./repositories.js";
// Review rounds: Petrina's tamper check and the product's checks first, then every reviewer at once, then
// fresh agents voting on Important findings, and the round closing back to the builder or on to delivery.

import {
  checkReviewEvidence,
  findingKind,
  reviewerAt,
  type Id,
  type Stage
} from "@petrina/core";
import type { z } from "zod";
import * as git from "@petrina/repositories/git";
import { contractFor, ReviewResult } from "./roles.js";
import { Kernel, type MutableStage, type RuntimeTask } from "./kernel.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import { CheckPreparationChanged, type ProductChecks } from "./product-checks.js";
import type { Learnings } from "./learnings.js";
import type { Updates } from "./update.js";
import { prepareReviewInput, readReviewInput, reviewBaseUpdates, reviewContextIntact, type ReviewInput } from "./review-context.js";
import { conversationDigest, ParticipantUnavailable } from "./participant-conversation.js";
import { checkProofRequests, recordReviewProofs } from "@petrina/orchestrator";
import {
  runParallelReviewGroup,
  runVerificationVote,
  type ParallelReviewMember,
} from "./review-parallel-group.js";

export class Reviews {
  private readonly ballots: VerifierBallots;
  private readonly reports: ReviewReports;
  private readonly rounds: ReviewRoundCompletion;
  private readonly conversations: ReviewConversations;
  private readonly workflow: ReviewWorkflow;
  private readonly inputs = new WeakMap<RuntimeTask, { digest: string; input: ReviewInput }>();
  constructor(
    private readonly k: Kernel,
    private readonly turns: Turns,
    private readonly context: Context,
    private readonly checks: ProductChecks,
    private readonly learnings: Learnings,
    private readonly updates: Updates,
  ) {
    this.conversations = new ReviewConversations({
      profiles: () => k.s.profiles, profile: id => k.profile(id), digest: conversationDigest,
      checkpoint: () => k.commitNow(), unavailable: reason => new ParticipantUnavailable(reason),
    }, { contextIntact: reviewContextIntact, baseUpdates: reviewBaseUpdates });
    this.reports = new ReviewReports({ roles: () => k.s.roles,
      hasPendingReviewers: (task, stage) => this.pendingReviewers(task, stage).length > 0,
      id: task => k.id(task.id), now: () => Date.now(),
      verdict: (...args) => k.tracking.verdict(...args), note: (...args) => k.log(...args),
    });
    this.ballots = createVerifierBallots(k);
    this.rounds = new ReviewRoundCompletion({
      role: (id, task) => k.role(id, task), roles: () => k.s.roles,
      incrementalReview: id => {
        const role = k.role(id);
        return role && contractFor(role).incrementalReview;
      },
      ownChanges: task => this.ownChanges(task),
      anchor: async ({ work }, observation) => observation.incremental
        ? git.commitVersion(work.worktree!) : { tree: await git.treeOf(work.worktree!) },
      reviewEnd: (task, round, result) => k.tracking.reviewEnd(task, round, result),
      releaseInput: task => this.releaseRoundInput(task),
      note: (task, tone, text) => k.log(task, tone, text),
      commitNow: task => k.commitNow(task), changed: () => k.commit(),
      openDeliveryDecision: task => k.gate(task, "delivery"), now: () => Date.now(),
    });
    this.workflow = new ReviewWorkflow({
      now: () => Date.now(), id: task => k.id(task.id), checkpoint: () => k.commitNow(), changed: () => k.commit(),
      finishStep: task => k.finishStep(task), clearStep: task => k.clearStep(task), rerun: task => k.rerun(task),
    }, {
      prepareChecks: (scope, signal) => this.prepareChecks(scope, signal),
      checks: async (
        scope,
        signal
      ) => this.checks.failing(
        scope,
        signal,
        await this.checks.ensureChecks(
        scope,
        signal
      ),
        "review",
        () => this.prepareChecks(
        scope,
        signal
      )
      ),
      preparationChanged: error => error instanceof CheckPreparationChanged,
      backToBuilder: (scope, products) => this.checks.backToBuilder(scope, "before review", products), blocked: task => this.checks.blocked(task),
      versions: versionsOf,
      input: async (scope, signal) => {
        const snapshot = await this.context.captureReview(scope);
        const input = await prepareReviewInput(k.dataDir, scope, snapshot, signal);
        this.inputs.set(scope.task, { digest: input.digest, input: snapshot });
        return input;
      },
      pendingReviewers: (
        task,
        stage
      ) => this.pendingReviewers(
        task,
        stage
      ), hunt: (
        task,
        stage,
        reviewers,
        signal
      ) => this.hunt(
        task,
        stage,
        reviewers,
        signal
      ),
      pendingVote: (task, stage) => this.pendingVote(task, stage), vote: (task, pending, signal) => this.vote(task, pending, signal),
      finishBallot: (task, pending) => this.ballots.finish(task, pending),
      closeRound: (task, stage, round, outcome, versions) => this.closeReviewRound(task, stage, round, outcome, versions),
    });
  }

  /** Bring review checks onto their current source and reconcile Petrina's own findings. */
  private async prepareChecks(scope: RepositoryContext, signal: AbortSignal): Promise<boolean> {
    const { task, work } = scope;
    this.updates.clearObservedHead(scope);
    if (await this.updates.upToDate(scope, signal) === "conflict") return false;
    // Repeat the whole review preflight on the code actually admitted, including Petrina's own findings.
    delete task.handChanges;
    const knownHead = this.updates.consumeObservedHead(scope);
    const [problems, sha] = await Promise.all([
      git.tamperCheck(work.worktree!, work.baseSha ?? work.base!), knownHead ?? git.head(work.worktree!),
    ]);
    work.tamper = { at: Date.now(), sha, problems };
    for (const finding of task.findings) {
      const kind = findingKind(finding);
      if (
        finding.status === "open"
        && (kind === "tamper" || kind === "delivery")
        && (!task.repositories || finding.productIds?.includes(work.productId))
        && !problems.includes(finding.text)
      ) {
        finding.status = "fixed";
      }
    }
    for (const problem of problems) {
      if (!task.findings.some(finding => finding.text === problem && finding.status === "open" && (!task.repositories || finding.productIds?.includes(work.productId)))) {
        task.findings.push({
          kind: "tamper",
          ...(task.repositories ? { productIds: [work.productId] } : {}),
          id: this.k.id(task.id),
          text: problem,
          severity: "blocking",
          raisedBy: "petrina",
          confirmedBy: [],
          status: "open"
        });
      }
    }
    this.k.log(
      scope,
      problems.length ? "warn" : "done",
      problems.length ? `Tamper check: ${problems.length} problem${problems.length === 1 ? "" : "s"}` : "Tamper check passed: no tests removed or skipped"
    );
    return true;
  }

  /**
   * A review round: Petrina's own checks first; then every reviewer looks at the change at once, each on
   * its own; then fresh agents vote on the Important findings no second tool has backed yet; then the round
   * ends. What each reviewer and voter hands back is saved as it arrives, so a restart only redoes the rest.
   */
  async runReview(task: RuntimeTask, stage: MutableStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    return this.workflow.run(task, stage, signal);
  }

  /** Who works on the review step next: a reviewer who has not reported yet, else a voter, else nobody. */
  nextAgent(task: RuntimeTask, stage: MutableStage): { roleId: Id; profileId: Id; reviewerKey?: string; requiredToolId?: Id } | undefined {
    return nextReviewPlace(task, stage, {
      roles: () => this.k.s.roles, profile: id => this.k.profile(id), pendingVoter: () => this.pendingVote(task, stage)?.voters[0],
    });
  }

  /** The stage's reviewers who have not reported this round, by their place in the stage. */
  private pendingReviewers(task: RuntimeTask, stage: Stage): { key: string; profileId: Id }[] {
    return pendingReviewPlaces(task, stage, { roles: () => this.k.s.roles, profile: id => this.k.profile(id) });
  }

  /** Every reviewer place the round waits for: the whole stage, or a port review's one reviewer. */
  private plannedReviewers(task: RuntimeTask, stage: Stage): { key: string; profileId: Id }[] {
    return plannedReviewPlaces(task, stage, { roles: () => this.k.s.roles, profile: id => this.k.profile(id) });
  }

  /** The positions the round's step expects a result from, recorded on the step as its participants are admitted. */
  private plannedSeats(task: RuntimeTask, stage: Stage): string[] {
    return this.plannedReviewers(task, stage).map(({ key }) => `reviewer:${key}`);
  }

  private rememberReviewer(task: RuntimeTask, key: string, profileId: Id): void {
    rememberReviewProfile(task, key, profileId);
    this.k.commitNow();
  }

  private releaseRoundInput(task: RuntimeTask): void {
    this.inputs.delete(task);
    // Keep one completed conversation per stage seat for later check/coordinator returns,
    // including the same numbered round. Scope, context and ancestry are checked on reuse.
    // Pause/cancellation and final context cleanup release these bounded references.
  }

  /** A seat returns only to its own completed conversation, with unchanged role and approved scope. */
  private participant(scope: RepositoryContext, stage: MutableStage, seat: Id, plannedId: Id) {
    return this.conversations.participant(scope, stage, seat, plannedId);
  }

  private async input(task: RuntimeTask, signal: AbortSignal): Promise<ReviewInput> {
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
  private async hunt(task: RuntimeTask, stage: MutableStage, reviewers: readonly { key: string; profileId: Id }[], signal: AbortSignal): Promise<void> {
    const scope = executionFor(task);
    const input = await this.input(task, signal);
    const check = (result: z.infer<typeof ReviewResult>) => checkReviewEvidence(
      input.findings,
      result,
      task
    ) ?? checkProofRequests(
      this.k,
      task,
      result.proofRequests
    );
    // What the step waits for: every planned place, not only the participants that happen to start.
    const seats = this.plannedSeats(task, stage);
    if (stage.profileIds.length === 1 && !task.repositories) {
      const { key, profileId } = reviewers[0]!;
      const roleId = reviewerAt(stage, Number(key));
      const participant = { ...this.participant(scope, stage, key, profileId), reviewFindings: input.findings };
      let by = profileId;
      const result = await this.turns.turn(
        scope,
        roleId,
        profileId,
        () => this.context.sectionsFor(
        scope,
        roleId,
        undefined,
        undefined,
        `review-${key}`,
        input
      ),
        ReviewResult,
        signal,
        {
        ...participant,
        check,
        reviewerKey: key,
        seats,
        used: (id) => {
        by = id;
        this.rememberReviewer(
        task,
        key,
        id
      );
      }
      }
      );
      await this.applyReview(scope, stage, result, by, roleId, key);
      this.reportAccepted(task, key);
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
          const used = (id: Id) => {
            by = id;
            onUsed(id);
          };
          const given = () => this.context.sectionsFor(scope, roleId, `review-${key}`, this.turns.repositoryCopies.get(copy), undefined, input);
          const result = continuing
            ? await this.turns.turn(
              scope,
              roleId,
              profileId,
              given,
              ReviewResult,
              signal,
              {
              ...participant,
              check,
              copy,
              member: `review-${key}`,
              reviewKey: `reviewer:${key}`,
              used,
              room,
              reviewerKey: key,
              seats
            }
            )
            : await this.turns.parallel(
              scope,
              roleId,
              profileId,
              copy,
              given,
              ReviewResult,
              signal,
              {
              ...participant,
              check,
              key: `reviewer:${key}`,
              member: `review-${key}`,
              used,
              room,
              seat,
              ...selection,
              reviewerKey: key,
              seats,
              agent,
              refresh: false
            }
            );
          await this.applyReview(scope, stage, result, by, roleId, key);
          this.k.finishReviewWork(task, `reviewer:${key}`);
          this.reportAccepted(task, key);
        },
      })),
      signal,
      (
        running,
        waiting
      ) => `${running} ${role.toLowerCase()}${running === 1 ? ` looking at the ${scope.work.portReview ? "port" : "change"}` : "s looking at the change at once"}${waiting ? `, ${waiting} waiting for a slot` : ""}`,
    );
  }

  /** Checkpoint the accepted normalized report at its original place in this round. */
  private reportAccepted(task: RuntimeTask, key: string): void {
    task.hunt = { ...task.hunt!, reported: { ...task.hunt!.reported, [key]: true } };
    this.k.commitNow();
  }

  /** What one reviewer reported: its confirmations and disputes of earlier findings, and its own. */
  private async applyReview(scope: RepositoryContext, stage: MutableStage, result: z.infer<typeof ReviewResult>, profileId: Id, roleId: Id, reviewerKey: string): Promise<void> {
    recordReviewProofs(this.k, scope.task, stage, result.proofRequests, profileId, roleId, reviewerKey);
    const { task } = scope;
    await this.learnings.note(scope, result.learnings, roleId, profileId);
    this.reports.apply(task, stage, result, profileId, roleId, reviewerKey);
  }

  /** Settle reviewer reports before asking which saved ballot phase needs work. */
  private pendingVote(task: RuntimeTask, stage: MutableStage): PendingVerification | undefined {
    this.settleReviews(task, stage);
    return this.ballots.next(task, stage);
  }

  /**
   * Fresh agents check their place's findings, all at once, each blind to its peers' answers. Every answer is saved
   * as it arrives with its place, so a limit or restart only asks for what that place still owes.
   */
  private async vote(task: RuntimeTask, pending: PendingVerification, signal: AbortSignal): Promise<void> {
    return runVerificationVote(
      {
        k: this.k,
        turns: this.turns,
        context: this.context,
        ballots: this.ballots,
        readInput: (current, innerSignal) => this.input(current, innerSignal),
        together: (current, members, innerSignal, status) => this.together(current, members, innerSignal, status),
      },
      task,
      pending,
      signal,
    );
  }

  /**
   * Several agents on one step at once, each in a working copy of its own made from the task's current
   * commit, so a test one runs or a checkout one makes never disturbs another, and the task's own copy is
   * never touched.
   */
  private async together(
    task: RuntimeTask,
    members: readonly ParallelReviewMember[],
    parentSignal: AbortSignal,
    status: (running: number, waiting: number) => string,
  ): Promise<void> {
    return runParallelReviewGroup(
      this.k,
      this.turns,
      (current, key, profileId) => this.rememberReviewer(current, key, profileId),
      task,
      members,
      parentSignal,
      status,
    );
  }

  /** Settle objections and shared repairs together, only after the whole reviewer group reports. */
  private settleReviews(task: RuntimeTask, stage: MutableStage): void {
    this.reports.settle(task, stage);
  }

  /** The task's own change per product, without main's; one that cannot be read is unavailable. */
  private async ownChanges(task: RuntimeTask): Promise<Record<Id, string>> {
    return changesOf(task).catch(() => ({}));
  }

  /**
   * The end of a review round: back to the builder with what is Important, or on towards delivery. `outcome`: what
   * the round's last box (its reviewers', or its voters') says.
   */
  private async closeReviewRound(task: RuntimeTask, stage: MutableStage, round: number, outcome: string, reviewedVersions?: Readonly<Record<Id, string>>): Promise<"continue" | "stop"> {
    return this.rounds.finish(task, stage, round, outcome, reviewedVersions);
  }
}
