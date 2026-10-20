import { type RepositoryContext } from "./repository-context.js";
import { beginRepair, acceptanceVersion } from "./repositories.js";
// The product's checks, run by Petrina itself: the Check finder works out the commands, and failing
// checks become findings with the real output. Running commands is in checks.ts.

import { beginPetrinaStep, endAgentStep, endPetrinaStep, JOURNEY_WORDS as W, lastIndexWhere, openStep, type Id, type ProductCheck } from "@petrina/core";
import * as git from "./git.js";
import { CheckFinderResult } from "./roles.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckRun, DeepMutable, JourneyProductCheck } from "@petrina/core";
import { CHECKS_SEEN, checksFingerprint, checksFor, detectChecks, runChecks, commandText, expectedCheckCommands, orderedChecks, staticCheck, type CheckProgress } from "./checks.js";
import { CLEANUP_INCOMPLETE } from "./process-tree.js";
import { withoutCredentials } from "./env.js";
import { Kernel, Aborted, CHECK_FINDER_PROFILE, ScreenWait } from "./kernel.js";
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
type CheckState = { sha?: string; tree?: string; trackedChanged: boolean; hooks: string[]; definition: string };

export class ProductChecks {
  /**
   * Task check runs take turns: each can start a full parallel test suite and build, so overlapping them
   * multiplies CPU and memory pressure and can make both slower or cause timeouts.
   */
  private running = 0;
  private readonly line: (() => void)[] = [];
  private readonly preparations = new Set<Id>();

  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context) {}

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
    const continuing = repository.conversation?.roleId === "check-finder";
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
    if (!checks.length && !hooks.length && !repository.checks) return 0;
    // Resuming unfinished release notes revalidates the preparation first. Those repeated checks belong
    // to the same step's timeline: they do not complete the notes or start another agent step.
    const open = openStep(task);
    const resumingNotes = open?.kind === "agent" && open.roleId === "release-manager" && open.stageId === task.plan?.stages[task.stageIndex]?.id;
    // A checks step's elapsed time includes waiting for another task's run.
    if (!resumingNotes) beginPetrinaStep(task, "checks", Date.now(), repository);
    const step = openStep(task);
    const prefix = step?.productChecks?.length ? `run-${step.productChecks.length}:` : "";
    const entries: CheckEntries = new Map<string, DeepMutable<JourneyProductCheck>>([
      ...checks.filter((check) => check.argv.length).map((check, index) => [`check-${index}`, { id: `${prefix}check-${index}`, name: check.name, result: "pending" as const }] as const),
      ...hooks.map((hook) => [`hook-${hook}`, { id: `${prefix}hook-${hook}`, name: hook === "pre-commit" ? "Pre-commit hook" : "Commit message hook", result: "pending" as const }] as const),
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
      finished = await this.turnToRun(scope, signal);
      if (finished.waited) {
        state = await this.captureState(scope, checks);
        // Another run held the lane. Files and external hook inputs may have changed while waiting.
        kept = await this.savedProductResults(scope, checks, state);
        for (const [id, entry] of entries) if (id.startsWith("hook-") && !state.hooks.includes(id.slice(5))) entry.result = "skipped";
        for (const hook of state.hooks) if (!entries.has(`hook-${hook}`)) {
          const entry: DeepMutable<JourneyProductCheck> = { id: `${prefix}hook-${hook}`, name: hook === "pre-commit" ? "Pre-commit hook" : "Commit message hook", result: "pending" };
          entries.set(`hook-${hook}`, entry);
          if (step) step.productChecks = [...(step.productChecks ?? []), entry];
        }
      }
      const failures = await this.runAll(scope, checks, state, signal, entries, kept);
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

  private async runAll(scope: RepositoryContext, checks: readonly ProductCheck[], state: CheckState, signal: AbortSignal, entries: CheckEntries, kept?: readonly CheckRun[]): Promise<number> {
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
    const progress = (id: string, event: CheckProgress) => {
      if (this.k.stopped || signal.aborted || step?.endedAt !== undefined || openStep(task)?.id !== step?.id) return;
      const check = entries.get(id);
      if (!check) return;
      if (event.kind === "started") { check.result = "running"; check.startedAt = event.at; }
      else {
        check.run = { ...event.run };
        check.result = event.run.ok ? "pass" : event.run.timedOut ? "did-not-finish" : signal.aborted ? "stopped" : "fail";
        check.endedAt = event.at;
        if (!event.run.ok) check.detail = checkDiagnostic(event.run.output);
      }
      const running = step!.productChecks!.filter((entry) => entry.result === "running").map((entry) => entry.name);
      task.statusLine = running.length ? `Running checks: ${running.join(", ")}` : "Finishing the check run";
      this.k.commit();
    };
    let results: CheckRun[];
    let checksRestored = false;
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
        });
      }
      if (signal.aborted) {
        this.noteStopped(scope, ran, entries);
        throw new Aborted();
      }
      await restore(true);
      checksRestored = true;
      const staticFailed = checks.some((check) => staticCheck(check) && ran.some((run) => !run.ok && run.command === commandText(check.argv)));
      hooksStarted = !staticFailed && hooks.length > 0;
      const hooksRan = staticFailed ? [] : await this.runHooks(scope, hooks, env, signal, progress);
      if (signal.aborted) {
        this.noteStopped(scope, [...ran, ...hooksRan], entries);
        throw new Aborted();
      }
      results = [...ran, ...hooksRan];
    } finally {
      // The hooks too: whatever they committed or changed in files git tracks is put back.
      if (!repository.hooking && (!checksRestored || hooksStarted)) await restore();
    }
    const tree = await git.treeOf(repository.worktree, before);
    repository.checks = { current: true, at: Date.now(), ...(before ? { sha: before } : {}), ...(tree ? { tree } : {}), definition, results };
    const checksStep = openStep(task);
    for (const check of checksStep?.productChecks ?? []) if (check.result === "pending") check.result = "skipped";
    const failed = this.settleFindings(scope, results);
    this.k.log(scope, failed.length ? "warn" : "done", failed.length ? `Checks: ${failed.length} of ${results.length} failed (${failed.map((run) => run.name).join(", ")})` : results.length ? `Checks passed: ${results.map((run) => run.name).join(", ")}` : "No product checks or commit hooks to run");
    if (failed.length && openStep(task)?.roleId === "release-manager") {
      endAgentStep(task, { outcome: W.interrupted, reason: W.checksFailed(failed.length), tone: "back", end: "failed" }, Date.now());
    } else {
      endPetrinaStep(task, failed.length ? { outcome: W.checks(failed.length, results.length), reason: W.checksFailed(failed.length), tone: "back" } : { outcome: W.checks(0, results.length), reason: W.checksPassed }, Date.now());
    }
    this.k.commit();
    return failed.length;
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
    const failed = results.filter((run) => !run.ok);
    const product = this.k.productOf(scope);
    const declared = new Set([
      ...(product && repository.worktree ? checksFor(product, repository.worktree) : []).map((check) => `Check failed: ${check.name} (${commandText(check.argv)})`),
      ...(product?.hooks?.includes("pre-commit") ? ["Check failed: Pre-commit hook (git hook run --ignore-missing pre-commit)"] : []),
      ...(product?.hooks?.includes("commit-msg") ? ["Check failed: Commit message hook (git hook run commit-msg)"] : []),
    ]);
    // An earlier failure settles on this run, whatever anyone answered about it.
    for (const finding of task.findings) {
      if (finding.raisedBy === "petrina" && finding.status === "open" && finding.text.startsWith("Check failed") && (!task.repositories || finding.productIds?.includes(repository.productId)) && (!declared.has(finding.text) || results.some((run) => run.ok && finding.text === `Check failed: ${run.name} (${run.command})`))) finding.status = "fixed";
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
  private async definition(scope: RepositoryContext, checks: readonly ProductCheck[], hooks: Awaited<ReturnType<typeof git.commitHookFiles>>): Promise<string> {
    const { work: repository } = scope;
    const hash = createHash("sha256").update(JSON.stringify(checks.filter((check) => check.argv.length).map((check) => check.argv)));
    const [bodies, message] = await Promise.all([
      Promise.all(hooks.map((hook) => readFile(hook.path))),
      hooks.some((hook) => hook.name === "commit-msg") ? git.message(repository.worktree!) : undefined,
    ]);
    for (const [index, hook] of hooks.entries()) {
      hash.update(JSON.stringify([hook.name, hook.path])).update(bodies[index]!);
      if (hook.name === "commit-msg") hash.update(message!);
      if (hook.name === "pre-commit") hash.update(repository.baseSha ?? "");
    }
    return hash.digest("hex");
  }

  /** Reuse one observation within this operation, never as a persistent freshness flag. */
  private async captureState(scope: RepositoryContext, checks: readonly ProductCheck[]): Promise<CheckState> {
    const path = scope.work.worktree!;
    const [status, files, tree] = await Promise.all([git.worktreeStatus(path), git.commitHookFiles(path), git.treeOf(path)]);
    const hooks = await this.noteHooks(scope, files.map((hook) => hook.name));
    return { sha: status.head, tree, trackedChanged: status.trackedChanged, hooks, definition: await this.definition(scope, checks, files) };
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
   * A failure sends the work back to the builder, twice at most; after that the coordinator sees it.
   * Exhausted returns are a failure, never permission to start final acceptance.
   */
  async checksBeforeDelivery(scope: RepositoryContext, signal: AbortSignal): Promise<"passed" | "returned" | "exhausted"> {

    if (!(await this.failing(scope, signal))) return "passed";
    return this.backToBuilder(scope, "right before your delivery check") ? "returned" : "exhausted";
  }

  /**
   * Right before shipping: the checks pass on exactly what ships. Failing, the work goes back to the builder,
   * twice at most, and then to the coordinator's delivery check.
   */
  async checksBeforeShipping(scope: RepositoryContext, signal: AbortSignal): Promise<boolean> {
    const { task, work: repository } = scope;
    if (!(await this.failing(scope, signal))) return false;
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

  /** Reuse a completed run, including failures, until the code or check definition changes. */
  async failing(scope: RepositoryContext, signal: AbortSignal, checks?: readonly ProductCheck[]): Promise<boolean> {
    const { work: repository } = scope;
    if (!repository.worktree) return false;
    const product = this.k.productOf(scope);
    checks ??= product ? checksFor(product, repository.worktree) : [];
    const state = await this.captureState(scope, checks);
    if (await this.ranOn(scope, checks, state)) {
      if (repository.checks) repository.checks.current = true;
      const failed = this.settleFindings(scope, repository.checks!.results);
      this.k.commit();
      return failed.length > 0;
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
  private async runHooks(scope: RepositoryContext, hooks: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal, progress: (id: string, event: CheckProgress) => void): Promise<CheckRun[]> {
    const { task, work: repository } = scope;
    const worktree = repository.worktree!;
    const base = repository.baseSha;
    const branch = repository.branch;
    if (!hooks.length || !base || !branch || (await git.head(worktree).catch(() => base)) === base) return [];
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
      // The message the task's one commit carries, in a file of its own, as git hands it over.
      const folder = await mkdtemp(join(tmpdir(), "petrina-message-"));
      try {
        const file = join(folder, "COMMIT_EDITMSG");
        await writeFile(file, `${await git.message(worktree)}\n`);
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

  /** Failing checks send the work back to the builder, twice at most. */
  backToBuilder(scope: RepositoryContext, when: string): boolean {
    const { task, work: repository } = scope;
    if (task.repositories) return beginRepair(this.k, task, "checks", task.stageIndex);
    const builder = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && this.k.role(entry.roleId)?.result === "build");
    if (builder < 0 || (repository.checkReturns ?? 0) >= 2) return false;
    repository.checkReturns = (repository.checkReturns ?? 0) + 1;
    task.stageIndex = builder;
    task.sub = 0;
    task.fixing = true;
    this.k.log(scope, "warn", `Sent back to the builder: the checks failed ${when}`);
    this.k.commit();
    return true;
  }
}
