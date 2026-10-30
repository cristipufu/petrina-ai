import { runtimeWaitHolds, stepKey } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import { executionFor, scopesFor, type RepositoryContext } from "./repository-context.js";

/** Live step admission belongs to the existing scheduler; this owner keeps the refresh obligation. */
export interface WaitSourceRefreshHost {
  due(task: RuntimeTask): boolean;
  stepStarted(task: RuntimeTask): boolean;
  checkpoint(): void;
  note(task: RuntimeTask, tone: "milestone", text: string): void;
  aborted(): Error;
}
export interface WaitSourceRefreshEffects {
  clean(scope: RepositoryContext): Promise<boolean>;
  clearUnpublishedVersion(scope: RepositoryContext, preserveAttempts: boolean): Promise<void>;
  update(scope: RepositoryContext, signal: AbortSignal): Promise<"current" | "moved" | "conflict">;
}

/** Actual post-prerequisite refresh loop; native clean/fold/conflict effects retain their adapters. */
export class WaitSourceRefresh {
  constructor(private readonly host: WaitSourceRefreshHost, private readonly effects: WaitSourceRefreshEffects) {}
  async run(task: RuntimeTask, signal: AbortSignal): Promise<boolean> {
    const wait = task.runtimeWait;
    if (!wait?.refreshPending || runtimeWaitHolds(task)) return false;
    const scopes = scopesFor(task);
    const own = executionFor(task).work;
    const recovery = own.editAttempt;
    if (recovery?.failed) {
      if (recovery.step !== stepKey(task) || !own.worktree || await this.effects.clean({ task, work: own })) {
        delete own.editAttempt;
        this.host.checkpoint();
      }
      if (signal.aborted) throw this.host.aborted();
    }
    if (!this.host.due(task)) return false;
    if (!scopes.length || scopes.some(({ work }) => !work.worktree && !(task.repositories && (work.pr || work.release || work.landed)))) return false;
    // Persist each owner's unfinished work before I/O. A port keeps its own version until its
    // Builder finishes, while every companion still owes the strict source check now.
    wait.refreshProducts ??= scopes.map(({ work }) => work.productId);
    this.host.checkpoint();
    // Preparation with no admitted reviewer is disposable; its round number and conversations are kept.
    if (task.hunt && !this.host.stepStarted(task)) delete task.hunt;
    let conflict = false;
    for (const scope of scopes) {
      if (signal.aborted) throw this.host.aborted();
      const { work } = scope;
      if (!wait.refreshProducts.includes(work.productId)) continue;
      const delivered = task.repositories && (work.pr || work.release || work.landed);
      // Existing ports and admitted publishing retain their exact saved version and recovery rules.
      if (!delivered && (work.updating || work.shipping?.step || work.shipping?.pushed)) continue;
      if (!delivered) {
        // A prepared delivery is bound to its old checked commit. Restore any release version
        // before folding, then let ordinary delivery preparation recheck and approve the candidate.
        await this.effects.clearUnpublishedVersion(scope, true);
        const result = await this.effects.update(scope, signal);
        if (signal.aborted) throw this.host.aborted();
        if (result === "conflict") {
          conflict = true;
          continue;
        }
      }
      wait.refreshProducts = wait.refreshProducts.filter(id => id !== work.productId);
      this.host.checkpoint();
    }
    if (!wait.refreshProducts.length) {
      delete wait.refreshPending;
      delete wait.refreshProducts;
      delete wait.refreshAfterStep;
      this.host.note(task, "milestone", "The prerequisite wait ended; source checks are complete for the remaining work");
      this.host.checkpoint();
    }
    return conflict;
  }
}
