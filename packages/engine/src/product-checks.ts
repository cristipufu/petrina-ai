import { executionFor, scopesFor, taskView, type RepositoryContext } from "./repository-context.js";
import { beginRepair, acceptanceVersion } from "./repositories.js";
// The product's checks, run by Petrina itself: the Check finder works out the commands, and failing
// checks become findings with the real output. Running commands is in checks.ts.

import { beginPetrinaStep, checkCounts, checkProblem, checkResult, incompleteCheckOutcome, decisionEvidence, gateStatus, evidenceFor, originalCheck, recordCheckReuse, checkProblemTitle, endAgentStep, endPetrinaStep, JOURNEY_WORDS as W, lastIndexWhere, openStep, repositoryPublished, stepsFrom, type Id, type ProductCheck, type State, type Task } from "@petrina/core";
import { powerInterruption, readMachinePowerRecords } from "./check-interruption.js";
import * as git from "./git.js";
import { CheckFinderResult } from "./roles.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CheckAttemptEvidence, CheckRun, DeepMutable, JourneyCheckReuse, JourneyProductCheck } from "@petrina/core";
import { namedCheckFailures } from "./related-check-evidence.js";
import { CHECKS_SEEN, checksFingerprint, checksFor, detectChecks, runChecks, commandText, expectedCheckCommands, orderedChecks, staticCheck, type CheckProgress } from "./checks.js";
import { CLEANUP_INCOMPLETE } from "./process-tree.js";
import { withoutCredentials } from "./env.js";
import { Kernel, Aborted, CHECK_FINDER_PROFILE, ScreenWait, type MTask } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import { beginSideStep } from "./side-step.js";

/** Keep the failed test name and short cause with the journey step without saving the whole log twice. */
function checkDiagnostic(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.replace(/^@[^|]+\|\s*/, "").trim());
  const failures = lines.filter((line) => /^\(fail\)\s/i.test(line));
  const causes = lines.filter((line) => /^(?:error|assertionerror):/i.test(line) || /^timed out waiting for\b/i.test(line));
  const detail = [...failures, ...causes].filter((line, index, all) => all.indexOf(line) === index).slice(0, 6).join("\n").slice(0, 1000);
  return detail || undefined;
}

type CheckEntries = Map<string, DeepMutable<JourneyProductCheck>>;
type CheckState = { sha?: string; tree?: string; trackedChanged: boolean; hooks: string[]; definition: string; message?: string };

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
  private running = 0;
  private readonly line: (() => void)[] = [];
  private readonly preparations = new Set<Id>();

  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context) {}

  /** Recover trustworthy evidence once at startup, including decisions already waiting on the coordinator. */
  async restoreEvidence(records?: string): Promise<void> {
    const observations = this.k.s.tasks.filter((task) => !["running", "done", "cancelled", "pr-open"].includes(task.state)).flatMap((task) => scopesFor(task).flatMap((scope) => (scope.work.checks?.results ?? []).filter((run) => !run.ok && !run.interruption && !run.interrupted).flatMap((run) => {
      const original = originalCheck(task, run)?.check;
      const start = run.startedAt ?? original?.startedAt, end = run.endedAt ?? original?.endedAt;
      return start !== undefined && end !== undefined ? [{ scope, run, start, end }] : [];
    })));
    if (!observations.length) return;
    records ??= await readMachinePowerRecords(undefined, undefined, this.k.stopRequested.signal);
    if (this.k.stopped || this.k.stopRequested.signal.aborted) return;
    const changed = new Set<MTask>();
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
    if (this.k.admissionsClosed || !this.canPrepare(taskId)) return false;
    this.preparations.add(taskId);
    return true;
  }

  releasePreparation(taskId: Id): void { this.preparations.delete(taskId); }

  private async turnToRun(scope: RepositoryContext, signal: AbortSignal): Promise<(() => void) & { waited: boolean }> {
    const { task } = scope;
    if (signal.aborted || this.k.stopped) throw new Aborted();
    const most = this.k.options.checkRuns ?? 1;
    const waited = this.running >= most;
    if (waited) {
      task.statusLine = "Waiting to run the checks: another task's run comes first";
      this.k.commit();
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal.removeEventListener("abort", stop);
          resolve();
        };
        const stop = () => {
          const index = this.line.indexOf(go);
          if (index >= 0) this.line.splice(index, 1);
          reject(new Aborted());
        };
        this.line.push(go);
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      });
    } else this.running += 1;
    let done = false;
    const finished = () => {
      if (done) return;
      done = true;
      const next = this.line.shift();
      // Reserve this place for the waiter before its promise resumes. New arrivals must stay in line.
      if (next) next();
      else this.running -= 1;
    };
    // Cancellation can arrive after the handoff but before this continuation gets its turn.
    if (signal.aborted || this.k.stopped) {
      finished();
      throw new Aborted();
    }
    if (this.k.admissionsClosed) {
      finished();
      throw new WaitingForUsage(this.k.draining ? this.k.drainLine : "Waiting for the pool to resume");
    }
    return Object.assign(finished, { waited });
  }

  /**
   * The product's checks. The Check finder works them out once per product, and again only when the
   * CI, build or hook files it read have changed or a check could not even start. Checks the coordinator set
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
    const unstartable = repository.checks?.results.some((run) => run.output.startsWith("Could not start")) ?? false;
    if (!continuing && product.checks && product.checksFingerprint === fingerprint && !unstartable) return product.checks;
    // Tasks on different bases have different CI and build files: each reuses what was found for its own.
    const seen = product.checksSeen?.find((entry) => entry.fingerprint === fingerprint);
    if (!continuing && seen && !unstartable) return seen.checks;
    const declared = detectChecks(repository.worktree);
    // A side errand inside the step: it leaves the step's own restart bookkeeping as it found it.
    const restore = beginSideStep(this.k, scope, "check-finder");
    const why = !product.checks ? "first time" : unstartable ? "a check could not start" : "the CI, build or hook files changed";
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
      endAgentStep(task, { outcome: W.foundChecks(product.checks.length), reason: W.checksFound }, Date.now());
      this.k.log(scope, "done", `Found how to check ${product.name} (${why}): ${product.checks.map((check) => check.name).join(", ")}`, "check-finder", ran);
    } catch (error) {
      if (signal.aborted || error instanceof Aborted || error instanceof ScreenWait) throw error;
      this.k.releaseScreen(task);
      restore();
      // Everyone who could work it is out of usage: the task waits, and the finder runs when one is back.
      if (error instanceof WaitingForUsage) throw error;
      // Petrina carries on without it, but it is still a failure in Analytics.
      this.k.tracking.failed(scope, error, { roleId: "check-finder", profileId: ran });
      endAgentStep(task, { outcome: W.couldNotFinish, reason: W.checksAsBefore }, Date.now());
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

  /**
   * Petrina runs the product's checks itself, without credentials, and then the repository's own commit
   * hooks on the task's whole change. Failures become blocking findings, with the output as evidence. A check
   * only looks: whatever one changes in files git tracks is undone, so nothing unreviewed joins the work.
   */
  async runProductChecks(scope: RepositoryContext, checks: readonly ProductCheck[], signal: AbortSignal, kept?: readonly CheckRun[], prepared?: CheckState): Promise<number> {
    const { task, work: repository } = scope;
    if (!repository.worktree) return 0;
    // A check queue entry is not a model conversation. No agent still runs on this copy.
    if (!this.k.runs.has(task.id) && !this.k.helperRuns.get(task.id)?.size) {
      task.holdsSlot = false;
      delete task.agent;
    }
    if (!this.claimPreparation(task.id)) throw new WaitingForUsage("Waiting for room to prepare the product checks");
    this.k.schedule();
    try { return await this.runPreparedChecks(scope, checks, signal, kept, prepared); }
    finally { this.releasePreparation(task.id); }
  }

  private async runPreparedChecks(scope: RepositoryContext, checks: readonly ProductCheck[], signal: AbortSignal, kept?: readonly CheckRun[], prepared?: CheckState): Promise<number> {
    const { task, work: repository } = scope;
    if (!repository.worktree) return 0;
    let state = prepared ?? await this.captureState(scope, checks);
    const hooks = state.hooks;
    const nothing = nothingToRun(checks, hooks);
    // Resuming unfinished release notes revalidates the preparation first. Those repeated checks belong
    // to the same step's timeline: they do not complete the notes or start another agent step.
    const open = openStep(task);
    const resumingNotes = open?.kind === "agent" && this.k.role(open.roleId ?? "")?.result === "delivery" && open.stageId === task.plan?.stages[task.stageIndex]?.id;
    // A checks step's elapsed time includes waiting for another task's run.
    if (!resumingNotes) beginPetrinaStep(task, "checks", Date.now(), repository);
    const step = openStep(task);
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
    try {
      finished = nothing ? undefined : await this.turnToRun(scope, signal);
      if (finished?.waited) {
        state = await this.captureState(scope, checks);
        // Another run held the lane. Files and external hook inputs may have changed while waiting.
        kept = await this.savedProductResults(scope, checks, state);
        for (const [id, entry] of entries) if (id.startsWith("hook-") && !state.hooks.includes(id.slice(5))) entry.result = "skipped";
        for (const hook of state.hooks) if (!entries.has(`hook-${hook}`)) {
          const entry: DeepMutable<JourneyProductCheck> = { ...attempt, id: `${prefix}hook-${hook}`, name: hook === "pre-commit" ? "Pre-commit hook" : "Commit message hook", result: "pending" };
          entries.set(`hook-${hook}`, entry);
          if (step) step.productChecks = [...(step.productChecks ?? []), entry];
        }
      }
      const failures = await this.runAll(scope, checks, state, signal, entries, kept, attempt.attemptId);
      complete = true;
      return failures;
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

  private async runAll(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState, signal: AbortSignal, entries: CheckEntries, kept?: readonly CheckRun[], attemptId = entries.values().next().value?.attemptId): Promise<number> {
    const { task, work: repository } = scope;
    if (signal.aborted || this.k.stopped) throw new Aborted();
    if (!repository.worktree) return 0;
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
        if (!event.run.ok) check.detail = checkDiagnostic(event.run.output);
        if (!event.run.ok && id.startsWith("check-")) check.namedFailures = namedCheckFailures(event.run.output);
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
      const status = await git.worktreeStatus(repository.worktree!);
      if (status.head !== before) {
        await git.resetTo(repository.worktree!, before);
        if (report) this.k.log(scope, "warn", "A check made a commit, so Petrina put the work back as it was: checks only look, and fixes come from the builder");
      } else if (status.trackedChanged) {
        await git.restoreTracked(repository.worktree!);
        if (report) this.k.log(scope, "warn", "A check changed files, so Petrina put them back: checks only look, and fixes come from the builder");
      }
      if (status.head !== before || status.trackedChanged) {
        const restored = await git.worktreeStatus(repository.worktree!);
        if (restored.head !== before || restored.trackedChanged) throw new Error("The check run could not restore the original work. Its results cannot count as current evidence.");
      }
    };
    try {
      const ran = kept ?? await runChecks(repository.worktree, checks, env, this.k.options.checkTimeoutMs, signal, join(this.k.dataDir, "checks", task.id), undefined, (event) => progress(`check-${event.index}`, event));
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
      const hooksRan = staticFailed ? [] : await this.runHooks(scope, hooks, before, state.message, env, signal, progress);
      if (signal.aborted) {
        this.noteStopped(scope, [...ran, ...hooksRan], entries);
        throw new Aborted();
      }
      results = [...ran, ...hooksRan];
    } finally {
      // The hooks too: whatever they committed or changed in files git tracks is put back.
      if (!repository.hooking && (!checksRestored || hooksStarted)) await restore();
    }
    const tree = state.sha === before && state.tree ? state.tree : await git.treeOf(repository.worktree, before);
    repository.checks = { current: true, at: Date.now(), ...(before ? { sha: before } : {}), ...(tree ? { tree } : {}), definition, results, ...(step && attemptId ? { provenance: { nodeId: step.id, attemptId } } : {}) };
    const checksStep = openStep(task);
    for (const check of checksStep?.productChecks ?? []) if (check.result === "pending") check.result = "skipped";
    const failed = this.settleFindings(scope, results);
    const interrupted = results.some((run) => run.interruption || run.interrupted);
    for (const entry of entries.values()) if (entry.run && !entry.run.ok) {
      entry.findingId = task.findings.findLast((finding) => finding.raisedBy === "petrina" && finding.text === `Check failed: ${entry.run!.name} (${entry.run!.command})` && (!task.repositories || finding.productIds?.includes(repository.productId)))?.id;
    }
    if (provenance && !failed.length && !interrupted && provenance.tree) {
      const required = this.k.productOf(scope);
      // Restoration already verified the captured commit and tracked contents. Recheck only definitions
      // that can change during a run, retaining the immutable commit's captured message too.
      const current = await git.commitHookFiles(repository.worktree)
        .then((files) => this.definition(scope, required ? checksFor(required, repository.worktree!) : [], files, before, state.message))
        .catch(() => undefined);
      const commands = [...orderedChecks(checks).map((check) => commandText(check.argv)), ...hooks.map((hook) => hook === "pre-commit" ? "git hook run --ignore-missing pre-commit" : "git hook run commit-msg")];
      provenance.passed = current?.definition === definition
        && JSON.stringify(commands) === JSON.stringify(results.map((run) => run.command))
        && results.every((run) => run.ok && !run.interruption && !run.interrupted && !run.timedOut && !run.cleanupIncomplete);
    }
    if (results.every((run) => run.ok && !run.interruption && !run.interrupted)) await this.closeEpisode(scope, state);
    const incomplete = incompleteCheckOutcome(results.map((run) => ({ name: run.name, result: checkResult(run), run })));
    const failureNames = failed.map((run) => run.name).join(", ");
    this.k.log(scope, failed.length || interrupted ? "warn" : "done", incomplete ? `${incomplete}${failed.length ? ` (${failureNames})` : ""}; original reported results retained` : failed.length ? `Checks: ${failed.length} of ${results.length} failed (${failureNames})` : results.length ? `Checks passed: ${results.map((run) => run.name).join(", ")}` : "No product checks or commit hooks to run");
    if ((failed.length || interrupted) && this.k.role(openStep(task)?.roleId ?? "")?.result === "delivery") {
      endAgentStep(task, { outcome: incomplete ?? W.interrupted, reason: incomplete ?? W.checksFailed(failed.length), tone: "back", end: "failed" }, Date.now());
    } else {
      endPetrinaStep(task, incomplete ? { outcome: incomplete, reason: incomplete, tone: "back" } : failed.length ? { outcome: W.checks(failed.length, results.length), reason: W.checksFailed(failed.length), tone: "back" } : { outcome: W.checks(0, results.length), reason: results.length ? W.checksPassed : W.noChecks }, Date.now());
    }
    this.k.commit();
    return results.filter((run) => !run.ok || run.interruption || run.interrupted).length;
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
    const { task, work: repository } = scope;
    const failed = results.filter((run) => !run.ok && !run.interruption && !run.interrupted);
    const product = this.k.productOf(scope);
    const declared = new Set([
      ...(product && repository.worktree ? checksFor(product, repository.worktree) : []).map((check) => `Check failed: ${check.name} (${commandText(check.argv)})`),
      ...(product?.hooks?.includes("pre-commit") ? ["Check failed: Pre-commit hook (git hook run --ignore-missing pre-commit)"] : []),
      ...(product?.hooks?.includes("commit-msg") ? ["Check failed: Commit message hook (git hook run commit-msg)"] : []),
    ]);
    // An earlier failure settles on this run, whatever anyone answered about it.
    for (const finding of task.findings) {
      if (finding.raisedBy === "petrina" && (finding.status === "open" || finding.status === "unverified") && finding.text.startsWith("Check failed") && (!task.repositories || finding.productIds?.includes(repository.productId))) {
        const matching = results.find((run) => finding.text === `Check failed: ${run.name} (${run.command})`);
        if (!declared.has(finding.text) || (matching?.ok && !matching.interruption && !matching.interrupted)) finding.status = "fixed";
        else if (matching?.interruption || matching?.interrupted) finding.status = "unverified";
      }
    }
    for (const run of failed) {
      const text = `Check failed: ${run.name} (${run.command})`;
      const finding = task.findings.findLast((finding) => finding.raisedBy === "petrina" && finding.text === text && (!task.repositories || finding.productIds?.includes(repository.productId)));
      if (finding) {
        finding.status = "open";
        finding.severity = "blocking";
        finding.evidence = run.output.slice(-1500);
      } else task.findings.push({ ...(task.repositories ? { productIds: [repository.productId] } : {}), id: this.k.id(task.id), text, evidence: run.output.slice(-1500), severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
    }
    return failed;
  }

  /** The commands and hook inputs: a new definition needs a fresh run, even on the same tree. */
  private async definition(scope: RepositoryContext, checks: readonly ProductCheck[], hooks: Awaited<ReturnType<typeof git.commitHookFiles>>, sha?: string, capturedMessage?: string): Promise<{ definition: string; message?: string }> {
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
    return { definition: hash.digest("hex"), ...(message !== undefined ? { message } : {}) };
  }

  /** Reuse one observation within this operation, never as a persistent freshness flag. */
  private async captureState(scope: RepositoryContext, checks: readonly ProductCheck[]): Promise<CheckState> {
    const path = scope.work.worktree!;
    const [status, files] = await Promise.all([git.worktreeStatus(path), git.commitHookFiles(path)]);
    const hooks = await this.noteHooks(scope, files.map((hook) => hook.name));
    // The reusable tree and message must belong to the same observed commit.
    const [tree, definition] = await Promise.all([status.head ? git.treeOf(path, status.head) : undefined, this.definition(scope, checks, files, status.head)]);
    return { sha: status.head, tree, trackedChanged: status.trackedChanged, hooks, ...definition };
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
    const { work: repository } = scope;
    if (!repository.checks || !repository.worktree) return false;
    if (state.trackedChanged) return false;
    const { hooks, definition, sha, tree } = state;
    const productCommands = expectedCheckCommands(checks, repository.checks.results);
    const staticFailed = checks.some((check) => staticCheck(check) && repository.checks!.results.some((run) => !run.ok && run.command === commandText(check.argv)));
    const expected = [
      ...productCommands,
      ...(!staticFailed && hooks.includes("pre-commit") ? ["git hook run --ignore-missing pre-commit"] : []),
      ...(!staticFailed && hooks.includes("commit-msg") ? ["git hook run commit-msg"] : []),
    ];
    if (JSON.stringify(expected) !== JSON.stringify(repository.checks.results.map((run) => run.command))) return false;
    if (repository.checks.definition) {
      if (repository.checks.definition !== definition) return false;
    } else {
      // Older runs identify product commands, but cannot establish which hook file or contents ran.
      // Verify hooks once, then save their complete definition instead of guessing from command text.
      if (hooks.length) return false;
    }
    const matched = (!!tree && repository.checks.tree === tree) || (!!sha && repository.checks.sha === sha);
    if (matched) repository.checks.definition = definition;
    // A hook may launch checks outside the committed tree: unchanged launcher bytes cannot prove
    // their inputs stayed unchanged. Revalidate passes; a captured failure still blocks without retrying.
    if (matched && repository.checks.results.every((run) => run.ok) && hooks.length) return false;
    return matched;
  }

  /** The same freshness rule for agent evidence as for the review and delivery gates. */
  async current(scope: RepositoryContext): Promise<boolean> {
    const { work: repository } = scope;
    const product = this.k.productOf(scope);
    if (!repository.checks || !repository.worktree) return false;
    const checks = product ? checksFor(product, repository.worktree) : [];
    return this.ranOn(scope, checks, await this.captureState(scope, checks));
  }

  /** Revalidating opaque or older hooks must not retry product checks with unchanged code and commands. */
  private async savedProductResults(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState): Promise<readonly CheckRun[] | undefined> {
    const { work: repository } = scope;
    if (!repository.checks || !repository.worktree) return undefined;
    if (state.trackedChanged) return undefined;
    if (repository.checks.definition && (repository.checks.definition !== state.definition || !state.hooks.length)) return undefined;
    const { sha, tree } = state;
    if (!(tree && repository.checks.tree === tree) && !(sha && repository.checks.sha === sha)) return undefined;
    const commands = orderedChecks(checks).map((check) => commandText(check.argv));
    const results = repository.checks.results.slice(0, commands.length);
    if (JSON.stringify(commands) !== JSON.stringify(results.map((run) => run.command))) return undefined;
    const hooks = repository.checks.results.slice(commands.length);
    if (!hooks.every((run) => run.command === "git hook run commit-msg" || run.command === "git hook run --ignore-missing pre-commit")) return undefined;
    return results;
  }

  /**
   * Right before the delivery check: the checks run again when the code changed since they last ran.
   * A failure sends the work back to the builder while its failure episode has returns left; after that the
   * coordinator sees it. Exhausted returns are a failure, never permission to start final acceptance.
   */
  async checksBeforeDelivery(scope: RepositoryContext, signal: AbortSignal): Promise<"passed" | "returned" | "exhausted"> {
    if (!(await this.failing(scope, signal, undefined, "delivery-check"))) return "passed";
    return this.backToBuilder(scope, "right before your delivery check") ? "returned" : "exhausted";
  }

  /**
   * Right before shipping: the checks pass on exactly what ships. Failing, the work goes back to the builder
   * while the episode has returns left, and then to the coordinator's delivery check.
   */
  async checksBeforeShipping(scope: RepositoryContext, signal: AbortSignal): Promise<boolean> {
    const { task, work: repository } = scope;
    if (!(await this.failing(scope, signal, undefined, "publishing"))) return false;
    if (this.backToBuilder(scope, "on what was about to ship")) return true;
    const check = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.gate === "delivery");
    if (check < 0) throw new Error("The product's checks fail on the work about to ship");
    delete repository.approvedSha;
    delete repository.approvedPatch;
    delete repository.approvedFor;
    task.stageIndex = check;
    task.sub = 0;
    this.k.log(scope, "warn", "The checks fail on what was about to ship, so Petrina asks you again");
    this.k.commit();
    return true;
  }

  /**
   * Reuse a completed run, including failures, until the code or check definition changes. A reuse is recorded
   * on the step that ran the original, with its basis, so the evidence survives restarts and later runs.
   */
  async failing(scope: RepositoryContext, signal: AbortSignal, checks?: readonly ProductCheck[], purpose: JourneyCheckReuse["purpose"] = "acceptance"): Promise<boolean> {
    const { task, work: repository } = scope;
    if (!repository.worktree) return false;
    const product = this.k.productOf(scope);
    checks ??= product ? checksFor(product, repository.worktree) : [];
    const state = await this.captureState(scope, checks);
    if (await this.ranOn(scope, checks, state)) {
      const saved = repository.checks!;
      saved.current = true;
      let records: string | undefined;
      for (const run of saved.results) if (!run.ok && !run.interruption && !run.interrupted) {
        const original = originalCheck(scope.task, run)?.check;
        const start = run.startedAt ?? original?.startedAt, end = run.endedAt ?? original?.endedAt;
        if (start === undefined || end === undefined) continue;
        // All these executions have finished. One log snapshot covers the whole saved batch.
        records ??= await readMachinePowerRecords(undefined, undefined, signal);
        if (signal.aborted || this.k.stopped) throw new Aborted();
        const interruption = powerInterruption(start, end, records);
        if (interruption) { run.interruption = interruption; if (original?.run) original.run.interruption = interruption; }
      }
      // Rereading a saved failure is no new attempt; a saved pass on this code and these definitions is a genuine pass.
      this.settleFindings(scope, saved.results);
      const passed = saved.results.every((run) => run.ok && !run.interruption && !run.interrupted);
      if (passed) await this.closeEpisode(scope, state);
      // The reuse and its basis are saved on the step that ran the original, so the evidence survives restarts and later runs.
      const host = (saved.provenance ? task.journey?.find((step) => step.id === saved.provenance!.nodeId) : undefined) ?? task.journey?.at(-1);
      if (host) host.reuses = [...(host.reuses ?? []), { at: Date.now(), purpose, productId: repository.productId, ...(saved.provenance ? { attemptId: saved.provenance.attemptId } : {}), basis: state.tree && saved.tree === state.tree ? "same-tree" : "same-commit", originalAt: saved.at, ...(saved.sha ? { sha: saved.sha } : {}), ...(saved.tree ? { tree: saved.tree } : {}), ...(saved.definition ? { definition: saved.definition } : {}), passed }];
      recordCheckReuse(scope.task, repository, Date.now());
      this.k.commit();
      return saved.results.some((run) => !run.ok || run.interruption || run.interrupted);
    }
    return (await this.runProductChecks(scope, checks, signal, await this.savedProductResults(scope, checks, state), state)) > 0;
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
  private async runHooks(scope: RepositoryContext, hooks: readonly string[], head: string, message: string | undefined, env: NodeJS.ProcessEnv, signal: AbortSignal, progress: (id: string, event: CheckProgress) => void): Promise<CheckRun[]> {
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
        runs.push(...(await runChecks(worktree, [{ name: "Pre-commit hook", argv: ["git", "hook", "run", "--ignore-missing", "pre-commit"] }], env, this.k.options.checkTimeoutMs, signal, join(this.k.dataDir, "checks", task.id), undefined, (event) => progress("hook-pre-commit", event))));
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
        const [run] = await runChecks(worktree, [{ name: "Commit message hook", argv: ["git", "hook", "run", "--ignore-missing", "commit-msg", "--", file] }], env, this.k.options.checkTimeoutMs, signal, join(this.k.dataDir, "checks", task.id), undefined, (event) => progress("hook-commit-msg", event));
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

  /**
   * A genuine pass ends the failure episode, and the next one starts afresh: every check failure of this product
   * settled, on the code and the check definitions required now. A pass on checks or hooks replaced while it ran
   * proves nothing about the current ones, so the spent returns stay.
   */
  private async closeEpisode(scope: RepositoryContext, state: CheckState): Promise<void> {
    const { task, work } = scope;
    if (work.checkReturns === undefined || !work.worktree) return;
    if (task.findings.some((finding) => finding.raisedBy === "petrina" && finding.status === "open" && finding.text.startsWith("Check failed") && (!task.repositories || finding.productIds?.includes(work.productId)))) return;
    const product = this.k.productOf(scope);
    const required = product ? checksFor(product, work.worktree) : [];
    const { definition } = await this.definition(scope, required, await git.commitHookFiles(work.worktree), state.sha);
    if (definition === state.definition) delete work.checkReturns;
  }

  /**
   * Failing checks send the work back to the builder, twice at most in one failure episode. Each real send-back
   * counts; rereading a saved failure does not. The fix walks forward from the builder through every stage up to
   * the one these checks guard, so a fix made after reviews passed is reviewed again, and acceptance retried.
   */
  backToBuilder(scope: RepositoryContext, when: string): boolean {
    const { task, work: repository } = scope;
    if (checkProblem(taskView(task)) === "unverified") return false;
    if (task.repositories) {
      // A shared repair pass returns to one stage. From the delivery check or shipping it returns through the
      // first review after the builder, as a single product walks forward; nothing it changed is unreviewed.
      const stages = task.plan?.stages ?? [];
      const here = stages[task.stageIndex];
      const late = here?.gate === "delivery" || this.k.role(here?.roleId ?? "", task)?.result === "delivery";
      const builder = stages.findIndex((entry) => entry.kind === "do" && this.k.role(entry.roleId, task)?.result === "build");
      const review = late && !task.repositories.some(repositoryPublished) ? stages.findIndex((entry, index) => index > builder && index < task.stageIndex && entry.kind === "review-chain") : -1;
      if (!beginRepair(this.k, task, "checks", review >= 0 ? review : task.stageIndex)) return false;
      // Through review, the delivery check asks again. A pass returning to shipping keeps the approval, so the
      // changed work is compared with what was approved there and never ships on a withdrawn approval.
      if (review >= 0) for (const work of task.repositories) if (!repositoryPublished(work)) withdrawApproval(work);
      this.k.commitNow();
      return true;
    }
    const builder = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && this.k.role(entry.roleId, task)?.result === "build");
    if (builder < 0 || (repository.checkReturns ?? 0) >= 2) return false;
    repository.checkReturns = (repository.checkReturns ?? 0) + 1;
    withdrawApproval(repository);
    task.stageIndex = builder;
    task.sub = 0;
    task.fixing = true;
    this.k.log(scope, "warn", `Sent back to the builder: the checks failed ${when}`);
    this.k.commit();
    return true;
  }

  /**
   * The automatic returns of this failure episode are used up. The task waits at the step these checks guard
   * (a pending review round keeps its number), and the coordinator gets a check problem: asking for changes
   * gives the Builder one more turn, and approving never ships failing checks. Without a delivery check to ask
   * again, an approval stops the task for Retry instead.
   */
  blocked(task: MTask): "stop" {
    const stages = task.plan?.stages ?? [];
    if (!stages.some((stage) => stage.kind === "gate" && stage.gate === "delivery") && scopesFor(task).some(({ work }) => work.approvedFor?.by === "coordinator")) {
      throw new Error("The product's checks fail, and approving does not ship failing checks. Retry runs them again; a pass continues where the task stopped.");
    }
    const problem = this.checkProblem(task);
    this.k.log(task, "warn", problem.line);
    this.k.gate(task, "delivery", undefined, problem);
    return "stop";
  }

  /** What the coordinator reads at a check problem: each failing check, the Builder's turns and answers, where the task stopped and what comes after. */
  private checkProblem(task: MTask): { title: string; body: string; line: string } {
    const stages = task.plan?.stages ?? [];
    const shared = !!task.repositories;
    const failing = scopesFor(task).flatMap((scope) => {
      const runs = scope.work.checks?.results.filter((run) => !run.ok || run.interruption || run.interrupted) ?? [];
      return runs.length ? [{ scope, runs, name: this.k.productOf(scope)?.name ?? scope.work.productId }] : [];
    });
    const names = failing.flatMap(({ runs, name }) => runs.filter((run) => !run.interruption && !run.interrupted).map((run) => shared ? `${name}: ${run.name}` : run.name));
    const unverifiedNames = failing.flatMap(({ runs, name }) => runs.filter((run) => run.interruption || run.interrupted).map((run) => shared ? `${name}: ${run.name}` : run.name));
    const turns = (count: number) => `${count} automatic Builder ${count === 1 ? "turn" : "turns"}`;
    const sections = failing.map(({ scope, runs, name }) => {
      const attempts = scope.work.checkReturns ?? 0;
      const lines = runs.map((run) => {
        const finding = task.findings.findLast((entry) => entry.raisedBy === "petrina" && entry.text === `Check failed: ${run.name} (${run.command})` && (!shared || entry.productIds?.includes(scope.work.productId)));
        const answer = (shared ? finding?.answers?.[scope.work.productId] : undefined) ?? finding?.answer;
        return [
          `• ${run.name} ${run.interruption ? "interrupted — verification incomplete; original reported result" : run.interrupted ? "stopped — verification incomplete; original reported result" : run.timedOut ? "did not finish" : "failed"}: ${diagnosticOf(run)}`,
          ...(run.interruption ? [`  ${run.interruption.source}: ${new Date(run.interruption.at).toLocaleString()} — ${run.interruption.event}`] : []),
          ...(answer ? [`  The Builder's last answer${answer.fixed ? ", saying it fixed this" : ""}: “${answer.text.trim()}”`] : []),
          ...(answer && !answer.fixed ? ["  Builder’s explanation — not independently confirmed. Only recorded machine evidence establishes interruption."] : []),
        ].join("\n");
      });
      const evidence = evidenceFor(task, scope.work);
      const reused = evidence.some((check) => check.reusedAt !== undefined);
      const fresh = evidence.some((check) => check.run && check.reusedAt === undefined);
      const { failed, unverified } = checkCounts(evidence);
      return [failed ? `${shared ? `${name}: s` : "S"}till failing after ${turns(attempts)}.${unverified ? ` ${unverified} ${unverified === 1 ? "check also unverified" : "checks also unverified"}.` : ""}` : `${shared ? `${name}: ` : ""}Checks unverified. No automatic repair for interruption alone.`, ...lines, ...(reused ? [fresh ? "Some previous check evidence reused; other checks ran in this attempt." : "Previous check evidence reused; no new execution."] : [])].join("\n");
    });
    const builder = lastIndexWhere(stages, (entry, index) => index < task.stageIndex && entry.kind === "do" && this.k.role(entry.roleId, task)?.result === "build");
    const where = this.stoppedAt(task);
    const reviews = new Set(stages.filter((stage) => stage.kind === "review-chain").map((stage) => stage.id));
    const reviewed = Math.max(-Infinity, ...(task.journey ?? []).filter((step) => step.kind === "agent" && step.stageId && reviews.has(step.stageId) && step.endedAt !== undefined).map((step) => step.endedAt!));
    const unconfirmed = task.findings.filter((finding) => finding.raisedBy !== "petrina" && finding.status !== "dismissed" && !/^(Failed|Could not verify) acceptance check:/.test(finding.text) && finding.answer?.fixed && finding.answer.at > reviewed).length;
    const view = { ...taskView(task), ...(builder >= 0 ? { stageIndex: builder, fixing: false } : {}) } as Task;
    const ahead = stepsFrom(this.k.s as unknown as State, view, builder >= 0 ? builder + 1 : task.stageIndex);
    const body = [
      ...sections,
      [
        `Stopped ${where}.`,
        ...(unconfirmed ? [`A reviewer has not yet confirmed ${unconfirmed === 1 ? "1 fix" : `${unconfirmed} fixes`} the Builder made for review findings.`] : []),
        ...(ahead.length ? [`${builder >= 0 ? "After the Builder's next turn, still to come" : "Still to come"}: ${ahead.join(", then ")}.`] : []),
      ].join(" "),
      `${builder >= 0 ? "Send back with a note to give the Builder one more turn. " : ""}Approving does not ship while checks fail or remain unverified. Run checks again explicitly requests fresh verification without approving delivery.`,
    ].join("\n\n");
    const attempts = shared ? "their automatic Builder turns" : turns(executionFor(task).work.checkReturns ?? 0);
    return {
      title: checkProblem(taskView(task)) === "unverified" ? `Your call on “${task.title}”: checks unverified` : checkProblemTitle(task.title, names, unverifiedNames),
      body,
      line: checkProblem(taskView(task)) === "unverified" ? `Checks unverified (${unverifiedNames.join(", ")}), so Petrina waits for you ${where}` : `Checks still fail after ${attempts} (${names.join(", ")})${unverifiedNames.length ? `; unverified (${unverifiedNames.join(", ")})` : ""}, so Petrina waits for you ${where}`,
    };
  }

  /** The step the failing checks guard, in the coordinator's words. */
  private stoppedAt(task: MTask): string {
    const stage = task.plan?.stages[task.stageIndex];
    if (!stage) return "before delivery";
    if (stage.kind === "gate") return stage.gate === "delivery" ? "before your delivery check" : `before ${stage.title.toLowerCase()}`;
    if (stage.kind === "review-chain") {
      const round = task.rounds[stage.id] ?? 1;
      return `before the ${stage.title.toLowerCase()}${round > 1 ? ` (round ${round})` : ""}`;
    }
    const result = this.k.role(stage.roleId, task)?.result;
    return result === "checks" ? "before acceptance testing" : result === "delivery" ? "before shipping" : `before ${stage.title.toLowerCase()}`;
  }
}

/** The builder changes the work: whatever was approved before, the coordinator checks it again. */
function withdrawApproval(work: { approvedSha?: string; approvedPatch?: string; approvedFor?: unknown }): void {
  delete work.approvedSha;
  delete work.approvedPatch;
  delete work.approvedFor;
}

/** A failed run in a few lines: the failing tests and causes, else the end of its output. */
function diagnosticOf(run: CheckRun): string {
  const detail = checkDiagnostic(run.output) ?? run.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join("\n");
  return (detail || "no output").slice(0, 600);
}
