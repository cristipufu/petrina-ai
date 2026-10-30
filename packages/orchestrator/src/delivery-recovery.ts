import {
  CLEANUP_WORDS,
  beginYouStep,
  endOpenStep,
  endPetrinaStep,
  endYouStep,
  JOURNEY_WORDS,
  lastIndexWhere,
  openStep,
  landingState,
  syncRuntimeWait,
  type Id
} from "@petrina/core";
import { executionFor, type RepositoryContext } from "./repository-context.js";
import type { RuntimeTask } from "./model.js";
import type {
  DeliveryEvidence,
  DeliveryRecoveryEffects,
  DeliveryRecoveryHost,
  DeliveryRecoveryFailures,
  PullRequestCreationEffects,
  ReleaseCreationEffects
} from "./ports/delivery-recovery.js";

/** A delivery from before the update, which Petrina leaves to the coordinator. */
export const CARRIED_OVER = "This delivery was interrupted before Petrina was updated";

/** Decide what observed delivery means, and record recovery without performing native publication. */
export class DeliveryRecovery {
  constructor(
    private readonly host: DeliveryRecoveryHost,
    private readonly effects: DeliveryRecoveryEffects,
    private readonly failures: DeliveryRecoveryFailures
  ) {}

  /** A successful or duplicate create still needs an exact observation before recording. */
  async createPullRequest(scope: RepositoryContext, signal: AbortSignal, effects: PullRequestCreationEffects): Promise<"done"> {
    const opened = await effects.create();
    if (signal.aborted) throw this.failures.aborted();
    if (!opened.ok && !opened.exists) throw new Error(`GitHub did not open the pull request (${opened.error}). Retry: Petrina looks for it on GitHub before opening another.`);
    const pr = await effects.find();
    if (!pr) throw new Error(opened.ok
      ? "GitHub said it opened the pull request, but Petrina cannot find it for this branch and commit. Retry to check again."
      : `GitHub says a pull request already exists for this branch, but none matches this work (${opened.error}). Look at it on GitHub, then retry or cancel.`);
    return this.recordPr(scope, pr, "opened");
  }

  async createRelease(scope: RepositoryContext, signal: AbortSignal, effects: ReleaseCreationEffects): Promise<"done"> {
    const { tested } = scope.work.shipping!.prepared!;
    const tag = scope.work.shipping!.tag!;
    const created = await effects.create();
    if (signal.aborted) throw this.failures.aborted();
    if (!created.ok && !created.exists) throw new Error(`GitHub did not create the release ${tag} (${created.error}). Retry: Petrina looks for it on GitHub before creating another.`);
    const release = await effects.find();
    if (!release) throw new Error(`GitHub ${created.ok ? "said it created" : "says it already has"} the release ${tag}, but Petrina cannot find it. Retry to check again.`);
    if (await effects.tag() !== tested) throw new Error(`The release ${tag} is on GitHub, but its tag is not at the tested commit ${tested.slice(
      0,
      7
    )}. Look at it on GitHub.`);
    return this.recordRelease(scope, release, "published");
  }

  async checkDelivery(scope: RepositoryContext, signal: AbortSignal): Promise<"continue" | "stop"> {
    const { task, work: repository } = scope;
    const shipping = repository.shipping!;
    const interrupted = shipping.step !== undefined;
    const when = interrupted && shipping.boot !== this.host.boot ? " after a restart" : "";
    if (interrupted) {
      task.statusLine = "Checking whether it already went out";
      this.host.commit();
    }
    const delivery = await this.effects.lookForDelivery(scope);
    if (signal.aborted) throw this.failures.aborted();
    if (delivery.found === true) {
      this.host.log(scope, "done", `Found${when} that it had already gone out: ${delivery.text}`);
      await this.recordDelivery(scope, delivery.evidence, signal);
      return "stop";
    }
    if (delivery.found === false) {
      if (interrupted) this.host.log(scope, "status", `Checked${when}: ${delivery.text} Petrina carries on publishing.`);
      return "continue";
    }
    if (!interrupted) throw delivery.found === "unknown" ? this.failures.unreachable(delivery.text) : new Error(delivery.text);
    delete task.agent;
    task.holdsSlot = false;
    task.statusLine = "Shipping was interrupted. Your call";
    endPetrinaStep(task, { outcome: JOURNEY_WORDS.interrupted, reason: JOURNEY_WORDS.shippingInterrupted, tone: "back" }, this.host.now());
    beginYouStep(task, "shipping", this.host.now());
    this.host.raise(scope, "shipping", `Shipping “${task.title}” was interrupted`, false, {
      body: `${delivery.text} Petrina will not publish it again on its own: check again, ship it again (it gets ready again, and Petrina checks GitHub before publishing), or mark it as done if it went out another way.`,
    });
    this.host.log(scope, "warn", `Shipping was interrupted${when}. ${delivery.text}`);
    this.host.commitNow();
    return "stop";
  }


  /** Observations alone never complete publishing. The state machine owns recording and local recovery. */
  async recordDelivery(scope: RepositoryContext, evidence: DeliveryEvidence, signal: AbortSignal): Promise<"done" | "unknown"> {
    if (evidence.kind === "pr") return this.recordPr(scope, evidence.pr, evidence.updated ? "updated" : undefined);
    if (evidence.kind === "release") return this.recordRelease(scope, evidence.release);
    if (scope.task.state === "cancelled") return await this.effects.noteCancelledLocal(scope) === "unknown" ? "unknown" : "done";
    return this.effects.landLocal(scope, signal, evidence.tested, "found");
  }

  recordPr(scope: RepositoryContext, pr: { number: number; url: string; state: "open" | "merged" | "closed" }, how?: "opened" | "updated"): "done" {
    const { task, work: repository } = scope;
    repository.pr = { number: pr.number, url: pr.url, state: pr.state, openedAt: repository.pr?.openedAt ?? this.host.now() };
    // GitHub answered: an open pull request now explains why the copy stays. Its earlier warning stays in history.
    if (pr.state === "open" && repository.cleanup?.error === CLEANUP_WORDS.unconfirmed) delete repository.cleanup;
    delete repository.shipping;
    if (task.state === "cancelled") {
      this.host.log(scope, "status", `Pull request #${pr.number} went out while you cancelled it: ${pr.url}`);
    } else {
      if (how) this.host.log(
        scope,
        "done",
        how === "updated" ? `Updated PR #${pr.number}: ${repository.report?.summary ?? "The checked work was added"}. Delivered to ${repository.source!.destination.repo} · ${repository.source!.destination.branch}` : `Petrina opened pull request #${pr.number}, and checked it on GitHub`
      );
      if (!task.repositories) this.host.delivered(scope);
      endPetrinaStep(
        task,
        { outcome: how === "updated" ? `Updated pull request #${pr.number}` : how ? JOURNEY_WORDS.openedPr(pr.number) : JOURNEY_WORDS.alreadyOut(`pull request #${pr.number}`) },
        this.host.now()
      );
      if (task.repositories) {
        this.saveOutcome();
        return "done";
      }
      if (pr.state === "open") {
        delete task.agent;
        task.holdsSlot = false;
        task.state = "pr-open";
        task.column = "ready";
        task.statusLine = how === "updated" ? `Updated PR #${pr.number}. Merge it on GitHub when you are happy` : `Pull request #${pr.number} is open. Merge it on GitHub when you are happy`;
        syncRuntimeWait(task, id => this.host.taskDetails(id), this.host.now());
      } else {
        this.finished(scope, pr.state === "merged" ? `Merged #${pr.number} on GitHub` : `Closed #${pr.number} without merging`);
      }
    }
    this.saveOutcome();
    return "done";
  }

  async recordRelease(scope: RepositoryContext, release: { tag: string; url: string }, how?: "published"): Promise<"done"> {
    const { task, work: repository } = scope;
    const sha = repository.shipping?.prepared?.tested;
    if (sha) await this.effects.rememberDelivery(scope, sha, repository.source?.destination.branch ?? this.host.repository(scope)?.defaultBranch ?? "main");
    repository.release = release;
    delete repository.shipping;
    if (task.state === "cancelled") this.host.log(scope, "status", `Release ${release.tag} went out while you cancelled it: ${release.url}`);
    else {
      if (how) this.host.log(scope, "done", `Petrina published release ${release.tag}, and checked it on GitHub`);
      if (!task.repositories) this.host.delivered(scope);
      endPetrinaStep(task, { outcome: how ? JOURNEY_WORDS.released(release.tag) : JOURNEY_WORDS.alreadyOut(`release ${release.tag}`) }, this.host.now());
      this.finished(scope, `Released ${release.tag}`);
    }
    this.saveOutcome();
    return "done";
  }


  async recordLanded(scope: RepositoryContext, branch: string, sha: string, how?: "found" | "moved"): Promise<"done"> {
    const { task, work: repository } = scope;
    if (!repository.localUpdate || repository.localUpdate.pushed) await this.effects.rememberDelivery(scope, sha, branch);
    repository.landed = { branch, sha: sha.slice(0, 7) };
    // A local move is not a push. `localUpdate.pushed` is set only after GitHub is shown to have the commit.
    delete repository.shipping;
    if (task.state === "cancelled") {
      this.host.log(scope, "status", repository.localUpdate && !repository.localUpdate.pushed
        ? `${branch} moved forward in the local copy while you cancelled it (${sha.slice(0, 7)}). Its push to GitHub did not finish.`
        : `${branch} moved forward to it while you cancelled it (${sha.slice(0, 7)})`);
    }
    else {
      if (!task.repositories) this.host.delivered(scope);
      if (how) this.host.log(
        scope,
        "done",
        how === "found" ? `Checked: ${branch} already has it (${sha.slice(
        0,
        7
      )})` : `Petrina moved ${branch} forward to it (${sha.slice(
        0,
        7
      )}), and checked the main copy`
      );
      endPetrinaStep(task, { outcome: how === "moved" ? JOURNEY_WORDS.movedMain(branch) : JOURNEY_WORDS.alreadyOut(`${branch} has it`) }, this.host.now());
      this.finished(scope, `Committed to ${branch}`);
    }
    this.saveOutcome();
    return "done";
  }

  /** A verified delivery stays completed even when saving fails: removing its copy may free the disk. */
  private saveOutcome(): void {
    try {
      this.host.commitNow();
    } catch {
      this.host.commit();
    }
  }

  finished(scope: RepositoryContext, statusLine: string): void {
    const { task } = scope;
    if (task.repositories) {
      task.statusLine = statusLine;
      return;
    }
    delete task.agent;
    task.holdsSlot = false;
    task.state = "done";
    task.column = "done";
    task.finishedAt = this.host.now();
    task.statusLine = statusLine;
    syncRuntimeWait(task, id => this.host.taskDetails(id), this.host.now());
    this.host.done(task);
  }

  // ── From before this version ───────────────────────────────────────────

  /**
   * Deliveries a Petrina from before it published deliveries saved while its delivery agent published them with a GitHub login:
   * Petrina cannot tell what went out, so it never acts on one by itself, and asks the coordinator instead.
   */
  carryOverShipping(): void {
    for (const task of this.host.state.tasks) {
      const saved: unknown = executionFor(task).work.shipping;
      if (!saved || typeof saved !== "object" || ("moves" in saved && typeof saved.moves === "number" && "failures" in saved && typeof saved.failures === "number")) continue;
      // Delivered already: nothing is left to decide.
      if (task.state === "done" || task.state === "pr-open") {
        delete executionFor(task).work.shipping;
        continue;
      }
      executionFor(task).work.shipping = { moves: 0, failures: 0, carriedOver: true };
      if (task.state === "cancelled") task.statusLine = `Cancelled. ${CARRIED_OVER}: check GitHub for what went out`;
      if (!["running", "waiting", "needs-you"].includes(task.state)) continue;
      // What the old version asked about this delivery goes: the coordinator's choice replaces it.
      this.host.state.inbox = this.host.state.inbox.filter((item) => item.taskId !== task.id);
      this.askCarriedOver(task);
    }
  }

  /**
   * A delivery from before the update: nothing happens, not even an update from GitHub, until the coordinator
   * checks GitHub and chooses: it went out (mark as done), or ship it again.
   */
  askCarriedOver(task: RuntimeTask): void {
    const scope = executionFor(task);
    delete task.agent;
    delete scope.work.conversation;
    task.holdsSlot = false;
    task.statusLine = `${CARRIED_OVER}: check GitHub, then choose`;
    if (!this.host.state.inbox.some((item) => item.taskId === task.id && item.kind === "shipping")) {
      // The step that was delivering ends as interrupted, and the task waits for the coordinator's choice.
      if (openStep(task)?.kind !== "you") endOpenStep(
        task,
        {
        outcome: JOURNEY_WORDS.interrupted,
        reason: JOURNEY_WORDS.shippingInterrupted,
        tone: "back"
      },
        this.host.now()
      );
      beginYouStep(task, "shipping", this.host.now());
      this.host.raise(task, "shipping", `Shipping “${task.title}” was interrupted`, false, {
        body: `${CARRIED_OVER}: check GitHub, then choose. Its delivery agent published deliveries itself then, so Petrina cannot tell what went out, and does nothing with it until you choose.`,
      });
      this.host.log(task, "warn", `${CARRIED_OVER}: check GitHub, then choose`);
    }
    task.state = "needs-you";
    this.host.commitNow();
  }

  // ── The coordinator's choices ──────────────────────────────────────────

  private takeShippingItem(itemId: Id): RuntimeTask | undefined {
    if (this.host.state.inbox.find((entry) => entry.id === itemId)?.kind !== "shipping") return undefined;
    const item = this.host.takeItem(itemId);
    return item && this.host.task(item.taskId);
  }

  /** "Check again": look for the interrupted delivery once more. */
  checkShipping(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    if (!task) return;
    this.host.log(task, "you", "You asked Petrina to check again");
    endYouStep(task, { outcome: JOURNEY_WORDS.checkedAgain, reason: JOURNEY_WORDS.checkAgain }, this.host.now());
    this.host.toWaiting(task);
    this.host.commit();
    this.host.schedule();
  }

  /**
   * "Ship it again": the delivery gets ready again, and Petrina publishes it after the same check as always. A
   * release whose push already went out keeps its version and commit. A delivery from before the update, which
   * the coordinator checked on GitHub, starts afresh from the delivery check, as the task sets it.
   */
  shipAgain(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    const scope = task ? executionFor(task) : undefined;
    if (!task) return;
    const shipping = scope!.work.shipping;
    if (shipping?.carriedOver) {
      delete scope!.work.shipping;
      this.effects.clearApproval(scope!);
      const check = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.gate === "delivery");
      if (check >= 0 && task.approveDelivery) {
        task.stageIndex = check;
        task.sub = 0;
      }
    } else if (shipping?.prepared && (shipping.localUpdated || scope!.work.source?.start.kind === "pull-request")) {
      // Keep the original tested commit until its publishing evidence is resolved.
    } else if (shipping && !shipping.pushed) {
      // What the work was stays, so an earlier version change can go before it gets ready again.
      scope!.work.shipping = { ...(shipping.start ? { start: shipping.start } : {}), moves: 0, failures: shipping.failures };
    }
    this.host.log(task, "you", "You asked to ship it again");
    endYouStep(task, { outcome: JOURNEY_WORDS.shippedAgain, reason: JOURNEY_WORDS.shipAgain }, this.host.now());
    this.host.toWaiting(task);
    this.host.commitNow();
    this.host.schedule();
  }

  /** "Mark as done": it went out another way. */
  markDone(itemId: Id): void {
    const pending = this.host.state.inbox.find((item) => item.id === itemId);
    const shared = pending && this.host.task(pending.taskId);
    if (shared?.repositories && !shared.repositories.some((work) => work.pr?.state === "closed" && !work.landingAccepted)) throw new Error("Check each unfinished delivery before marking this shared task as landed.");
    const task = this.takeShippingItem(itemId);
    const scope = task ? executionFor(task) : undefined;
    if (!task) return;
    if (task.repositories) {
      for (const work of task.repositories) if (work.pr?.state === "closed" && !work.landingAccepted) work.landingAccepted = { at: this.host.now() };
      this.host.log(task, "you", "You resolved the closed pull requests. Open companion pull requests still need to land.");
      if (landingState(task.repositories) === "unfinished") {
        this.host.toWaiting(task);
        this.host.commitNow();
        this.host.schedule();
      }
      else this.effects.finishMany(task);
      return;
    }
    if (!scope!.work.pr && (scope!.work.delivery === "pull-request" || scope!.work.shipping?.carriedOver)) {
      // An update's destination is the PR's working branch, not its base. Its existing approved-PR
      // path keeps the earlier cleanup rules; this extra attribution proof is for newly opened PRs.
      const tested = scope!.work.source?.start.kind === "pull-request" ? undefined : scope!.work.shipping?.prepared?.tested;
      const base = scope!.work.source?.destination.branch ?? this.host.repository(task)?.defaultBranch ?? "main";
      scope!.work.cleanup = { ...scope!.work.cleanup, pullRequest: "unconfirmed", ...(tested ? { checkedDelivery: { tested, base } } : {}) };
      if (!tested) delete scope!.work.cleanup.checkedDelivery;
    }
    if (!scope!.work.pr && !scope!.work.release && (!scope!.work.landed || scope!.work.localUpdate?.pushed === false)) scope!.work.cleanup = {
      ...scope!.work.cleanup,
      markedDone: true
    };
    delete scope!.work.shipping;
    this.host.clearStep(task);
    this.host.delivered(task);
    task.state = "done";
    task.column = "done";
    task.finishedAt = this.host.now();
    task.statusLine = "Marked as done by you";
    this.host.log(task, "you", "You marked it as done");
    endYouStep(task, { outcome: JOURNEY_WORDS.markedDone, reason: JOURNEY_WORDS.youMarkedDone }, this.host.now());
    this.host.done(task);
    this.host.commitNow();
    this.host.schedule();
    void this.effects.checkUnrecordedPullRequest(scope!);
    this.host.tidy(task.id);
  }
}
