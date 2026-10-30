import { CheckDecision, CheckDelivery, checkDiagnostic, CheckEvidence, CheckSetup, type CheckVerification } from "@petrina/orchestrator";
export type { CheckVerification } from "@petrina/orchestrator";
import { checkSetupContract, deriveCheckEnvironmentIdentity, observeCheckExecutor } from "@petrina/repositories/check-environment";
import { checkSetupOutcome, checkSetupWords, checkInputApplicability, recordedCheckBatch, type CheckInputApplicability, type RecordedCheckBatchOutcome, type CheckSetupAttempt, type CheckSetupInput, type CheckSetupOutcome, type ProductCheckSetup } from "@petrina/core";
import { acquireCheckPlace } from "@petrina/orchestrator";
import { scopesFor, taskView, type RepositoryContext } from "@petrina/orchestrator";
import { acceptanceVersion } from "./repositories.js";
import { CheckRepairs } from "@petrina/orchestrator";
// The product's checks, run by Petrina itself: the Check finder works out the commands, and failing
// checks become findings with the real output. Running commands is in checks.ts.

import { beginPetrinaStep, checkOutcome, checkResult, decisionEvidence, gateStatus, originalCheck, endAgentStep, endPetrinaStep, JOURNEY_WORDS, openStep, runtimeWaitHolds, type Id, type ProductCheck } from "@petrina/core";
import { livePowerRecords, powerInterruption, readMachineRecords, type MachineRecords } from "./check-interruption.js";
import * as git from "@petrina/repositories/git";
import { CheckFinderResult } from "./roles.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CheckAttemptEvidence, CheckRun, DeepMutable, JourneyCheckReuse, JourneyProductCheck } from "@petrina/core";
import { namedCheckFailures } from "./related-check-evidence.js";
import { CHECKS_SEEN, checksFingerprint, checksFor, detectChecks, runChecks, commandText, expectedCheckCommands, orderedChecks, staticCheck, type CheckProgress } from "./checks.js";
import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";
import { withoutCredentials } from "@petrina/platform/process-environment";
import { Kernel, Aborted, CHECK_FINDER_PROFILE, ScreenWait, SourceRefreshRequired, type RuntimeTask } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import { beginSideStep } from "./side-step.js";

/** Keep the failed test name and short cause with the journey step without saving the whole log twice. */


type CheckEntries = Map<string, DeepMutable<JourneyProductCheck>>;
type CheckState = { sha?: string; tree?: string; trackedChanged: boolean; hooks: string[]; definition: string; message?: string; setup?: ProductCheckSetup; contract: string; requiredCommands: string; invalidationId?: Id };

export type RecordedChecksApplicability = { inputs: CheckInputApplicability; batch: RecordedCheckBatchOutcome };
type LiveSetup = { attempt: CheckSetupAttempt; outcome: CheckSetupOutcome; valid: () => boolean; forceFresh: boolean };


/** Repeat the owning step's source/approval policy only when its check batch waited. */
export type CheckPreparation = (() => Promise<boolean | void>) & { beforeQueue?: () => boolean | void };
export class CheckPreparationChanged extends Error {
  constructor() { super("The work needs its existing update or approval step before checks can run"); }
}

/**
 * Nothing to run: no check with a command and no commit hook. Such a run still records a checks step and its
 * attempt's versions, so later steps can tell "no checks configured" from missing evidence, but it needs no turn
 * on the check lane and touches no file: nothing ran, so there is nothing to put back, and uncommitted edits stay.
 */
const nothingToRun = (checks: readonly ProductCheck[], hooks: readonly string[]): boolean => !checks.some((check) => check.argv.length) && !hooks.length;

export class ProductChecks {
  /**
   * Task check runs take turns: each can start a full parallel test suite and build, so overlapping them
   * multiplies CPU and memory pressure and can make both slower or cause timeouts.
   */
  private readonly preparations = new Set<Id>();
  /** A source update may ask about a saved repository address; that decision owns no check place. */
  private readonly decisionReleases = new Map<Id, () => boolean>();
  /** A local delivery keeps its original check order while waiting for its destination turn. */
  readonly deliveryOrders = new Map<Id, number>();

  private readonly decision: CheckDecision;
  private readonly delivery: CheckDelivery<CheckPreparation>;
  private readonly repairs: CheckRepairs;
  private readonly evidence: CheckEvidence;
  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context) {
    this.decision = new CheckDecision({ state: () => k.s, role: (id, task) => k.role(id, task), productName: scope => k.productOf(scope)?.name ?? scope.work.productId,
      id: task => k.id(task.id), now: Date.now, log: (scope, tone, text) => k.log(scope, tone, text), gate: (task, problem) => k.gate(task, "delivery", undefined, problem) });
    this.delivery = new CheckDelivery({
      failing: (scope, signal, purpose, prepare) => this.failing(scope, signal, undefined, purpose, prepare),
      preparationChanged: error => error instanceof CheckPreparationChanged,
      backToBuilder: (scope, when, products) => this.backToBuilder(scope, when, products), blocked: task => this.blocked(task),
    });
    this.evidence = new CheckEvidence({
      now: Date.now, changed: () => k.commit(), log: (scope, tone, text) => k.log(scope, tone, text),
      deliveryRole: scope => k.role(openStep(scope.task)?.roleId ?? "")?.result === "delivery",
      check: signal => { if (signal.aborted || k.stopped) throw new Aborted(); },
      refreshInterruptions: (scope, signal) => this.refreshInterruptions(scope, signal),
      recordFailedFindings: (scope, results) => this.recordFailedFindings(scope, results),
      settleFindings: (scope, results) => this.settleFindings(scope, results),
      closeEpisode: (scope, state, valid) => this.repairs.closeEpisode(scope, state, valid),
    });
    this.repairs = new CheckRepairs({
      role: (id, task) => k.role(id, task), id: task => k.id(task.id),
      log: (scope, tone, text) => k.log(scope, tone, text), changed: () => k.commit(),
      commitNow: task => k.commitNow(task), checkpoint: () => k.commitNow(),
      definition: async (scope, sha) => {
        const product = k.productOf(scope), worktree = scope.work.worktree!;
        return (await this.definition(scope, product ? checksFor(product, worktree) : [], await git.commitHookFiles(worktree), sha)).definition;
      },
    });
  }

  /** This engine's one source of sleep records, for its checks and hooks, failure reuse and startup recovery. */
  private get machineRecords(): MachineRecords { return this.k.options.machineRecords ?? livePowerRecords; }

  /** Recover trustworthy evidence once at startup, including decisions already waiting on the coordinator. */
  async restoreEvidence(): Promise<void> {
    const observations = this.k.s.tasks.filter((task) => !["running", "done", "cancelled", "pr-open"].includes(task.state)).flatMap((task) => scopesFor(task).flatMap((scope) => (scope.work.checks?.results ?? []).filter((run) => !run.ok && !run.interruption && !run.interrupted).flatMap((run) => {
      const original = originalCheck(task, run)?.check;
      const start = run.startedAt ?? original?.startedAt, end = run.endedAt ?? original?.endedAt;
      return start !== undefined && end !== undefined ? [{ scope, run, start, end }] : [];
    })));
    if (!observations.length) return;
    const records = await readMachineRecords(this.machineRecords, this.k.stopRequested.signal);
    if (this.k.stopped || this.k.stopRequested.signal.aborted) return;
    const changed = new Set<RuntimeTask>();
    for (const { scope, run, start, end } of observations) {
      if (scope.task.state === "running" || !scope.work.checks?.results.includes(run)) continue;
      const interruption = powerInterruption(start, end, records);
      if (!interruption) continue;
      run.interruption = interruption;
      for (const step of scope.task.journey ?? []) for (const check of step.productChecks ?? []) if (check.run && (run.source ? check.run.source?.stepId === run.source.stepId && check.run.source?.checkId === run.source.checkId && check.run.source?.attemptId === run.source.attemptId : !!run.logPath && check.run.logPath === run.logPath)) check.run.interruption = interruption;
      this.settleFindings(scope, scope.work.checks.results);
      changed.add(scope.task);
    }
    for (const task of changed) {
      const decision = openStep(task);
      if (task.state !== "needs-you" || decision?.waitsFor !== "delivery") continue;
      decision.productChecks = decisionEvidence(taskView(task));
      const problem = this.checkProblem(task);
      for (const item of this.k.s.inbox) if (item.taskId === task.id && item.kind === "delivery") { item.title = problem.title; item.body = problem.body; }
      task.statusLine = gateStatus(taskView(task), "delivery");
    }
    if (changed.size) this.k.commitNow();
  }

  get preparingCount(): number { return this.preparations.size; }

  canPrepare(taskId: Id): boolean {
    return this.preparations.has(taskId) || this.preparations.size < Math.max(1, this.k.s.pool.limit);
  }

  claimPreparation(taskId: Id): boolean {
    if (this.k.taskAdmissionsClosed(taskId) || !this.canPrepare(taskId)) return false;
    this.preparations.add(taskId);
    return true;
  }

  releasePreparation(taskId: Id): void { this.preparations.delete(taskId); }

  releaseForDecision(taskId: Id): boolean {
    // Discovery can ask too, after returning check capacity. Its decision must not reserve preparation room.
    const preparation = this.preparations.delete(taskId);
    const checks = this.decisionReleases.get(taskId)?.() ?? false;
    return preparation || checks;
  }

  private async turnToRun(scope: RepositoryContext, signal: AbortSignal, order = this.k.checkQueue.reserveOrder()): Promise<(() => void) & { waited: boolean }> {
    const { task } = scope;
    if (signal.aborted || this.k.stopped) throw new Aborted();
    if (runtimeWaitHolds(task)) throw new WaitingForUsage(this.k.taskAdmissionWait(task));
    let waitingForPool = false;
    const resume = (words: string) => {
      const wasPaused = waitingForPool && task.state === "waiting";
      waitingForPool = false;
      if (!wasPaused && task.statusLine === words) return;
      if (wasPaused) { task.state = "running"; task.column = this.k.columnFor(task); }
      task.statusLine = words;
      this.k.commit();
    };
    const onWait = (closed?: string) => {
      if (signal.aborted || this.k.stopped || runtimeWaitHolds(task) || !["running", "waiting"].includes(task.state)) return;
      if (closed) {
        waitingForPool = true;
        if (task.state !== "waiting" || task.statusLine !== closed) this.k.waitForUsage(task, closed);
      } else resume(this.k.extraCheckBlocker?.() ?? "Waiting to run the checks: another task's run comes first");
    };
    this.k.waitingChecks.set(task.id, (this.k.waitingChecks.get(task.id) ?? 0) + 1);
    try {
      return await acquireCheckPlace(this.k.checkQueue, signal, order, {
        stopped: () => this.k.stopped,
        prerequisite: () => runtimeWaitHolds(task),
        closed: () => this.k.taskAdmissionsClosed(task),
        draining: () => this.k.draining,
        reason: () => this.k.taskAdmissionWait(task),
        subscribe: changed => this.k.subscribe(changed),
        onWait,
        admitted: () => { if (waitingForPool) resume("Preparing the product's checks"); },
      });
    } finally {
      const left = this.k.waitingChecks.get(task.id)! - 1;
      if (left) this.k.waitingChecks.set(task.id, left);
      else this.k.waitingChecks.delete(task.id);
      this.k.syncIdleSleep();
    }
  }

  /**
   * The product's checks. The Check finder works them out once per product, and again only when the
   * CI, build or hook files it read have changed. Checks the coordinator set
   * by hand are never replaced. Discovery acquires a real agent slot; commands use their own queue.
   */
  async ensureChecks(scope: RepositoryContext, signal: AbortSignal): Promise<readonly ProductCheck[]> {
    const { task, work: repository } = scope;
    const product = this.k.productOf(scope);
    if (!product || !repository.worktree) return [];
    // Another task may have found (or the coordinator set) the checks while this agent waited.
    // Its saved conversation still finishes its own request before the cached checks can be reused.
    const continuing = this.k.role(repository.conversation?.roleId ?? "")?.result === "check-discovery";
    if (product.checksBy === "coordinator" && !continuing) return product.checks ?? [];
    const fingerprint = checksFingerprint(repository.worktree);
    if (!continuing && product.checks && product.checksFingerprint === fingerprint) return product.checks;
    // Tasks on different bases have different CI and build files: each reuses what was found for its own.
    const seen = product.checksSeen?.find((entry) => entry.fingerprint === fingerprint);
    if (!continuing && seen) return seen.checks;
    const declared = detectChecks(repository.worktree);
    // A side errand inside the step: it leaves the step's own restart bookkeeping as it found it.
    const restore = beginSideStep(this.k, scope, "check-finder");
    const why = !product.checks ? "first time" : "the CI, build or hook files changed";
    // On a tool the squad can use, like every other step.
    const finder = this.k.onUsable(CHECK_FINDER_PROFILE);
    let ran: Id = finder;
    try {
      const result = await this.turns.turn(
        scope,
        "check-finder",
        finder,
        async () => [
          ...await this.context.sectionsFor(scope, "check-finder"),
          ...(product.checks ? [{ title: "The checks used until now", body: product.checks.map((check) => `- ${check.name}: ${commandText(check.argv)}`).join("\n") }] : []),
          ...(declared.length ? [{ title: "Commands the repository declares (a starting point, not the answer)", body: declared.map((check) => `- ${check.name}: ${commandText(check.argv)}`).join("\n") }] : []),
        ],
        CheckFinderResult,
        signal,
        { status: "Working out how to check this product", used: (id) => (ran = id) },
      );
      this.k.releaseScreen(task);
      restore();
      if (product.checksBy === "coordinator") return product.checks ?? [];
      product.checks = result.checks.map((check) => ({ name: check.name, argv: check.argv, why: check.why }));
      endAgentStep(task, { outcome: JOURNEY_WORDS.foundChecks(product.checks.length), reason: JOURNEY_WORDS.checksFound }, Date.now());
      this.k.log(scope, "done", `Found how to check ${product.name} (${why}): ${product.checks.map((check) => check.name).join(", ")}`, "check-finder", ran);
    } catch (error) {
      if (signal.aborted || error instanceof Aborted || error instanceof ScreenWait) throw error;
      this.k.releaseScreen(task);
      restore();
      // Admission waits leave discovery pending; neither usage nor source catch-up is a failed finder.
      if (error instanceof WaitingForUsage || error instanceof SourceRefreshRequired) throw error;
      // Petrina carries on without it, but it is still a failure in Analytics.
      this.k.tracking.failed(scope, error, { roleId: "check-finder", profileId: ran });
      endAgentStep(task, { outcome: JOURNEY_WORDS.couldNotFinish, reason: JOURNEY_WORDS.checksAsBefore }, Date.now());
      if (product.checksBy === "coordinator") return product.checks ?? [];
      const fallback: ProductCheck[] = product.checks ? [...product.checks] : declared;
      product.checks = fallback.map((check) => ({ name: check.name, argv: [...check.argv], ...(check.why ? { why: check.why } : {}) }));
      this.k.log(scope, "warn", `The Check finder could not finish, so Petrina uses ${fallback.length ? "the checks it had" : "no checks"} for now`);
    }
    product.checksBy = "finder";
    product.checksFingerprint = fingerprint;
    product.checksSeen = [...(product.checksSeen ?? []).filter((entry) => entry.fingerprint !== fingerprint), { fingerprint, checks: product.checks ?? [] }].slice(-CHECKS_SEEN);
    this.k.commit();
    return product.checks ?? [];
  }

  /** Undefined means discovery needs an agent, which must happen outside the check place. */
  private cachedChecks(scope: RepositoryContext): readonly ProductCheck[] | undefined {
    const product = this.k.productOf(scope), repository = scope.work;
    if (!product || !repository.worktree) return [];
    if (product.checksBy === "coordinator") return product.checks ?? [];
    const fingerprint = checksFingerprint(repository.worktree);
    if (product.checks && product.checksFingerprint === fingerprint) return product.checks;
    return product.checksSeen?.find(entry => entry.fingerprint === fingerprint)?.checks;
  }

  /**
   * Petrina runs the product's checks itself, without credentials, and then the repository's own commit
   * hooks on the task's whole change. Failures become blocking findings, with the output as evidence. A check
   * only looks: whatever one changes in files git tracks is undone, so nothing unreviewed joins the work.
   */
  async runProductChecks(scope: RepositoryContext, checks: readonly ProductCheck[], signal: AbortSignal, kept?: readonly CheckRun[], prepared?: CheckState, prepare?: CheckPreparation, purpose: JourneyCheckReuse["purpose"] = "acceptance"): Promise<CheckVerification> {
    const { task, work: repository } = scope;
    if (!repository.worktree) return { kind: "blocked", productId: repository.productId, results: repository.checks?.results ?? [], reason: "inputs-changed", setup: { kind: "unobserved" } };
    // A check queue entry is not a model conversation. No agent still runs on this copy.
    if (!this.k.runs.has(task.id) && !this.k.helperRuns.get(task.id)?.size) {
      task.holdsSlot = false;
      delete task.agent;
    }
    if (!this.claimPreparation(task.id)) throw new WaitingForUsage(this.k.taskAdmissionsClosed(task) ? this.k.taskAdmissionWait(task) : "Waiting for room to prepare the product checks");
    this.k.schedule();
    try { return await this.runPreparedChecks(scope, checks, signal, kept, prepared, prepare, purpose); }
    finally { this.releasePreparation(task.id); }
  }

  private async runPreparedChecks(scope: RepositoryContext, checks: readonly ProductCheck[], signal: AbortSignal, kept?: readonly CheckRun[], prepared?: CheckState, prepare?: CheckPreparation, purpose: JourneyCheckReuse["purpose"] = "acceptance"): Promise<CheckVerification> {
    const { task, work: repository } = scope;
    if (!repository.worktree) return { kind: "blocked", productId: repository.productId, results: repository.checks?.results ?? [], reason: "inputs-changed", setup: { kind: "unobserved" } };
    let state = prepared ?? await this.captureState(scope, checks);
    const hooks = state.hooks;
    let nothing = nothingToRun(checks, hooks) && !(this.k.productOf(scope)?.checkSetup?.requirements.length);
    // Prepared, unstarted commands retain one pending attempt through a pool pause.
    // Task prerequisites, draining and empty batches still return to ordinary admission.
    const queueWhilePaused = () => !nothing && this.k.s.pool.paused && !this.k.draining && !this.k.stopped && !runtimeWaitHolds(task);
    if (this.k.taskAdmissionsClosed(task) && !queueWhilePaused()) throw new WaitingForUsage(this.k.taskAdmissionWait(task));
    if (this.k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
    // Resuming unfinished release notes revalidates the preparation first. Those repeated checks belong
    // to the same step's timeline: they do not complete the notes or start another agent step.
    const open = openStep(task);
    const resumingNotes = open?.kind === "agent" && this.k.role(open.roleId ?? "")?.result === "delivery" && open.stageId === task.plan?.stages[task.stageIndex]?.id;
    // A checks step's elapsed time includes waiting for another task's run.
    if (!resumingNotes) beginPetrinaStep(task, "checks", Date.now(), repository);
    let step = openStep(task);
    const prefix = step?.productChecks?.length ? `run-${step.productChecks.length}:` : "";
    const attempt = { attemptId: `run-${step?.productChecks?.length ?? 0}`, queuedAt: Date.now(), productId: repository.productId };
    const entries: CheckEntries = new Map<string, DeepMutable<JourneyProductCheck>>([
      ...checks.filter((check) => check.argv.length).map((check, index) => [`check-${index}`, { ...attempt, id: `${prefix}check-${index}`, name: check.name, result: "pending" as const }] as const),
      ...hooks.map((hook) => [`hook-${hook}`, { ...attempt, id: `${prefix}hook-${hook}`, name: hook === "pre-commit" ? "Pre-commit hook" : "Commit message hook", result: "pending" as const }] as const),
    ]);
    if (step) {
      // Continuing release notes reuse their journey node. Each revalidation keeps its own
      // progress and original diagnostics instead of replacing the earlier run's evidence.
      for (const check of step.productChecks ?? []) if (check.result === "pending" || check.result === "running") {
        check.result = "stopped";
        check.endedAt = Date.now();
      }
      step.productChecks = [...(step.productChecks ?? []), ...entries.values()];
    }
    this.k.commit();
    let finished: Awaited<ReturnType<ProductChecks["turnToRun"]>> | undefined;
    let complete = false;
    let recapture = false;
    let discoveries = 0;
    const order = nothing ? undefined : this.deliveryOrders.get(task.id) ?? this.k.checkQueue.reserveOrder();
    const reopenChecks = () => {
      if (step?.endedAt === undefined) return;
      step = beginPetrinaStep(task, "checks", Date.now(), repository);
      const refreshed: DeepMutable<JourneyProductCheck>[] = [...entries.values()].map(check => ({ ...check, result: "pending", detail: undefined, endedAt: undefined }));
      step.productChecks = refreshed;
      entries.clear();
      for (const check of refreshed) entries.set(check.id!.slice(prefix.length), check);
    };
    try {
      for (;;) {
        // A discovery conversation can yield a local delivery's turn. Reacquire before joining the line,
        // without reserving check capacity or fetching twice for an unwaited run.
        const reacquired = prepare?.beforeQueue?.();
        if (!this.preparations.has(task.id) && !this.claimPreparation(task.id)) throw new WaitingForUsage(this.k.taskAdmissionsClosed(task) ? this.k.taskAdmissionWait(task) : "Waiting for room to prepare the product checks");
        finished = nothing ? undefined : await this.turnToRun(scope, signal, this.deliveryOrders.get(task.id) ?? order);
        if (finished?.waited || recapture || reacquired) {
          // Discovery needs fresh captured inputs, but only another queue wait or a regained delivery
          // turn needs another source update. An immediately available place adds no second fetch.
          if ((finished?.waited || reacquired) && prepare) {
            let yieldedForDecision = false;
            const release = () => {
              const released = finished !== undefined;
              finished?.(); finished = undefined;
              this.releasePreparation(task.id);
              yieldedForDecision = true;
              return released;
            };
            this.decisionReleases.set(task.id, release);
            try { if (await prepare() === false) throw new CheckPreparationChanged(); }
            finally { if (this.decisionReleases.get(task.id) === release) this.decisionReleases.delete(task.id); }
            if (yieldedForDecision) {
              recapture = true;
              reopenChecks();
              continue;
            }
          }
          if (signal.aborted || this.k.stopped) throw new Aborted();
          if (this.k.taskAdmissionsClosed(task) && !queueWhilePaused()) throw new WaitingForUsage(this.k.taskAdmissionWait(task));
          if (this.k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
          if (prepare) {
            const current = this.cachedChecks(scope);
            if (!current) {
              if (discoveries++ >= 3) throw new Error("The files defining this product's checks kept changing before they could start. Your work is preserved; try again once they are stable.");
              // Discovery can wait for a model or the coordinator. It must never retain check capacity.
              finished?.(); finished = undefined;
              checks = await this.ensureChecks(scope, signal);
              recapture = true;
              // Discovery ended the earlier checks step. Its stopped evidence is historical; any
              // later admission or preparation result belongs to a new step, including a conflict.
              reopenChecks();
              task.holdsSlot = false;
              delete task.agent;
              this.k.schedule();
              continue;
            }
            checks = current;
          }
          state = await this.captureState(scope, checks);
          nothing = nothingToRun(checks, state.hooks) && !(this.k.productOf(scope)?.checkSetup?.requirements.length);
          recapture = false;
          // Another run held the lane. Files and external hook inputs may have changed while waiting.
          kept = undefined;
          // An update may record its own journey moment. The admitted run needs an open check step.
          reopenChecks();
          const declared = new Map(checks.filter(check => check.argv.length).map((check, index) => [`check-${index}`, check.name]));
          for (const [id, entry] of entries) if (id.startsWith("check-")) {
            if (declared.has(id)) { entry.name = declared.get(id)!; entry.result = "pending"; }
            else entry.result = "skipped";
          }
          for (const [id, name] of declared) if (!entries.has(id)) {
            const entry: DeepMutable<JourneyProductCheck> = { ...attempt, id: `${prefix}${id}`, name, result: "pending" };
            entries.set(id, entry);
            if (step) step.productChecks = [...(step.productChecks ?? []), entry];
          }
          for (const [id, entry] of entries) if (id.startsWith("hook-") && !state.hooks.includes(id.slice(5))) entry.result = "skipped";
          for (const hook of state.hooks) if (!entries.has(`hook-${hook}`)) {
            const entry: DeepMutable<JourneyProductCheck> = { ...attempt, id: `${prefix}hook-${hook}`, name: hook === "pre-commit" ? "Pre-commit hook" : "Commit message hook", result: "pending" };
            entries.set(`hook-${hook}`, entry);
            if (step) step.productChecks = [...(step.productChecks ?? []), entry];
          }
        }
        if (!this.k.taskAdmissionsClosed(task)) break;
        if (!queueWhilePaused()) throw new WaitingForUsage(this.k.taskAdmissionWait(task));
        // A pause during asynchronous recapture returns the place without replacing evidence or FIFO order.
        finished?.(); finished = undefined;
      }
      if (this.k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
      const failures = await this.runAll(scope, checks, state, signal, entries, kept, attempt.attemptId, purpose, () => finished !== undefined);
      complete = true;
      return failures;
    } catch (error) {
      if (error instanceof CheckPreparationChanged) {
        for (const check of entries.values()) if (check.result === "pending" || check.result === "stopped") {
          check.result = "skipped";
          check.detail = scope.work.updating ? "The starting branch moved and conflicts need the Builder before checks can run" : "The updated change needs approval before checks can run";
          check.endedAt = Date.now();
        }
        if (step) { step.outcome = "Not run"; step.reason = entries.values().next().value?.detail; }
      }
      throw error;
    } finally {
      if (step && !complete) {
        for (const check of entries.values()) if (check.result === "pending" || check.result === "running") {
          check.result = "stopped";
          check.endedAt = Date.now();
        }
        this.k.commit();
      }
      finished?.();
    }
  }

  private async runAll(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState, signal: AbortSignal, entries: CheckEntries, kept?: readonly CheckRun[], attemptId = entries.values().next().value?.attemptId, purpose: JourneyCheckReuse["purpose"] = "acceptance", ownsPlace: () => boolean = () => false): Promise<CheckVerification> {
    const { task, work: repository } = scope;
    if (signal.aborted || this.k.stopped) throw new Aborted();
    if (!repository.worktree) return { kind: "blocked", productId: repository.productId, results: repository.checks?.results ?? [], reason: "inputs-changed", setup: { kind: "unobserved" } };
    task.statusLine = "Running the product's checks";
    if (repository.checks) repository.checks.current = false;
    this.k.commit();
    // Checks and hooks are the repository's own code: whatever they commit or change, the work stays as it was.
    const before = state.sha ?? await git.head(repository.worktree);
    const { hooks, definition } = state;
    const env = { ...withoutCredentials(process.env, await this.k.emptyGhConfig()), CI: "1", BROWSER: "none", PETRINA_AGENT: "1" };
    const step = openStep(task);
    const provenance: DeepMutable<CheckAttemptEvidence> | undefined = attemptId && step ? {
      id: attemptId, productId: repository.productId, sha: before, tree: state.trackedChanged ? undefined : state.tree,
      commands: checks.filter((check) => check.argv.length).map((check) => commandText(check.argv)), definition,
    } : undefined;
    if (step && provenance) step.checkAttempts = [...(step.checkAttempts ?? []), provenance];
    const progress = (id: string, event: CheckProgress) => {
      if (this.k.stopped || signal.aborted || step?.endedAt !== undefined || openStep(task)?.id !== step?.id) return;
      const check = entries.get(id);
      if (!check) return;
      if (event.kind === "started") { check.result = "running"; check.startedAt = event.at; }
      else {
        if (!kept?.includes(event.run)) event.run.source ??= { stepId: step!.id, attemptId: check.attemptId!, checkId: check.id! };
        check.run = { ...event.run };
        check.result = signal.aborted ? "stopped" : checkResult(event.run);
        check.endedAt = event.at;
        if (checkOutcome(event.run).kind !== "passed") check.detail = checkDiagnostic(event.run.output);
        if (checkOutcome(event.run).kind === "failed" && id.startsWith("check-")) check.namedFailures = namedCheckFailures(event.run.output);
      }
      const running = step!.productChecks!.filter((entry) => entry.result === "running").map((entry) => entry.name);
      task.statusLine = running.length ? `Running checks: ${running.join(", ")}` : "Finishing the check run";
      this.k.commit();
    };
    let results: CheckRun[];
    // A run that executed something gets one combined inspection afterwards; an empty run gets none.
    const nothing = nothingToRun(checks, hooks);
    let checksRestored = nothing;
    let hooksStarted = false;
    const restore = async (report = false) => {
      const status = await git.worktreeStatus(repository.worktree!, false);
      if (status.head !== before) {
        await git.resetTo(repository.worktree!, before);
        if (report) this.k.log(scope, "warn", "A check made a commit, so Petrina put the work back as it was: checks only look, and fixes come from the builder");
      } else if (status.trackedChanged) {
        await git.restoreTracked(repository.worktree!);
        if (report) this.k.log(scope, "warn", "A check changed files, so Petrina put them back: checks only look, and fixes come from the builder");
      }
      if (status.head !== before || status.trackedChanged) {
        const restored = await git.worktreeStatus(repository.worktree!, false);
        if (restored.head !== before || restored.trackedChanged) throw new Error("The check run could not restore the original work. Its results cannot count as current evidence.");
      }
    };
    const live = await this.observeSetup(scope, checks, state, signal, env, "before-checks", restore, ownsPlace);
    if (signal.aborted || this.k.stopped) throw new Aborted();
    if (live.outcome.kind !== "verified") return this.setupBlocked(scope, live);
    if (!live.valid()) return this.setupBlocked(scope, live, "inputs-changed");
    if (kept === undefined && await this.ranOn(scope, checks, state) && this.matchesEnvironment(scope, live)) {
      const reused = await this.reuse(scope, state, purpose, live, signal);
      for (const check of entries.values()) if (check.result === "pending") { check.result = "skipped"; check.detail = "The earlier batch was verified for this operation"; }
      endPetrinaStep(task, { outcome: reused.kind === "passed" ? "Previous checks reused" : "Checks need attention", reason: "Existing raw results retained" }, Date.now());
      return reused;
    }
    if (!live.forceFresh && kept === undefined && await this.ranOn(scope, checks, state) && repository.checks!.results.some(run => !["passed", "failed"].includes(checkOutcome(run).kind)))
      return this.retainIncomplete(scope, state, purpose, live);
    if (!kept || !this.matchesEnvironment(scope, live, kept)) kept = await this.savedProductResults(scope, checks, state, live);
    // Even a retained subset must come from the same observed executor and complete environment.
    const beforeStart = () => live.valid();
    try {
      const ran = kept ?? await runChecks(repository.worktree, checks, env, this.k.options.checkTimeoutMs, signal, join(this.k.dataDir, "checks", task.id), undefined, (event) => progress(`check-${event.index}`, event), this.machineRecords, undefined, undefined, beforeStart, this.k.options.runCheckCommand);
      if (kept) {
        const shown = new Set<number>();
        kept.forEach((run) => {
          const index = checks.findIndex((check, i) => !shown.has(i) && check.name === run.name && commandText(check.argv) === run.command);
          shown.add(index);
          progress(`check-${index}`, { kind: "finished", index, at: Date.now(), run });
          const entry = entries.get(`check-${index}`);
          if (entry) { entry.reusedAt = Date.now(); entry.startedAt = run.startedAt; entry.endedAt = run.endedAt; }
        });
      }
      if (signal.aborted) {
        this.noteStopped(scope, ran, entries);
        throw new Aborted();
      }
      if (!nothing) await restore(true);
      checksRestored = true;
      const staticFailed = checks.some((check) => staticCheck(check) && ran.some((run) => !run.ok && run.command === commandText(check.argv)));
      hooksStarted = !staticFailed && hooks.length > 0;
      const hooksRan = staticFailed ? [] : await this.runHooks(scope, hooks, before, state.message, env, signal, progress, beforeStart);
      if (signal.aborted) {
        this.noteStopped(scope, [...ran, ...hooksRan], entries);
        throw new Aborted();
      }
      results = [...ran, ...hooksRan];
    } finally {
      // The hooks too: whatever they committed or changed in files git tracks is put back.
      if (!repository.hooking && (!checksRestored || hooksStarted)) await restore();
    }
    const required = this.k.productOf(scope);
    const rawTree = state.sha === before && state.tree ? state.tree : await git.treeOf(repository.worktree, before);
    // Preserve actual raw product results even if a later input/setup observation rejects.
    repository.checks = { current: false, at: Date.now(), ...(before ? { sha: before } : {}), ...(rawTree ? { tree: rawTree } : {}), definition, results,
      ...(step && attemptId ? { provenance: { nodeId: step.id, attemptId } } : {}) };
    this.k.commit();
    const ranAnything = (!nothing && !kept) || hooksStarted || !!state.setup?.requirements.length;
    const finalState = await this.captureFinalDefinition(scope, required ? checksFor(required, repository.worktree) : checks, state, ranAnything);
    const after = await this.observeSetup(scope, checks, finalState, signal, env, "after-checks", restore, ownsPlace);
    if (signal.aborted || this.k.stopped) { this.noteStopped(scope, results, entries); throw new Aborted(); }
    const staticFailedNow = checks.some(check => staticCheck(check) && results.some(run => checkOutcome(run).kind === "failed" && run.command === commandText(check.argv)));
    const expected = [...expectedCheckCommands(checks, results), ...(!staticFailedNow ? hooks.map(hook => hook === "pre-commit" ? "git hook run --ignore-missing pre-commit" : "git hook run commit-msg") : [])];
    return this.evidence.record(scope, { state, finalState, live, after, before, rawTree, results, expected,
      commands: [...orderedChecks(checks).map(check => commandText(check.argv)), ...hooks.map(hook => hook === "pre-commit" ? "git hook run --ignore-missing pre-commit" : "git hook run commit-msg")],
      attemptId, stepId: step?.id, provenance, entries });
  }

  /**
   * A pause or cancel stopped the run before every program it started could be listed. Keep the warning
   * and the runs, without a commit or tree, so this does not count as a finished check of the work.
   */
  private noteStopped(scope: RepositoryContext, runs: readonly CheckRun[], entries: CheckEntries): void {
    const { work: repository } = scope;
    if (!runs.length) return;
    if (runs.some((run) => run.cleanupIncomplete)) this.k.log(scope, "warn", CLEANUP_INCOMPLETE);
    repository.checks = { at: Date.now(), results: runs.map((run) => ({ ...run })) };
    const remaining = [...entries.values()];
    for (const run of runs) {
      const index = remaining.findIndex((check) => check.name === run.name);
      if (index < 0) continue;
      const [check] = remaining.splice(index, 1);
      check!.run = { ...run };
      if (!run.ok) check!.detail = checkDiagnostic(run.output);
    }
    this.k.commitNow();
  }

  /** A builder's answer cannot settle a failed check; only a fresh passing run can. */
  private settleFindings(scope: RepositoryContext, results: readonly CheckRun[]): readonly CheckRun[] {
    const { work: repository } = scope;
    const product = this.k.productOf(scope);
    const declared = new Set([
      ...(product && repository.worktree ? checksFor(product, repository.worktree) : []).map((check) => `Check failed: ${check.name} (${commandText(check.argv)})`),
      ...(product?.hooks?.includes("pre-commit") ? ["Check failed: Pre-commit hook (git hook run --ignore-missing pre-commit)"] : []),
      ...(product?.hooks?.includes("commit-msg") ? ["Check failed: Commit message hook (git hook run commit-msg)"] : []),
    ]);
    return this.repairs.settleFindings(scope, results, declared);
  }

  private recordFailedFindings(scope: RepositoryContext, failed: readonly CheckRun[]): void {
    this.repairs.recordFailedFindings(scope, failed);
  }

  /** The commands and hook inputs: a new definition needs a fresh run, even on the same tree. */
  private async definition(scope: RepositoryContext, checks: readonly ProductCheck[], hooks: Awaited<ReturnType<typeof git.commitHookFiles>>, sha?: string, capturedMessage?: string, setup = this.k.productOf(scope)?.checkSetup): Promise<{ definition: string; message?: string }> {
    const { work: repository } = scope;
    const hash = createHash("sha256").update(JSON.stringify(checks.filter((check) => check.argv.length).map((check) => check.argv)));
    const [bodies, message] = await Promise.all([
      Promise.all(hooks.map((hook) => readFile(hook.path))),
      hooks.some((hook) => hook.name === "commit-msg") ? capturedMessage ?? git.message(repository.worktree!, sha) : undefined,
    ]);
    for (const [index, hook] of hooks.entries()) {
      hash.update(JSON.stringify([hook.name, hook.path])).update(bodies[index]!);
      if (hook.name === "commit-msg") hash.update(message!);
      if (hook.name === "pre-commit") hash.update(repository.baseSha ?? "");
    }
    if (setup) hash.update(JSON.stringify(["local-check-setup", checkSetupContract(setup)]));
    return { definition: hash.digest("hex"), ...(message !== undefined ? { message } : {}) };
  }

  /** Reuse one observation within this operation, never as a persistent freshness flag. */
  private async captureState(scope: RepositoryContext, checks: readonly ProductCheck[]): Promise<CheckState> {
    const path = scope.work.worktree!, product = this.k.productOf(scope);
    const setup = product?.checkSetup && structuredClone(product.checkSetup);
    const contract = checkSetupContract(setup), invalidationId = scope.work.checkSetupInvalidated?.id;
    const requiredCommands = JSON.stringify((product ? checksFor(product, path) : checks).filter(check => check.argv.length).map(check => check.argv));
    const status = await git.worktreeStatus(path, false);
    const { tree, hooks: files } = await git.checkInputFiles(path, status.head);
    const hooks = await this.noteHooks(scope, files.map((hook) => hook.name));
    // The reusable tree and message must belong to the same observed commit.
    const definition = await this.definition(scope, checks, files, status.head, undefined, setup);
    return { sha: status.head, tree, trackedChanged: status.trackedChanged, hooks, ...definition, ...(setup ? { setup } : {}), contract, requiredCommands, ...(invalidationId ? { invalidationId } : {}) };
  }

  /** Restoration already confirmed HEAD/tracked contents. Only definitions and external hook inputs need another read. */
  private async captureFinalDefinition(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState, ranAnything = true): Promise<CheckState> {
    const product = this.k.productOf(scope), setup = product?.checkSetup && structuredClone(product.checkSetup);
    const contract = checkSetupContract(setup), invalidationId = scope.work.checkSetupInvalidated?.id;
    const requiredCommands = JSON.stringify((product ? checksFor(product, scope.work.worktree!) : checks).filter(check => check.argv.length).map(check => check.argv));
    if (!ranAnything && contract === state.contract && requiredCommands === state.requiredCommands && invalidationId === state.invalidationId) return state;
    const files = await git.commitHookFiles(scope.work.worktree!);
    const definition = await this.definition(scope, checks, files, state.sha, state.message, setup);
    return { ...state, ...definition, setup, contract, requiredCommands, invalidationId, hooks: files.map(file => file.name) };
  }

  private setupInput(_scope: RepositoryContext, state: CheckState): CheckSetupInput {
    return { ...(state.sha ? { sha: state.sha } : {}), ...(state.tree && !state.trackedChanged ? { tree: state.tree } : {}), definition: state.definition,
      contract: state.contract,
      ...(state.invalidationId ? { invalidationId: state.invalidationId } : {}) };
  }

  /** One live observation is scoped to this source, declaration, admission and cancellation owner. */
  private async observeSetup(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState, signal: AbortSignal,
    env: NodeJS.ProcessEnv, position: CheckSetupAttempt["position"], restore?: () => Promise<void>, ownsPlace: () => boolean = () => false): Promise<LiveSetup> {
    const { task, work } = scope;
    const input = this.setupInput(scope, state), invalidation = state.invalidationId;
    const declaration = state.setup;
    const requirements = declaration?.requirements ?? [];
    const commands = state.requiredCommands;
    const valid = () => {
      if (signal.aborted || this.k.stopped || work.checkSetupInvalidated?.id !== invalidation) return false;
      try {
        const product = this.k.productOf(scope);
        return checkSetupContract(product?.checkSetup) === input.contract
          && JSON.stringify((product ? checksFor(product, work.worktree!) : checks).filter(check => check.argv.length).map(check => check.argv)) === commands;
      } catch { return false; }
    };
    const admitted = () => ownsPlace() || !this.k.taskAdmissionsClosed(task) && !this.k.taskSourceRefreshDue(task);
    const assertAdmission = () => {
      if (signal.aborted || this.k.stopped) throw new Aborted();
      if (admitted()) return;
      if (this.k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
      throw new WaitingForUsage(this.k.taskAdmissionWait(task));
    };
    assertAdmission();
    const request = { id: this.k.id(task.id), productId: work.productId, queuedAt: Date.now(), position, input,
      requirements: requirements.map(requirement => ({ ...requirement, argv: [...requirement.argv] })) };
    const step = openStep(task);
    // Quiet reuse has no new execution step. Keep its actual later observation on the saved origin,
    // without changing the original execution's timestamps, inputs or environment binding.
    const history = step ?? (work.checks?.provenance ? task.journey?.find(node => node.id === work.checks!.provenance!.nodeId) : undefined);
    const attempt = await new CheckSetup({
      now: () => Date.now(),
      executor: () => {
        if (!valid()) return { kind: "unavailable", message: "The check inputs or admission changed before setup could be observed" };
        const observed = observeCheckExecutor();
        return observed.executor ? { kind: "observed", facts: observed.executor } : { kind: "unavailable", message: observed.executorError ?? "The local executor could not be observed" };
      },
      execute: async (requirement, stopped) => {
        if (!valid() || !admitted()) return { kind: "not-started", reason: stopped.aborted ? "cancelled" : !valid() ? "inputs-changed" : "admission-lost" };
        const runs = await runChecks(work.worktree!, [{ name: requirement.name, argv: [...requirement.argv] }], env,
          this.k.options.checkTimeoutMs, stopped, join(this.k.dataDir, "checks", task.id), undefined, undefined,
          this.machineRecords, undefined, undefined, () => valid() && admitted(), this.k.options.runCheckCommand);
        return runs[0] ? { kind: "recorded", run: runs[0] } : { kind: "not-started", reason: stopped.aborted ? "cancelled" : "admission-lost" };
      },
      finish: async (_attempt, activity) => {
        if (activity === "none") return { afterInput: { ...input, ...(valid() ? {} : { contract: checkSetupContract(this.k.productOf(scope)?.checkSetup) }), trackedChanged: state.trackedChanged }, restoration: "unchanged" };
        const product = this.k.productOf(scope);
        let observed: CheckState | undefined;
        const errors: unknown[] = [];
        try { observed = await this.captureState(scope, product ? checksFor(product, work.worktree!) : checks); }
        catch (error) { errors.push(error); }
        // Potentially started probes must restore even when their input read failed. Preserve both causes in order.
        const needsRestore = !observed || observed.trackedChanged || observed.sha !== state.sha;
        try { if (needsRestore && restore) await restore(); }
        catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, "Setup inputs and restoration could not both be confirmed");
        const changed = observed!.trackedChanged || observed!.sha !== state.sha;
        return { afterInput: { ...this.setupInput(scope, observed!), trackedChanged: changed }, restoration: changed ? "restored" : "unchanged" };
      },
      identity: attempt => deriveCheckEnvironmentIdentity(attempt),
      changed: snapshot => {
        work.checkSetup = structuredClone(snapshot) as DeepMutable<CheckSetupAttempt>;
        if (!signal.aborted && !this.k.stopped && step?.id === openStep(task)?.id) {
          task.statusLine = snapshot.lifecycle === "running" ? snapshot.runningRequirementId
            ? `Checking local setup: ${snapshot.requirements.find(requirement => requirement.id === snapshot.runningRequirementId)?.name ?? "a requirement"}`
            : "Checking local setup" : checkSetupWords(checkSetupOutcome(snapshot));
        }
        if (history) {
          const prior = history.checkSetups ?? [];
          history.checkSetups = [...prior.filter(value => value.id !== snapshot.id), structuredClone(snapshot)] as DeepMutable<CheckSetupAttempt[]>;
        }
        this.k.commit();
      },
    }).observe(request, signal);
    if (!admitted()) {
      // A scheduling closure is transient, not an unavailable executor. Preserve raw progress and mark its lifecycle honestly.
      const stopped = { ...attempt, lifecycle: "stopped" as const, identity: undefined };
      work.checkSetup = structuredClone(stopped) as DeepMutable<CheckSetupAttempt>;
      if (history) history.checkSetups = (history.checkSetups ?? []).map(value => value.id === stopped.id ? structuredClone(stopped) : value) as DeepMutable<CheckSetupAttempt[]>;
      this.k.commit();
      assertAdmission();
    }
    return { attempt, outcome: checkSetupOutcome(attempt), valid, forceFresh: invalidation !== undefined };
  }

  private setupBlocked(scope: RepositoryContext, live: LiveSetup, reason: Extract<CheckVerification, { kind: "blocked" }>["reason"] = "setup"): CheckVerification {
    return this.evidence.blocked(scope, live, reason);
  }

  private matchesEnvironment(scope: RepositoryContext, live: LiveSetup, rows: readonly CheckRun[] | undefined = scope.work.checks?.results): boolean {
    return this.evidence.matchesEnvironment(scope, live, rows);
  }


  /** Capture a candidate's own definition, never borrow one from its later checks. */
  async repairVersion(scope: RepositoryContext): Promise<(Pick<CheckState, "sha" | "tree" | "definition"> & { commands: string[] }) | undefined> {
    if (!scope.work.worktree) return;
    const product = this.k.productOf(scope);
    const checks = product ? checksFor(product, scope.work.worktree) : [];
    const state = await this.captureState(scope, checks);
    return state.trackedChanged ? undefined : { sha: state.sha, tree: state.tree, definition: state.definition, commands: checks.filter((check) => check.argv.length).map((check) => commandText(check.argv)) };
  }

  /** Whether the last run used the same code and definitions. A squash keeps its evidence, pass or fail. */
  private async ranOn(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState): Promise<boolean> {
    const saved = scope.work.checks;
    if (!saved || !Array.isArray(saved.results) || saved.results.some(run => !run)) return false;
    const staticFailed = checks.some(check => staticCheck(check) && saved.results.some(run => !run.ok && run.command === commandText(check.argv)));
    return this.evidence.applies(scope, state, {
      commands: orderedChecks(checks).map(check => commandText(check.argv)), hooks: state.hooks,
      expected: [...expectedCheckCommands(checks, saved.results), ...(!staticFailed ? state.hooks.map(hook => hook === "pre-commit" ? "git hook run --ignore-missing pre-commit" : "git hook run commit-msg") : [])],
    });
  }

  /** Recorded applicability only: reads never sample an executor, execute a probe or mint live authority. */
  async current(scope: RepositoryContext): Promise<RecordedChecksApplicability> {
    const product = this.k.productOf(scope), work = scope.work;
    const batch = recordedCheckBatch(work);
    if (!work.worktree) return { inputs: { kind: "unknown", reason: "source" }, batch };
    const state = await this.captureState(scope, product ? checksFor(product, work.worktree) : []);
    return { inputs: state.trackedChanged ? { kind: "changed", reason: "code" } : checkInputApplicability(work.checks, this.setupInput(scope, state)), batch };
  }

  /** Revalidating opaque or older hooks must not retry product checks with unchanged code and commands. */
  private async savedProductResults(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState, live: LiveSetup): Promise<readonly CheckRun[] | undefined> {
    return this.evidence.retainedProductResults(scope, state, live, { hooks: state.hooks, commands: orderedChecks(checks).map(check => commandText(check.argv)), expected: [] });
  }

  /**
   * Right before the delivery check: the checks run again when the code changed since they last ran.
   * A failure sends the work back to the builder while its failure episode has returns left; after that the
   * coordinator sees it. Exhausted returns are a failure, never permission to start final acceptance.
   */
  checksBeforeDelivery(scope: RepositoryContext, signal: AbortSignal, prepare?: CheckPreparation): Promise<"passed" | "returned" | "exhausted" | "blocked"> {
    return this.delivery.beforeDelivery(scope, signal, prepare);
  }

  /** Final verification has its own live observation; no earlier acceptance authority is borrowed. */
  checksBeforeShipping(scope: RepositoryContext, signal: AbortSignal, prepare?: CheckPreparation): Promise<"passed" | "returned" | "blocked"> {
    return this.delivery.beforeShipping(scope, signal, prepare);
  }

  /**
   * Reuse a completed run, including failures, until the code or check definition changes. A reuse is recorded
   * on the step that ran the original, with its basis, so the evidence survives restarts and later runs.
   */
  async failing(scope: RepositoryContext, signal: AbortSignal, checks?: readonly ProductCheck[], purpose: JourneyCheckReuse["purpose"] = "acceptance", prepare?: CheckPreparation): Promise<CheckVerification> {
    return this.evidence.verify(scope, {
      verify: current => this.verifyOnce(scope, signal, current, purpose, prepare),
      check: () => { if (signal.aborted || this.k.stopped) throw new Aborted(); },
      currentChecks: previous => { const product = this.k.productOf(scope); return product ? checksFor(product, scope.work.worktree!) : previous ?? []; },
    }, checks);
  }

  private async verifyOnce(scope: RepositoryContext, signal: AbortSignal, checks?: readonly ProductCheck[], purpose: JourneyCheckReuse["purpose"] = "acceptance", prepare?: CheckPreparation): Promise<CheckVerification> {
    const product = this.k.productOf(scope);
    checks ??= product && scope.work.worktree ? checksFor(product, scope.work.worktree) : [];
    const required = checks;
    return this.evidence.attempt(scope, signal, purpose, {
      capture: () => this.captureState(scope, required),
      setupContract: () => checkSetupContract(product?.checkSetup),
      setupRequired: () => !!product?.checkSetup?.requirements.length,
      applies: state => this.ranOn(scope, required, state),
      observe: async state => {
        const env = { ...withoutCredentials(process.env, await this.k.emptyGhConfig()), CI: "1", BROWSER: "none", PETRINA_AGENT: "1" };
        return this.observeSetup(scope, required, state, signal, env, "before-checks");
      },
      execute: state => this.runProductChecks(scope, required, signal, undefined, state, prepare, purpose),
    });
  }

  private retainIncomplete(scope: RepositoryContext, state: CheckState, purpose: JourneyCheckReuse["purpose"], live: LiveSetup): CheckVerification {
    return this.evidence.retainIncomplete(scope, state, purpose, live);
  }

  private reuse(scope: RepositoryContext, state: CheckState, purpose: JourneyCheckReuse["purpose"], live: LiveSetup, signal: AbortSignal): Promise<CheckVerification> {
    return this.evidence.reuse(scope, state, purpose, live, signal);
  }

  private async refreshInterruptions(scope: RepositoryContext, signal: AbortSignal): Promise<void> {
    const saved = scope.work.checks!;
    let records: string | undefined;
    for (const run of saved.results) if (!run.ok && !run.interruption && !run.interrupted) {
      const original = originalCheck(scope.task, run)?.check;
      const start = run.startedAt ?? original?.startedAt, end = run.endedAt ?? original?.endedAt;
      if (start === undefined || end === undefined) continue;
      // All these executions have finished. One log snapshot covers the whole saved batch.
      records ??= await readMachineRecords(this.machineRecords, signal);
      if (signal.aborted || this.k.stopped) throw new Aborted();
      const interruption = powerInterruption(start, end, records);
      if (interruption) { run.interruption = interruption; if (original?.run) original.run.interruption = interruption; }
    }
  }

  /** The repository's commit hooks, as git would run them now, noted on the product for the builder's instructions. */
  async noteHooks(scope: RepositoryContext, observed?: string[]): Promise<string[]> {
    const { work: repository } = scope;
    const hooks = observed ?? await git.commitHooks(repository.worktree!);
    const product = this.k.productOf(scope);
    if (product && (product.hooks ?? []).join() !== hooks.join()) {
      if (hooks.length) product.hooks = hooks;
      else delete product.hooks;
    }
    return hooks;
  }

  /**
   * The repository's own commit hooks, run the way git runs them right before committing the task's whole
   * change: pre-commit with the change staged on top of where the task started, and commit-msg on the task's
   * commit message. Petrina's own git steps never run hooks; these run like the product's checks, with no logins.
   */
  private async runHooks(scope: RepositoryContext, hooks: readonly string[], head: string, message: string | undefined, env: NodeJS.ProcessEnv, signal: AbortSignal, progress: (id: string, event: CheckProgress) => void, beforeStart?: () => boolean): Promise<CheckRun[]> {
    const { task, work: repository } = scope;
    const worktree = repository.worktree!;
    const base = repository.baseSha;
    const branch = repository.branch;
    if (!hooks.length || !base || !branch || head === base) return [];
    const runs: CheckRun[] = [];
    if (hooks.includes("pre-commit")) {
      // On disk before HEAD moves: a restart while it is detached puts it back on the branch.
      repository.hooking = true;
      this.k.commitNow();
      await git.detachAt(worktree, base);
      try {
        runs.push(...(await runChecks(worktree, [{ name: "Pre-commit hook", argv: ["git", "hook", "run", "--ignore-missing", "pre-commit"] }], env, this.k.options.checkTimeoutMs, signal, join(this.k.dataDir, "checks", task.id), undefined, (event) => progress("hook-pre-commit", event), this.machineRecords, undefined, undefined, beforeStart)));
      } finally {
        await git.reattach(worktree, branch);
        delete repository.hooking;
        this.k.commit();
      }
    }
    if (hooks.includes("commit-msg") && !signal.aborted) {
      // The exact message fingerprinted before checks, as Git hands it over.
      if (message === undefined) throw new Error("The check run has no captured commit message. Capture its inputs again before running commit hooks.");
      const parent = join(this.k.dataDir, "checks", task.id);
      await mkdir(parent, { recursive: true });
      const folder = await mkdtemp(join(parent, "message-"));
      try {
        const file = join(folder, "COMMIT_EDITMSG");
        await writeFile(file, `${message}\n`);
        const [run] = await runChecks(worktree, [{ name: "Commit message hook", argv: ["git", "hook", "run", "--ignore-missing", "commit-msg", "--", file] }], env, this.k.options.checkTimeoutMs, signal, join(this.k.dataDir, "checks", task.id), undefined, (event) => progress("hook-commit-msg", event), this.machineRecords, undefined, undefined, beforeStart);
        if (run) runs.push({ ...run, command: "git hook run commit-msg" });
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    }
    // The caller keeps a stopped run that could not list its programs. Throwing here would drop it.
    return runs;
  }

  async acceptanceVersion(scope: RepositoryContext, versions?: Record<string, string>): Promise<string | undefined> {
    const { task, work: repository } = scope;
    if (task.repositories) return acceptanceVersion(task, versions);
    const base = repository.baseSha ?? repository.base;
    return repository.worktree && base ? git.patchId(repository.worktree, (await git.mergeBase(repository.worktree, "HEAD", base)) ?? base, "HEAD") : undefined;
  }


  backToBuilder(scope: RepositoryContext, when: string, eligibleProducts: ReadonlySet<Id>): boolean {
    return this.repairs.backToBuilder(scope, when, eligibleProducts);
  }

  /**
   * The automatic returns of this failure episode are used up. The task waits at the step these checks guard
   * (a pending review round keeps its number), and the coordinator gets a check problem: asking for changes
   * gives the Builder one more turn. Approval is refused; an explicit rerun keeps the same repair allowance.
   */
  blocked(task: RuntimeTask): "stop" { return this.decision.blocked(task); }
  private checkProblem(task: RuntimeTask) { return this.decision.problem(task); }
  rerun(task: RuntimeTask): void { this.decision.rerun(task); }

}

