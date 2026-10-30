// Native ownership for screen-wait copies; portable arbitration lives in the orchestrator.
import { join } from "node:path";
import { ScreenArbitration, executionOf, scopesFor, type RepositoryContext } from "@petrina/orchestrator";
import type { ConversationNote, Id, ScreenMode } from "@petrina/core";
import type { Kernel, RuntimeTask } from "./kernel.js";
import * as git from "@petrina/repositories/git";
import { completeAll } from "@petrina/core";
import { runtimeClock } from "./clock.js";
type ScreenHost = Pick<Kernel, "taskAdmissionWait" | "drivers" | "settling" | "agentCleanup" | "dataDir" | "productOf" | "log" | "syncIdleSleep" | "s" | "columnFor" | "commitNow" | "id" | "schedule" | "stopped" | "task">;

export class ScreenCoordinator {
  private readonly arbitration: ScreenArbitration;
  readonly copyCleanups = new Map<Id, Promise<void>>();
  constructor(private readonly k: ScreenHost) {
    this.arbitration = new ScreenArbitration({
      state: () => k.s, task: id => k.task(id), stopped: () => k.stopped,
      sessionOwned: task => k.drivers.has(task.id) || k.settling.has(task.id),
      waitLine: task => k.taskAdmissionWait(task), column: task => k.columnFor(task),
      record: (task, tone, text, roleId, profileId) => k.log(task, tone, text, roleId, profileId),
      inboxId: () => k.id("inbox"), checkpoint: scope => k.commitNow(scope), schedule: () => k.schedule(),
    }, runtimeClock);
  }
  get groups() { return this.arbitration.groups; }
  stop(): void { this.arbitration.stop(); }
  setScreenUse(mode: ScreenMode, hourMs: number): void { this.arbitration.setScreenUse(mode, hourMs); }
  allowScreen(taskId: Id): void { this.arbitration.allowScreen(taskId); }
  setTaskScreen(taskId: Id, allowed: boolean): void { this.arbitration.setTaskScreen(taskId, allowed); }
  askScreen(task: RuntimeTask, roleId: Id, profileId: Id, reason: string, member?: string): boolean { return this.arbitration.askScreen(task, roleId, profileId, reason, member); }
  saveTurn(scope: RepositoryContext, roleId: Id, profileId: Id, member: string, copy: string, note: ConversationNote | undefined, reason: string): boolean { return this.arbitration.saveTurn(scope, roleId, profileId, member, copy, note, reason); }
  waitForScreen(task: RuntimeTask): void { this.arbitration.waitForScreen(task); }
  syncScreen(): void { this.arbitration.syncScreen(); }
  selectScreen(task: RuntimeTask): void { this.arbitration.selectScreen(task); }
  releaseScreen(task: RuntimeTask): void { this.arbitration.releaseScreen(task); }
  armScreenTimer(): void { this.arbitration.armScreenTimer(); }

  /** A reopened reviewer or voter still works in its own copy, including during terminal take-over. */
  agentWorktree(target: RuntimeTask | RepositoryContext): string {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const member = task.screen?.member;
    return (member && task.hunt?.screenTurns?.[member]?.copy) || repository.worktree!;
  }

  /** Pause, cancel or failure discards saved screen conversations and their separate working copies. */
  discardScreenTurns(task: RuntimeTask): void {
    if (!Object.keys(task.hunt?.screenTurns ?? {}).length) return;
    delete task.hunt!.screenTurns;
    const owners = scopesFor(task, { includeExcluded: true }).map((scope) => ({ productId: scope.work.productId, root: scope.work.source?.product.path ?? this.k.productOf(scope)?.path }));
    if (!owners.some((owner) => owner.root)) return;
    const stopped = this.k.settling.get(task.id);
    const cleanup = Promise.all([stopped, this.copyCleanups.get(task.id)])
      .then(async () => {
        await this.k.agentCleanup.wait(task.id);
        await completeAll(owners.flatMap((owner) => owner.root ? [git.removeCopies(owner.root, join(this.k.dataDir, "worktrees", owner.productId, `${task.id}.copies`))] : []));
      })
      .catch((error: unknown) => this.k.log(task, "warn", `Could not remove the reviewers' working copies: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (this.copyCleanups.get(task.id) === cleanup) this.copyCleanups.delete(task.id);
        this.k.syncIdleSleep();
      });
    this.copyCleanups.set(task.id, cleanup);
    this.k.syncIdleSleep();
  }

}
