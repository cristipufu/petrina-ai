import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  beginPetrinaStep, checkOutcome, checkResult, endPetrinaStep,
  openStep, runtimeWaitHolds, type CheckAttemptEvidence, type CheckRun,
  type DeepMutable, type Id, type JourneyCheckReuse, type JourneyProductCheck, type ProductCheck,
} from "@petrina/core";
import {
  checkDiagnostic, type CheckEvidence, type CheckVerification, type RepositoryContext,
} from "@petrina/orchestrator";
import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";
import * as git from "@petrina/repositories/git";
import {
  checksFor, commandText, orderedChecks, runCheckBatch, staticCheck, type CheckProgress,
} from "./checks.js";
import { Aborted, SourceRefreshRequired, type Kernel } from "./kernel.js";
import {
  acquireCheckTurnToRun,
  cachedProductChecks,
  ensureProductChecks,
  refreshCheckInterruptions,
  restoreCheckEvidence,
} from "./product-check-discovery.js";
import {
  captureFinalCheckDefinition, checkExecutionEnvironment, CheckPreparationChanged, expectedCommandsWithHooks,
  machineRecordsOf, nothingToRun, restoreCheckWorktree, type CheckEntries, type CheckPreparation, type CheckState,
  type LiveSetup, type ObserveCheckSetupRequest,
} from "./product-check-setup.js";
import { namedCheckFailures } from "./related-check-evidence.js";
import { acceptanceVersion } from "./repositories.js";
import { WaitingForUsage } from "./usage.js";

export {
  acquireCheckTurnToRun,
  cachedProductChecks,
  ensureProductChecks,
  refreshCheckInterruptions,
  restoreCheckEvidence,
};

export function noteStoppedCheckRun(k: Kernel, scope: RepositoryContext, runs: readonly CheckRun[], entries: CheckEntries): void {
  const { work: repository } = scope;
  if (!runs.length) return;
  if (runs.some((run) => run.cleanupIncomplete)) k.log(scope, "warn", CLEANUP_INCOMPLETE);
  repository.checks = { at: Date.now(), results: runs.map((run) => ({ ...run })) };
  const remaining = [...entries.values()];
  for (const run of runs) {
    const index = remaining.findIndex((check) => check.name === run.name);
    if (index < 0) continue;
    const [check] = remaining.splice(index, 1);
    check!.run = { ...run };
    if (!run.ok) check!.detail = checkDiagnostic(run.output);
  }
  k.commitNow();
}

export async function noteRepositoryHooks(k: Kernel, scope: RepositoryContext, observed?: string[]): Promise<string[]> {
  const hooks = observed ?? (await git.commitHooks(scope.work.worktree!));
  const product = k.productOf(scope);
  if (product && (product.hooks ?? []).join() !== hooks.join()) {
    if (hooks.length) product.hooks = hooks;
    else delete product.hooks;
  }
  return hooks;
}

export async function runRepositoryCommitHooks(
  k: Kernel,
  scope: RepositoryContext,
  hooks: readonly string[],
  head: string,
  message: string | undefined,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  progress: (id: string, event: CheckProgress) => void,
  beforeStart?: () => boolean,
): Promise<CheckRun[]> {
  const { task, work: repository } = scope;
  const worktree = repository.worktree!;
  const base = repository.baseSha;
  const branch = repository.branch;
  if (!hooks.length || !base || !branch || head === base) return [];
  const runs: CheckRun[] = [];
  if (hooks.includes("pre-commit")) {
    repository.hooking = true;
    k.commitNow();
    await git.detachAt(worktree, base);
    try {
      runs.push(...(await runCheckBatch({
        cwd: worktree,
        checks: [{ name: "Pre-commit hook", argv: ["git", "hook", "run", "--ignore-missing", "pre-commit"] }],
        env,
        timeoutMs: k.options.checkTimeoutMs,
        signal,
        logDirectory: join(k.dataDir, "checks", task.id),
        onProgress: (event) => progress("hook-pre-commit", event),
        machineRecords: machineRecordsOf(k),
        beforeStart,
      })));
    } finally {
      await git.reattach(worktree, branch);
      delete repository.hooking;
      k.commit();
    }
  }
  if (hooks.includes("commit-msg") && !signal.aborted) {
    if (message === undefined) throw new Error("The check run has no captured commit message. Capture its inputs again before running commit hooks.");
    const parent = join(k.dataDir, "checks", task.id);
    await mkdir(parent, { recursive: true });
    const folder = await mkdtemp(join(parent, "message-"));
    try {
      const file = join(folder, "COMMIT_EDITMSG");
      await writeFile(file, `${message}\n`);
      const [run] = await runCheckBatch({
        cwd: worktree,
        checks: [{ name: "Commit message hook", argv: ["git", "hook", "run", "--ignore-missing", "commit-msg", "--", file] }],
        env,
        timeoutMs: k.options.checkTimeoutMs,
        signal,
        logDirectory: join(k.dataDir, "checks", task.id),
        onProgress: (event) => progress("hook-commit-msg", event),
        machineRecords: machineRecordsOf(k),
        beforeStart,
      });
      if (run) runs.push({ ...run, command: "git hook run commit-msg" });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  return runs;
}

export async function computeAcceptanceVersion(scope: RepositoryContext, versions?: Record<string, string>): Promise<string | undefined> {
  const { task, work: repository } = scope;
  if (task.repositories) return acceptanceVersion(task, versions);
  const base = repository.baseSha ?? repository.base;
  return repository.worktree && base
    ? git.patchId(repository.worktree, (await git.mergeBase(repository.worktree, "HEAD", base)) ?? base, "HEAD")
    : undefined;
}

export function syncPreparedCheckEntries(
  entries: CheckEntries,
  checks: readonly ProductCheck[],
  hooks: readonly string[],
  attempt: { attemptId: string; queuedAt: number; productId: Id },
  prefix: string,
  step: ReturnType<typeof openStep>,
): void {
  const declared = new Map(checks.filter((check) => check.argv.length).map((check, index) => [`check-${index}`, check.name]));
  for (const [id, entry] of entries) if (id.startsWith("check-")) {
    if (declared.has(id)) {
      entry.name = declared.get(id)!;
      entry.result = "pending";
    }
    else entry.result = "skipped";
  }
  for (const [id, name] of declared) if (!entries.has(id)) {
    const entry: DeepMutable<JourneyProductCheck> = { ...attempt, id: `${prefix}${id}`, name, result: "pending" };
    entries.set(id, entry);
    if (step) step.productChecks = [...(step.productChecks ?? []), entry];
  }
  for (const [id, entry] of entries) if (id.startsWith("hook-") && !hooks.includes(id.slice(5))) entry.result = "skipped";
  for (const hook of hooks) if (!entries.has(`hook-${hook}`)) {
    const entry: DeepMutable<JourneyProductCheck> = {
      ...attempt, id: `${prefix}hook-${hook}`, name: hook === "pre-commit" ? "Pre-commit hook" : "Commit message hook", result: "pending",
    };
    entries.set(`hook-${hook}`, entry);
    if (step) step.productChecks = [...(step.productChecks ?? []), entry];
  }
}

export interface ExecuteAllChecksRequest {
  scope: RepositoryContext;
  checks: readonly ProductCheck[];
  state: CheckState;
  signal: AbortSignal;
  entries: CheckEntries;
  kept?: readonly CheckRun[];
  attemptId?: string;
  purpose?: JourneyCheckReuse["purpose"];
  ownsPlace?: () => boolean;
}

export interface CheckBatchHooks {
  k: Kernel;
  evidence: CheckEvidence;
  preparations: Set<Id>;
  decisionReleases: Map<Id, () => boolean>;
  deliveryOrders: Map<Id, number>;
  claimPreparation(taskId: Id): boolean;
  releasePreparation(taskId: Id): void;
  turnToRun(scope: RepositoryContext, signal: AbortSignal, order?: number): Promise<(() => void) & { waited: boolean }>;
  cachedChecks(scope: RepositoryContext): readonly ProductCheck[] | undefined;
  ensureChecks(scope: RepositoryContext, signal: AbortSignal): Promise<readonly ProductCheck[]>;
  captureState(scope: RepositoryContext, checks: readonly ProductCheck[]): Promise<CheckState>;
  observeSetup(request: ObserveCheckSetupRequest): Promise<LiveSetup>;
  ranOn(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState): Promise<boolean>;
  savedProductResults(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState, live: LiveSetup): Promise<readonly CheckRun[] | undefined>;
  runAll(request: ExecuteAllChecksRequest): Promise<CheckVerification>;
}

export async function executePreparedChecks(
  batch: CheckBatchHooks,
  scope: RepositoryContext,
  checks: readonly ProductCheck[],
  signal: AbortSignal,
  kept?: readonly CheckRun[],
  prepared?: CheckState,
  prepare?: CheckPreparation,
  purpose: JourneyCheckReuse["purpose"] = "acceptance",
): Promise<CheckVerification> {
  const { k } = batch;
  const { task, work: repository } = scope;
  if (!repository.worktree) return {
    kind: "blocked",
    productId: repository.productId,
    results: repository.checks?.results ?? [],
    reason: "inputs-changed",
    setup: { kind: "unobserved" }
  };
  let state = prepared ?? (await batch.captureState(scope, checks));
  let nothing = nothingToRun(checks, state.hooks) && !k.productOf(scope)?.checkSetup?.requirements.length;
  const queueWhilePaused = () => !nothing && k.s.pool.paused && !k.draining && !k.stopped && !runtimeWaitHolds(task);
  if (k.taskAdmissionsClosed(task) && !queueWhilePaused()) throw new WaitingForUsage(k.taskAdmissionWait(task));
  if (k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
  const open = openStep(task);
  const resumingNotes = open?.kind === "agent" && k.role(open.roleId ?? "")?.result === "delivery" && open.stageId === task.plan?.stages[task.stageIndex]?.id;
  if (!resumingNotes) beginPetrinaStep(task, "checks", Date.now(), repository);
  let step = openStep(task);
  const prefix = step?.productChecks?.length ? `run-${step.productChecks.length}:` : "";
  const attempt = { attemptId: `run-${step?.productChecks?.length ?? 0}`, queuedAt: Date.now(), productId: repository.productId };
  const entries: CheckEntries = new Map<string, DeepMutable<JourneyProductCheck>>([
    ...checks.filter((c) => c.argv.length).map((
      c,
      i
    ) => [
      `check-${i}`,
      {
      ...attempt,
      id: `${prefix}check-${i}`,
      name: c.name,
      result: "pending" as const
    }
    ] as const),
    ...state.hooks.map((h) => [
      `hook-${h}`,
      {
      ...attempt,
      id: `${prefix}hook-${h}`,
      name: h === "pre-commit" ? "Pre-commit hook" : "Commit message hook",
      result: "pending" as const
    }
    ] as const),
  ]);
  if (step) {
    for (const check of step.productChecks ?? []) if (check.result === "pending" || check.result === "running") {
      check.result = "stopped";
      check.endedAt = Date.now();
    }
    step.productChecks = [...(step.productChecks ?? []), ...entries.values()];
  }
  k.commit();
  let finished: Awaited<ReturnType<CheckBatchHooks["turnToRun"]>> | undefined;
  let complete = false;
  let recapture = false;
  let discoveries = 0;
  const order = nothing ? undefined : (batch.deliveryOrders.get(task.id) ?? k.checkQueue.reserveOrder());
  const reopenChecks = () => {
    if (step?.endedAt === undefined) return;
    step = beginPetrinaStep(task, "checks", Date.now(), repository);
    const refreshed: DeepMutable<JourneyProductCheck>[] = [...entries.values()].map((c) => ({
      ...c,
      result: "pending",
      detail: undefined,
      endedAt: undefined
    }));
    step.productChecks = refreshed;
    entries.clear();
    for (const check of refreshed) entries.set(check.id!.slice(prefix.length), check);
  };
  try {
    for (;;) {
      const reacquired = prepare?.beforeQueue?.();
      if (!batch.preparations.has(task.id) && !batch.claimPreparation(task.id)) {
        throw new WaitingForUsage(k.taskAdmissionsClosed(task) ? k.taskAdmissionWait(task) : "Waiting for room to prepare the product checks");
      }
      finished = nothing ? undefined : await batch.turnToRun(scope, signal, batch.deliveryOrders.get(task.id) ?? order);
      if (finished?.waited || recapture || reacquired) {
        if ((finished?.waited || reacquired) && prepare) {
          let yieldedForDecision = false;
          const release = () => {
            const released = finished !== undefined;
            finished?.();
            finished = undefined;
            batch.releasePreparation(task.id);
            yieldedForDecision = true;
            return released;
          };
          batch.decisionReleases.set(task.id, release);
          try { if ((await prepare()) === false) throw new CheckPreparationChanged(); }
          finally { if (batch.decisionReleases.get(task.id) === release) batch.decisionReleases.delete(task.id); }
          if (yieldedForDecision) {
            recapture = true;
            reopenChecks();
            continue;
          }
        }
        if (signal.aborted || k.stopped) throw new Aborted();
        if (k.taskAdmissionsClosed(task) && !queueWhilePaused()) throw new WaitingForUsage(k.taskAdmissionWait(task));
        if (k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
        if (prepare) {
          const current = batch.cachedChecks(scope);
          if (!current) {
            if (discoveries++ >= 3) throw new Error("The files defining this product's checks kept changing before they could start. Your work is preserved; try again once they are stable.");
            finished?.();
            finished = undefined;
            checks = await batch.ensureChecks(scope, signal);
            recapture = true;
            reopenChecks();
            task.holdsSlot = false;
            delete task.agent;
            k.schedule();
            continue;
          }
          checks = current;
        }
        state = await batch.captureState(scope, checks);
        nothing = nothingToRun(checks, state.hooks) && !k.productOf(scope)?.checkSetup?.requirements.length;
        recapture = false;
        kept = undefined;
        reopenChecks();
        syncPreparedCheckEntries(entries, checks, state.hooks, attempt, prefix, step);
      }
      if (!k.taskAdmissionsClosed(task)) break;
      if (!queueWhilePaused()) throw new WaitingForUsage(k.taskAdmissionWait(task));
      finished?.();
      finished = undefined;
    }
    if (k.taskSourceRefreshDue(task)) throw new SourceRefreshRequired();
    const failures = await batch.runAll({
      scope,
      checks,
      state,
      signal,
      entries,
      kept,
      attemptId: attempt.attemptId,
      purpose,
      ownsPlace: () => finished !== undefined,
    });
    complete = true;
    return failures;
  } catch (error) {
    if (error instanceof CheckPreparationChanged) {
      for (const check of entries.values()) if (check.result === "pending" || check.result === "stopped") {
        check.result = "skipped";
        check.detail = scope.work.updating ? "The starting branch moved and conflicts need the Builder before checks can run" : "The updated change needs approval before checks can run";
        check.endedAt = Date.now();
      }
      if (step) {
        step.outcome = "Not run";
        step.reason = entries.values().next().value?.detail;
      }
    }
    throw error;
  } finally {
    if (step && !complete) {
      for (const check of entries.values()) if (check.result === "pending" || check.result === "running") {
        check.result = "stopped";
        check.endedAt = Date.now();
      }
      k.commit();
    }
    finished?.();
  }
}

export async function executeAllChecks(
  batch: CheckBatchHooks,
  request: ExecuteAllChecksRequest,
): Promise<CheckVerification> {
  const {
    scope,
    checks,
    state,
    signal,
    entries,
    attemptId = entries.values().next().value?.attemptId,
    purpose = "acceptance",
    ownsPlace = () => false,
  } = request;
  let { kept } = request;
  const { k, evidence } = batch;
  const { task, work: repository } = scope;
  if (signal.aborted || k.stopped) throw new Aborted();
  if (!repository.worktree) return {
    kind: "blocked",
    productId: repository.productId,
    results: repository.checks?.results ?? [],
    reason: "inputs-changed",
    setup: { kind: "unobserved" }
  };
  task.statusLine = "Running the product's checks";
  if (repository.checks) repository.checks.current = false;
  k.commit();
  const before = state.sha ?? (await git.head(repository.worktree));
  const { hooks, definition } = state;
  const env = await checkExecutionEnvironment(k);
  const step = openStep(task);
  const provenance: DeepMutable<CheckAttemptEvidence> | undefined = attemptId && step ? {
    id: attemptId, productId: repository.productId, sha: before, tree: state.trackedChanged ? undefined : state.tree,
    commands: checks.filter((c) => c.argv.length).map((c) => commandText(c.argv)), definition,
  } : undefined;
  if (step && provenance) step.checkAttempts = [...(step.checkAttempts ?? []), provenance];
  const progress = (id: string, event: CheckProgress) => {
    if (k.stopped || signal.aborted || step?.endedAt !== undefined || openStep(task)?.id !== step?.id) return;
    const check = entries.get(id);
    if (!check) return;
    if (event.kind === "started") {
      check.result = "running";
      check.startedAt = event.at;
    }
    else {
      if (!kept?.includes(event.run)) event.run.source ??= { stepId: step!.id, attemptId: check.attemptId!, checkId: check.id! };
      check.run = { ...event.run };
      check.result = signal.aborted ? "stopped" : checkResult(event.run);
      check.endedAt = event.at;
      if (checkOutcome(event.run).kind !== "passed") check.detail = checkDiagnostic(event.run.output);
      if (checkOutcome(event.run).kind === "failed" && id.startsWith("check-")) check.namedFailures = namedCheckFailures(event.run.output);
    }
    const running = step!.productChecks!.filter((e) => e.result === "running").map((e) => e.name);
    task.statusLine = running.length ? `Running checks: ${running.join(", ")}` : "Finishing the check run";
    k.commit();
  };
  let results: CheckRun[];
  const nothing = nothingToRun(checks, hooks);
  let checksRestored = nothing;
  let hooksStarted = false;
  const restore = (report = false) => restoreCheckWorktree(k, scope, repository.worktree!, before, report);
  const live = await batch.observeSetup({
    scope,
    checks,
    state,
    signal,
    env,
    position: "before-checks",
    restore,
    ownsPlace,
  });
  if (signal.aborted || k.stopped) throw new Aborted();
  if (live.outcome.kind !== "verified") return evidence.blocked(scope, live, "setup");
  if (!live.valid()) return evidence.blocked(scope, live, "inputs-changed");
  if (kept === undefined && (await batch.ranOn(scope, checks, state)) && evidence.matchesEnvironment(scope, live, scope.work.checks?.results)) {
    const reused = await evidence.reuse(scope, state, purpose, live, signal);
    for (const check of entries.values()) if (check.result === "pending") {
      check.result = "skipped";
      check.detail = "The earlier batch was verified for this operation";
    }
    endPetrinaStep(
      task,
      {
      outcome: reused.kind === "passed" ? "Previous checks reused" : "Checks need attention",
      reason: "Existing raw results retained"
    },
      Date.now()
    );
    return reused;
  }
  if (!live.forceFresh && kept === undefined && (await batch.ranOn(
    scope,
    checks,
    state
  )) && repository.checks!.results.some((r) => ![
    "passed",
    "failed"
  ].includes(checkOutcome(r).kind))) {
    return evidence.retainIncomplete(scope, state, purpose, live);
  }
  if (!kept || !evidence.matchesEnvironment(scope, live, kept)) kept = await batch.savedProductResults(scope, checks, state, live);
  const beforeStart = () => live.valid();
  try {
    const ran = kept ?? (await runCheckBatch({
      cwd: repository.worktree,
      checks,
      env,
      timeoutMs: k.options.checkTimeoutMs,
      signal,
      logDirectory: join(k.dataDir, "checks", task.id),
      onProgress: (event) => progress(`check-${event.index}`, event),
      machineRecords: machineRecordsOf(k),
      beforeStart,
      executeCommand: k.options.runCheckCommand,
    }));
    if (kept) {
      const shown = new Set<number>();
      kept.forEach((run) => {
        const index = checks.findIndex((c, i) => !shown.has(i) && c.name === run.name && commandText(c.argv) === run.command);
        shown.add(index);
        progress(`check-${index}`, { kind: "finished", index, at: Date.now(), run });
        const entry = entries.get(`check-${index}`);
        if (entry) {
          entry.reusedAt = Date.now();
          entry.startedAt = run.startedAt;
          entry.endedAt = run.endedAt;
        }
      });
    }
    if (signal.aborted) {
      noteStoppedCheckRun(k, scope, ran, entries);
      throw new Aborted();
    }
    if (!nothing) await restore(true);
    checksRestored = true;
    const staticFailed = checks.some((c) => staticCheck(c) && ran.some((r) => !r.ok && r.command === commandText(c.argv)));
    hooksStarted = !staticFailed && hooks.length > 0;
    const hooksRan = staticFailed ? [] : await runRepositoryCommitHooks(k, scope, hooks, before, state.message, env, signal, progress, beforeStart);
    if (signal.aborted) {
      noteStoppedCheckRun(k, scope, [...ran, ...hooksRan], entries);
      throw new Aborted();
    }
    results = [...ran, ...hooksRan];
  } finally {
    if (!repository.hooking && (!checksRestored || hooksStarted)) await restore();
  }
  const required = k.productOf(scope);
  const rawTree = state.sha === before && state.tree ? state.tree : await git.treeOf(repository.worktree, before);
  repository.checks = {
    current: false, at: Date.now(), ...(before ? { sha: before } : {}), ...(rawTree ? { tree: rawTree } : {}),
    definition, results, ...(step && attemptId ? { provenance: { nodeId: step.id, attemptId } } : {}),
  };
  k.commit();
  const ranAnything = (!nothing && !kept) || hooksStarted || Boolean(state.setup?.requirements.length);
  const finalState = await captureFinalCheckDefinition(k, scope, required ? checksFor(required, repository.worktree) : checks, state, ranAnything);
  const after = await batch.observeSetup({
    scope,
    checks,
    state: finalState,
    signal,
    env,
    position: "after-checks",
    restore,
    ownsPlace,
  });
  if (signal.aborted || k.stopped) {
    noteStoppedCheckRun(k, scope, results, entries);
    throw new Aborted();
  }
  const staticFailedNow = checks.some((c) => staticCheck(c) && results.some((r) => checkOutcome(r).kind === "failed" && r.command === commandText(c.argv)));
  return evidence.record(scope, {
    state, finalState, live, after, before, rawTree, results,
    expected: expectedCommandsWithHooks(checks, results, hooks, staticFailedNow),
    commands: [
      ...orderedChecks(checks).map((c) => commandText(c.argv)),
      ...hooks.map((h) => (h === "pre-commit" ? "git hook run --ignore-missing pre-commit" : "git hook run commit-msg"))
    ],
    attemptId, stepId: step?.id, provenance, entries,
  });
}
