import { ADAPTERS } from "./tools.js";
import { executionOf, type RepositoryContext } from "./repository-context.js";
// The work log's bookkeeping: one entry for every agent turn and every notable moment (a stage starting and
// ending, a design round, a reviewer's verdict, a question to the coordinator, a failure, a retry, a task
// delivered or cancelled), the permanent list of every product, and the shared pool’s latest limits. Only numbers,
// names and ids go in. The window asks for the numbers one view needs (usage), never for the log itself.

import { randomUUID } from "node:crypto";
import { continuingAgentTurn, askMomentId, turnTokens, usageView, type AgentProfile, type AskAnswer, type DeepMutable, type Id, type InboxItem, type MomentOutcome, type UsageReport, type TurnReason, type UsageRequest, type UsageViewFor, type WorkMoment, type WorkStageKind } from "@petrina/core";
import type { AgentRun, TurnNotes, TurnResult } from "./acp-run.js";
import type { Kernel, MStage, MTask } from "./kernel.js";
import { ModelAtCapacity, UsageLimited, WaitingForCapacity, WaitingForUsage } from "./usage.js";
import { WaitClock, WorkLog } from "./worklog.js";

/** A stage that started and hasn't ended: kept in the work log, mirrored here. */
interface OpenStage {
  stageId: Id;
  title: string;
  kind: WorkStageKind;
  roleId: Id;
  /** Do stages and planning: which run of the stage this is. Others: the stage's round when it started. */
  run: number;
  startedAt: number;
}

/** One agent working on a task: what its turns are written down as, and its own waits for the coordinator. */
export interface TurnAgent {
  roleId: Id;
  profile: AgentProfile;
  /** Time this agent spent waiting for the coordinator's permission answers, left out of its working time. */
  waits: WaitClock;
  journeyId: Id;
  /** Assigned once work starts, or restored from this exact saved conversation on continuation. */
  agentRunId?: Id;
  agentSeat: Id;
}

const ACCOUNT_AFTER_TURN_MS = 5 * 60_000;
const ACCOUNT_ON_PAGE_MS = 60_000;

export class Tracking {
  readonly log: WorkLog;
  private readonly openStages = new Map<Id, OpenStage>();
  /** Errors already logged as a failure. */
  private readonly counted = new WeakSet<object>();

  constructor(private readonly k: Kernel) {
    this.log = new WorkLog(k.store.database);
  }

  /**
   * On every start: remember when tracking began, keep every product in the permanent list,
   * protect ids of products that are gone, mark turns cut off by the last stop as lost, and on
   * the first start mark tasks that had already started as "earlier work not recorded".
   */
  start(): void {
    const now = Date.now();
    const { since, fresh } = this.log.ensureSince(now);
    for (const product of this.k.s.products) this.log.recordProduct({ id: product.id, name: product.name, repo: product.repo, addedAt: since });
    for (const task of this.k.s.tasks) {
      if (!this.k.s.products.some((product) => product.id === task.productId) && !this.log.knowsProduct(task.productId)) this.log.recordProduct({ id: task.productId, removedAt: now });
      if (fresh && task.startedAt !== undefined) this.log.markUntracked(task.id, task.productId, now);
    }
    if (fresh) for (const task of this.k.store.history.earlierWork()) {
      if (!this.k.s.products.some((product) => product.id === task.productId) && !this.log.knowsProduct(task.productId)) this.log.recordProduct({ id: task.productId, removedAt: now });
      this.log.markUntracked(task.id, task.productId, now);
    }
    this.log.markLost();
    // If the saved state was lost, ids in the log are still never handed out again.
    this.k.s.seq = Math.max(this.k.s.seq, this.log.highestTaskNumber());
    this.k.s.work = { version: now, since };
  }

  /** Turns still running stay unfinished in the log: the next start marks them lost. */
  close(): void {
    this.log.close();
  }

  /** The numbers one view needs, worked out from the work log. The log itself never leaves the engine. */
  usage<R extends UsageRequest>(request: R): UsageViewFor<R> {
    if (request.view === "analytics") {
      this.k.readUsage(undefined, ACCOUNT_ON_PAGE_MS);
    }
    return usageView(this.log, request, { now: Date.now(), state: this.k.activeState(), task: (id) => this.k.task(id), taskName: (id) => this.k.s.tasks.find((task) => task.id === id)?.title ?? this.k.store.history.title(id) });
  }

  // ── Products and ids ───────────────────────────────────────────────────

  /** An id is never handed out again: not one in use, not a removed product's, not one in the work log. */
  productIdTaken(id: Id): boolean {
    return this.k.s.products.some((product) => product.id === id) || this.log.productIdTaken(id);
  }

  taskIdTaken(id: Id): boolean {
    return this.k.s.tasks.some((task) => task.id === id) || this.log.taskIdTaken(id);
  }

  /** The permanent list keeps every product with its latest name, and removed ones marked removed. */
  product(product: { id: Id; name: string; repo: string }, when: { addedAt?: number; removedAt?: number } = {}): void {
    this.log.recordProduct({ id: product.id, name: product.name, repo: product.repo, ...when });
    if (when.removedAt !== undefined) this.changed();
  }

  // ── Moments ────────────────────────────────────────────────────────────

  /** The task went out (or the coordinator marked it done): its last stage ends, and the task with it. */
  delivered(target: MTask | RepositoryContext): void {
    const scope = executionOf(target);
    const { task } = scope;
    if (task.state === "done" || task.state === "pr-open" || task.state === "cancelled") return;
    this.forgetRetries(task.id);
    this.endStage(scope, "delivered");
    this.moment(scope, { kind: "task-end", outcome: "delivered" });
  }

  /** The coordinator cancelled a task still under way. */
  cancelled(target: MTask | RepositoryContext): void {
    const scope = executionOf(target);
    const { task } = scope;
    if (task.state === "done" || task.state === "cancelled") return;
    this.forgetRetries(task.id);
    this.endStage(scope, "cancelled");
    this.moment(scope, { kind: "task-end", outcome: "cancelled" });
  }

  /** The pull request was merged or closed on GitHub. */
  prSettled(target: MTask | RepositoryContext, state: "merged" | "closed"): void {
    const scope = executionOf(target);

    this.moment(scope, { kind: "task-end", outcome: state });
  }

  /** An agent ran out of usage: one failure. The same error failing the task later is not a second one. */
  limitHit(target: MTask | RepositoryContext, roleId: Id, profileId: Id, error?: unknown): void {
    const scope = executionOf(target);

    if (error && typeof error === "object") this.counted.add(error);
    this.moment(scope, { kind: "failure", outcome: "limit", roleId, profileId, toolId: this.k.profile(profileId)?.toolId ?? "" });
  }

  /** The coordinator tried a failed task again. Whatever a limit had left owed for it is this retry. */
  retried(target: MTask | RepositoryContext): void {
    const scope = executionOf(target);
    const { task } = scope;
    this.forgetRetries(task.id);
    this.moment(scope, { kind: "retry" });
  }

  /**
   * A usage limit stopped this step's agent, and whoever takes over has to wait for the reset or a free slot.
   * The step starts again later, from the beginning: that attempt is the retry.
   */
  owesRetry(target: MTask | RepositoryContext, roleId: Id, plannedId: Id): void {
    const scope = executionOf(target);
    const { task } = scope;
    if (this.k.stopped) return;
    const key = retryKey(task.id, roleId, plannedId);
    const owed = this.log.owedRetries();
    if (!owed.includes(key)) this.log.setOwedRetries([...owed, key]);
  }

  /** An agent starts on a step: a retry when a limit stopped the one before it, just now or before a wait. */
  attempt(target: MTask | RepositoryContext, roleId: Id, plannedId: Id, profile: AgentProfile, afterLimit: boolean): void {
    const scope = executionOf(target);
    const { task } = scope;
    const key = retryKey(task.id, roleId, plannedId);
    const owed = this.log.owedRetries();
    const wasOwed = owed.includes(key);
    if (wasOwed) this.log.setOwedRetries(owed.filter((entry) => entry !== key));
    if (afterLimit || wasOwed) this.moment(scope, { kind: "retry", roleId, profileId: profile.id, toolId: profile.toolId });
  }

  private forgetRetries(taskId: Id): void {
    const owed = this.log.owedRetries();
    const kept = owed.filter((key) => !key.startsWith(`${taskId}|`));
    if (kept.length !== owed.length) this.log.setOwedRetries(kept);
  }

  /**
   * A failure, with its plain reason: one that failed the task, or one Petrina recovered from and carried on
   * (the Check finder or the Guide keeper could not finish). `by`: the agent that failed, when it is not the
   * task's current one. Each error counts once, however many places see it.
   */
  failed(target: MTask | RepositoryContext, error: unknown, by?: { roleId: Id; profileId?: Id }): void {
    const scope = executionOf(target);
    const { task } = scope;
    if (error && typeof error === "object") {
      if (this.counted.has(error)) return;
      this.counted.add(error);
    }
    const who = by ?? (task.agent ? { roleId: task.agent.roleId, profileId: task.agent.profileId } : undefined);
    const toolId = who?.profileId ? this.k.profile(who.profileId)?.toolId : undefined;
    this.moment(scope, { kind: "failure", outcome: failureReason(error), ...(who ? { roleId: who.roleId, ...(who.profileId ? { profileId: who.profileId } : {}) } : {}), ...(toolId ? { toolId } : {}) });
  }

  /** An agent's result was unusable, and it is asked to redo it. */
  redo(target: MTask | RepositoryContext, roleId: Id, profile: AgentProfile): void {
    const scope = executionOf(target);

    this.moment(scope, { kind: "redo", roleId, toolId: profile.toolId, profileId: profile.id });
  }

  /** Record the request immediately: cancelling or pausing must never erase that an agent needed help. */
  asked(target: MTask | RepositoryContext, item: DeepMutable<InboxItem>, answer?: AskAnswer): void {
    const scope = executionOf(target);
    const { task } = scope;
    if (!["question", "permission", "plan", "design", "delivery", "disagreement"].includes(item.kind)) return;
    const ask = item.kind === "question" ? "question" : item.kind === "permission" ? "permission" : "checkpoint";
    this.moment(scope, { kind: "ask", ask, ...(answer ? { answer, durationMs: Math.max(0, Date.now() - item.at) } : {}), ...(item.roleId ? { roleId: item.roleId } : {}), ...(item.profileId ? { profileId: item.profileId } : {}) }, { id: askMomentId(task.id, item.id), at: item.at });
  }

  /** Complete the saved request, including late answers after its inbox item disappeared. */
  answered(target: MTask | RepositoryContext, item: DeepMutable<InboxItem> | Id, answer: AskAnswer): void {
    const scope = executionOf(target);
    const { task } = scope;
    if (this.k.stopped) return;
    const request = this.log.moment(askMomentId(task.id, typeof item === "string" ? item : item.id));
    if (!request) {
      // A request already in the inbox when tracking began still gets its answer recorded.
      if (typeof item !== "string") this.asked(scope, item, answer);
      return;
    }
    if (request.kind !== "ask" || request.taskId !== task.id || request.answer !== undefined) return;
    this.log.addMoment({ ...request, answer, durationMs: Math.max(0, Date.now() - request.at) });
    this.changed();
  }

  /** One design round: the architect (`stage`'s author), the design reviewer, and what it raised. */
  designRound(target: MTask | RepositoryContext, stage: MStage, reviewer: { roleId: Id; profileId: Id }, round: number, count: number, blocking: number): void {
    const scope = executionOf(target);
    const { task } = scope;
    this.moment(scope, { kind: "design-round", ...this.author(task, stage, round), peerRoleId: reviewer.roleId, peerProfileId: reviewer.profileId, round, count, blocking });
  }

  /** How a design ended: settled, or with the coordinator. Its stage ends with it. */
  designEnd(target: MTask | RepositoryContext, stage: MStage, round: number, outcome: "settled" | "to-you"): void {
    const scope = executionOf(target);
    const { task } = scope;
    this.moment(scope, { kind: "design-end", ...this.author(task, stage, round), round, outcome, rounds: round });
    this.endStage(scope, outcome);
  }

  /** One reviewer's verdict: how many findings, how many of them blocking. */
  verdict(target: MTask | RepositoryContext, roleId: Id, profileId: Id, round: number, verdict: "pass" | "fail", count: number, blocking: number): void {
    const scope = executionOf(target);

    this.moment(scope, { kind: "verdict", roleId, profileId, round, verdict, count, blocking });
  }

  /** How a review round ended. Its stage ends with it. */
  reviewEnd(target: MTask | RepositoryContext, round: number, outcome: "passed" | "sent-back" | "rounds-used"): void {
    const scope = executionOf(target);

    this.moment(scope, { kind: "review-end", round, outcome });
    this.endStage(scope, outcome);
  }

  private author(task: MTask, stage: MStage, round: number): { roleId: Id; profileId?: Id } {
    // The last completed turn in this round produced the brief, including after a restart or a handover.
    const author = this.log.turns({ taskId: task.id, stageId: stage.id, round }).filter((turn) => turn.roleId === stage.roleId && turn.end === "finished").at(-1);
    return { roleId: stage.roleId, ...(author ? { profileId: author.profileId } : {}) };
  }

  // ── Stages ─────────────────────────────────────────────────────────────

  private stageNow(task: MTask): { stageId: Id; title: string; kind: WorkStageKind; roleId: Id } {
    const stage = task.stageIndex >= 0 ? task.plan?.stages[task.stageIndex] : undefined;
    if (!stage) return { stageId: `${task.id}:plan`, title: "Planning", kind: "plan", roleId: "planner" };
    return { stageId: stage.id, title: stage.title, kind: stage.kind, roleId: stage.roleId };
  }

  /** The open stage run of a task, from memory or, after a restart, from the log. */
  private openStage(task: MTask): OpenStage | undefined {
    const known = this.openStages.get(task.id);
    if (known) return known;
    const logged = this.log.openStage(task.id);
    if (!logged?.stageId) return undefined;
    const open: OpenStage = { stageId: logged.stageId, title: logged.stageTitle ?? "", kind: logged.stageKind ?? "do", roleId: logged.roleId ?? "", run: logged.round ?? 1, startedAt: logged.at };
    this.openStages.set(task.id, open);
    return open;
  }

  /** The task's current stage (or planning) is under way: it starts now unless it already has. */
  beginStage(target: MTask | RepositoryContext): void {
    const scope = executionOf(target);
    const { task } = scope;
    if (this.k.stopped) return;
    const now = this.stageNow(task);
    const open = this.openStage(task);
    if (open?.stageId === now.stageId) return;
    if (open) this.endStage(scope, "done");
    const repeats = now.kind === "converge" || now.kind === "review-chain";
    const run = repeats ? (task.rounds[now.stageId] ?? 1) : this.log.stageRuns(task.id, now.stageId) + 1;
    this.openStages.set(task.id, { stageId: now.stageId, title: now.title, kind: now.kind, roleId: now.roleId, run, startedAt: Date.now() });
    this.moment(scope, { kind: "stage-start", roleId: now.roleId, round: run });
  }

  /** The open stage ends: how it ended, its time from start to finish and its agent time. */
  endStage(target: MTask | RepositoryContext, outcome: MomentOutcome): void {
    const scope = executionOf(target);
    const { task } = scope;
    if (this.k.stopped) return;
    const open = this.openStage(task);
    if (!open) return;
    const now = Date.now();
    this.moment(scope, { kind: "stage-end", outcome, roleId: open.roleId, round: open.run, durationMs: now - open.startedAt, workMs: this.log.stageWork(task.id, open.stageId, open.startedAt) });
    this.openStages.delete(task.id);
  }

  /** The round a turn belongs to: the stage's round, or which run of a do stage this is. */
  private roundOf(task: MTask): number {
    const now = this.stageNow(task);
    if (now.kind === "converge" || now.kind === "review-chain") return task.rounds[now.stageId] ?? 1;
    return this.openStage(task)?.run ?? 1;
  }

  private moment(target: MTask | RepositoryContext, moment: Omit<WorkMoment, "id" | "at" | "taskId" | "productId">, when: { id?: Id; at?: number } = {}): void {
    const scope = executionOf(target);
    const { task } = scope;
    // Stopped: the log is closed, and work cut off by the stop changes nothing.
    if (this.k.stopped) return;
    const stage = this.openStages.get(task.id) ?? this.stageNow(task);
    this.log.addMoment({
      id: when.id ?? randomUUID(),
      at: when.at ?? Date.now(),
      taskId: task.id,
      productId: scope.work.productId,
      ...(moment.kind === "task-end" ? {} : { stageId: stage.stageId, stageTitle: stage.title, stageKind: stage.kind, round: this.roundOf(task) }),
      ...moment,
    });
    this.changed();
  }

  /** A new entry: the window's numbers are asked for again. */
  private changed(): void {
    const work = this.k.s.work ?? { version: 0, since: this.log.since() };
    this.k.s.work = { ...work, version: work.version + 1 };
    this.k.commit();
  }

  // ── Turns ──────────────────────────────────────────────────────────────

  /** One message to an agent and the reply it waits for: one entry in the work log. */
  async turn(target: MTask | RepositoryContext, agent: TurnAgent, run: AgentRun, text: string, reason: TurnReason, signal: AbortSignal): Promise<TurnResult> {
    const scope = executionOf(target);
    const { task } = scope;
    const { profile, roleId, waits } = agent;
    const settings = run.settings;
    const stage = this.stageNow(task);
    const id = randomUUID();
    const startedAt = Date.now();
    const waitedBefore = waits.of(task.id, startedAt);
    agent.agentRunId ??= (reason === "continue" ? continuingAgentTurn(this.log.turns({ taskId: task.id }), {
      taskId: task.id, journeyId: agent.journeyId, agentSeat: agent.agentSeat, roleId, toolId: profile.toolId, sessionId: run.sessionId,
    })?.agentRunId : undefined) ?? randomUUID();
    this.log.startTurn({
      id,
      taskId: task.id,
      productId: scope.work.productId,
      stageId: stage.stageId,
      stageTitle: stage.title,
      stageKind: stage.kind,
      round: this.roundOf(task),
      fixing: task.fixing,
      roleId,
      toolId: profile.toolId,
      profileId: profile.id,
      ...(profile.modelId ? { modelAsked: profile.modelId } : {}),
      modelAskedName: profile.model,
      effortAsked: profile.effort,
      ...(settings.model ? { modelRan: settings.model } : {}),
      ...(settings.modelName ? { modelRanName: settings.modelName } : {}),
      ...(settings.effort ? { effortRan: settings.effort } : {}),
      sessionId: run.sessionId,
      journeyId: agent.journeyId,
      agentRunId: agent.agentRunId,
      agentSeat: agent.agentSeat,
      reason,
      startedAt,
      mainOnly: false,
      helpers: 0,
    });
    this.changed();
    const finish = (end: "finished" | "interrupted" | "stopped" | "agent-stopped", result?: TurnNotes & Pick<TurnResult, "report">) => {
      const endedAt = Date.now();
      const workMs = Math.max(0, endedAt - startedAt - (waits.of(task.id, endedAt) - waitedBefore));
      // Claude Code's breakdown already counts its helper agents; only Codex leaves them out (and starts them as spawnAgent).
      const helpers = profile.toolId === "codex" ? (result?.helpers ?? 0) : 0;
      const model = result?.report?.model ?? settings.modelName ?? settings.model ?? result?.modelSeen;
      const counted = turnTokens({ toolId: profile.toolId, ...(result?.report ? { report: result.report } : {}), ...(model ? { model } : {}), rerouted: result?.rerouted ?? false, helpers });
      this.log.endTurn(
        id,
        {
          end,
          endedAt,
          workMs,
          mainOnly: counted.mainOnly,
          helpers,
          ...(result?.report?.model ? { modelRan: result.report.model } : {}),
          ...(counted.tokens ? { tokens: counted.tokens } : {}),
          ...(result?.changed.model ? { modelChangedTo: result.changed.model } : {}),
          ...(result?.changed.effort ? { effortChangedTo: result.changed.effort } : {}),
        },
        counted.lines,
      );
      this.changed();
    };
    try {
      const result = await run.prompt(text);
      finish(result.stopReason === "cancelled" ? "interrupted" : "finished", result);
      return result;
    } catch (error) {
      // No reply, but what the tool said during the turn (a switch of model or effort) still counts.
      finish(signal.aborted ? "stopped" : "agent-stopped", run.lastTurn);
      throw error;
    } finally {
      if (!ADAPTERS[profile.toolId]?.usageReader?.liveSession) this.k.readUsage(profile.toolId, ACCOUNT_AFTER_TURN_MS);
    }
  }

  // ── Limits ─────────────────────────────────────────────────────────────

  /** One reading of a limit goes into the thirty-day history; a changed reading has the window ask for its charts again. */
  usageReported(report: UsageReport): void {
    if (this.k.stopped) return;
    if (this.log.recordUsage(report)) this.changed();
  }

}

const retryKey = (taskId: Id, roleId: Id, plannedId: Id) => `${taskId}|${roleId}|${plannedId}`;

/** A failure in plain words: a usage limit, the agent stopping, an unusable result, or something else. A limit the tool's code named counts as one whatever its words. */
export function failureReason(error: unknown): "limit" | "agent-stopped" | "unusable" | "other" {
  // A full model waits and retries. It is not the account running out, even though the wait is a kind of WaitingForUsage.
  if (error instanceof WaitingForCapacity || error instanceof ModelAtCapacity) return "other";
  if (error instanceof UsageLimited || error instanceof WaitingForUsage) return "limit";
  const message = error instanceof Error ? error.message : String(error);
  if (/usage limit|rate limit|spend limit|extra usage|limit reached|quota|too many requests|\b429\b/i.test(message)) return "limit";
  if (/usable result/i.test(message)) return "unusable";
  if (/stopped \(exit|agent stopped|stopped \(signal/i.test(message)) return "agent-stopped";
  return "other";
}
