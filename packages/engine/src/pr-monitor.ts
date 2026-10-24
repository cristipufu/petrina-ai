import type { ShippingVerifier, DeliveryEvidence } from "./shipping-verifier.js";
// Observe PRs and interrupted cancelled deliveries. This module never publishes.
import { CLEANUP_WORDS, needsPullRequestCheck, repositoryDelivered, type Id, type Task } from "@petrina/core";
import * as github from "./github.js";
import type { Kernel, MTask } from "./kernel.js";
import { executionFor, type RepositoryContext } from "@petrina/orchestrator";
import { Unreachable } from "./connection.js";

interface DeliveryRecorder {
  recordDelivery(scope: RepositoryContext, evidence: DeliveryEvidence, signal: AbortSignal): Promise<"done" | "unknown">;
  finishMany(task: MTask): void;
}
type MonitorHost = Pick<Kernel, "task" | "stopped" | "drivers" | "settling" | "log" | "commitNow" | "commit" | "tidy" | "s" | "trackWork" | "repositoryOf" | "options" | "onTaskDone" | "tracking" | "schedule">;
export class PrMonitor {
  private readonly looking = new Set<Id>();
  private readonly following = new Set<Id>();
  constructor(private readonly k: MonitorHost, private readonly verifier: ShippingVerifier, private readonly delivery: DeliveryRecorder) {}

  // ── Cancelled while publishing ─────────────────────────────────────────

  /**
   * A task cancelled during a publishing step: the same check as after any interruption looks up what went
   * out and keeps its link, and nothing more is published. The task stays cancelled. When GitHub cannot be
   * asked, Petrina asks again at the next check and after a restart, so nothing that went out stays hidden.
   * `fromDriver`: called as the task's own driver ends; otherwise it waits for a running driver to end.
   */
  async settleCancelled(taskId: Id, fromDriver = false): Promise<void> {
    const task = this.k.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (this.k.stopped || task?.state !== "cancelled" || !scope!.work.shipping?.step || !scope!.work.shipping.prepared || this.looking.has(taskId)) return;
    if (!fromDriver && (this.k.drivers.has(taskId) || this.k.settling.has(taskId))) return;
    this.looking.add(taskId);
    try {
      const delivery = await this.verifier.lookForDelivery(scope!);
      if (delivery.found === "unknown") return this.keepCancelledCopy(task);
      if (delivery.found === true) {
        const recorded = await this.delivery.recordDelivery(scope!, delivery.evidence, new AbortController().signal);
        if (recorded === "unknown") return this.keepCancelledCopy(task);
      }
      else if (delivery.found === "other") this.k.log(task, "warn", `After you cancelled it, Petrina could not tell what went out: ${delivery.text}`);
      else if (scope!.work.source?.start.kind === "pull-request") {
        const start = scope!.work.source.start;
        scope!.work.pr = { number: start.number, url: start.url, state: "open", openedAt: scope!.work.pr?.openedAt ?? Date.now() };
        this.k.log(task, "status", `PR #${start.number} is still open. The checked work was not published: ${start.url}`);
      }
      else if (scope!.work.delivery === "release") await this.pushedWhileCancelled(task);
      // Looked up: what went out is recorded, and the delivery is over.
      delete scope!.work.shipping;
      this.k.commitNow();
    } catch (error) {
      if (error instanceof Unreachable) return this.keepCancelledCopy(task);
      this.k.log(task, "warn", `After you cancelled it, Petrina could not tell what went out: ${error instanceof Error ? error.message : String(error)}`);
      delete scope!.work.shipping;
      this.k.commitNow();
    } finally {
      this.looking.delete(taskId);
      this.k.tidy(taskId);
    }
  }

  /** Explain the retained copy once, including across retries and restarts, without an inbox item. */
  private keepCancelledCopy(task: MTask): void {
    const scope = executionFor(task);
    if (scope.work.cleanup?.error !== undefined) return;
    scope.work.cleanup = { error: CLEANUP_WORDS.unconfirmed };
    this.k.log(task, "warn", CLEANUP_WORDS.failed(CLEANUP_WORDS.unconfirmed));
    this.k.commit();
  }

  settleCancelledTasks(): void {
    for (const task of this.k.s.tasks) if (task.state === "cancelled" && executionFor(task).work.shipping?.step) void this.k.trackWork(this.settleCancelled(task.id));
  }

  /** A cancelled release with no release on GitHub: say so when its push of the default branch and tag went out. */
  private async pushedWhileCancelled(task: MTask): Promise<void> {
    const scope = executionFor(task);
    const shipping = scope.work.shipping!;
    const { tested } = shipping.prepared!;
    const refs = await this.verifier.releaseRefs(scope);
    if (refs.tag === tested) this.k.log(task, "status", `${this.k.repositoryOf(task)?.defaultBranch ?? "main"} and the tag ${shipping.tag} went out to GitHub at ${tested.slice(0, 7)} while you cancelled it, with no release for that tag`);
  }

  /** An uncertain finished delivery: only GitHub can establish whether its copy is free, including after cancellation. */
  async checkUnrecordedPullRequest(scope: RepositoryContext): Promise<void> {
    const { task, work: repository } = scope;
    const finished = () => task.state === "done" || task.state === "cancelled";
    if (this.k.stopped || !needsPullRequestCheck(task as Task) || !finished() || this.following.has(task.id)) return;
    this.following.add(task.id);
    try {
      const product = this.k.repositoryOf(scope);
      // Older local deliveries may have published something themselves, but a computer-only product has no GitHub to ask.
      if (repository.delivery === "local" && product?.repo.startsWith("local/")) {
        repository.cleanup = { ...repository.cleanup, pullRequest: "none" };
        if (repository.cleanup.error === CLEANUP_WORDS.unconfirmedPr) delete repository.cleanup.error;
        this.k.commit();
        return;
      }
      const repo = product?.repo;
      const result = repo && repository.branch ? await github.pullRequests(repo, repository.branch, this.k.options.gh) : undefined;
      if (this.k.stopped || !finished()) return;
      if (!result?.ok) {
        if (!repository.cleanup?.error) this.k.log(scope, "warn", CLEANUP_WORDS.failed(CLEANUP_WORDS.unconfirmedPr));
        repository.cleanup = { ...repository.cleanup, error: CLEANUP_WORDS.unconfirmedPr };
      } else {
        const ours = result.value.filter((pr) => pr.head === repository.branch && !pr.fork);
        const checked = repository.cleanup?.checkedDelivery;
        let pr: github.PullRequestInfo | undefined;
        if (checked) {
          for (const candidate of ours) if (await this.verifier.matchesPullRequest(scope, candidate, checked.tested, checked.base)) { pr = candidate; break; }
        } else {
          // Older deliveries did not record a checked commit. Keep their existing conservative
          // branch tracking so an open pull request can never lose its working copy.
          pr = ours.find((entry) => entry.state === "open") ?? ours.sort((a, b) => b.number - a.number)[0];
        }
        if (this.k.stopped || !finished()) return;
        const foreign = checked ? ours.find((entry) => entry.state === "open" && entry.number !== pr?.number) : undefined;
        const previousForeign = repository.cleanup?.foreignPullRequest;
        repository.cleanup = { ...repository.cleanup, pullRequest: "none" };
        if (repository.cleanup.error === CLEANUP_WORDS.unconfirmedPr) delete repository.cleanup.error;
        if (foreign) {
          repository.cleanup.foreignPullRequest = { number: foreign.number, url: foreign.url };
          if (previousForeign?.number !== foreign.number) this.k.log(scope, "warn", `Pull request #${foreign.number} uses this branch but is not the checked work. Its working copy is kept until that pull request closes`);
        } else {
          delete repository.cleanup.foreignPullRequest;
          if (previousForeign) this.k.log(scope, "status", `The other pull request #${previousForeign.number} is no longer open on GitHub`);
        }
        if (pr) {
          repository.pr = { number: pr.number, url: pr.url, state: pr.state, openedAt: Date.now() };
          this.k.log(scope, "done", pr.state === "open" ? `Pull request #${pr.number} is still open on GitHub, so its working copy is kept` : pr.state === "merged" ? `Merged #${pr.number} on GitHub` : `Closed #${pr.number} without merging`);
        }
      }
      this.k.commit();
    } catch {
      if (this.k.stopped || !finished()) return;
      if (!repository.cleanup?.error) this.k.log(scope, "warn", CLEANUP_WORDS.failed(CLEANUP_WORDS.unconfirmedPr));
      repository.cleanup = { ...repository.cleanup, pullRequest: "unconfirmed", error: CLEANUP_WORDS.unconfirmedPr };
      this.k.commit();
    } finally {
      this.following.delete(task.id);
      this.k.tidy(task.id);
    }
  }

  /**
   * Petrina never merges or closes a pull request; it only reads what happened on GitHub. A cancelled task is
   * followed too while it keeps its working copy for an open pull request; it stays cancelled when that ends.
   * Unless GitHub confirms the pull request ended, it is still open, and the copy stays.
   */
  async pollPullRequests(): Promise<void> {
    for (const task of this.k.s.tasks.filter((entry) => entry.repositories)) {
      if (this.k.stopped || this.k.drivers.has(task.id) || this.following.has(task.id)) continue;
      this.following.add(task.id);
      try {

        const pending = task.repositories!.filter((work) => work.pr?.state === "open").map((work) => ({ work, pr: work.pr! }));
        const states = await Promise.all(pending.map(({ work, pr }) => github.prState(work.source!.product.repo, pr.number, this.k.options.gh).catch(() => undefined)));
        if (this.k.stopped || this.k.drivers.has(task.id)) continue;
        for (const [index, { work, pr }] of pending.entries()) {
          const state = states[index];
          if (work.pr !== pr || pr.state !== "open") continue;
          if (state === "merged" || state === "closed") {
            work.pr.state = state;

            this.k.log(task, "done", `${work.source!.product.name}: ${state === "merged" ? "Pull request merged" : "Pull request closed without merging"}`);
          }
        }
        if ((task.state !== "cancelled" && task.repositories!.every(repositoryDelivered)) || task.repositories!.some((work) => work.pr?.state === "closed" && !work.landingAccepted)) this.delivery.finishMany(task);
      } finally { this.following.delete(task.id); }
    }
    const following = (task: MTask) => executionFor(task).work.pr?.state === "open" && !!executionFor(task).work.worktree && (task.state === "pr-open" || ((task.state === "done" || task.state === "cancelled") && executionFor(task).work.cleanup?.removedAt === undefined));
    await Promise.all([...this.k.s.tasks.filter((task) => !task.repositories && needsPullRequestCheck(task as Task)).map((task) => this.checkUnrecordedPullRequest(executionFor(task))), ...this.k.s.tasks.filter((task) => !task.repositories && following(task)).map(async (task) => {
      if (this.k.stopped || this.following.has(task.id)) return;
      this.following.add(task.id);
      try {
        const repo = this.k.repositoryOf(task)?.repo;
        const state = repo ? await github.prState(repo, executionFor(task).work.pr!.number, this.k.options.gh).catch(() => undefined) : undefined;
        if (this.k.stopped || (state !== "merged" && state !== "closed") || !following(task)) return;
        executionFor(task).work.pr!.state = state;
        const words = state === "merged" ? `Merged #${executionFor(task).work.pr!.number} on GitHub` : `Closed #${executionFor(task).work.pr!.number} without merging`;
        if (task.state === "pr-open") {
          task.state = "done";
          task.column = "done";
          task.finishedAt = Date.now();
          task.statusLine = words;
          this.k.log(task, "done", words);
          this.k.onTaskDone?.(task);
        } else {
          this.k.log(task, "done", words);
        }
        this.k.tracking.prSettled(task, state);
        this.k.commit();
        // Tasks waiting for this one to land can start now.
        this.k.schedule();
        this.k.tidy(task.id);
      } finally {
        this.following.delete(task.id);
      }
    })]);
  }
}
