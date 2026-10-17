// The product's checks, run by Petrina itself: the Check finder works out the commands, and failing
// checks become findings with the real output. Running commands is in checks.ts.

import { lastIndexWhere, type ProductCheck } from "@petrina/core";
import * as git from "./git.js";
import { CheckFinderResult } from "./roles.js";
import { checksFingerprint, commandText, detectChecks, runChecks } from "./checks.js";
import { agentEnv } from "./env.js";
import { Kernel, Aborted, CHECK_FINDER_PROFILE, type MTask } from "./kernel.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";

export class ProductChecks {
  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context) {}

  /**
   * The product's checks. The Check finder works them out once per product, and again only when the
   * CI or build files it read have changed or a check could not even start. Checks the coordinator set
   * by hand are never replaced. Runs inside a step that already holds an agent slot.
   */
  async ensureChecks(task: MTask, signal: AbortSignal): Promise<readonly ProductCheck[]> {
    const product = this.k.productOf(task);
    if (!product || !task.worktree) return [];
    if (product.checksBy === "coordinator") return product.checks ?? [];
    const fingerprint = checksFingerprint(task.worktree);
    const unstartable = task.checks?.results.some((run) => run.output.startsWith("Could not start")) ?? false;
    if (product.checks && product.checksFingerprint === fingerprint && !unstartable) return product.checks;
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
    const why = !product.checks ? "first time" : unstartable ? "a check could not start" : "the CI or build files changed";
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
        { status: "Working out how to check this product" },
      );
      restore();
      product.checks = result.checks.map((check) => ({ name: check.name, argv: check.argv, why: check.why }));
      this.k.log(task, "done", `Found how to check ${product.name} (${why}): ${product.checks.map((check) => check.name).join(", ")}`, "check-finder", CHECK_FINDER_PROFILE);
    } catch (error) {
      if (signal.aborted || error instanceof Aborted) throw error;
      restore();
      const fallback: ProductCheck[] = product.checks ? [...product.checks] : declared;
      product.checks = fallback.map((check) => ({ name: check.name, argv: [...check.argv], ...(check.why ? { why: check.why } : {}) }));
      this.k.log(task, "warn", `The Check finder could not finish, so Petrina uses ${fallback.length ? "the checks it had" : "no checks"} for now`);
    }
    product.checksBy = "finder";
    product.checksFingerprint = fingerprint;
    this.k.commit();
    return product.checks ?? [];
  }

  /** Petrina runs the product's checks itself, without credentials. Failures become blocking findings, with the output as evidence. */
  async runProductChecks(task: MTask, checks: readonly ProductCheck[], signal: AbortSignal): Promise<number> {
    if (!checks.length || !task.worktree) return 0;
    task.statusLine = "Running the product's checks";
    this.k.commit();
    const env = { ...agentEnv(process.env, await this.k.emptyGhConfig()), CI: "1", BROWSER: "none", PETRINA_AGENT: "1" };
    const results = await runChecks(task.worktree, checks, env, this.k.options.checkTimeoutMs, signal);
    if (signal.aborted) throw new Aborted();
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
    const product = this.k.productOf(task);
    if (!task.worktree || !product?.checks?.length) return false;
    if ((await this.ranOn(task)) && task.checks!.results.every((run) => run.ok)) return false;
    if ((await this.runProductChecks(task, product.checks, signal)) === 0) return false;
    const builder = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.roleId === "builder");
    if (builder < 0 || (task.checkReturns ?? 0) >= 2) return false;
    task.checkReturns = (task.checkReturns ?? 0) + 1;
    task.stageIndex = builder;
    task.sub = 0;
    task.fixing = true;
    this.k.log(task, "warn", "Sent back to the builder: the checks failed right before your delivery check");
    this.k.commit();
    return true;
  }
}
