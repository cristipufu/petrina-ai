import { executionFor, scopesFor, repositoryView, type RepositoryContext } from "./repository-context.js";
import { beginRepair, changesOf, productsFor, versionsOf } from "./repositories.js";
import { refreshProofs } from "@petrina/core";
// Review rounds: Petrina's tamper check and the product's checks first, then every reviewer at once, then
// fresh agents voting on Important findings, and the round closing back to the builder or on to delivery.

import { runtimeWaitHolds, acceptsAnswer, authorProfile, ballotOf, choosePanel, coveredByDecision, decide, endAgentStep, engagedTools, findingCount, inBallot, isRejectedReopenOfVerifiedFix, JOURNEY_WORDS as W, noteReproduction, noteReviewTag, noteRoundEnd, openStep, panelAnswers, passedOpenWords, pickStarts, planThirdAnswers, portReviewerIndex, recordStepResult, replacementFor, reopensUnresolved, reviewClaimIds, reviewDecisionFor, reviewRoundEnd, reviewRoundSteps, reviewedCode, reviewerAt, seatAnswered, seatRemaining, slotUses, type ActiveAgent, type AgentProfile, type ConversationNote, type DeepMutable, type Finding, type Hunt, type Id, type JourneyStep, type PanelCandidate, type ReadinessRecheck, type Role, type Stage, type Task, type VerifierPanel, type VerifierSeat, type Vote } from "@petrina/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import * as git from "./git.js";
import { formatFindings } from "./prompts.js";
import { contractFor, VerifyResult, ReviewResult } from "./roles.js";
import { Kernel, type MStage, type MTask, ScreenWait, SourceRefreshRequired } from "./kernel.js";
import { CAPACITY_WAIT, WaitingForCapacity, waitingFor, WaitingForUsage } from "./usage.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import type { ProductChecks } from "./product-checks.js";
import type { Learnings } from "./learnings.js";
import { finishMessageGroup, routeMessages } from "./messages.js";
import type { Updates } from "./update.js";
import { prepareReviewInput, readReviewInput, reviewBases, reviewBaseUpdates, reviewContextIntact, reviewScopeKey, type ReviewInput } from "./review-context.js";
import { participantConversation, ParticipantUnavailable } from "./participant-conversation.js";
import { completeAll } from "./parallel.js";
import { checkProofRequests, recordReviewProofs } from "./proof-requests.js";
import type { ReadinessNeed } from "./readiness.js";

/**
 * Keep each dispute with who and why. Status is settled after every reviewer reports, so an objection
 * arriving before a confirmation cannot hide a problem from the rest of the round.
 */
export function recordDisputes(findings: DeepMutable<Finding>[], disputes: readonly { id: string; reason: string }[], by: Id, at: number): void {
  for (const dispute of disputes) {
    const finding = findings.find((entry) => entry.id === dispute.id);
    if (!finding || finding.status !== "open") continue;
    finding.disputes = [...(finding.disputes ?? []), { by, reason: dispute.reason, at }];
  }
}

/** What a reviewer's tag means for the finding. */
const SEVERITY = { important: "blocking", nit: "suggestion", "pre-existing": "pre-existing" } as const;

/** A verifier's answer in plain words. */
const VERDICT_WORDS: Record<Vote["verdict"], string> = { real: "real", "not-a-bug": "not a bug", nit: "only a nit", "pre-existing": "older than the change" };

const listWords = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** What voting needs next: the ballot's findings, the places to admit now and the profile each would start on. `phase`: every place of their step. */
type PendingVote = { findings: Task["findings"]; seats: VerifierSeat[]; voters: Id[]; phase?: VerifierSeat[]; panel?: VerifierPanel; third?: boolean };

function closedFinding(finding: Finding): boolean {
  return finding.status === "fixed" || finding.status === "dismissed";
}

function needsCurrentEvidence(finding: Finding): boolean {
  return finding.raisedBy !== "petrina" && (closedFinding(finding) || finding.reopenedAt !== undefined || finding.answer?.fixed === true);
}

/**
 * Closed findings, and open ones the coordinator chose to continue with, are judged again only from current reproductions,
 * never unexplained old ids.
 */
export function checkReviewEvidence(findings: readonly Finding[], result: z.infer<typeof ReviewResult>, task?: Pick<Task, "reviewDecision">): string | undefined {
  const unknown = [...result.confirms, ...result.disputes.map((entry) => entry.id), ...result.resolves.map(entry => entry.id)].filter((id) => !findings.some((finding) => finding.id === id));
  if (unknown.length) return `Confirm or dispute only finding ids provided in your saved review input. These ids were not shown: ${[...new Set(unknown)].join(", ")}. Report a new problem as a new finding instead.`;
  const invalid = result.resolves.filter(entry => !findings.some(finding => finding.id === entry.id && finding.severity === "pre-existing" && finding.raisedBy !== "petrina") || result.confirms.includes(entry.id) || result.disputes.some(dispute => dispute.id === entry.id));
  if (invalid.length) return `Use "resolves" only for a supplied pre-existing bug you proved was repaired in current code, without also confirming or disputing that id: ${invalid.map(entry => entry.id).join(", ")}. Include the original reproduction, current observed result and nearby controls in the evidence.`;
  const continued = new Set(task?.reviewDecision?.accepted ? task.reviewDecision.covers ?? [] : []);
  const missing = new Set(result.confirms.filter((id) => {
    const finding = findings.find((entry) => entry.id === id);
    return finding && (needsCurrentEvidence(finding) || (finding.raisedBy !== "petrina" && continued.has(id))) && !result.confirmationEvidence[id]?.trim();
  }));
  return missing.size ? `Current evidence is required to reopen or support a previously closed finding, or one the coordinator chose to continue with while it stays open. For ${[...missing].join(", ")}, return "confirms": [{"id": "<finding id>", "evidence": "<exact current failing case, expected and observed result>"}]. Include a nearby passing control when it distinguishes the regression. If there is no current failing case, omit the confirmation. The old report alone is not current evidence.` : undefined;
}

/** Preserve independent current reproductions when more than one reviewer supplies evidence. */
export function addEvidence(finding: DeepMutable<Finding>, evidence: string | undefined): void {
  const current = evidence?.trim();
  const previous = finding.evidence?.trim();
  // Match a complete block, including multi-paragraph proofs, rather than shared words within one.
  if (!current || finding.raisedBy === "petrina" || (previous && `\n\n${previous}\n\n`.includes(`\n\n${current}\n\n`))) return;
  finding.evidence = previous ? `${previous}\n\n${current}` : current;
}

/** A new reproduction reopens the same finding; its earlier support and dismissal remain history. */
function reopenFinding(finding: DeepMutable<Finding>, at: number, evidence?: string): void {
  finding.earlierReviews = [...(finding.earlierReviews ?? []), {
    at,
    ...(finding.evidence ? { evidence: finding.evidence } : {}),
    confirmedBy: finding.confirmedBy,
    ...(finding.disputes ? { disputes: finding.disputes } : {}),
    ...(finding.verification ? { verification: finding.verification } : {}),
    ...(finding.votes ? { votes: finding.votes } : {}),
    ...(finding.unresolved ? { unresolved: finding.unresolved } : {}),
    ...(finding.answer ? { answer: finding.answer } : {}),
    ...(finding.resolution ? { resolution: finding.resolution } : {}),
  }];
  finding.confirmedBy = [];
  delete finding.disputes;
  delete finding.verification;
  delete finding.votes;
  delete finding.unresolved;
  delete finding.resolution;
  finding.status = "open";
  finding.reopenedAt = at;
  if (evidence !== undefined) finding.evidence = evidence.trim();
}

/** Recover older accepted reports before new hand-backs make the round's transitions explicit. */
function recordedReopenings(group: readonly JourneyStep[]): { id: Id; evidence: boolean }[] {
  const reopened = new Map<Id, { id: Id; evidence: boolean }>();
  for (const step of group) {
    const recorded = step.result?.findingChanges?.reopened;
    if (recorded) for (const finding of recorded) reopened.set(finding.id, finding);
    // Only saved participant copies can recover older transitions, never today's live findings.
    else for (const result of step.agentResults ?? []) for (const finding of result.findings ?? []) {
      if (finding.reopenedAt !== undefined && finding.reopenedAt >= group[0]!.startedAt && finding.reopenedAt >= result.at) reopened.set(finding.id, { id: finding.id, evidence: !!finding.evidence });
    }
  }
  return [...reopened.values()];
}

/** What admission decided for a parallel seat: the words on its start, why a saved conversation was not kept, and its readiness recheck. */
type SeatSelection = { selectionReason?: string; freshReason?: string; readiness?: ReadinessRecheck };

export class Reviews {
  private readonly inputs = new WeakMap<MTask, { digest: string; input: ReviewInput }>();
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
    const scope = executionFor(task);
    // Older saved tasks could reopen a fix while retaining the verdict on its previous code.
    for (const finding of task.findings) {
      if (finding.raisedBy !== "petrina" && finding.status === "open" && finding.answer?.fixed && (finding.reopenedAt ?? -Infinity) < finding.answer.at && (!finding.verification || finding.verification.at < finding.answer.at)) reopenFinding(finding, Date.now());
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
        if ((await this.updates.upToDate(scope, signal)) === "conflict") return "continue";
        // The chain starts again from its first reviewer: changes made by hand are in what it reviews.
        delete task.handChanges;
        const [problems, sha] = await Promise.all([
          git.tamperCheck(scope.work.worktree!, scope.work.baseSha ?? scope.work.base!), git.head(scope.work.worktree!),
        ]);
        scope.work.tamper = { at: Date.now(), sha, problems };
        // Petrina's own findings settle on what it sees now, whatever anyone answered.
        for (const finding of task.findings) {
          if (finding.raisedBy === "petrina" && finding.status === "open" && !finding.text.startsWith("Check failed") && (!task.repositories || finding.productIds?.includes(scope.work.productId)) && !problems.includes(finding.text)) finding.status = "fixed";
        }
        for (const problem of problems) {
          if (!task.findings.some((finding) => finding.text === problem && finding.status === "open" && (!task.repositories || finding.productIds?.includes(scope.work.productId)))) {
            task.findings.push({ ...(task.repositories ? { productIds: [scope.work.productId] } : {}), id: this.k.id(task.id), text: problem, severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
          }
        }
        this.k.log(scope, problems.length ? "warn" : "done", problems.length ? `Tamper check: ${problems.length} problem${problems.length === 1 ? "" : "s"}` : "Tamper check passed: no tests removed or skipped");
        // The product's checks run before any reviewer spends time: an agent's word never counts as passing.
        // A failed run is evidence too: it returns to the builder without spending a review round.
        failedChecks = await this.checks.failing(scope, signal, await this.checks.ensureChecks(scope, signal), "review") || failedChecks;
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
    const outcome = vote ? this.tally(task, vote) : this.raised(task);
    const reviewedVersions = task.hunt?.input?.trees;
    delete task.hunt;
    return this.closeReviewRound(task, stage, round, outcome, reviewedVersions);
  }

  /** What this round's reviewers raised, in plain counts. */
  private raised(task: MTask): string {
    const recorded = openStep(task)?.result?.findings;
    return findingCount(recorded ? recorded.filter((finding) => finding.status === "open") : task.findings.slice(task.hunt?.findings ?? 0));
  }

  /** Who works on the review step next: a reviewer who has not reported yet, else a voter, else nobody. */
  nextAgent(task: MTask, stage: MStage): { roleId: Id; profileId: Id; reviewerKey?: string; requiredToolId?: Id } | undefined {
    const reviewer = this.pendingReviewers(task, stage)[0];
    if (reviewer) return { roleId: reviewerAt(stage, Number(reviewer.key)), profileId: reviewer.profileId, reviewerKey: reviewer.key };
    const voter = this.pendingVote(task, stage)?.voters[0];
    return voter ? { roleId: "verifier", profileId: voter, requiredToolId: this.k.profile(voter)?.toolId } : undefined;
  }

  /** The stage's reviewers who have not reported this round, by their place in the stage. */
  private pendingReviewers(task: MTask, stage: MStage): { key: string; profileId: Id }[] {
    const scope = executionFor(task);
    const reported = task.hunt?.stageId === stage.id && task.hunt.round === (task.rounds[stage.id] ?? 1) ? task.hunt.reported : {};
    if (scope.work.portReview && Object.keys(reported).length) return [];
    return this.plannedReviewers(task, stage).filter((entry) => !reported[entry.key]);
  }

  /** Every reviewer place the round waits for: the whole stage, or a port review's one reviewer. */
  private plannedReviewers(task: MTask, stage: MStage): { key: string; profileId: Id }[] {
    const scope = executionFor(task);
    const planned = stage.profileIds.map((profileId, index) => ({ key: String(index), profileId }));
    // The journey and the engine share the port reviewer's position; tool choice follows the latest builder.
    return scope.work.portReview ? [planned[portReviewerIndex(repositoryView(scope), stage.profileIds, (id) => this.k.profile(id)?.toolId, this.k.s.roles)]!] : planned;
  }

  /** The positions the round's step expects a result from, recorded on the step as its participants are admitted. */
  private plannedSeats(task: MTask, stage: MStage): string[] {
    return this.plannedReviewers(task, stage).map(({ key }) => `reviewer:${key}`);
  }

  /** A vote's places are its step's expected seats, named by place: recorded on the open vote step, never on an ended one. */
  private syncVoterSeats(task: MTask, seats: readonly VerifierSeat[]): void {
    const step = openStep(task);
    if (step?.kind === "agent" && step.roleId && this.k.role(step.roleId)?.result === "votes") step.seats = seats.map((seat) => `verifier:${seat.key}`);
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
    const reopenings = new Set<Id>();
    for (const id of result.confirms) {
      const finding = task.findings.find((entry) => entry.id === id);
      // Fresh proof can challenge a claimed fix or dismissal without creating another finding, and on changed code starts
      // a fresh ballot for one a vote left unresolved. Native check findings remain governed by the actual check results.
      const evidence = result.confirmationEvidence[id];
      if (finding && finding.raisedBy !== "petrina" && (closedFinding(finding) || reopensUnresolved(finding, task.hunt, evidence))) {
        reopenFinding(finding, Date.now(), evidence);
        reopenings.add(id);
      } else if (finding) addEvidence(finding, evidence);
      if (finding && evidence?.trim()) noteReproduction(task, finding, Date.now());
      if (finding && !finding.confirmedBy.includes(profileId)) finding.confirmedBy.push(profileId);
    }
    if (task.hunt) for (const report of [...result.confirms.map(id => ({ id, resolved: false, evidence: result.confirmationEvidence[id] })), ...result.resolves.map(entry => ({ ...entry, resolved: true }))]) {
      task.hunt.findingChecks = { ...task.hunt.findingChecks, [report.id]: { ...task.hunt.findingChecks?.[report.id], [reviewerKey]: { by: profileId, resolved: report.resolved, ...(report.evidence ? { evidence: report.evidence } : {}) } } };
    }
    recordDisputes(task.findings.filter((finding) => !task.repositories || productsFor(task, finding.productIds).length > 0), result.disputes, profileId, Date.now());
    if (task.repositories && task.hunt) for (const finding of task.findings) {
      const owners = productsFor(task, finding.productIds);
      if (owners.length < 2 || finding.raisedBy === "petrina" || finding.text.startsWith("Failed acceptance check:") || !owners.every((id) => finding.answers?.[id]?.fixed)) continue;
      const passed = result.verdict === "pass" && !result.confirms.includes(finding.id);
      task.hunt.fixReviews = { ...task.hunt.fixReviews, [finding.id]: { ...task.hunt.fixReviews?.[finding.id], [reviewerKey]: passed } };
    }
    // New reports keep their own identities. Only explicit confirmations by id back an earlier finding.
    const shown = task.shownFollowUps?.[`review-${reviewerKey}`] ?? task.shownFollowUps?.[reviewerKey];
    const picked = (value: string | undefined): Finding["sameBug"] | undefined => {
      const choice = value?.trim();
      if (!choice || !shown?.length || (choice !== "none" && !shown.includes(choice))) return undefined;
      return choice === "none" ? "none" : choice;
    };
    const raised: DeepMutable<Finding>[] = [];
    for (const finding of result.findings) {
      const choice = picked(finding.sameBug);
      const tagged = noteReviewTag(undefined, SEVERITY[finding.severity], profileId, Date.now());
      const relevant = tagged.judgments.some((entry) => entry.severity === "pre-existing");
      const created: DeepMutable<Finding> = {
        id: this.k.id(task.id), text: finding.text,
        ...(task.repositories ? { productIds: productsFor(task, finding.productIds) } : {}),
        ...(finding.where ? { where: finding.where } : {}),
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
        ...(finding.steps?.trim() ? { steps: finding.steps.trim() } : {}),
        ...(shown?.length ? { cardsShown: [...shown] } : {}),
        ...(choice ? { sameBug: choice } : {}),
        ...(relevant ? { judgments: tagged.judgments } : {}),
        severity: tagged.severity, raisedBy: profileId, roleId, confirmedBy: [], status: "open",
      };
      task.findings.push(created);
      raised.push(created);
    }
    const important = raised.some((finding) => finding.severity === "blocking");
    // A confirmed existing finding asks for fixes just as a newly raised one does. Count each once.
    const created = new Set(raised.map((finding) => finding.id));
    const step = openStep(task);
    const seen = new Set([...(step?.result?.findings ?? []).map((finding) => finding.id), ...result.confirms, ...result.disputes.map((finding) => finding.id), ...result.resolves.map(finding => finding.id)]);
    const priorChanges = step?.result?.findingChanges;
    const priorReopened = recordedReopenings(step ? reviewRoundSteps(task, step.id, this.k.s.roles) : []);
    const reopened = task.findings.filter(finding => reopenings.has(finding.id)).map(finding => ({ id: finding.id, evidence: !!finding.evidence }));
    recordStepResult(task, {
      findings: task.findings.filter((finding) => seen.has(finding.id) || created.has(finding.id)),
      findingChanges: { raised: [...(priorChanges?.raised ?? []), ...created], fixed: priorChanges?.fixed ?? [], dismissed: priorChanges?.dismissed ?? [], reopened: [...priorReopened, ...reopened] },
    });
    // This seat's own copy of the records it touched: later peers and rounds never rewrite it.
    const own = step?.agentResults?.findLast((entry) => entry.roleId === roleId && entry.profileId === profileId && (entry.inputIndex === undefined || step.agentInputs?.[entry.inputIndex]?.reviewerKey === reviewerKey));
    if (own) own.findings = structuredClone(task.findings.filter((finding) => result.confirms.includes(finding.id) || result.disputes.some((dispute) => dispute.id === finding.id) || result.resolves.some(entry => entry.id === finding.id) || created.has(finding.id)));
    const supported = task.findings.filter((finding) => finding.status === "open" && (result.confirms.includes(finding.id) || created.has(finding.id)));
    this.k.tracking.verdict(task, roleId, profileId, task.rounds[stage.id] ?? 1, result.verdict, supported.length, supported.filter((finding) => finding.severity === "blocking").length);
    const confirmed = result.confirms.length;
    const also = [confirmed ? `confirmed ${confirmed}` : "", result.disputes.length ? `disputed ${result.disputes.length}` : ""].filter(Boolean).join(", ");
    this.k.log(task, important ? "warn" : "done", `${findingCount(raised)}${also ? `; ${also}` : ""}`, roleId, profileId);
  }

  /**
   * The Important findings to check (raised by a reviewer and not yet backed on a second tool), and the places to admit
   * next. A new ballot saves its bounded panel before anyone starts; the initial places finish first, then targeted third
   * answers, each set in its own journey step.
   */
  private pendingVote(task: MTask, stage: MStage): PendingVote | undefined {
    // Scheduling asks this before running the step. Settle the complete reviewer group first,
    // so a finding that needs no ballot cannot make the task wait for a voter's usage or slot.
    this.settleReviews(task, stage);
    const hunt = task.hunt;
    const eligible = this.ballotFindings(task);
    let panel: VerifierPanel | undefined = hunt?.panel;
    if (!panel && hunt?.voterProfiles?.length && eligible.length) {
      // An older round admitted one voter per tool: it keeps its places and majority rule until it finishes.
      hunt.panel = this.olderPanel(task, eligible) as DeepMutable<VerifierPanel>;
      panel = hunt.panel;
      delete hunt.voterProfiles;
      delete hunt.voterReplacements;
      this.k.commitNow();
    }
    if (!panel) {
      if (!eligible.length) return undefined;
      const chosen = this.newPanel(task, stage, eligible);
      if (!chosen) {
        // Nobody can vote yet: leave the panel open until at least one tool is usable, and keep the review waiting.
        const waiting = this.voters(stage)[0];
        return { findings: eligible, seats: waiting ? [{ key: waiting, profileId: waiting, toolId: this.k.profile(waiting)?.toolId ?? "", findingIds: eligible.map((finding) => finding.id), reason: "" }] : [], voters: waiting ? [waiting] : [] };
      }
      panel = chosen.panel;
      // A paused scheduler may ask who would run next before tool checks finish.
      // Keep that preview provisional until work can start; an existing ballot stays durable.
      if (hunt && !this.k.taskAdmissionsClosed(task)) {
        chosen.keep();
        hunt.panel = panel as DeepMutable<VerifierPanel>;
        this.syncVoterSeats(task, panel.seats);
        this.k.log(task, "milestone", `${panel.seats.length === 1 ? "Verifier" : "Verifiers"}: ${listWords(panel.seats.map((seat) => this.k.named(seat.profileId)))} check ${findingCount(eligible)}; usable at selection: ${listWords(panel.usable.map((tool) => this.toolName(tool)))}`);
        this.k.commitNow();
      }
    }
    const ids = new Set(panel.seats.flatMap((seat) => seat.findingIds));
    // A finding that became eligible while the initial places still work joins their assignment; it never waits for a later round.
    const joining = eligible.filter((finding) => !ids.has(finding.id));
    if (joining.length && hunt?.panel === panel && panel.escalatedAt === undefined && !this.k.taskAdmissionsClosed(task)) {
      for (const seat of panel.seats as DeepMutable<VerifierSeat>[]) seat.findingIds = [...seat.findingIds, ...joining.map((finding) => finding.id)];
      for (const finding of joining) ids.add(finding.id);
      this.k.commitNow();
    }
    const findings = task.findings.filter((finding) => ids.has(finding.id) && finding.status === "open" && !finding.verification && !finding.unresolved);
    if (!findings.length) return undefined;
    // Before the round saves its state, the preview reads answers as this stage and round's.
    const ballot = hunt ?? { stageId: stage.id, round: task.rounds[stage.id] ?? 1 };
    const remaining = (seat: VerifierSeat) => seatRemaining(panel, seat, findings, ballot).length > 0;
    const admit = (seats: VerifierSeat[], phase: VerifierSeat[], third?: boolean): PendingVote => ({ findings: findings as Task["findings"], panel, seats, voters: seats.map((seat) => this.voterOn(task, seat)), phase, ...(third ? { third } : {}) });
    const initial = panel.seats.filter((seat) => !seat.third);
    if (initial.some(remaining)) {
      if (hunt?.panel === panel && !this.k.taskAdmissionsClosed(task)) this.replaceStalled(task, stage, panel, findings, initial);
      return admit(initial.filter(remaining), initial);
    }
    if (panel.rule === "bounded" && panel.escalatedAt === undefined) {
      const plan = this.thirdAnswers(task, stage, panel, findings, ballot);
      if (hunt?.panel !== panel || this.k.taskAdmissionsClosed(task)) return admit(plan.seats, plan.seats, true);
      this.escalate(task, panel, findings, plan);
    }
    const third = panel.seats.filter((seat) => seat.third);
    if (third.some(remaining) && hunt?.panel === panel && !this.k.taskAdmissionsClosed(task)) this.replaceStalled(task, stage, panel, findings, third);
    return admit(third.filter(remaining), third, true);
  }

  /** Important reports that still need independent support: not backed on a second tool, never settled, never left unresolved. */
  private ballotFindings(task: MTask): Task["findings"] {
    const toolOf = (profileId: Id) => this.k.profile(profileId)?.toolId;
    return task.findings.filter((finding) => {
      if (finding.status !== "open" || finding.severity !== "blocking" || finding.raisedBy === "petrina" || finding.verification || finding.unresolved) return false;
      if (task.repositories && !productsFor(task, finding.productIds).length) return false;
      const judgments = finding.judgments ?? [];
      const clashed = judgments.some((entry) => entry.severity === "pre-existing") && judgments.some((entry) => entry.severity === "blocking");
      // A reviewer who says the bug is older is not a second tool agreeing that it is Important.
      const older = new Set(judgments.filter((entry) => entry.severity === "pre-existing").map((entry) => entry.by));
      const supporters = clashed
        ? [...judgments.filter((entry) => entry.severity === "blocking").map((entry) => entry.by), ...finding.confirmedBy.filter((id) => !older.has(id))]
        : [...((finding.reopenedAt !== undefined || finding.answer?.fixed) ? [] : [finding.raisedBy]), ...finding.confirmedBy];
      return new Set(supporters.map(toolOf).filter(Boolean)).size < 2;
    }) as Task["findings"];
  }

  private toolName(toolId: Id): string {
    return this.k.s.tools.find((tool) => tool.id === toolId)?.name ?? toolId;
  }

  /** The actual tool of a finding's author, or of the reviewer whose current reproduction reopened it. Unknown stays unknown. */
  private authorTool(finding: Finding): Id | undefined {
    const author = authorProfile(finding);
    return author ? this.k.profile(author)?.toolId : undefined;
  }

  /** The tools a verifier choice resolves on now, one per actual tool, in the stable order: stand-ins on the same tool included. */
  private usableVoters(task: MTask, stage: MStage): PanelCandidate[] {
    const tools = new Set<Id>();
    return this.voters(stage).flatMap((id) => {
      const choice = this.k.choose(id, task, "verifier");
      if (!choice || choice.kind === "none" || tools.has(choice.profile.toolId)) return [];
      tools.add(choice.profile.toolId);
      return [{ toolId: choice.profile.toolId, profileId: choice.profile.id, usableNow: true }];
    });
  }

  /**
   * A new ballot's bounded panel. Usage, model and capacity choices resolve first: a tool already unavailable is not
   * reserved for later, while a full slot still waits for its place. Answers this ballot already proved keep their places.
   */
  private newPanel(task: MTask, stage: MStage, findings: Task["findings"]): { panel: VerifierPanel; keep: () => void } | undefined {
    const recovered = this.recoveredAnswers(task, findings);
    const panel = choosePanel({
      candidates: this.usableVoters(task, stage),
      recovered: recovered.candidates,
      findings: findings.map((finding) => ({ id: finding.id, ...(this.authorTool(finding) ? { author: this.authorTool(finding)! } : {}) })),
      name: (tool) => this.toolName(tool),
    });
    return panel ? { panel, keep: recovered.keep } : undefined;
  }

  /**
   * Answers to this stage, round and reviewed code saved before a panel was: they count before more work is chosen.
   * An older answer without ballot details counts only when this round's own vote step recorded it on this input.
   */
  private recoveredAnswers(task: MTask, findings: Task["findings"]): { candidates: PanelCandidate[]; keep: () => void } {
    const hunt = task.hunt;
    if (!hunt) return { candidates: [], keep: () => {} };
    const recorded = (finding: Finding, vote: Vote) => !!hunt.input?.digest && (task.journey ?? []).some((step) => step.stageId === hunt.stageId && step.round === hunt.round && step.reviewInput?.digest === hunt.input!.digest && this.k.role(step.roleId ?? "")?.result === "votes" &&
      [...(step.result?.findings ?? []), ...(step.agentResults ?? []).flatMap((entry) => entry.findings ?? [])].some((copy) => copy.id === finding.id && copy.votes?.some((saved) => !saved.ballot && saved.toolId === vote.toolId && saved.by === vote.by && saved.verdict === vote.verdict && saved.reason === vote.reason)));
    const proven = (finding: Finding, vote: Vote) => !!vote.toolId && (vote.ballot ? inBallot(vote, hunt) : recorded(finding, vote));
    const places = new Map<Id, Id>();
    for (const finding of findings) for (const vote of finding.votes ?? []) if (proven(finding, vote) && !places.has(vote.toolId!)) places.set(vote.toolId!, vote.plannedProfileId ?? vote.by);
    return {
      candidates: [...places].map(([toolId, profileId]) => ({ toolId, profileId })),
      // Proven answers are attributed to their tool's kept place, so the saved panel counts them as this ballot's.
      keep: () => {
        for (const finding of findings) if (finding.votes?.some((vote) => proven(finding, vote))) finding.votes = finding.votes.map((vote) => proven(finding, vote) ? { ...vote, ballot: ballotOf(hunt, places.get(vote.toolId!)!) } : vote);
      },
    };
  }

  /** An older round's saved electorate, as places with its original majority rule. */
  private olderPanel(task: MTask, findings: Task["findings"]): VerifierPanel {
    const hunt = task.hunt!;
    const planned = hunt.voterProfiles!;
    const toolOf = (id: Id) => this.k.profile(id)?.toolId ?? id;
    return {
      rule: "majority",
      usable: [...new Set(planned.map(toolOf))],
      seats: planned.map((id) => ({ key: id, profileId: id, toolId: toolOf(id), findingIds: findings.map((finding) => finding.id), reason: "Kept the place this ballot admitted before bounded panels, with its original rule.", ...(hunt.voterReplacements?.[id] ? { replaced: hunt.voterReplacements[id]! } : {}) })),
    };
  }

  /** The profile that would start on a place now: a same-tool model stand-in, or the planned profile while it waits. */
  private voterOn(task: MTask, seat: VerifierSeat): Id {
    const choice = this.k.choose(seat.profileId, task, "verifier");
    // A full model keeps this tool's seat. The vote waits instead of settling on the other tools.
    if (choice?.kind === "none" && choice.waiting.startsWith(CAPACITY_WAIT)) return seat.profileId;
    // Once admitted, a missing independent tool cannot be replaced by a finished partner's answer.
    return choice && choice.kind !== "none" && choice.profile.toolId === seat.toolId ? choice.profile.id : seat.profileId;
  }

  /**
   * A place whose tool cannot continue may move to a currently usable tool independent of every finding it still owes,
   * preferring tools that reported none of them. A cap, a pause or a drain never makes a usable place disappear,
   * a completed partner never covers it, and its saved answers remain. `phase`: every place of one step. Each place keeps
   * its own seat, conversation and working copy, so a tool that finished another place may take this one; a tool still
   * working another unfinished place finishes that first.
   */
  private replaceStalled(task: MTask, stage: MStage, panel: VerifierPanel, findings: Task["findings"], phase: readonly VerifierSeat[]): void {
    const hunt = task.hunt!;
    let changed = false;
    for (const seat of phase as DeepMutable<VerifierSeat>[]) {
      const owed = seatRemaining(panel, seat, findings, hunt);
      if (!owed.length) continue;
      const choice = this.k.choose(seat.profileId, task, "verifier");
      if (choice?.kind === "none" && choice.waiting.startsWith(CAPACITY_WAIT)) continue;
      if (choice && choice.kind !== "none" && choice.profile.toolId === seat.toolId) continue;
      const busy = new Set(phase.filter((other) => other !== seat && seatRemaining(panel, other, findings, hunt).length).map((other) => other.toolId));
      const alternatives = this.usableVoters(task, stage).filter((candidate) => candidate.toolId !== seat.toolId && !busy.has(candidate.toolId));
      const replacement = replacementFor(owed, (id) => engagedTools(panel, findings.find((finding) => finding.id === id)!, hunt, seat), alternatives, owed.map((id) => panel.authors?.[id]));
      if (!replacement) continue;
      const reason = `${this.k.named(seat.profileId)} could not finish verification (${choice?.kind === "none" ? choice.waiting : "selection did not retain its tool"}). ${this.k.named(replacement.profileId)} takes its required seat on a different tool; saved votes remain.`;
      seat.replaced = { from: seat.profileId, reason };
      seat.profileId = replacement.profileId;
      seat.toolId = replacement.toolId;
      this.k.log(task, "milestone", reason);
      changed = true;
    }
    if (!changed) return;
    this.syncVoterSeats(task, phase);
    this.k.commitNow();
  }

  /** The findings whose two completed answers both said they do not block, and who gives each its third answer. */
  private thirdAnswers(task: MTask, stage: MStage, panel: VerifierPanel, findings: Task["findings"], ballot: Pick<Hunt, "stageId" | "round" | "input">) {
    const needs = findings.flatMap((finding) => {
      const answers = panelAnswers(panel, finding, ballot);
      return decide(panel, answers)?.verdict === "third" ? [{ id: finding.id, answered: answers.map((vote) => vote.toolId!), ...(panel.authors?.[finding.id] ? { author: panel.authors[finding.id]! } : {}) }] : [];
    });
    if (!needs.length) return { seats: [], escalations: {} };
    // Any ready tool that has not answered a finding may give its third answer when it can start now. Only a tool
    // usable when the panel was saved is waited for: one already left out then is never a required tie-breaker.
    const tools = new Set<Id>();
    const suppliers = this.voters(stage).flatMap((id) => {
      const toolId = this.k.profile(id)?.toolId;
      if (!toolId || tools.has(toolId)) return [];
      tools.add(toolId);
      const choice = this.k.choose(id, task, "verifier");
      const usableNow = !!choice && choice.kind !== "none" && choice.profile.toolId === toolId;
      if (!usableNow && !panel.usable.includes(toolId)) return [];
      return [{ toolId, profileId: usableNow ? choice.profile.id : id, usableNow }];
    });
    return planThirdAnswers({ findings: needs, suppliers, name: (tool) => this.toolName(tool) });
  }

  /** Save the third answers once the initial places finished, and close the first pair's step with what it decided. */
  private escalate(task: MTask, panel: VerifierPanel, findings: Task["findings"], plan: ReturnType<Reviews["thirdAnswers"]>): void {
    const hunt = task.hunt!;
    const saved = panel as DeepMutable<VerifierPanel>;
    saved.seats = [...saved.seats, ...plan.seats as DeepMutable<VerifierSeat>[]];
    saved.escalatedAt = Date.now();
    if (Object.keys(plan.escalations).length) saved.escalations = plan.escalations;
    // A third place is named on its own and starts clean, never in an earlier place's conversation.
    for (const seat of plan.seats) {
      if (hunt.work) delete hunt.work[`verifier:${seat.key}`];
      if (hunt.screenTurns) delete hunt.screenTurns[`vote-${seat.key}`];
    }
    const voting = (entry: { roleId: Id }) => this.k.role(entry.roleId)?.result === "votes";
    if (plan.seats.length) {
      task.capacityResume = task.capacityResume?.filter((entry) => !voting(entry));
      task.capacityRetries = task.capacityRetries?.filter((entry) => !voting(entry));
      task.capacityPaused = task.capacityPaused?.filter((entry) => !voting(entry));
    }
    for (const [id, escalation] of Object.entries(plan.escalations)) this.k.log(task, escalation.unresolved ? "warn" : "milestone", `${findings.find((finding) => finding.id === id)?.text.slice(0, 80) ?? id}: ${escalation.reason}`);
    const asked = plan.seats.reduce((count, seat) => count + seat.findingIds.length, 0);
    const open = openStep(task);
    if (asked && open?.kind === "agent" && open.roleId && this.k.role(open.roleId)?.result === "votes") {
      const real = findings.filter((finding) => decide(panel, panelAnswers(panel, finding, hunt))?.verdict === "real").length;
      endAgentStep(task, { outcome: W.firstAnswers(findings.length, real, Object.keys(plan.escalations).length), reason: W.thirdAnswer(asked) }, Date.now());
    }
    this.k.commitNow();
  }

  /**
   * One fresh voter per usable tool, in the tools' stable order: the candidates a panel is chosen from. Prefer high
   * effort for checking a specific claim; the stage's discovery reviewers keep their configured profiles.
   */
  private voters(stage: MStage): Id[] {
    const usable = this.k.usableTools() as Id[];
    const ready = new Set(this.k.s.tools.filter((tool) => tool.status === "ready" && (!usable.length || usable.includes(tool.id))).map((tool) => tool.id));
    // With no tool found ready (tests stand in for the tools), the tools the stage's reviewers use.
    const tools = ready.size ? [...ready] : [...new Set(stage.profileIds.map((id) => this.k.profile(id)?.toolId).filter((id): id is Id => !!id))];
    return tools
      .map((toolId) => {
        const own = stage.profileIds.find((id) => this.k.profile(id)?.toolId === toolId);
        const profiles = this.k.s.profiles.filter((profile) => profile.toolId === toolId && !profile.standby);
        return profiles.find((profile) => profile.effort === "high")?.id ?? own ?? profiles[0]?.id;
      })
      .filter((id): id is Id => !!id);
  }

  /**
   * Fresh agents check their place's findings, all at once, each blind to its peers' answers. Every answer is saved
   * as it arrives with its place, so a limit or restart only asks for what that place still owes.
   */
  private async vote(task: MTask, pending: PendingVote, signal: AbortSignal): Promise<void> {
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
            const toolId = this.k.profile(by)!.toolId;
            const hunt = task.hunt!;
            const older = task.hunt?.panel?.rule === "majority";
            for (const verdict of value.verdicts) {
              const finding = task.findings.find((entry) => entry.id === verdict.id && assigned.has(entry.id));
              if (!finding) continue;
              // An unasked answer changes nothing: a place records only what it still owes, or its own tool's correction.
              if (task.hunt?.panel && !acceptsAnswer(task.hunt.panel, place(), finding, hunt, toolId)) continue;
              const previous = finding.votes?.findLast((vote) => vote.toolId === toolId && (older || (vote.ballot?.seat === planned.key && inBallot(vote, hunt))));
              if (previous?.by === by && previous.verdict === verdict.verdict && previous.reason === verdict.reason) continue;
              // A repair can revise an earlier verdict. Keep both reasons; the latest one counts for this place.
              finding.votes = [...(finding.votes ?? []), { by, toolId, plannedProfileId: plannedId, verdict: verdict.verdict, reason: verdict.reason, ballot: ballotOf(hunt, planned.key) }];
            }
            // A partial report is finished work too. Keep its reasons before asking for the rest,
            // so a limit or restart only redoes the missing verdicts on this place.
            recordStepResult(task, { findings: task.findings.filter((finding) => assigned.has(finding.id)) });
            this.k.commitNow();
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
   * Every place has answered: each finding is settled by its panel's rule (see `decide`). A real answer keeps it
   * Important, disputed when another answer disagreed; a finding whose required third answer nobody could give stays
   * Important and unresolved, without an invented verification. Says how the vote went.
   */
  private tally(task: MTask, pending: PendingVote): string {
    const ids = new Set(pending.findings.map((finding) => finding.id));
    const panel = task.hunt?.panel ?? pending.panel;
    const at = Date.now();
    let real = 0, disputed = 0, unresolved = 0;
    for (const finding of task.findings.filter((entry) => ids.has(entry.id))) {
      if (!panel || !task.hunt) continue;
      // One actual tool, one answer on this ballot. Older rounds' answers and unproven identities stay history.
      const decision = decide(panel, panelAnswers(panel, finding, task.hunt));
      if (!decision) continue;
      if (decision.verdict === "third") {
        finding.unresolved = { at, reason: panel.escalations?.[finding.id]?.reason ?? "Both answers said it does not block, and the required third answer could not be had: it stays Important, unresolved.", ...reviewedCode(task.hunt) };
        unresolved += 1;
        continue;
      }
      if (decision.verdict === "real") {
        real += 1;
        if (decision.disputed.length) disputed += 1;
        const dispute = decision.disputed.map((vote) => `${this.k.named(vote.by)} answered ${VERDICT_WORDS[vote.verdict]}: ${vote.reason}`).join(" ");
        finding.verification = { by: decision.vote.by, verdict: "real", reason: dispute ? `${decision.vote.reason} Disputed: ${dispute}` : decision.vote.reason, at };
        continue;
      }
      finding.verification = { by: decision.vote.by, verdict: decision.verdict, reason: decision.vote.reason, at };
      if (decision.verdict === "not-a-bug") finding.status = isRejectedReopenOfVerifiedFix(finding) ? "fixed" : "dismissed";
      else if (decision.verdict === "nit") finding.severity = "suggestion";
      else finding.severity = "pre-existing";
    }
    const checked = task.findings.filter((finding) => ids.has(finding.id));
    recordStepResult(task, { findings: checked, findingsSettled: true });
    const oneTool = panel?.rule === "bounded" && panel.usable.length === 1;
    const outcome = W.voted(checked, { disputed, oneTool });
    this.k.log(task, real || unresolved ? "warn" : "done", outcome);
    this.k.commit();
    return outcome;
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
    if (!task.hunt || task.hunt.stageId !== stage.id || task.hunt.round !== (task.rounds[stage.id] ?? 1) || this.pendingReviewers(task, stage).length) return;
    const reviewers = Object.keys(task.hunt.reported);
    const before = new Map(task.findings.map(finding => [finding.id, finding.status]));
    for (const finding of task.findings) {
      if (finding.status !== "open" || finding.severity !== "pre-existing" || finding.raisedBy === "petrina") continue;
      const checks = Object.values(task.hunt.findingChecks?.[finding.id] ?? {});
      const repaired = checks.find(check => check.resolved && check.evidence);
      const versions = task.hunt.input?.heads;
      // Omission and a passing review are not repair evidence. Any current confirmation
      // keeps the bug open; resolving reports stay on their immutable journey results.
      if (!repaired?.evidence || checks.some(check => !check.resolved) || !versions || !Object.keys(versions).length) continue;
      finding.resolution = { by: repaired.by, evidence: repaired.evidence, at: Date.now(), versions: { ...versions } };
      finding.status = "fixed";
      addEvidence(finding, `Verified repaired: ${repaired.evidence}`);
    }
    for (const finding of task.findings) {
      if (finding.status !== "open" || finding.raisedBy === "petrina" || finding.text.startsWith("Failed acceptance check:")) continue;
      if (task.repositories && !productsFor(task, finding.productIds).length) continue;
      if (finding.disputes?.length && !finding.confirmedBy.length) finding.status = "dismissed";
      if (!task.repositories) continue;
      const owners = productsFor(task, finding.productIds);
      const reviews = task.hunt.fixReviews?.[finding.id];
      if (owners.length > 1 && finding.status === "open" && !finding.confirmedBy.length && owners.every((id) => finding.answers?.[id]?.fixed) && reviewers.length && reviewers.every((key) => reviews?.[key] === true)) finding.status = "fixed";
    }
    // The round's decision includes unmentioned fixes and claims, not just ids touched by a
    // reviewer. Never rewrite a closed step, the pre-vote copy, or any participant's hand-back.
    const step = openStep(task);
    if (step?.stageId === stage.id && step.round === task.hunt.round && step.roleId && this.k.role(step.roleId)?.result === "findings" && !step.result?.findingsSettled) {
      const group = reviewRoundSteps(task, step.id, this.k.s.roles);
      const raised = task.findings.slice(task.hunt.findings ?? task.findings.length).map(finding => finding.id);
      const claims = new Set(reviewClaimIds(task, group[0]!.id, this.k.s.roles));
      const changed = task.findings.filter(finding => before.get(finding.id) !== finding.status);
      const seen = new Set([...group.flatMap(entry => [...(entry.result?.findings ?? []), ...(entry.agentResults ?? []).flatMap(result => result.findings ?? [])]).map(finding => finding.id), ...raised, ...claims, ...changed.map(finding => finding.id)]);
      const findingChanges = {
        raised,
        fixed: task.findings.filter(finding => finding.status === "fixed" && (before.get(finding.id) !== "fixed" || claims.has(finding.id))).map(finding => finding.id),
        dismissed: changed.filter(finding => finding.status === "dismissed").map(finding => finding.id),
        reopened: recordedReopenings(group),
        claimedFixed: [...claims],
      };
      recordStepResult(task, { findings: task.findings.filter(finding => seen.has(finding.id)), findingsSettled: true, findingChanges });
    }
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
    const scope = executionFor(task);
    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
    // The coordinator's decision to continue still covers its findings only on the task's own change it was made on.
    const continued = task.reviewDecision?.accepted && task.reviewDecision.covers?.length;
    let changes = continued ? await this.ownChanges(task) : undefined;
    const covered = changes ? coveredByDecision(task as unknown as Task, changes) : new Set<Id>();
    const end = reviewRoundEnd(task as unknown as Task, stage as Stage, round, this.k.s.roles, covered);
    // A decision raised below records the change it is made on, read before anything else moves.
    if (end.kind === "used up" || (end.kind === "send back" && task.repositories)) changes ??= await this.ownChanges(task);
    noteRoundEnd(task, stage.id, open.length);
    // A port review is one round: whatever it found, the rounds after it are ordinary ones.
    const port = scope.work.portReview !== undefined;
    const role = this.k.role(stage.roleId);
    const incremental = role && contractFor(role).incrementalReview;
    delete scope.work.portReview;
    // Resolve each owner once. An incremental round records the HEAD and its tree
    // together; security rounds keep their code-review anchors unchanged.
    const scopes = scopesFor(task);
    const anchors = await Promise.all(scopes.map(async ({ work }) => {
      if (!work.worktree) return {};
      if (incremental) return git.commitVersion(work.worktree);
      return task.repositories && end.kind === "passed" ? { tree: await git.treeOf(work.worktree) } : {};
    }));
    for (const [index, { work }] of scopes.entries()) {
      const anchor = anchors[index]!;
      if (end.kind === "passed") {
        if (work.worktree && (task.repositories || incremental)) work.reviewedTree = anchor.tree;
        const step = openStep(task);
        const reviewed = reviewedVersions?.[work.productId];
        if (step && reviewed) step.checkReviews = [...(step.checkReviews ?? []), { productId: work.productId, tree: reviewed, at: Date.now(), stageId: stage.id, round }];
      } else if (work === scope.work) delete work.reviewedTree;
      if (incremental) {
        if (anchor.head) work.reviewedSha = anchor.head;
        else delete work.reviewedSha;
      }
    }
    this.k.tracking.reviewEnd(task, round, end.kind === "send back" ? "sent-back" : end.kind === "used up" ? "rounds-used" : "passed");
    const pendingProofs = task.proofRequests?.filter(request => request.status !== "proved" && request.status !== "already-current").length ?? 0;
    const passed = [W.reviewPassed, ...(end.kind === "passed" && end.covered ? [W.coveredOpen(end.covered)] : []), ...(pendingProofs ? [`${pendingProofs} proof request${pendingProofs === 1 ? "" : "s"} for final acceptance testing`] : [])].join("; ");
    const reason = end.kind === "send back" ? { reason: W.sentBack(end.open), tone: "back" as const } : end.kind === "used up" ? { reason: W.stillOpen(end.open), tone: "back" as const } : { reason: passed };
    endAgentStep(task, { outcome, ...reason }, Date.now());
    if (end.kind === "send back") {
      task.rounds[stage.id] = round + 1;
      if (task.repositories) {
        if (beginRepair(this.k, task, "review", task.stageIndex, covered)) return "continue";
        this.releaseRoundInput(task);
        // Continue through any remaining acceptance stage after the decision, before delivery approval.
        const delivery = task.plan!.stages.findIndex((entry, index) => index > task.stageIndex && entry.kind === "gate" && entry.gate === "delivery");
        if (delivery < 0) throw new Error("The plan has no delivery check after review");
        task.stageIndex += 1;
        task.sub = 0;
        this.k.log(task, "warn", "No builder can take the remaining findings, so the decision goes to you");
        task.reviewDecision = reviewDecisionFor(task, stage.id, round, Date.now(), changes!);
        this.k.gate(task, "delivery");
        return "stop";
      }
      task.stageIndex = end.builder;
      task.sub = 0;
      task.fixing = true;
      this.k.log(task, "warn", `Sent back to the builder: ${findingCount(open)}`);
      this.k.commit();
      return "continue";
    }
    this.releaseRoundInput(task);
    task.stageIndex += 1;
    task.sub = 0;
    if (end.kind === "used up") {
      this.k.log(task, "warn", `Review rounds used up: ${findingCount(open)} still open`);
      // With blocking findings left, the coordinator always looks before anything ships.
      task.reviewDecision = reviewDecisionFor(task, stage.id, round, Date.now(), changes!);
      this.k.gate(task, "delivery");
      return "stop";
    } else {
      this.k.log(task, "done", `${port ? "Port review" : "Review"} passed: ${passedOpenWords(task.findings, covered)}`);
    }
    this.k.commit();
    return "continue";
  }
}
