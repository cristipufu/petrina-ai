// Scheduling and the task driver: who gets a slot next, the loop that runs a task's stages and stops at
// checkpoints, and putting interrupted work back in line after a restart.

import { join } from "node:path";
import { lastIndexWhere, pickStarts, queueOf, slotWait, slotUses, type Candidate, type Id, type InboxItem, type Task } from "@petrina/core";
import * as git from "./git.js";
import { Kernel, Aborted, type MTask, PLANNER_PROFILE } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
import type { Planning } from "./planning.js";
import type { Work } from "./work.js";
import type { Design } from "./design.js";
import type { Reviews } from "./review.js";
import type { ProductChecks } from "./product-checks.js";
import type { GuideKeeper } from "./guide-keeper.js";
import type { Updates } from "./update.js";
import type { Learnings } from "./learnings.js";
import type { Connections } from "./connection.js";
import { destination, needsReleaseManager, type Shipping } from "./shipping.js";

/** How a status line starts while a task waits for a tool to be out of its usage limit. */
const USAGE_WAIT = "Waiting for usage";

export class Driver {
  constructor(
    private readonly k: Kernel,
    private readonly planning: Planning,
    private readonly work: Work,
    private readonly design: Design,
    private readonly reviews: Reviews,
    private readonly checks: ProductChecks,
    private readonly guide: GuideKeeper,
    private readonly updates: Updates,
    private readonly learnings: Learnings,
    private readonly shipping: Shipping,
    private readonly connections: Connections,
  ) {}

  schedule(): void {
    if (this.k.stopped) return;
    // Limits that ended no longer hold anyone back.
    this.k.expireLimits();
    const candidates: Candidate[] = [];
    // A task waiting for others to land stays out of the running and says what it waits for.
    const blocked = (task: MTask): boolean => {
      const waitingFor = this.k.blockers(task);
      if (!waitingFor.length) return false;
      const line = `Waiting for “${waitingFor[0]!.title}”${waitingFor.length > 1 ? ` and ${waitingFor.length - 1} more` : ""} to land`;
      if (task.statusLine !== line) task.statusLine = line;
      return true;
    };
    for (const task of this.k.s.tasks.filter((entry) => entry.state === "waiting").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
      if (blocked(task)) continue;
      if (task.statusLine.startsWith("Waiting for “") || task.statusLine.startsWith(USAGE_WAIT)) task.statusLine = "Waiting for a free slot";
      const seat = this.seatFor(task);
      // Everyone who could work this step is out of usage: it waits for a limit to end, and takes no slot.
      if (seat.waiting) {
        task.statusLine = seat.waiting;
        continue;
      }
      const candidate = { taskId: task.id, toolId: seat.toolId };
      task.statusLine = slotWait(this.k.getState(), candidate) ?? "Waiting for a free slot";
      candidates.push(candidate);
    }
    for (const task of queueOf(this.k.s.tasks as Task[])) {
      if (task.held || blocked(task as MTask)) continue;
      // What it waited for landed or was cancelled: back to plain queue words.
      if (task.statusLine.startsWith("Waiting for “") || task.statusLine.startsWith(USAGE_WAIT)) (task as MTask).statusLine = "In the queue";
      const seat = this.seatOf({ roleId: "planner", profileId: PLANNER_PROFILE });
      if (seat.waiting) {
        (task as MTask).statusLine = seat.waiting;
        continue;
      }
      candidates.push({ taskId: task.id, toolId: seat.toolId });
    }

    for (const taskId of pickStarts({ candidates, inUse: slotUses(this.k.getState()), pool: this.k.s.pool })) {
      const task = this.k.task(taskId);
      if (!task || this.k.drivers.has(taskId)) continue;
      if (task.state === "queued") {
        task.startedAt = Date.now();
        task.stageIndex = -1;
        this.k.log(task, "milestone", "Started from the queue");
      }
      if (this.reserveAgent(task)) this.startDriver(taskId);
    }
    this.k.armLimitTimer();
    this.k.commit();
  }

  /**
   * Who would work this task's next step: its planned agent, or a stand-in while the planned tool or model is
   * out of usage. `waiting` says why nobody can; `toolId` is the tool the slot is for.
   */
  private seatFor(task: MTask) {
    return this.seatOf(this.nextAgent(task), task);
  }

  private seatOf(next: { roleId: Id; profileId: Id } | undefined, task?: MTask): { agent?: { roleId: Id; profileId: Id }; toolId: Id; waiting?: string } {
    if (!next) return { toolId: "none" };
    // This task's own slot does not count: it is the seat being filled. A stand-in whose tool is full yields.
    const room = task ? (toolId: Id) => !slotWait(this.k.getState(), { taskId: task.id, toolId }) : undefined;
    const choice = this.k.choose(next.profileId, task, next.roleId, room);
    if (!choice) return { agent: next, toolId: this.k.profile(next.profileId)?.toolId ?? "unknown" };
    if (choice.kind === "none") return { toolId: "none", waiting: choice.waiting };
    return { agent: { roleId: next.roleId, profileId: choice.profile.id }, toolId: choice.profile.toolId };
  }

  /** Take the slot and name its agent together, before any working-copy or tool I/O. */
  private reserveAgent(task: MTask): boolean {
    const { agent: next, toolId, waiting: noOne } = this.seatFor(task);
    const waiting = noOne ?? slotWait(this.k.getState(), { taskId: task.id, toolId });
    if (waiting) {
      task.state = "waiting";
      task.holdsSlot = false;
      delete task.agent;
      task.column = this.k.columnFor(task);
      task.statusLine = waiting;
      return false;
    }
    task.state = "running";
    task.holdsSlot = !!next;
    if (next) task.agent = { ...next, since: Date.now(), step: 0 };
    else delete task.agent;
    task.column = this.k.columnFor(task);
    task.statusLine = next ? `${this.k.role(next.roleId)?.name ?? next.roleId} is starting` : "Getting ready";
    return true;
  }

  private nextAgent(task: MTask): { roleId: Id; profileId: Id } | undefined {
    if (task.stageIndex < 0) return { roleId: "planner", profileId: PLANNER_PROFILE };
    const stage = task.plan?.stages[task.stageIndex];
    if (!stage) return undefined;
    switch (stage.kind) {
      case "do":
        // Petrina publishes by itself: the Release Manager's seat is needed only for a release's notes.
        if (stage.roleId === "release-manager" && !needsReleaseManager(task)) return undefined;
        return { roleId: stage.roleId, profileId: stage.profileIds[0] ?? PLANNER_PROFILE };
      case "converge":
        return task.sub === 0
          ? { roleId: stage.roleId, profileId: stage.profileIds[0] ?? PLANNER_PROFILE }
          : { roleId: stage.reviewerRoleId ?? "design-reviewer", profileId: stage.reviewerProfileIds?.[0] ?? "sol-xhigh" };
      case "review-chain":
        return this.reviews.nextAgent(task, stage);
      case "gate":
        return undefined;
    }
  }

  /** `resume`: the agent already has its seat (a hand back), so its step carries on whatever the pool is doing. */
  startDriver(taskId: Id, resume = false): void {
    const done = this.drive(taskId, resume);
    this.k.settling.set(taskId, done);
    void done.finally(() => {
      if (this.k.settling.get(taskId) === done) this.k.settling.delete(taskId);
    });
  }

  private async drive(taskId: Id, resume = false): Promise<void> {
    const controller = new AbortController();
    this.k.drivers.set(taskId, controller);
    const { signal } = controller;
    const task = () => {
      const found = this.k.task(taskId);
      if (!found) throw new Aborted();
      return found;
    };
    try {
      // A delivery from before the update: nothing happens, not even an update from GitHub, until the coordinator chooses.
      if (task().shipping?.carriedOver) {
        this.shipping.askCarriedOver(task());
        return;
      }
      await this.prepare(task(), signal);
      for (;;) {
        if (signal.aborted) throw new Aborted();
        const current = task();
        const stage = current.stageIndex < 0 ? undefined : current.plan?.stages[current.stageIndex];
        // Nothing ships while changes made by hand wait for review: the last review chain looks at them first.
        if (stage && current.handChanges && (stage.gate === "delivery" || stage.roleId === "release-manager")) {
          const chain = lastIndexWhere(current.plan!.stages, (entry) => entry.kind === "review-chain");
          if (chain >= 0) {
            current.stageIndex = chain;
            current.sub = 0;
            current.fixing = false;
            delete current.hunt;
            this.k.log(current, "milestone", "Reviewing your changes before anything ships: the review starts again from the first reviewer");
            this.k.commit();
            continue;
          }
          delete current.handChanges;
        }
        // Checkpoints need no new agent, so a paused or full pool must not hold them back.
        if (stage?.kind === "gate") {
          // On the way back to the check where changes were asked, earlier design checks are not asked again.
          if (stage.gate === "design" && current.returnToCheck !== undefined && current.stageIndex < current.returnToCheck) {
            this.k.log(current, "milestone", "Went past the earlier design check you already approved, back to the one where you asked for changes");
            current.stageIndex += 1;
            current.sub = 0;
            this.k.commit();
            continue;
          }
          delete current.returnToCheck;
          if (stage.gate === "delivery") {
            await this.guide.writeGuide(current);
            await this.learnings.write(current);
            // What the coordinator checks is the work as it would land: one commit on top of the latest main.
            if ((await this.updates.upToDate(current, signal)) === "conflict") continue;
            // Right before the coordinator is asked to ship, the checks run again on what would ship.
            if (await this.checks.checksBeforeDelivery(current, signal)) continue;
            const head = await git.head(current.worktree!).catch(() => undefined);
            if (head) current.checkedSha = head;
            const patch = await this.updates.patch(current);
            if (patch) current.checkedPatch = patch;
            // What agents learned on the way: offered to the coordinator without holding the delivery up.
            this.learnings.offer(current);
            if (this.shipsUnasked(current)) {
              if (head) current.approvedSha = head;
              if (patch) current.approvedPatch = patch;
              current.approvedFor = { by: "task", mode: current.delivery, destination: destination(current, this.k.productOf(current)) };
              this.k.log(current, "milestone", "Low risk, checks passed and nothing left to fix: shipping without asking you, as this product's settings allow");
              current.stageIndex += 1;
              current.sub = 0;
              this.k.commit();
              continue;
            }
          }
          this.k.gate(current, stage.gate ?? "delivery");
          return;
        }
        // Running agents finish; every following agent must qualify again, even on the same tool.
        if (resume) resume = false;
        else if (!this.reserveAgent(current)) {
          this.k.commit();
          return;
        }
        this.k.commit();
        if (current.stageIndex < 0) {
          await this.planning.runPlanner(current, signal);
          if (current.approvePlan) {
            this.k.gate(current, "plan");
            return;
          }
          current.stageIndex = 0;
          current.sub = 0;
          this.k.commit();
          continue;
        }
        if (!stage) throw new Error("The plan ended without a delivery");
        const next =
          stage.kind === "do"
            ? stage.roleId === "release-manager"
              ? await this.shipping.deliver(current, stage, signal)
              : await this.work.runDo(current, stage, signal)
            : stage.kind === "converge"
              ? await this.design.runConverge(current, stage, signal)
              : await this.reviews.runReview(current, stage, signal);
        if (next === "stop") return;
      }
    } catch (error) {
      if (signal.aborted || error instanceof Aborted) return;
      // The task already says it waits for usage and has let go of its slot.
      if (error instanceof WaitingForUsage) return;
      this.k.fail(taskId, error);
    } finally {
      if (this.k.drivers.get(taskId) === controller) this.k.drivers.delete(taskId);
      // Cancelled during a publishing step: what went out is looked up and kept.
      if (signal.aborted && !this.k.stopped) await this.shipping.settleCancelled(taskId, true);
      if (!this.k.stopped) this.schedule();
    }
  }

  private async prepare(task: MTask, signal: AbortSignal): Promise<void> {
    const product = this.k.productOf(task);
    if (!product?.path) throw new Error(`${product?.name ?? "This product"} has no local copy`);
    const branch = task.branch ?? git.branchName(task.title, task.id);
    const worktree = task.worktree ?? join(this.k.dataDir, "worktrees", product.id, task.id);
    const defaultBranch = product.defaultBranch ?? "main";
    let base = defaultBranch;
    // A new working copy starts from the latest main: GitHub's for GitHub deliveries, the main clone's own for local ones.
    if (!task.worktree && task.delivery !== "local") {
      const fetched = await this.connections.fetchDefault(task, signal);
      // A stalled or refused fetch never holds a task: it works from the local copy.
      if (!fetched.ok && !fetched.missing) this.k.log(task, "warn", `${fetched.timedOut ? "GitHub did not answer in time" : `Did not update from GitHub: ${this.connections.why(task, fetched)}`}, so this task starts from the local copy`);
      if (await git.revParse(product.path, `refs/remotes/origin/${defaultBranch}`)) base = `origin/${defaultBranch}`;
    }
    await git.ensureWorktree(product.path, worktree, branch, base);
    if (!task.branch) this.k.log(task, "milestone", "Set up a fresh working copy");
    task.branch = branch;
    task.worktree = worktree;
    // Petrina stopped while a pre-commit hook ran: the working copy goes back on its branch first.
    if (task.hooking) {
      await git.reattach(worktree, branch);
      delete task.hooking;
    }
    // Known before the builder starts, so it runs them too.
    await this.checks.noteHooks(task);
    task.base = task.base ?? base;
    // Pinned once, in the product's own clone: an agent moving a ref later changes nothing Petrina compares against.
    task.baseSha = task.baseSha ?? (await git.revParse(product.path, task.base));
    this.k.commit();
  }

  /**
   * After a restart, nothing is running: put interrupted work back in line. A question stays in the
   * inbox for the conversation that asked it, without a slot; an open permission request goes.
   */
  recover(): void {
    const keep = (item: InboxItem) => {
      if (!item.blocking) return true;
      const task = this.k.task(item.taskId);
      return item.kind === "question" && task?.state === "needs-you" && task.conversation?.asked?.itemId === item.id;
    };
    for (const item of this.k.s.inbox.filter((entry) => entry.kind === "permission" && !keep(entry))) {
      const task = this.k.task(item.taskId);
      if (task) this.k.log(task, "warn", `Petrina restarted before you answered “${item.title}”, so it left your inbox. The agent will ask again if it still needs to`, item.roleId, item.profileId);
    }
    this.k.s.inbox = this.k.s.inbox.filter(keep);
    for (const task of this.k.s.tasks) {
      if (task.driving) {
        // Still in the coordinator's hands: the step keeps its seat, and Hand back works as before.
        task.state = "needs-you";
        task.holdsSlot = true;
        continue;
      }
      if (this.k.s.inbox.some((item) => item.taskId === task.id && item.blocking)) {
        task.statusLine = "Waiting for your answer";
        delete task.agent;
      } else if (["running", "waiting"].includes(task.state) || (task.state === "needs-you" && !this.k.s.inbox.some((item) => item.taskId === task.id))) {
        task.state = "waiting";
        task.statusLine = "Waiting for a free slot";
        delete task.agent;
      }
      task.holdsSlot = false;
      // Nothing runs after a restart: agents that worked beside the main one are gone too.
      delete task.helpers;
    }
  }

  /** Low-risk work skips the delivery check only where the coordinator opted in, with nothing left that needs them. */
  private shipsUnasked(task: MTask): boolean {
    if (task.risk?.level !== "low" || !this.k.productOf(task)?.shipLowRisk) return false;
    if (task.findings.some((finding) => finding.status === "open" && finding.severity === "blocking")) return false;
    return task.checks?.results.every((run) => run.ok) ?? true;
  }
}
