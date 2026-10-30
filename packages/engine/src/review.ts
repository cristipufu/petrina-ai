import { ReviewConversations, nextReviewPlace, pendingReviewPlaces, plannedReviewPlaces, rememberReviewProfile } from "@petrina/orchestrator";
import { ParallelAdmissionGroup } from "@petrina/orchestrator";
import { ReviewRoundCompletion, ReviewWorkflow } from "@petrina/orchestrator";
import { createVerifierBallots } from "./verifier-host.js";
import { executionFor, ReviewReports, type VerifierBallots, type PendingVerification, type RepositoryContext } from "@petrina/orchestrator";
import { changesOf, versionsOf } from "./repositories.js";
// Review rounds: Petrina's tamper check and the product's checks first, then every reviewer at once, then
// fresh agents voting on Important findings, and the round closing back to the builder or on to delivery.

import { checkReviewEvidence, inBallot, openStep,   reviewerAt, seatAnswered,  type ActiveAgent, type AgentProfile, type Id, type ReadinessRecheck, type Stage } from "@petrina/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import * as git from "@petrina/repositories/git";
import { formatFindings } from "./prompts.js";
import { contractFor, VerifyResult, ReviewResult } from "./roles.js";
import { Kernel, type MutableStage, type RuntimeTask,  SourceRefreshRequired } from "./kernel.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import { CheckPreparationChanged, type ProductChecks } from "./product-checks.js";
import type { Learnings } from "./learnings.js";
import type { Updates } from "./update.js";
import { prepareReviewInput, readReviewInput, reviewBaseUpdates, reviewContextIntact, type ReviewInput } from "./review-context.js";
import { conversationDigest, ParticipantUnavailable } from "./participant-conversation.js";
import { completeAll } from "@petrina/core";
import { checkProofRequests, recordReviewProofs } from "@petrina/orchestrator";

/** What admission decided for a parallel seat: the words on its start, why a saved conversation was not kept, and its readiness recheck. */
type SeatSelection = { selectionReason?: string; freshReason?: string; readiness?: ReadinessRecheck };

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
    this.workflow = new ReviewWorkflow({
      now: () => Date.now(), id: task => k.id(task.id), checkpoint: () => k.commitNow(), changed: () => k.commit(),
      finishStep: task => k.finishStep(task), clearStep: task => k.clearStep(task), rerun: task => k.rerun(task),
    }, {
      prepareChecks: (scope, signal) => this.prepareChecks(scope, signal),
      checks: async (scope, signal) => this.checks.failing(scope, signal, await this.checks.ensureChecks(scope, signal), "review", () => this.prepareChecks(scope, signal)),
      preparationChanged: error => error instanceof CheckPreparationChanged,
      backToBuilder: (scope, products) => this.checks.backToBuilder(scope, "before review", products), blocked: task => this.checks.blocked(task),
      versions: versionsOf,
      input: async (scope, signal) => {
        const snapshot = await this.context.captureReview(scope);
        const input = await prepareReviewInput(k.dataDir, scope, snapshot, signal);
        this.inputs.set(scope.task, { digest: input.digest, input: snapshot });
        return input;
      },
      pendingReviewers: (task, stage) => this.pendingReviewers(task, stage), hunt: (task, stage, reviewers, signal) => this.hunt(task, stage, reviewers, signal),
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
    const check = (result: z.infer<typeof ReviewResult>) => checkReviewEvidence(input.findings, result, task) ?? checkProofRequests(this.k, task, result.proofRequests);
    // What the step waits for: every planned place, not only the participants that happen to start.
    const seats = this.plannedSeats(task, stage);
    if (stage.profileIds.length === 1 && !task.repositories) {
      const { key, profileId } = reviewers[0]!;
      const roleId = reviewerAt(stage, Number(key));
      const participant = { ...this.participant(scope, stage, key, profileId), reviewFindings: input.findings };
      let by = profileId;
      const result = await this.turns.turn(scope, roleId, profileId, () => this.context.sectionsFor(scope, roleId, undefined, undefined, `review-${key}`, input), ReviewResult, signal, { ...participant, check, reviewerKey: key, seats, used: (id) => { by = id; this.rememberReviewer(task, key, id); } });
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
          const used = (id: Id) => { by = id; onUsed(id); };
          const given = () => this.context.sectionsFor(scope, roleId, `review-${key}`, this.turns.repositoryCopies.get(copy), undefined, input);
          const result = continuing
            ? await this.turns.turn(scope, roleId, profileId, given, ReviewResult, signal, { ...participant, check, copy, member: `review-${key}`, reviewKey: `reviewer:${key}`, used, room, reviewerKey: key, seats })
            : await this.turns.parallel(scope, roleId, profileId, copy, given, ReviewResult, signal, { ...participant, check, key: `reviewer:${key}`, member: `review-${key}`, used, room, seat, ...selection, reviewerKey: key, seats, agent, refresh: false });
          await this.applyReview(scope, stage, result, by, roleId, key);
          this.k.finishReviewWork(task, `reviewer:${key}`);
          this.reportAccepted(task, key);
        },
      })),
      signal,
      (running, waiting) => `${running} ${role.toLowerCase()}${running === 1 ? ` looking at the ${scope.work.portReview ? "port" : "change"}` : "s looking at the change at once"}${waiting ? `, ${waiting} waiting for a slot` : ""}`,
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
          const own = openStep(task)?.agentResults?.findLast((entry) => (this.k.role(entry.roleId, task)?.result === "votes" || entry.roleId === "verifier") && entry.profileId === by);
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
  private async together(task: RuntimeTask, members: readonly { key: string; reviewKey: string; roleId: Id; profileId: Id; reviewerKey?: string; work: (copy: string, room: (toolId: Id, profile: AgentProfile) => boolean, seat: Id, used: (profileId: Id) => void, agent: ActiveAgent, continuing: boolean, signal: AbortSignal, selection?: SeatSelection) => Promise<void> }[], parentSignal: AbortSignal, status: (running: number, waiting: number) => string): Promise<void> {
    const scope = executionFor(task);
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
    const group = new ParallelAdmissionGroup({
      state: () => this.k.s, activeState: () => this.k.activeState(), now: () => Date.now(), draining: () => this.k.draining,
      admissionsClosed: task => this.k.taskAdmissionsClosed(task), admissionWait: task => this.k.taskAdmissionWait(task), sourceRefreshDue: task => this.k.taskSourceRefreshDue(task),
      selectScreen: task => this.k.selectScreen(task), syncScreen: () => this.k.syncScreen(), showReviewWork: task => this.k.showReviewWork(task), finishStep: task => this.k.finishStep(task), waitForUsage: (task, words) => this.k.waitForUsage(task, words),
      rememberReviewer: (task, key, profileId) => this.rememberReviewer(task, key, profileId), changed: () => this.k.commit(), checkpoint: () => this.k.commitNow(), schedule: () => this.k.schedule(),
    }, this.k.agentAdmission);
    await group.run({ scope, members, signal: parentSignal, status, workspaces: {
      reference: member => memberCopy(scope.work.productId, member),
      prepare: async (member, copy, continuing, reuse) => {
        const kept = continuing ? task.hunt?.screenTurns?.[member.key]?.copies : undefined;
        const copies: Record<string, string> = { [scope.work.productId]: copy };
        await completeAll([
          reuse ? Promise.resolve() : git.addCopy(root, copy, sha),
          ...versions.filter((work) => work.productId !== scope.work.productId).map(async (work) => {
            const peer = kept?.[work.productId] ?? memberCopy(work.productId, member.key);
            if (!reuse) await git.addCopy(work.root, peer, work.sha);
            copies[work.productId] = peer;
          }),
        ]);
        return {
          activate: () => {
            if (versions.length) this.turns.repositoryCopies.set(copy, copies);
            if (!reuse) this.turns.copyHeads.set(copy, sha);
          },
          finish: () => {
            const saved = task.hunt?.screenTurns?.[member.key];
            if (saved && versions.length) { saved.copies = copies; saved.conversation.repositoryCopies = copies; this.k.commitNow(); }
            // Primary and companion copies are reclaimed together by their owning repositories
            // when the group settles; saved screen turns retain their complete map.
            this.turns.repositoryCopies.delete(copy);
            this.turns.copyHeads.delete(copy);
          },
        };
      },
      stopHelpers: () => this.k.stopHelpers(task.id), closeTaskRun: () => {
        const run = this.k.runs.get(task.id);
        if (run) void this.k.stopAgent(task.id, run).catch(() => undefined);
      }, releasedStops: () => this.turns.releasedStops(task.id),
      finish: async readOnly => {
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
      },
    } });
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
