// Scheduling and the task driver: who gets a slot next, the loop that runs a task's stages and stops at
// checkpoints, and putting interrupted work back in line after a restart.

import { join } from "node:path";
import { pickStarts, queueOf, slotWait, slotUses, type Candidate, type Id, type InboxItem, type Task } from "@petrina/core";
import * as git from "./git.js";
import { Kernel, Aborted, type MTask, PLANNER_PROFILE, lastIndex } from "./kernel.js";
import type { Planning } from "./planning.js";
import type { Work } from "./work.js";
import type { Design } from "./design.js";
import type { Reviews } from "./review.js";
import type { ProductChecks } from "./product-checks.js";
import type { GuideKeeper } from "./guide-keeper.js";

export class Driver {
  constructor(private readonly k: Kernel, private readonly planning: Planning, private readonly work: Work, private readonly design: Design, private readonly reviews: Reviews, private readonly checks: ProductChecks, private readonly guide: GuideKeeper) {}

  schedule(): void {
    if (this.k.stopped) return;
    const candidates: Candidate[] = [];
    const tool = (profileId: Id) => this.k.profile(profileId)?.toolId ?? "unknown";
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
      if (task.statusLine.startsWith("Waiting for “")) task.statusLine = "Waiting for a free slot";
      const next = this.nextAgent(task);
      const candidate = { taskId: task.id, toolId: next ? tool(next.profileId) : "none" };
      task.statusLine = slotWait(this.k.getState(), candidate) ?? "Waiting for a free slot";
      candidates.push(candidate);
    }
    for (const task of queueOf(this.k.s.tasks as Task[])) if (!task.held && !blocked(task as MTask)) candidates.push({ taskId: task.id, toolId: tool(PLANNER_PROFILE) });

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
    this.k.commit();
  }

  /** Take the slot and name its agent together, before any working-copy or tool I/O. */
  private reserveAgent(task: MTask): boolean {
    const next = this.nextAgent(task);
    const waiting = slotWait(this.k.getState(), { taskId: task.id, toolId: next ? this.k.profile(next.profileId)?.toolId ?? "unknown" : "none" });
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
        return { roleId: stage.roleId, profileId: stage.profileIds[0] ?? PLANNER_PROFILE };
      case "converge":
        return task.sub === 0
          ? { roleId: stage.roleId, profileId: stage.profileIds[0] ?? PLANNER_PROFILE }
          : { roleId: stage.reviewerRoleId ?? "design-reviewer", profileId: stage.reviewerProfileIds?.[0] ?? "sol-xhigh" };
      case "review-chain": {
        if (task.sub < stage.profileIds.length) return { roleId: stage.roleId, profileId: stage.profileIds[task.sub] ?? stage.profileIds[0] ?? PLANNER_PROFILE };
        const verify = this.reviews.nextVerification(task, stage);
        return verify ? { roleId: "verifier", profileId: verify.profileId } : undefined;
      }
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
      await this.prepare(task());
      for (;;) {
        if (signal.aborted) throw new Aborted();
        const current = task();
        const stage = current.stageIndex < 0 ? undefined : current.plan?.stages[current.stageIndex];
        // Nothing ships while changes made by hand wait for review: the last review chain looks at them first.
        if (stage && current.handChanges && (stage.gate === "delivery" || stage.roleId === "shipper")) {
          const chain = lastIndex(current.plan!.stages, (entry) => entry.kind === "review-chain");
          if (chain >= 0) {
            current.stageIndex = chain;
            current.sub = 0;
            current.fixing = false;
            this.k.log(current, "milestone", "Reviewing your changes before anything ships: the review starts again from the first reviewer");
            this.k.commit();
            continue;
          }
          delete current.handChanges;
        }
        // What ships is what the coordinator approved: a change since then asks them again.
        if (stage?.roleId === "shipper" && stage.kind !== "gate" && current.approvedSha && !current.shipping && current.worktree) {
          const head = await git.head(current.worktree).catch(() => undefined);
          const check = lastIndex(current.plan!.stages, (entry, index) => index < current.stageIndex && entry.gate === "delivery");
          if (head && head !== current.approvedSha && check >= 0) {
            delete current.approvedSha;
            current.stageIndex = check;
            current.sub = 0;
            this.k.log(current, "warn", "The work changed after you approved the delivery, so Petrina asks you again");
            this.k.commit();
            continue;
          }
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
          if (stage.gate === "delivery") await this.guide.writeGuide(current);
          // Right before the coordinator is asked to ship, the checks run again on what would ship.
          if (stage.gate === "delivery" && (await this.checks.checksBeforeDelivery(current, signal))) continue;
          if (stage.gate === "delivery") {
            const head = await git.head(current.worktree!).catch(() => undefined);
            if (head) current.checkedSha = head;
            if (this.shipsUnasked(current)) {
              if (head) current.approvedSha = head;
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
        const next = stage.kind === "do" ? await this.work.runDo(current, stage, signal) : stage.kind === "converge" ? await this.design.runConverge(current, stage, signal) : await this.reviews.runReview(current, stage, signal);
        if (next === "stop") return;
      }
    } catch (error) {
      if (signal.aborted || error instanceof Aborted) return;
      this.k.fail(taskId, error);
    } finally {
      if (this.k.drivers.get(taskId) === controller) this.k.drivers.delete(taskId);
      if (!this.k.stopped) this.schedule();
    }
  }

  private async prepare(task: MTask): Promise<void> {
    const product = this.k.productOf(task);
    if (!product?.path) throw new Error(`${product?.name ?? "This product"} has no local copy`);
    const branch = task.branch ?? git.branchName(task.title, task.id);
    const worktree = task.worktree ?? join(this.k.dataDir, "worktrees", product.id, task.id);
    const { base, skippedFetch, fetchTimedOut } = await git.ensureWorktree(product.path, worktree, branch, product.defaultBranch ?? "main");
    if (fetchTimedOut) this.k.log(task, "warn", "GitHub did not answer in time, so this task starts from the local copy");
    if (skippedFetch) this.k.log(task, "warn", `Did not update from GitHub: the repository's git settings include ${skippedFetch.slice(0, 3).join(", ")}, which could misuse your GitHub login. Working from the local copy.`);
    if (!task.branch) this.k.log(task, "milestone", "Set up a fresh working copy");
    task.branch = branch;
    task.worktree = worktree;
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
    }
  }

  /** Low-risk work skips the delivery check only where the coordinator opted in, with nothing left that needs them. */
  private shipsUnasked(task: MTask): boolean {
    if (task.risk?.level !== "low" || !this.k.productOf(task)?.shipLowRisk) return false;
    if (task.findings.some((finding) => finding.status === "open" && finding.severity === "blocking")) return false;
    return task.checks?.results.every((run) => run.ok) ?? true;
  }
}
