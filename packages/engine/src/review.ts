import { executionFor, scopesFor, repositoryView, type RepositoryContext } from "./repository-context.js";
import { beginRepair, productsFor } from "./repositories.js";
// Review rounds: Petrina's tamper check and the product's checks first, then every reviewer at once, then
// fresh agents voting on Important findings, and the round closing back to the builder or on to delivery.

import { endAgentStep, findingCount, independentVotes, isRejectedReopenOfVerifiedFix, JOURNEY_WORDS as W, noteReviewTag, noteRoundEnd, openStep, pickStarts, portReviewerIndex, recordStepResult, reviewRoundEnd, reviewerAt, slotUses, type ActiveAgent, type AgentProfile, type ConversationNote, type DeepMutable, type Finding, type Id, type Role, type Stage, type Task, type Vote } from "@petrina/core";
import { join } from "node:path";
import type { z } from "zod";
import * as git from "./git.js";
import { formatFindings } from "./prompts.js";
import { contractFor, VerifyResult, ReviewResult } from "./roles.js";
import { Kernel, type MStage, type MTask, ScreenWait } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import type { ProductChecks } from "./product-checks.js";
import type { Learnings } from "./learnings.js";
import { finishMessageGroup, routeMessages } from "./messages.js";
import type { Updates } from "./update.js";
import { prepareReviewInput, readReviewInput, reviewContextIntact, reviewScopeKey, type ReviewInput } from "./review-context.js";
import { completeAll } from "./parallel.js";

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

/** The verdict most voters gave, the mildest first on a tie: a nit, then older than the change, then not a bug. */
function mostCommon(votes: readonly Vote[]): Vote | undefined {
  const order: Vote["verdict"][] = ["nit", "pre-existing", "not-a-bug"];
  const count = (verdict: Vote["verdict"]) => votes.filter((vote) => vote.verdict === verdict).length;
  const best = [...order].sort((a, b) => count(b) - count(a) || order.indexOf(a) - order.indexOf(b))[0]!;
  return votes.find((vote) => vote.verdict === best);
}

function closedFinding(finding: Finding): boolean {
  return finding.status === "fixed" || finding.status === "dismissed";
}

function needsCurrentEvidence(finding: Finding): boolean {
  return finding.raisedBy !== "petrina" && (closedFinding(finding) || finding.reopenedAt !== undefined || finding.answer?.fixed === true);
}

/** Closed findings are judged again only from current reproductions, never unexplained old ids. */
export function checkReviewEvidence(findings: readonly Finding[], result: z.infer<typeof ReviewResult>, _task?: Task): string | undefined {
  const unknown = [...result.confirms, ...result.disputes.map((entry) => entry.id)].filter((id) => !findings.some((finding) => finding.id === id));
  if (unknown.length) return `Confirm or dispute only finding ids provided in your saved review input. These ids were not shown: ${[...new Set(unknown)].join(", ")}. Report a new problem as a new finding instead.`;
  const missing = new Set(result.confirms.filter((id) => {
    const finding = findings.find((entry) => entry.id === id);
    return finding && needsCurrentEvidence(finding) && !result.confirmationEvidence[id]?.trim();
  }));
  return missing.size ? `Current evidence is required to reopen or support a previously closed finding. For ${[...missing].join(", ")}, return "confirms": [{"id": "<finding id>", "evidence": "<exact current failing case, expected and observed result>"}]. Include a nearby passing control when it distinguishes the regression. If there is no current failing case, omit the confirmation. The old report alone is not current evidence.` : undefined;
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
    ...(finding.answer ? { answer: finding.answer } : {}),
  }];
  finding.confirmedBy = [];
  delete finding.disputes;
  delete finding.verification;
  delete finding.votes;
  finding.status = "open";
  finding.reopenedAt = at;
  if (evidence !== undefined) finding.evidence = evidence.trim();
}

/** Tools that finished the whole ballot. Partial verdicts are saved, but cannot close a round alone. */
function finishedVoters(findings: readonly Finding[]): Set<Id> {
  return new Set(findings[0]?.votes?.flatMap((vote) => vote.toolId && findings.every((finding) => finding.votes?.some((entry) => entry.toolId === vote.toolId)) ? [vote.toolId] : []));
}

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
        failedChecks = await this.checks.failing(scope, signal, await this.checks.ensureChecks(scope, signal)) || failedChecks;
      }
      if (failedChecks) {
        // The check fix can reach beyond the port's conflicted files, so its review must be ordinary.
        for (const { work } of scopesFor(task)) {
          delete work.portReview;
          delete work.reviewedTree;
        }
        if (this.checks.backToBuilder(scope, "before review")) return "continue";
        this.forgetSessions(task, stage.id);
        // The same delivery decision used after final checks exhaust their builder returns.
        const delivery = task.plan!.stages.findIndex((entry, index) => index > task.stageIndex && entry.gate === "delivery");
        task.stageIndex = delivery >= 0 ? delivery : task.plan!.stages.length - 1;
        task.sub = 0;
        this.k.log(task, "warn", "Checks still fail: the builder returns are used up, so the decision goes to you");
        this.k.commitNow();
        if (delivery >= 0) return "continue";
        this.k.gate(task, "delivery");
        return "stop";
      }
      if (task.repositories) task.activeProductId = task.leadProductId ?? task.repositories[0]!.productId;
      task.statusLine = "Preparing the review";
      this.k.commit();
      const snapshot = await this.context.captureReview(executionFor(task));
      const input = await prepareReviewInput(this.k.dataDir, executionFor(task), snapshot, signal);
      this.inputs.set(task, { digest: input.digest, input: snapshot });
      signal.throwIfAborted();
      task.hunt = { stageId: stage.id, round, reported: {}, findings: task.findings.length, input };
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
      await this.vote(task, vote.findings, vote.voters, signal);
      return "continue";
    }
    const outcome = vote ? this.tally(task, vote.findings) : this.raised(task);
    delete task.hunt;
    return this.closeReviewRound(task, stage, round, outcome);
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
    const planned = stage.profileIds.map((profileId, index) => ({ key: String(index), profileId }));
    // The journey and the engine share the port reviewer's position; tool choice follows the latest builder.
    const reviewers = scope.work.portReview ? [planned[portReviewerIndex(repositoryView(scope), stage.profileIds, (id) => this.k.profile(id)?.toolId)]!] : planned;
    return reviewers.filter((entry) => !reported[entry.key]);
  }

  private rememberReviewer(task: MTask, key: string, profileId: Id): void {
    task.hunt = { ...task.hunt!, profiles: { ...task.hunt!.profiles, [key]: profileId } };
    this.k.commitNow();
  }

  private forgetSessions(task: MTask, stageId: Id): void {
    this.inputs.delete(task);
    if (!task.reviewSessions) return;
    delete task.reviewSessions[stageId];
    if (!Object.keys(task.reviewSessions).length) delete task.reviewSessions;
  }

  /** A seat returns only to its own completed conversation, with unchanged role and approved scope. */
  private participant(scope: RepositoryContext, stage: MStage, seat: Id, plannedId: Id) {
    const { task } = scope;
    const round = task.rounds[stage.id] ?? 1;
    const planned = structuredClone(this.k.profile(plannedId));
    return {
      reviewContext: true,
      resume: async (actual: AgentProfile, role: Role) => {
        const prior = task.reviewSessions?.[stage.id]?.[seat];
        if (!prior || prior.round >= round) return;
        if (prior.plannedProfileId === plannedId && prior.profileId === actual.id && prior.scope === reviewScopeKey(scope, stage.id, seat, role, planned, actual)) {
          if (await reviewContextIntact(prior.context)) return prior;
          this.k.log(scope, "status", "Started a fresh review conversation: its saved context is unavailable", role.id, actual.id);
          return;
        }
        this.k.log(scope, "status", "Started a fresh review conversation: its role, profile, request or starting point changed", role.id, actual.id);
      },
      started: () => {
        // An interrupted parallel attempt starts fresh unless it saved a screen conversation.
        // Never return to an older round's reference after that native session has begun new work.
        const saved = task.reviewSessions?.[stage.id];
        if (!saved?.[seat]) return;
        delete saved[seat];
        this.k.commitNow();
      },
      completed: (note: ConversationNote, actual: AgentProfile, role: Role) => {
        task.reviewSessions = { ...task.reviewSessions, [stage.id]: {
          ...task.reviewSessions?.[stage.id],
          [seat]: { scope: reviewScopeKey(scope, stage.id, seat, role, planned, actual), round, plannedProfileId: plannedId, profileId: actual.id, toolId: note.toolId, model: note.model, sessionId: note.sessionId, ...(note.context ? { context: note.context } : {}) },
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
    const check = (result: z.infer<typeof ReviewResult>) => checkReviewEvidence(input.findings, result, task);
    const reported = (key: string) => {
      task.hunt = { ...task.hunt!, reported: { ...task.hunt!.reported, [key]: true } };
      this.k.commitNow();
    };
    if (stage.profileIds.length === 1 && !task.repositories) {
      const { key, profileId } = reviewers[0]!;
      const roleId = reviewerAt(stage, Number(key));
      const participant = this.participant(scope, stage, key, profileId);
      let by = profileId;
      const result = await this.turns.turn(scope, roleId, profileId, () => this.context.sectionsFor(scope, roleId, undefined, undefined, `review-${key}`, input), ReviewResult, signal, { ...participant, check, reviewerKey: key, used: (id) => { by = id; this.rememberReviewer(task, key, id); } });
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
        work: async (copy, room, seat, onUsed, agent, continuing, signal) => {
          let by = profileId;
          const roleId = reviewerAt(stage, Number(key));
          const participant = this.participant(scope, stage, key, profileId);
          const used = (id: Id) => { by = id; onUsed(id); };
          const given = () => this.context.sectionsFor(scope, roleId, `review-${key}`, this.turns.repositoryCopies.get(copy), undefined, input);
          const result = continuing
            ? await this.turns.turn(scope, roleId, profileId, given, ReviewResult, signal, { ...participant, check, copy, member: `review-${key}`, reviewKey: `reviewer:${key}`, used, room, reviewerKey: key })
            : await this.turns.parallel(scope, roleId, profileId, copy, given, ReviewResult, signal, { ...participant, check, key: `reviewer:${key}`, member: `review-${key}`, used, room, seat, reviewerKey: key, agent, refresh: false });
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
    const { task } = scope;
    await this.learnings.note(scope, result.learnings, roleId, profileId);
    for (const id of result.confirms) {
      const finding = task.findings.find((entry) => entry.id === id);
      // Fresh proof can challenge a claimed fix or dismissal without creating another finding.
      // Native check findings remain governed by the actual check results.
      const evidence = result.confirmationEvidence[id];
      if (finding && closedFinding(finding) && finding.raisedBy !== "petrina") reopenFinding(finding, Date.now(), evidence);
      else if (finding) addEvidence(finding, evidence);
      if (finding && !finding.confirmedBy.includes(profileId)) finding.confirmedBy.push(profileId);
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
    const seen = new Set([...(openStep(task)?.result?.findings ?? []).map((finding) => finding.id), ...result.confirms, ...result.disputes.map((finding) => finding.id)]);
    recordStepResult(task, { findings: task.findings.filter((finding) => seen.has(finding.id) || created.has(finding.id)) });
    const supported = task.findings.filter((finding) => finding.status === "open" && (result.confirms.includes(finding.id) || created.has(finding.id)));
    this.k.tracking.verdict(task, roleId, profileId, task.rounds[stage.id] ?? 1, result.verdict, supported.length, supported.filter((finding) => finding.severity === "blocking").length);
    const confirmed = result.confirms.length;
    const also = [confirmed ? `confirmed ${confirmed}` : "", result.disputes.length ? `disputed ${result.disputes.length}` : ""].filter(Boolean).join(", ");
    this.k.log(task, important ? "warn" : "done", `${findingCount(raised)}${also ? `; ${also}` : ""}`, roleId, profileId);
  }

  /**
   * The Important findings still to vote on (raised by a reviewer, and not yet backed on a second tool),
   * and the voters who have not voted yet: one fresh agent per tool.
   */
  private pendingVote(task: MTask, stage: MStage): { findings: Task["findings"]; voters: Id[] } | undefined {
    // Scheduling asks this before running the step. Settle the complete reviewer group first,
    // so a finding that needs no ballot cannot make the task wait for a voter's usage or slot.
    this.settleReviews(task, stage);
    const toolOf = (profileId: Id) => this.k.profile(profileId)?.toolId;
    const findings = task.findings.filter((finding) => {
      if (finding.status !== "open" || finding.severity !== "blocking" || finding.raisedBy === "petrina" || finding.verification) return false;
      if (task.repositories && !productsFor(task, finding.productIds).length) return false;
      const judgments = finding.judgments ?? [];
      const clashed = judgments.some((entry) => entry.severity === "pre-existing") && judgments.some((entry) => entry.severity === "blocking");
      // A reviewer who says the bug is older is not a second tool agreeing that it is Important.
      const older = new Set(judgments.filter((entry) => entry.severity === "pre-existing").map((entry) => entry.by));
      const supporters = clashed
        ? [...judgments.filter((entry) => entry.severity === "blocking").map((entry) => entry.by), ...finding.confirmedBy.filter((id) => !older.has(id))]
        : [...((finding.reopenedAt !== undefined || finding.answer?.fixed) ? [] : [finding.raisedBy]), ...finding.confirmedBy];
      return new Set(supporters.map(toolOf).filter(Boolean)).size < 2;
    });
    if (!findings.length) return undefined;
    // Resolve usage and model fallbacks before choosing the electorate. A capped tool is still
    // usable and waits for its seat. Older votes remain history; their nominal names do not prove
    // an actual tool voted, so only newly recorded identities cover a tool's place.
    const covered = finishedVoters(findings);
    let planned = task.hunt?.voterProfiles;
    if (!planned) {
      const tools = new Set<Id>();
      planned = this.voters(stage).flatMap((id) => {
        const choice = this.k.choose(id, task, "verifier");
        if (!choice || choice.kind === "none" || tools.has(choice.profile.toolId)) return [];
        tools.add(choice.profile.toolId);
        return [choice.profile.id];
      });
      // Nobody can vote yet: leave the electorate open until at least one tool is usable.
      // A paused scheduler may ask who would run next before tool checks finish.
      // Keep that preview provisional until work can start; an existing ballot stays durable.
      if (planned.length && task.hunt && !this.k.admissionsClosed) {
        task.hunt.voterProfiles = planned;
        this.k.commitNow();
      }
    }
    if (task.hunt?.voterProfiles && !this.k.admissionsClosed) {
      // Keep the existing usage-handoff rule: an unavailable tool can yield to a new
      // independent tool, or leave a completed partner's ballot to settle the findings.
      // A cap, a pause or a drain never makes a usable participant disappear.
      const requiredTools = new Set(planned.map(id => this.k.profile(id)?.toolId));
      const available = planned.flatMap(id => {
        const tool = this.k.profile(id)?.toolId;
        if (covered.has(tool ?? "")) return [id];
        const choice = this.k.choose(id, task, "verifier");
        if (!choice || choice.kind === "none") return covered.size ? [] : [id];
        if (choice.profile.toolId === tool) return [id];
        if (requiredTools.has(choice.profile.toolId) || covered.has(choice.profile.toolId)) return covered.size ? [] : [id];
        requiredTools.delete(tool);
        requiredTools.add(choice.profile.toolId);
        return [choice.profile.id];
      });
      if (!covered.size && !available.some(id => this.k.choose(id, task, "verifier")?.kind !== "none")) {
        // No complete ballot and every original tool is out: a newly recovered independent
        // tool may finish the missing verdicts, keeping the partial reasons already saved.
        for (const id of this.voters(stage)) {
          const choice = this.k.choose(id, task, "verifier");
          if (choice && choice.kind !== "none" && !available.some(existing => this.k.profile(existing)?.toolId === choice.profile.toolId)) available.push(choice.profile.id);
        }
      }
      if (JSON.stringify(available) !== JSON.stringify(planned)) {
        planned = available;
        task.hunt.voterProfiles = planned;
        this.k.commitNow();
      }
    }
    const voters = planned.flatMap((id) => {
      if (covered.has(this.k.profile(id)?.toolId ?? "")) return [];
      const choice = this.k.choose(id, task, "verifier");
      // Once admitted to the electorate, a missing independent tool cannot be replaced by a
      // finished partner's vote. Same-tool model substitutions retain that tool's seat.
      return choice && choice.kind !== "none" && choice.profile.toolId === this.k.profile(id)?.toolId ? [choice.profile.id] : [];
    });
    // With no finished ballot and nobody usable, keep the review waiting for usage, never pass it.
    if (!voters.length && !covered.size) {
      const waiting = planned[0] ?? this.voters(stage)[0];
      if (waiting) voters.push(waiting);
    }
    return { findings: findings as Task["findings"], voters };
  }

  /**
   * One fresh voter per tool. Prefer high effort for checking a specific claim;
   * the stage's discovery reviewers keep their configured profiles.
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
   * Fresh agents vote on each Important finding, all at once. A finding stands when at least half of them
   * say it is real; otherwise the most common other verdict settles it (see tally). Every vote is kept.
   */
  private async vote(task: MTask, findings: Task["findings"], voters: readonly Id[], signal: AbortSignal): Promise<void> {
    const scope = executionFor(task);
    const input = task.hunt?.input ? await this.input(task, signal) : undefined;
    const ids = new Set(findings.map((finding) => finding.id));
    // Keep each review position stable through model fallbacks and restarts.
    const planned = task.hunt?.voterProfiles ?? this.voters(task.plan!.stages[task.stageIndex]!);
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
          const given = async () => [...await this.context.sectionsFor(scope, "verifier", key, this.turns.repositoryCopies.get(copy), undefined, input), { title: "Important findings to check (a verdict on every one, by id)", body: formatFindings(missing()) }];
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
            recordStepResult(task, { findings: task.findings.filter((finding) => ids.has(finding.id)) });
            this.k.commitNow();
            const left = missing();
            return left.length ? `give a verdict on every finding by id, and these have none:\n${formatFindings(left)}` : undefined;
          };
          const heard = (id: Id) => { by = id; used(id); };
          if (continuing) await this.turns.turn(scope, "verifier", profileId, given, VerifyResult, signal, { copy, member: key, reviewKey, check, used: heard, room });
          else await this.turns.parallel(scope, "verifier", profileId, copy, given, VerifyResult, signal, {
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
      else if (verdict === "not-a-bug") finding.status = isRejectedReopenOfVerifiedFix(finding) ? "fixed" : "dismissed";
      else if (verdict === "nit") finding.severity = "suggestion";
      else finding.severity = "pre-existing";
    }
    recordStepResult(task, { findings: task.findings.filter((finding) => ids.has(finding.id)) });
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
    // One fresh pull-request read is shared by reviewers; a usage replacement reads again on its attempt.
    await this.turns.refresh(scope);
    const pending = [...members];
    const accepted = new Set<string>();
    const running = new Map<string, { agent: ActiveAgent; done: Promise<void> }>();
    const yielded = new Set<string>();
    let failure: unknown;
    let noOne: WaitingForUsage | undefined;
    let wake: (() => void) | undefined;
    const show = () => {
      if (signal.aborted) return;
      this.k.selectScreen(task);
      if (task.screen?.member) scope.work.conversation ??= task.hunt?.screenTurns?.[task.screen.member]?.conversation;
      const agents = [...running.entries()].filter(([key]) => !yielded.has(key)).sort(([a], [b]) => Number(b === task.screen?.member) - Number(a === task.screen?.member)).map(([, entry]) => entry.agent);
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
      const member = members.find(member => member.key === key);
      if (member && this.k.role(member.roleId)?.result === "votes" && this.k.profile(member.profileId)?.toolId !== toolId) return false;
      const state = this.k.activeState();
      let uses = slotUses(state);
      const agent = running.get(key)?.agent;
      if (agent) {
        const own = uses.findIndex((use) => use.taskId === task.id && use.profileId === agent.profileId && use.roleId === agent.roleId);
        uses = uses.filter((_, index) => index !== own);
      } else if (!running.size) uses = uses.filter((use) => use.taskId !== task.id);
      return pickStarts({ candidates: [{ taskId: task.id, toolId }], inUse: uses, pool: state.pool, now: state.now }).length > 0;
    };
    const startMember = (member: (typeof members)[number], copy: string, room: (toolId: Id) => boolean, seat: Id, continuing: boolean) => {
      yielded.delete(member.key);
      const agent: DeepMutable<ActiveAgent> = { roleId: member.roleId, profileId: seat, since: Date.now(), step: 0, reviewKey: member.reviewKey };
      let completed = false;
      const used = (profileId: Id) => {
        agent.profileId = profileId;
        if (member.reviewerKey !== undefined) this.rememberReviewer(task, member.reviewerKey, profileId);
        show();
        this.k.commitNow();
      };
      const done = Promise.resolve()
        .then(async () => {
          const copies: Record<string, string> = { [scope.work.productId]: copy };
          await completeAll([
            continuing ? Promise.resolve() : git.addCopy(root, copy, sha),
            ...versions.filter((work) => work.productId !== scope.work.productId).map(async (work) => {
              const peer = join(copyFolder(work.productId), member.key);
              if (!continuing) await git.addCopy(work.root, peer, work.sha);
              copies[work.productId] = peer;
            }),
          ]);
          if (versions.length) this.turns.repositoryCopies.set(copy, copies);
          try { await member.work(copy, room, seat, used, agent, continuing, signal); }
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
      // Saving the profile notifies listeners, which may change permissions and schedule again.
      // Expose its reservation first so that reentrant scheduling counts every seat and cannot admit it twice.
      if (member.reviewerKey !== undefined) this.rememberReviewer(task, member.reviewerKey, seat);
    };
    const continueScreen = () => {
      if (signal.aborted || failure !== undefined || this.k.admissionsClosed) return;
      const member = members.find((entry) => entry.key === task.screen?.member);
      const saved = member && task.hunt?.screenTurns?.[member.key];
      if (!member || !saved || running.has(member.key)) return;
      const index = pending.findIndex((entry) => entry.key === member.key);
      if (index >= 0) pending.splice(index, 1);
      scope.work.conversation ??= saved.conversation;
      startMember(member, saved.copy, roomFor(member.key), task.agent?.profileId ?? saved.conversation.profileId, true);
    };
    const start = () => {
      while (pending.length && failure === undefined && !task.screen && !Object.keys(task.hunt?.screenTurns ?? {}).length) {
        if (this.k.admissionsClosed || signal.aborted) break;
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
    this.k.screenGroups.set(task.id, {
      continue: continueScreen,
      running: (key) => running.has(key),
      yield: (key) => { yielded.add(key); show(); },
      recipients: () => members.filter((member) => !accepted.has(member.key)).map((member) => member.key),
      finished: (key) => { accepted.add(key); },
    });
    routeMessages(task, members.map((member) => member.key));
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
      if (!signal.aborted && !this.k.draining && !pending.length) finishMessageGroup(task, members.map((member) => member.key));
    } finally {
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
    if (!task.hunt || this.pendingReviewers(task, stage).length) return;
    const reviewers = Object.keys(task.hunt.reported);
    for (const finding of task.findings) {
      if (finding.status !== "open" || finding.raisedBy === "petrina" || finding.text.startsWith("Failed acceptance check:")) continue;
      if (task.repositories && !productsFor(task, finding.productIds).length) continue;
      if (finding.disputes?.length && !finding.confirmedBy.length) finding.status = "dismissed";
      if (!task.repositories) continue;
      const owners = productsFor(task, finding.productIds);
      const reviews = task.hunt.fixReviews?.[finding.id];
      if (owners.length > 1 && finding.status === "open" && !finding.confirmedBy.length && owners.every((id) => finding.answers?.[id]?.fixed) && reviewers.length && reviewers.every((key) => reviews?.[key] === true)) finding.status = "fixed";
    }
  }

  /**
   * The end of a review round: back to the builder with what is Important, or on towards delivery. `outcome`: what
   * the round's last box (its reviewers', or its voters') says.
   */
  private async closeReviewRound(task: MTask, stage: MStage, round: number, outcome: string): Promise<"continue" | "stop"> {
    const scope = executionFor(task);
    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
    const end = reviewRoundEnd(task as unknown as Task, stage as Stage, round);
    noteRoundEnd(task, stage.id, open.length);
    // A port review is one round: whatever it found, the rounds after it are ordinary ones.
    const port = scope.work.portReview !== undefined;
    const role = this.k.role(stage.roleId);
    const incremental = role && contractFor(role).incrementalReview;
    delete scope.work.portReview;
    if (end.kind !== "passed") delete scope.work.reviewedTree;
    else if (!task.repositories && incremental) scope.work.reviewedTree = await git.treeOf(scope.work.worktree!);
    if (task.repositories && end.kind === "passed") {

      const trees = await Promise.all(task.repositories.map((work) => work.worktree ? git.treeOf(work.worktree) : undefined));
      // Publish the completed round’s anchors together; snapshots never modify repository records.
      task.repositories.forEach((work, index) => { if (work.worktree) work.reviewedTree = trees[index]; });
    }
    // Each shared reviewer sees every repository snapshot. Keep a separate anchor for each
    // one so a later repair reviews only work added since this completed round.
    // Security-only stages do not advance the code-review baseline; partial rounds never close here.
    if (incremental) {
      if (task.repositories) {

        const heads = await Promise.all(task.repositories.map((work) => work.worktree ? git.head(work.worktree).catch(() => undefined) : undefined));
        task.repositories.forEach((work, index) => {
          const sha = heads[index];
          if (sha) work.reviewedSha = sha;
          else delete work.reviewedSha;
        });
      } else {
        const sha = await git.head(scope.work.worktree!).catch(() => undefined);
        if (sha) scope.work.reviewedSha = sha;
      }
    }
    this.k.tracking.reviewEnd(task, round, end.kind === "send back" ? "sent-back" : end.kind === "used up" ? "rounds-used" : "passed");
    const reason = end.kind === "send back" ? { reason: W.sentBack(end.open), tone: "back" as const } : end.kind === "used up" ? { reason: W.stillOpen(end.open), tone: "back" as const } : { reason: W.reviewPassed };
    endAgentStep(task, { outcome, ...reason }, Date.now());
    if (end.kind === "send back") {
      task.rounds[stage.id] = round + 1;
      if (task.repositories) {
        if (beginRepair(this.k, task, "review", task.stageIndex)) return "continue";
        this.forgetSessions(task, stage.id);
        // This decision is a delivery checkpoint. Approval must resume after it, not re-enter review.
        const delivery = task.plan!.stages.findIndex((entry, index) => index > task.stageIndex && entry.kind === "gate" && entry.gate === "delivery");
        if (delivery < 0) throw new Error("The plan has no delivery check after review");
        task.stageIndex = delivery;
        task.sub = 0;
        this.k.log(task, "warn", "No builder can take the remaining findings, so the decision goes to you");
        this.k.commit();
        return "continue";
      }
      task.stageIndex = end.builder;
      task.sub = 0;
      task.fixing = true;
      this.k.log(task, "warn", `Sent back to the builder: ${findingCount(open)}`);
      this.k.commit();
      return "continue";
    }
    this.forgetSessions(task, stage.id);
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
