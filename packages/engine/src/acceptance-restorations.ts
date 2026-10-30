// Read-only worktree restoration, editing-role commits and crash-safe acceptance cleanup records.

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStep, type Id, type Role } from "@petrina/core";
import { executionOf, type RepositoryContext } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import { addRestored, type RuntimeTask } from "./engine-options.js";
import type { Kernel } from "./kernel.js";

export class AcceptanceRestorations {
  /** Lines noted by cleanups that finish after the last save at shutdown, per task. */
  private readonly stoppedLines = new Map<Id, string[]>();

  constructor(private readonly kernel: Kernel) {}

  private get stoppedRestorations(): string {
    return join(this.kernel.dataDir, "acceptance-restorations");
  }

  async undoReadOnly(
    target: RuntimeTask | RepositoryContext,
    roleId: Id,
    worktree?: string,
    knownClean?: boolean,
  ): Promise<void> {
    const scope = executionOf(target);
    const { work: repository } = scope;
    worktree ??= repository.worktree;
    const conversation = repository.conversation?.roleId === roleId ? repository.conversation : undefined;
    const role = conversation?.role ?? this.kernel.role(roleId);
    if (!role || (conversation?.access?.canEdit ?? role.canEdit) || !worktree) return;
    if (knownClean === undefined && role.result === "checks" && scope.task.acceptanceRun) {
      const status = await git.worktreeStatus(worktree).catch(() => undefined);
      if (status?.clean) return;
      if (status?.trackedChanged !== false) {
        await this.kernel.noteRestoredAcceptance(scope, role, repository.productId, worktree, undefined, {
          commits: false,
          edits: true,
        });
      }
      await git.discardChanges(worktree);
      this.kernel.log(scope, "warn", `Undid changes from ${role.name}, which is read-only`);
      return;
    }
    if (!(knownClean ?? await git.isClean(worktree))) {
      if (role.result === "checks" && scope.task.acceptanceRun) {
        // An unreadable status cannot show that only new output files are being removed.
        const status = await git.worktreeStatus(worktree).catch(() => undefined);
        if (status?.trackedChanged !== false) {
          await this.kernel.noteRestoredAcceptance(scope, role, repository.productId, worktree, undefined, {
            commits: false,
            edits: true,
          });
        }
      }
      await git.discardChanges(worktree);
      this.kernel.log(scope, "warn", `Undid changes from ${role.name}, which is read-only`);
    }
  }

  /**
   * Petrina is about to undo commits or tracked-file edits from an acceptance run, found by its role's result kind:
   * none of the run's answers can verify the restored product. Saved with the run, and its open step, before the
   * undo removes the evidence, so pause, restart, a stand-in or a take-over within the run keep it.
   */
  async noteRestoredAcceptance(
    scope: RepositoryContext,
    role: Role,
    productId: Id,
    path: string,
    since: string | undefined,
    change: { commits: boolean; edits: boolean },
  ): Promise<void> {
    const { task } = scope;
    const run = task.acceptanceRun;
    if (role.result !== "checks" || !run || (!change.commits && !change.edits)) return;
    const files = await git.trackedChangesSince(path, since);
    addRestored(task, {
      productId,
      ...(change.commits ? { commits: true } : {}),
      ...(change.edits ? { edits: true } : {}),
      files,
    });
    const what = [change.commits && "commits", change.edits && "changes to project files"].filter(Boolean).join(" and ");
    const named = files.length ? ` (${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""})` : "";
    const line = `This acceptance run cannot verify the restored product: Petrina is undoing ${what} from ${role.name} in ${this.kernel.productLabel(productId)}${named}`;
    this.kernel.log(scope, "warn", line);
    // Shutdown saved and closed the store before this cleanup: its record goes beside the store once the cleanup is over.
    if (this.kernel.stopped) this.stoppedLines.set(task.id, [...(this.stoppedLines.get(task.id) ?? []), line]);
    else this.kernel.commitNow(scope);
  }

  /**
   * An acceptance agent is starting: until its cleanup is over, every save marks the run with this cleanup's own
   * identity, which names the only record a later start may take for it.
   */
  beginAcceptanceCleanup(task: RuntimeTask): string {
    const cleanup = randomBytes(12).toString("hex");
    task.acceptanceCleanupPending = cleanup;
    return cleanup;
  }

  /** That cleanup is over with any undone changes noted: saved now, or kept beside the store when shutdown already closed it. */
  endAcceptanceCleanup(scope: RepositoryContext, cleanup: string): void {
    const { task } = scope;
    if (task.acceptanceCleanupPending !== cleanup) return;
    if (this.kernel.stopped) return this.keepStoppedOutcome(task, cleanup);
    delete task.acceptanceCleanupPending;
    this.kernel.commitNow(scope);
  }

  private keepStoppedOutcome(task: RuntimeTask, cleanup: string): void {
    const run = task.acceptanceRun;
    if (!run) return;
    const path = join(this.stoppedRestorations, `${cleanup}.json`);
    try {
      mkdirSync(this.stoppedRestorations, { recursive: true, mode: 0o700 });
      writeFileSync(
        `${path}.tmp`,
        JSON.stringify({
          taskId: task.id,
          cleanup,
          ...(run.restored ? { restored: run.restored } : {}),
          lines: this.stoppedLines.get(task.id) ?? [],
        }),
        { mode: 0o600 },
      );
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      // The run stays marked, so the next start cannot trust it.
      console.error(`Could not keep the acceptance cleanup record for task ${task.id}:`, error);
    }
  }

  /**
   * A run marked at shutdown takes the record its own cleanup left, saved before the record goes. A record from an
   * earlier cleanup has another name, so it never speaks for a later one. Without a readable record of that cleanup,
   * nothing shows what it undid, so the run cannot verify the product.
   */
  recoverStoppedRestorations(): void {
    type Kept = {
      taskId?: Id;
      cleanup?: string;
      restored?: { products?: { productId: Id; commits?: boolean; edits?: boolean; files?: string[] }[] };
      lines?: string[];
    };
    let names: string[] = [];
    try {
      names = readdirSync(this.stoppedRestorations);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Could not read the acceptance cleanup records:", error);
      }
    }
    const read = (cleanup: string): Kept | undefined => {
      const path = join(this.stoppedRestorations, `${cleanup}.json`);
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`Could not read the acceptance cleanup record ${path}:`, error);
        }
      }
      return undefined;
    };
    let changed = false;
    for (const task of this.kernel.s.tasks) {
      const cleanup = task.acceptanceCleanupPending;
      const run = task.acceptanceRun;
      if (cleanup === undefined) continue;
      delete task.acceptanceCleanupPending;
      changed = true;
      if (!run) continue;
      const kept = /^[0-9a-f]{24}$/.test(cleanup) ? read(cleanup) : undefined;
      if (kept?.taskId === task.id && kept.cleanup === cleanup) {
        for (const entry of kept.restored?.products ?? []) addRestored(task, entry);
        for (const line of kept.lines ?? []) this.kernel.log(task, "warn", line);
        continue;
      }
      run.restored ??= { at: Date.now(), products: [] };
      const step = openStep(task);
      if (step?.kind === "agent" && step.proofRun) step.proofRun = structuredClone(run);
      this.kernel.log(
        task,
        "warn",
        "This acceptance run cannot verify the product: Petrina closed during it and could not read what its cleanup undid",
      );
    }
    if (!changed && !names.length) return;
    this.kernel.save();
    for (const name of names) {
      try {
        rmSync(join(this.stoppedRestorations, name), { force: true });
      } catch (error) {
        console.error(`Could not remove the acceptance cleanup record ${name}:`, error);
      }
    }
  }

  /** Keep an editing role's work before another role's read-only clean-up can undo it. */
  async saveRoleEdits(target: RuntimeTask | RepositoryContext, roleId: Id, profileId: Id): Promise<void> {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const conversation = repository.conversation?.roleId === roleId ? repository.conversation : undefined;
    const role = conversation?.role ?? this.kernel.role(roleId);
    if (role && (conversation?.access?.canEdit ?? role.canEdit)) {
      const committed = await git.commitChanges(repository.worktree!, `${task.title}: ${role.name}`);
      const checks = repository.checks;
      const refreshChecks = !!checks && !!(committed || checks.current !== false);
      // An unreadable post-save version cannot leave a previous pass displayed as current.
      if (checks && refreshChecks) checks.current = false;
      const version = await git.commitVersion(repository.worktree!);
      if (checks && refreshChecks) {
        checks.current = !!version.head && !!version.tree
          && git.isSha(version.head) && git.isSha(version.tree) && checks.tree === version.tree;
      }
      await this.kernel.rememberVersion(scope, version);
      if (committed) {
        this.kernel.log(scope, "done", `Saved the changes from the ${role.name} on the task's branch`, roleId, profileId);
      }
    }
  }

  /** Reuse only a version this operation just observed or created, never an earlier saved freshness flag. */
  async rememberVersion(scope: RepositoryContext, observed?: { head?: string; tree?: string }): Promise<void> {
    if (!scope.work.worktree) return;
    // An explicit empty observation is unavailable, not permission to read again and upgrade it.
    // Keep a prior saved version as history; its consumers compare fresh HEAD rather than treating it as current proof.
    const version = observed ?? await git.commitVersion(scope.work.worktree);
    if (version.head && version.tree && git.isSha(version.head) && git.isSha(version.tree)) {
      scope.work.savedVersion = { commit: version.head, tree: version.tree };
    }
  }
}
