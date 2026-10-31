// The product's checks, run by Petrina itself: the Check finder works out the commands, and failing
// checks become findings with the real output. Running commands is in checks.ts.

import {
  checkActivityLine, checkInputApplicability, openStep, recordedCheckBatch,
  type CheckActivity, type CheckRun, type CheckRunReason, type CheckSetupInput, type DeepMutable,
  type Id, type JourneyCheckReuse, type ProductCheck,
} from "@petrina/core";
import {
  CheckDecision, CheckDelivery, CheckEvidence, CheckRepairs, type CheckVerification, type RepositoryContext,
} from "@petrina/orchestrator";
import { checkSetupContract } from "@petrina/repositories/check-environment";
import * as git from "@petrina/repositories/git";
import { checkRunReasonFor, sameActivity } from "./check-activity.js";
import { checksFor, commandText, orderedChecks, staticCheck } from "./checks.js";
import type { Context } from "./context.js";
import { Aborted, type Kernel, type RuntimeTask } from "./kernel.js";
import {
  acquireCheckTurnToRun, cachedProductChecks, computeAcceptanceVersion, ensureProductChecks, executeAllChecks,
  executePreparedChecks, noteRepositoryHooks, refreshCheckInterruptions, restoreCheckEvidence, type CheckBatchHooks,
  type ExecuteAllChecksRequest,
} from "./product-check-execution.js";
import {
  buildCheckSetupInput, captureCheckState, checkExecutionEnvironment, CheckPreparationChanged, computeCheckDefinition,
  expectedCommandsWithHooks, observeProductCheckSetup, type CheckPreparation, type CheckState,
  type LiveSetup, type ObserveCheckSetupRequest, type RecordedChecksApplicability,
} from "./product-check-setup.js";
import type { Turns } from "./turn.js";
import { WaitingForUsage } from "./usage.js";

export type { CheckVerification } from "@petrina/orchestrator";
export { CheckPreparationChanged, type CheckPreparation, type RecordedChecksApplicability };

export class ProductChecks {
  private readonly preparations = new Set<Id>();
  private readonly decisionReleases = new Map<Id, () => boolean>();
  readonly deliveryOrders = new Map<Id, number>();

  private readonly decision: CheckDecision;
  private readonly delivery: CheckDelivery<CheckPreparation>;
  private readonly repairs: CheckRepairs;
  private readonly evidence: CheckEvidence;

  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context) {
    this.decision = new CheckDecision({
      state: () => k.s,
      role: (id, task) => k.role(id, task),
      productName: (scope) => k.productOf(scope)?.name ?? scope.work.productId,
      id: (task) => k.id(task.id),
      now: Date.now,
      log: (scope, tone, text) => k.log(scope, tone, text),
      gate: (task, problem) => k.gate(task, "delivery", undefined, problem),
    });
    this.delivery = new CheckDelivery({
      failing: (scope, signal, purpose, prepare) => this.failing(scope, signal, undefined, purpose, prepare),
      preparationChanged: (error) => error instanceof CheckPreparationChanged,
      backToBuilder: (scope, when, products) => this.backToBuilder(scope, when, products),
      blocked: (task) => this.blocked(task),
    });
    this.evidence = new CheckEvidence({
      now: Date.now,
      changed: () => k.commit(),
      log: (scope, tone, text) => k.log(scope, tone, text),
      deliveryRole: (scope) => k.role(openStep(scope.task)?.roleId ?? "")?.result === "delivery",
      check: (signal) => { if (signal.aborted || k.stopped) throw new Aborted(); },
      refreshInterruptions: (scope, signal) => this.refreshInterruptions(scope, signal),
      recordFailedFindings: (scope, results) => this.recordFailedFindings(scope, results),
      settleFindings: (scope, results) => this.settleFindings(scope, results),
      closeEpisode: (scope, state, valid) => this.repairs.closeEpisode(scope, state, valid),
    });
    this.repairs = new CheckRepairs({
      role: (id, task) => k.role(id, task),
      id: (task) => k.id(task.id),
      log: (scope, tone, text) => k.log(scope, tone, text),
      changed: () => k.commit(),
      commitNow: (task) => k.commitNow(task),
      checkpoint: () => k.commitNow(),
      definition: async (scope, sha) => {
        const product = k.productOf(scope);
        const worktree = scope.work.worktree!;
        return (await computeCheckDefinition(k, scope, product ? checksFor(product, worktree) : [], await git.commitHookFiles(worktree), sha)).definition;
      },
    });
  }

  private batchHooks(): CheckBatchHooks {
    return {
      k: this.k,
      evidence: this.evidence,
      preparations: this.preparations,
      decisionReleases: this.decisionReleases,
      deliveryOrders: this.deliveryOrders,
      claimPreparation: (taskId) => this.claimPreparation(taskId),
      releasePreparation: (taskId) => this.releasePreparation(taskId),
      turnToRun: (scope, signal, order, since) => this.turnToRun(scope, signal, order, since),
      showActivity: (task, activity, changed) => this.showActivity(task, activity, changed),
      showPreparing: (task, productId) => this.showPreparing(task, productId),
      reasonFor: (scope, checks, state, purpose) => checkRunReasonFor(scope, checks, state, purpose),
      cachedChecks: (scope) => this.cachedChecks(scope),
      ensureChecks: (scope, signal) => this.ensureChecks(scope, signal),
      captureState: (scope, checks) => this.captureState(scope, checks),
      observeSetup: (request) => this.observeSetup(request),
      ranOn: (scope, checks, state) => this.ranOn(scope, checks, state),
      savedProductResults: (scope, checks, state, live) => this.savedProductResults(scope, checks, state, live),
      runAll: (request) => this.runAll(request),
    };
  }

  restoreEvidence(): Promise<void> {
    return restoreCheckEvidence(this.k, (scope, results) => this.settleFindings(scope, results), (task) => this.checkProblem(task));
  }

  get preparingCount(): number { return this.preparations.size; }
  canPrepare(taskId: Id): boolean { return this.preparations.has(taskId) || this.preparations.size < Math.max(1, this.k.s.pool.limit); }

  claimPreparation(taskId: Id): boolean {
    if (this.k.taskAdmissionsClosed(taskId) || !this.canPrepare(taskId)) return false;
    this.preparations.add(taskId);
    return true;
  }

  releasePreparation(taskId: Id): void { this.preparations.delete(taskId); }

  releaseForDecision(taskId: Id): boolean {
    const preparation = this.preparations.delete(taskId);
    const checks = this.decisionReleases.get(taskId)?.() ?? false;
    const task = this.k.task(taskId);
    if ((preparation || checks) && task) this.clearActivity(task);
    return preparation || checks;
  }

  /**
   * The task's check fact and the main line it says, saved only when either changed. Written from the check line
   * and this run's own progress; nothing reads it to decide admission or order.
   */
  showActivity(task: RuntimeTask, activity: CheckActivity, changed = false): void {
    const line = checkActivityLine(activity);
    if (!changed && sameActivity(task.checkActivity, activity) && task.statusLine === line) return;
    task.checkActivity = activity as DeepMutable<CheckActivity>;
    task.statusLine = line;
    this.k.commit(task);
  }

  /** The run ended, left the line or never started: no check fact outlives it. */
  clearActivity(task: RuntimeTask): void {
    if (!task.checkActivity) return;
    delete task.checkActivity;
    this.k.commit(task);
  }

  /** Getting the work ready for its checks, before it joins the line. */
  showPreparing(task: RuntimeTask, productId?: Id): void {
    if (task.checkActivity?.phase === "preparing" && task.checkActivity.productId === productId) return;
    this.showActivity(task, {
      phase: "preparing",
      ...(productId ? { productId } : {}),
      since: Date.now(),
      slots: this.k.checkQueue.view().limit,
    });
  }

  private turnToRun(scope: RepositoryContext, signal: AbortSignal, order = this.k.checkQueue.reserveOrder(), since = Date.now()) {
    return acquireCheckTurnToRun(
      this.k,
      scope,
      signal,
      order,
      since,
      (task, activity, changed) => this.showActivity(task, activity, changed),
      (task) => this.clearActivity(task),
    );
  }

  ensureChecks(scope: RepositoryContext, signal: AbortSignal): Promise<readonly ProductCheck[]> {
    return ensureProductChecks(this.k, this.turns, this.context, scope, signal);
  }

  private cachedChecks(scope: RepositoryContext): readonly ProductCheck[] | undefined {
    return cachedProductChecks(this.k, scope);
  }

  async runProductChecks(
    scope: RepositoryContext,
    checks: readonly ProductCheck[],
    signal: AbortSignal,
    kept?: readonly CheckRun[],
    prepared?: CheckState,
    prepare?: CheckPreparation,
    purpose: JourneyCheckReuse["purpose"] = "acceptance",
    reason?: CheckRunReason,
  ): Promise<CheckVerification> {
    const { task, work: repository } = scope;
    if (!repository.worktree) return {
      kind: "blocked",
      productId: repository.productId,
      results: repository.checks?.results ?? [],
      reason: "inputs-changed",
      setup: { kind: "unobserved" }
    };
    if (!this.k.runs.has(task.id) && !this.k.helperRuns.get(task.id)?.size) {
      task.holdsSlot = false;
      delete task.agent;
    }
    if (!this.claimPreparation(task.id)) {
      this.clearActivity(task);
      throw new WaitingForUsage(this.k.taskAdmissionsClosed(task) ? this.k.taskAdmissionWait(task) : "Waiting for room to prepare the product checks");
    }
    this.showPreparing(task, repository.productId);
    this.k.schedule();
    try {
      return await this.runPreparedChecks(scope, checks, signal, kept, prepared, prepare, purpose, reason);
    } finally {
      this.releasePreparation(task.id);
      this.clearActivity(task);
    }
  }

  private runPreparedChecks(
    scope: RepositoryContext,
    checks: readonly ProductCheck[],
    signal: AbortSignal,
    kept?: readonly CheckRun[],
    prepared?: CheckState,
    prepare?: CheckPreparation,
    purpose: JourneyCheckReuse["purpose"] = "acceptance",
    reason?: CheckRunReason,
  ): Promise<CheckVerification> {
    return executePreparedChecks(this.batchHooks(), scope, checks, signal, kept, prepared, prepare, purpose, reason);
  }

  private runAll(request: ExecuteAllChecksRequest): Promise<CheckVerification> {
    return executeAllChecks(this.batchHooks(), request);
  }

  private settleFindings(scope: RepositoryContext, results: readonly CheckRun[]): readonly CheckRun[] {
    const { work: repository } = scope;
    const product = this.k.productOf(scope);
    const declared = new Set([
      ...(product && repository.worktree ? checksFor(product, repository.worktree) : []).map((c) => `Check failed: ${c.name} (${commandText(c.argv)})`),
      ...(product?.hooks?.includes("pre-commit") ? ["Check failed: Pre-commit hook (git hook run --ignore-missing pre-commit)"] : []),
      ...(product?.hooks?.includes("commit-msg") ? ["Check failed: Commit message hook (git hook run commit-msg)"] : []),
    ]);
    return this.repairs.settleFindings(scope, results, declared);
  }

  private recordFailedFindings(scope: RepositoryContext, failed: readonly CheckRun[]): void {
    this.repairs.recordFailedFindings(scope, failed);
  }

  private captureState(scope: RepositoryContext, checks: readonly ProductCheck[]): Promise<CheckState> {
    return captureCheckState(this.k, (s, observed) => this.noteHooks(s, observed), scope, checks);
  }

  private setupInput(_scope: RepositoryContext, state: CheckState): CheckSetupInput {
    return buildCheckSetupInput(state);
  }

  private observeSetup(request: ObserveCheckSetupRequest): Promise<LiveSetup> {
    return observeProductCheckSetup(this.k, (s, c) => this.captureState(s, c), request);
  }

  async repairVersion(scope: RepositoryContext): Promise<(Pick<CheckState, "sha" | "tree" | "definition"> & { commands: string[] }) | undefined> {
    if (!scope.work.worktree) return;
    const product = this.k.productOf(scope);
    const checks = product ? checksFor(product, scope.work.worktree) : [];
    const state = await this.captureState(scope, checks);
    return state.trackedChanged ? undefined : {
      sha: state.sha, tree: state.tree, definition: state.definition,
      commands: checks.filter((c) => c.argv.length).map((c) => commandText(c.argv)),
    };
  }

  private async ranOn(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState): Promise<boolean> {
    const saved = scope.work.checks;
    if (!saved || !Array.isArray(saved.results) || saved.results.some((run) => !run)) return false;
    const staticFailed = checks.some((c) => staticCheck(c) && saved.results.some((r) => !r.ok && r.command === commandText(c.argv)));
    return this.evidence.applies(scope, state, {
      commands: orderedChecks(checks).map((c) => commandText(c.argv)),
      hooks: state.hooks,
      expected: expectedCommandsWithHooks(checks, saved.results, state.hooks, staticFailed),
    });
  }

  async current(scope: RepositoryContext): Promise<RecordedChecksApplicability> {
    const product = this.k.productOf(scope);
    const work = scope.work;
    const batch = recordedCheckBatch(work);
    if (!work.worktree) return { inputs: { kind: "unknown", reason: "source" }, batch };
    const state = await this.captureState(scope, product ? checksFor(product, work.worktree) : []);
    return {
      inputs: state.trackedChanged ? { kind: "changed", reason: "code" } : checkInputApplicability(work.checks, this.setupInput(scope, state)),
      batch,
    };
  }

  private async savedProductResults(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState, live: LiveSetup): Promise<readonly CheckRun[] | undefined> {
    return this.evidence.retainedProductResults(scope, state, live, {
      hooks: state.hooks,
      commands: orderedChecks(checks).map((c) => commandText(c.argv)),
      expected: [],
    });
  }

  checksBeforeDelivery(scope: RepositoryContext, signal: AbortSignal, prepare?: CheckPreparation) {
    return this.delivery.beforeDelivery(scope, signal, prepare);
  }

  checksBeforeShipping(scope: RepositoryContext, signal: AbortSignal, prepare?: CheckPreparation) {
    return this.delivery.beforeShipping(scope, signal, prepare);
  }

  async failing(
    scope: RepositoryContext,
    signal: AbortSignal,
    checks?: readonly ProductCheck[],
    purpose: JourneyCheckReuse["purpose"] = "acceptance",
    prepare?: CheckPreparation,
  ): Promise<CheckVerification> {
    return this.evidence.verify(scope, {
      verify: (current) => this.verifyOnce(scope, signal, current, purpose, prepare),
      check: () => { if (signal.aborted || this.k.stopped) throw new Aborted(); },
      currentChecks: (previous) => {
        const product = this.k.productOf(scope);
        return product ? checksFor(product, scope.work.worktree!) : (previous ?? []);
      },
    }, checks);
  }

  private async verifyOnce(
    scope: RepositoryContext,
    signal: AbortSignal,
    checks?: readonly ProductCheck[],
    purpose: JourneyCheckReuse["purpose"] = "acceptance",
    prepare?: CheckPreparation,
  ): Promise<CheckVerification> {
    const product = this.k.productOf(scope);
    const required = checks ?? (product && scope.work.worktree ? checksFor(product, scope.work.worktree) : []);
    return this.evidence.attempt(scope, signal, purpose, {
      capture: () => this.captureState(scope, required),
      setupContract: () => checkSetupContract(product?.checkSetup),
      setupRequired: () => Boolean(product?.checkSetup?.requirements.length),
      applies: (state) => this.ranOn(scope, required, state),
      observe: async (state) => this.observeSetup({
        scope,
        checks: required,
        state,
        signal,
        env: await checkExecutionEnvironment(this.k),
        position: "before-checks",
      }),
      execute: (state) =>
        this.runProductChecks(
          scope,
          required,
          signal,
          undefined,
          state,
          prepare,
          purpose,
          checkRunReasonFor(scope, required, state, purpose),
        ),
    });
  }

  private refreshInterruptions(scope: RepositoryContext, signal: AbortSignal): Promise<void> {
    return refreshCheckInterruptions(this.k, scope, signal);
  }

  noteHooks(scope: RepositoryContext, observed?: string[]): Promise<string[]> {
    return noteRepositoryHooks(this.k, scope, observed);
  }

  acceptanceVersion(scope: RepositoryContext, versions?: Record<string, string>): Promise<string | undefined> {
    return computeAcceptanceVersion(scope, versions);
  }

  backToBuilder(scope: RepositoryContext, when: string, eligibleProducts: ReadonlySet<Id>): boolean {
    return this.repairs.backToBuilder(scope, when, eligibleProducts);
  }

  blocked(task: RuntimeTask): "stop" { return this.decision.blocked(task); }
  private checkProblem(task: RuntimeTask) { return this.decision.problem(task); }
  rerun(task: RuntimeTask): void { this.decision.rerun(task); }
}
