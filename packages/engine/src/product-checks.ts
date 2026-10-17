// The product's checks, run by Petrina itself: the Check finder works out the commands, and failing
// checks become findings with the real output. Running commands is in checks.ts.

import { lastIndexWhere, type Id, type ProductCheck } from "@petrina/core";
import * as git from "./git.js";
import { CheckFinderResult } from "./roles.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckRun } from "@petrina/core";
import { CHECKS_SEEN, checksFingerprint, checksFor, detectChecks, runChecks, commandText } from "./checks.js";
import { withoutCredentials } from "./env.js";
import { Kernel, Aborted, CHECK_FINDER_PROFILE, type MTask } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";

export class ProductChecks {
  /**
   * Tasks' checks take turns: a product's full test suite and build, several at once on one machine (with a
   * security scanner looking at every process they start), is slower for each and times out for nothing.
   */
  private running = 0;
  private readonly line: (() => void)[] = [];

  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context) {}

  private async turnToRun(task: MTask, signal: AbortSignal): Promise<() => void> {
    const most = this.k.options.checkRuns ?? Math.max(1, Math.floor(cpus().length / 6));
    if (this.running >= most) {
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
        signal.addEventListener("abort", stop, { once: true });
      });
    }
    this.running += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.running -= 1;
      this.line.shift()?.();
    };
  }

  /**
   * The product's checks. The Check finder works them out once per product, and again only when the
   * CI, build or hook files it read have changed or a check could not even start. Checks the coordinator set
   * by hand are never replaced. Runs inside a step that already holds an agent slot.
   */
  async ensureChecks(task: MTask, signal: AbortSignal): Promise<readonly ProductCheck[]> {
    const product = this.k.productOf(task);
    if (!product || !task.worktree) return [];
    if (product.checksBy === "coordinator") return product.checks ?? [];
    const fingerprint = checksFingerprint(task.worktree);
    const unstartable = task.checks?.results.some((run) => run.output.startsWith("Could not start")) ?? false;
    if (product.checks && product.checksFingerprint === fingerprint && !unstartable) return product.checks;
    // Tasks on different bases have different CI and build files: each reuses what was found for its own.
    const seen = product.checksSeen?.find((entry) => entry.fingerprint === fingerprint);
    if (seen && !unstartable) return seen.checks;
    const declared = detectChecks(task.worktree);
    // A side errand inside the step: it leaves the step's own restart bookkeeping as it found it.
    const attempts = task.stepAttempts;
    const conversation = task.conversation;
    const restore = () => {
      if (attempts === undefined) delete task.stepAttempts;
      else task.stepAttempts = attempts;
      if (conversation === undefined) delete task.conversation;
      else task.conversation = conversation;
    };
    const why = !product.checks ? "first time" : unstartable ? "a check could not start" : "the CI, build or hook files changed";
    let ran: Id = CHECK_FINDER_PROFILE;
    try {
      const result = await this.turns.turn(
        task,
        "check-finder",
        CHECK_FINDER_PROFILE,
        () => [
          ...this.context.sectionsFor(task, "check-finder"),
          ...(product.checks ? [{ title: "The checks used until now", body: product.checks.map((check) => `- ${check.name}: ${commandText(check.argv)}`).join("\n") }] : []),
          ...(declared.length ? [{ title: "Commands the repository declares (a starting point, not the answer)", body: declared.map((check) => `- ${check.name}: ${commandText(check.argv)}`).join("\n") }] : []),
        ],
        CheckFinderResult,
        signal,
        { status: "Working out how to check this product", used: (id) => (ran = id) },
      );
      restore();
      product.checks = result.checks.map((check) => ({ name: check.name, argv: check.argv, why: check.why }));
      this.k.log(task, "done", `Found how to check ${product.name} (${why}): ${product.checks.map((check) => check.name).join(", ")}`, "check-finder", CHECK_FINDER_PROFILE);
    } catch (error) {
      if (signal.aborted || error instanceof Aborted) throw error;
      restore();
      // Everyone who could work it is out of usage: the task waits, and the finder runs when one is back.
      if (error instanceof WaitingForUsage) throw error;
      // Petrina carries on without it, but it is still a failure in Analytics.
      this.k.tracking.failed(task, error, { roleId: "check-finder", profileId: ran });
      const fallback: ProductCheck[] = product.checks ? [...product.checks] : declared;
      product.checks = fallback.map((check) => ({ name: check.name, argv: [...check.argv], ...(check.why ? { why: check.why } : {}) }));
      this.k.log(task, "warn", `The Check finder could not finish, so Petrina uses ${fallback.length ? "the checks it had" : "no checks"} for now`);
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
  async runProductChecks(task: MTask, checks: readonly ProductCheck[], signal: AbortSignal): Promise<number> {
    if (!task.worktree) return 0;
    const hooks = await this.noteHooks(task);
    if (!checks.length && !hooks.length) return 0;
    const finished = await this.turnToRun(task, signal);
    try {
      return await this.runAll(task, checks, hooks, signal);
    } finally {
      finished();
    }
  }

  private async runAll(task: MTask, checks: readonly ProductCheck[], hooks: string[], signal: AbortSignal): Promise<number> {
    if (!task.worktree) return 0;
    task.statusLine = "Running the product's checks";
    this.k.commit();
    // Checks and hooks are the repository's own code: whatever they commit or change, the work stays as it was.
    const before = await git.head(task.worktree);
    const env = { ...withoutCredentials(process.env, await this.k.emptyGhConfig()), CI: "1", BROWSER: "none", PETRINA_AGENT: "1" };
    let results: CheckRun[];
    try {
      const ran = await runChecks(task.worktree, checks, env, this.k.options.checkTimeoutMs, signal);
      if (signal.aborted) throw new Aborted();
      if ((await git.head(task.worktree).catch(() => "")) !== before) {
        await git.resetTo(task.worktree, before);
        this.k.log(task, "warn", "A check made a commit, so Petrina put the work back as it was: checks only look, and fixes come from the builder");
      } else if (await git.trackedChanged(task.worktree)) {
        await git.restoreTracked(task.worktree);
        this.k.log(task, "warn", "A check changed files, so Petrina put them back: checks only look, and fixes come from the builder");
      }
      results = [...ran, ...(await this.runHooks(task, hooks, env, signal))];
    } finally {
      // The hooks too: whatever they committed or changed in files git tracks is put back.
      if (!task.hooking) {
        if ((await git.head(task.worktree).catch(() => "")) !== before) await git.resetTo(task.worktree, before);
        else if (await git.trackedChanged(task.worktree)) await git.restoreTracked(task.worktree);
      }
    }
    const [sha, tree] = await Promise.all([git.head(task.worktree).catch(() => undefined), git.treeOf(task.worktree)]);
    task.checks = { at: Date.now(), ...(sha ? { sha } : {}), ...(tree ? { tree } : {}), results };
    const failed = results.filter((run) => !run.ok);
    // An earlier failure settles on this run, whatever anyone answered about it.
    for (const finding of task.findings) {
      if (finding.raisedBy === "petrina" && finding.status === "open" && finding.text.startsWith("Check failed") && !failed.some((run) => finding.text === `Check failed: ${run.name} (${run.command})`)) finding.status = "fixed";
    }
    for (const run of failed) {
      const text = `Check failed: ${run.name} (${run.command})`;
      if (task.findings.some((finding) => finding.text === text && finding.status === "open")) continue;
      task.findings.push({ id: this.k.id(task.id), text, evidence: run.output.slice(-1500), severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
    }
    this.k.log(task, failed.length ? "warn" : "done", failed.length ? `Checks: ${failed.length} of ${results.length} failed (${failed.map((run) => run.name).join(", ")})` : `Checks passed: ${results.map((run) => run.name).join(", ")}`);
    this.k.commit();
    return failed.length;
  }

  /** Whether the last run of the checks was on the code the task has now (its tree: a squash keeps it). */
  async ranOn(task: MTask): Promise<boolean> {
    if (!task.checks || !task.worktree) return false;
    const [sha, tree] = await Promise.all([git.head(task.worktree).catch(() => undefined), git.treeOf(task.worktree)]);
    return (!!tree && task.checks.tree === tree) || (!!sha && task.checks.sha === sha);
  }

  /**
   * Right before the delivery check: the checks run again when the code changed since they last ran.
   * A failure sends the work back to the builder, twice at most; after that the coordinator sees it.
   */
  async checksBeforeDelivery(task: MTask, signal: AbortSignal): Promise<boolean> {
    return (await this.failing(task, signal)) && this.backToBuilder(task, "right before your delivery check");
  }

  /**
   * Right before shipping: the checks pass on exactly what ships. Failing, the work goes back to the builder,
   * twice at most, and then to the coordinator's delivery check.
   */
  async checksBeforeShipping(task: MTask, signal: AbortSignal): Promise<boolean> {
    if (!(await this.failing(task, signal))) return false;
    if (this.backToBuilder(task, "on what was about to ship")) return true;
    const check = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.gate === "delivery");
    if (check < 0) throw new Error("The product's checks fail on the work about to ship");
    delete task.approvedSha;
    delete task.approvedPatch;
    delete task.approvedFor;
    task.stageIndex = check;
    task.sub = 0;
    this.k.log(task, "warn", "The checks fail on what was about to ship, so Petrina asks you again");
    this.k.commit();
    return true;
  }

  /** Whether the checks (and the repository's commit hooks) fail on the code the task has now, running them unless they already passed on it. */
  async failing(task: MTask, signal: AbortSignal): Promise<boolean> {
    if (!task.worktree) return false;
    if ((await this.ranOn(task)) && task.checks!.results.every((run) => run.ok)) return false;
    const product = this.k.productOf(task);
    return (await this.runProductChecks(task, product ? checksFor(product, task.worktree) : [], signal)) > 0;
  }

  /** The repository's commit hooks, as git would run them now, noted on the product for the builder's instructions. */
  async noteHooks(task: MTask): Promise<string[]> {
    const hooks: string[] = await git.commitHooks(task.worktree!);
    const product = this.k.productOf(task);
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
  private async runHooks(task: MTask, hooks: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<CheckRun[]> {
    const worktree = task.worktree!;
    const base = task.baseSha;
    const branch = task.branch;
    if (!hooks.length || !base || !branch || (await git.head(worktree).catch(() => base)) === base) return [];
    const runs: CheckRun[] = [];
    if (hooks.includes("pre-commit")) {
      // On disk before HEAD moves: a restart while it is detached puts it back on the branch.
      task.hooking = true;
      this.k.commitNow();
      await git.detachAt(worktree, base);
      try {
        runs.push(...(await runChecks(worktree, [{ name: "Pre-commit hook", argv: ["git", "hook", "run", "--ignore-missing", "pre-commit"] }], env, this.k.options.checkTimeoutMs, signal)));
      } finally {
        await git.reattach(worktree, branch);
        delete task.hooking;
        this.k.commit();
      }
    }
    if (hooks.includes("commit-msg") && !signal.aborted) {
      // The message the task's one commit carries, in a file of its own, as git hands it over.
      const folder = await mkdtemp(join(tmpdir(), "petrina-message-"));
      try {
        const file = join(folder, "COMMIT_EDITMSG");
        await writeFile(file, `${await git.message(worktree)}\n`);
        const [run] = await runChecks(worktree, [{ name: "Commit message hook", argv: ["git", "hook", "run", "--ignore-missing", "commit-msg", "--", file] }], env, this.k.options.checkTimeoutMs, signal);
        if (run) runs.push({ ...run, command: "git hook run commit-msg" });
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    }
    if (signal.aborted) throw new Aborted();
    return runs;
  }

  /** Failing checks send the work back to the builder, twice at most. */
  private backToBuilder(task: MTask, when: string): boolean {
    const builder = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.roleId === "builder");
    if (builder < 0 || (task.checkReturns ?? 0) >= 2) return false;
    task.checkReturns = (task.checkReturns ?? 0) + 1;
    task.stageIndex = builder;
    task.sub = 0;
    task.fixing = true;
    this.k.log(task, "warn", `Sent back to the builder: the checks failed ${when}`);
    this.k.commit();
    return true;
  }
}
