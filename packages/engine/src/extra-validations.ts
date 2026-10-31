import { createHash, randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import { constants, realpathSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { checkHoldLine, openStep, runtimeWaitHolds, type DeepMutable, type ExtraValidation } from "@petrina/core";
import type { Kernel } from "./kernel.js";
import { executionFor, ValidationRun } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import { runCheckBatch, CHECK_TIMEOUT_MS, checkLogBeginning } from "./checks.js";
import { containerEnv, ExtraContainer } from "./extra-container.js";
import type { Result } from "./coordination.js";
import type { CheckOwner } from "./check-queue.js";
import { lineOwner } from "./check-activity.js";

type Record = DeepMutable<ExtraValidation>;
export interface ExtraRequest { taskId: string; productId?: string; name: string; reason: string; image: string; argv: string[]; requestId: string }
const terminal = (record: ExtraValidation) => record.state === "finished";
const VERSION_NOTE = "Saved version only; working edits are not included. Hand new work back to Petrina before requesting validation of it.";
const PREREQUISITE_WAIT = "Waiting for this task's prerequisites before joining the check queue.";
const RECOVERY_WAIT = "Waiting while Petrina confirms an earlier validation stopped, before joining the check queue.";
/** Which wait keeps a request out of the line; a new wording of the same one is not another transition. */
const waitKind = (reason: string | undefined) => !reason ? undefined : reason.startsWith(PREREQUISITE_WAIT) ? "prerequisites" : "recovery";
/** One sentence, ending with its stop, so the next one never runs into it. */
const sentence = (text: string) => /[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
const ownerOf = (record: ExtraValidation): CheckOwner => ({ taskId: record.taskId, productId: record.productId, kind: "extra", validationId: record.id });

/** Engine-owned runs, not leases. Callers only submit/read; their cancellation cannot release capacity. */
export class ExtraValidations {
  private readonly container: ExtraContainer;
  private readonly jobs = new Map<string, { stop: AbortController; release?: () => void; unblock?: () => void; work?: Promise<void> }>();
  private retrying?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private notices?: (() => void)[];
  readonly ready: Promise<void>;

  constructor(private readonly k: Kernel) {
    this.container = new ExtraContainer(k);
    this.k.extraChecksActive = () => this.active > 0;
    for (const record of this.records) this.k.checkQueue.restoreOrder(record.queueOrder);
    // A place comes only from the live line: a queued request gets its place again when it rejoins.
    for (const record of this.records) delete record.queuePosition;
    const pending = this.records.filter(record => record.state !== "queued");
    this.k.extraRecovery = pending.length > 0;
    for (const record of pending) this.jobs.set(record.id, {
      stop: new AbortController(),
      release: k.checkQueue.hold(ownerOf(record)),
      unblock: k.checkQueue.block(ownerOf(record)),
    });
    this.ready = this.recover(pending).then(() => {
      this.k.extraRecovery = false;
      if (!k.stopped) {
        this.timer = setInterval(() => {
          void this.retryCleanup().catch(error => console.error("Could not retry extra validation cleanup:", error));
        }, k.options.extraCleanupEveryMs ?? 15_000);
        this.pump();
        this.k.schedule();
      }
    }, error => {
      this.k.extraRecovery = false;
      throw error;
    });
  }
  private get records(): Record[] { return this.k.s.extraValidations ?? []; }
  /** The same words as each waiting task's check activity: what holds the line, then the recorded cleanup explanation. */
  get blockers(): string[] {
    return this.records.filter(record => record.state === "held").map(record => checkHoldLine({
      kind: "cleanup",
      owner: lineOwner(this.k, ownerOf(record)),
      detail: record.cleanupDetail ?? `Make the local container service available, or stop container ${record.containerName}; Petrina will confirm cleanup.`,
    }, this.k.s.tasks));
  }
  get blocker(): string | undefined { return this.blockers[0]; }

  get active(): number { return [...this.jobs.values()].filter(job => job.work).length; }
  outstanding(productId: string): ExtraValidation | undefined { return this.records.find(record => record.productId === productId); }

  /** Why a queued request is outside the shared line: its task's prerequisites, or Petrina confirming an earlier run stopped. */
  private deferredWait(taskId: string): string | undefined {
    const task = this.k.s.tasks.find(task => task.id === taskId);
    if (task && runtimeWaitHolds(task)) return `${PREREQUISITE_WAIT} ${sentence(this.k.taskAdmissionWait(task))}`;
    return this.k.extraRecovery ? RECOVERY_WAIT : undefined;
  }
  /** A place only for a real member of the line, counted from the line itself. */
  private queuePosition(record: ExtraValidation): number | undefined {
    return this.k.checkQueue.has(record.queueOrder) ? this.k.checkQueue.positionFor(record.queueOrder) : undefined;
  }
  /** A request that never joined, or whose save failed, leaves the line without taking or reordering any place. */
  private withdraw(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.work) return;
    this.jobs.delete(id);
    job.stop.abort("rollback");
  }
  /** The line changed: a waiting request's place follows silently, with no timeline line or event. */
  private placeChanged(record: Record): void {
    if (this.k.stopped || record.state !== "queued" || !this.records.includes(record)) return;
    const place = this.queuePosition(record);
    if (place === undefined || place === record.queuePosition) return;
    record.queuePosition = place;
    this.k.commit(this.k.task(record.taskId));
  }
  private queuedWords(record: ExtraValidation): string {
    return record.waitingReason
      ? `Extra validation “${record.name}”: ${sentence(record.waitingReason)} Working edits are not included.`
      : record.queuePosition !== undefined
        ? `Extra validation “${record.name}” queued at place ${record.queuePosition}. Working edits are not included.`
        : `Extra validation “${record.name}” queued. Working edits are not included.`;
  }

  async submit(request: ExtraRequest, saveReceipt: (result: Result) => void): Promise<Result> {
    if (process.platform === "win32") throw new Error("Extra full validation currently requires a local Linux container on a Unix host.");
    const task = this.k.s.tasks.find(task => task.id === request.taskId);
    if (!task) throw new Error("That current task does not exist.");
    if ([
      "done",
      "cancelled",
      "pr-open",
      "backlog",
      "paused"
    ].includes(task.state)) throw new Error("Extra validation needs an unfinished, unpaused task outside Backlog.");
    if (task.repositories && task.repositories.length > 1 && !request.productId) throw new Error("Name the product for this shared task.");
    const scope = executionFor(task, request.productId);
    const product = this.k.productOf(scope);
    const source = this.k.repositoryOf(scope)?.path;
    if (!product || !source) throw new Error("That task product is unavailable.");
    const previous = this.records.find(record => record.taskId === task.id && record.productId === scope.work.productId);
    if (previous) throw new Error(`Extra validation is already outstanding for this task and product. Use request reference ${previous.requestId}.`);
    const saved = scope.work.savedVersion;
    if (!saved || !git.isSha(saved.commit) || !git.isSha(saved.tree)) throw new Error("Petrina has no saved version for this task yet. Hand the work back first.");
    const workingStatus = scope.work.worktree ? await git.worktreeStatus(scope.work.worktree) : undefined;
    const workingEdits = !!workingStatus && (!workingStatus.clean || workingStatus.head !== saved.commit);
    // Recheck after filesystem reads: task cancellation/removal can come from the window too.
    if (!this.k.s.tasks.includes(task) || [
      "done",
      "cancelled",
      "pr-open",
      "backlog",
      "paused"
    ].includes(task.state)) throw new Error("The task changed while the version was inspected. Inspect it again.");
    const id = randomUUID();
    const queueOrder = this.k.checkQueue.reserveOrder();
    const waitingReason = this.deferredWait(task.id);
    const record: Record = { id, requestId: request.requestId, taskId: task.id, productId: scope.work.productId, productName: product.name,
      repository: product.repo, source, nodeId: openStep(task)?.id, name: request.name, reason: request.reason, image: request.image, argv: [...request.argv],
      ...saved, versionNote: VERSION_NOTE, workingEdits, host: { system: platform(), arch: arch() },
      containerName: `petrina-extra-${id}`, owner: createHash("sha256").update(realpathSync(this.k.dataDir)).digest("hex"),
      snapshot: join(this.k.dataDir, "extra-snapshots", id), state: "queued", queuedAt: Date.now(), queueOrder,
      ...(waitingReason ? { waitingReason } : {}) };
    // Insertion, joining the line, timeline and receipt share one commit, including a pending to-do flush
    // triggered by logging. No startup can observe ownership without its retry identity.
    try {
      return this.change(record, () => {
        this.k.s.extraValidations = [...this.records, record];
        // An eligible request joins the shared line at once, so its reply and timeline give the place it takes.
        if (!waitingReason && !this.k.stopped) this.enqueue(record);
        this.note(record, "queued", this.queuedWords(record));
        const reply = this.reply(record);
        saveReceipt(reply);
        return reply;
      });
    } catch (error) {
      this.withdraw(id); // The request was never accepted.
      throw error;
    }
  }

  get(requestId: string): Result | undefined {
    const record = this.records.find(record => record.requestId === requestId);
    if (record) return this.reply(record);
    // Terminal receipts retain the complete result, even after task history is removed.
    const receipt = this.k.store.readReceipt(requestId);
    const saved = receipt ? JSON.parse(receipt.result) as Result : undefined;
    return saved?.validation && saved.requestId === requestId ? saved : undefined;
  }
  private reply(record: ExtraValidation): Result {
    return { outcome: terminal(record) ? "completed" : "pending", requestId: record.requestId, validation: structuredClone(record),
      message: `${record.versionNote}${record.workingEdits ? " The working copy currently has changes that are excluded." : ""}${record.waitingReason ? ` ${sentence(record.waitingReason)}` : ""}` };
  }

  pump(): void {
    if (this.k.stopped || this.k.extraRecovery) return;
    for (const record of [...this.records]) {
      const task = this.k.s.tasks.find(task => task.id === record.taskId);
      if (!task || ["done", "cancelled", "pr-open", "paused", "backlog"].includes(task.state)) {
        this.cancelTask(record.taskId);
        continue;
      }
      if (record.state !== "queued") continue;
      const waitingReason = this.deferredWait(record.taskId);
      // Joining or leaving the line is a real transition, said once; a new wording of the same wait is saved quietly.
      const joining = !waitingReason && !this.jobs.has(record.id);
      if (waitKind(record.waitingReason) !== waitKind(waitingReason)) {
        try {
          this.change(record, () => {
            if (waitingReason) {
              record.waitingReason = waitingReason;
              delete record.queuePosition;
            } else {
              delete record.waitingReason;
              if (joining) this.enqueue(record);
            }
            this.note(record, "queued", this.queuedWords(record));
            this.persist();
          });
        } catch (error) {
          if (joining) this.withdraw(record.id);
          throw error;
        }
      } else if (waitingReason && record.waitingReason !== waitingReason) {
        record.waitingReason = waitingReason;
        this.persist();
      }
      if (this.jobs.has(record.id) || waitingReason) continue;
      this.enqueue(record);
    }
    this.k.checkQueue.pump();
  }

  private enqueue(record: Record): void {
    const held = () => runtimeWaitHolds(this.k.s.tasks.find(task => task.id === record.taskId) ?? {});
    if (held()) return; // Keep the durable request and original order without occupying the shared line.
    const job = { stop: new AbortController() } as NonNullable<ReturnType<typeof this.jobs.get>>;
    this.jobs.set(record.id, job);
    const forget = () => { if (this.jobs.get(record.id) === job) this.jobs.delete(record.id); };
    const unsubscribe = this.k.subscribe(() => { if (held()) job.stop.abort("prerequisite"); });
    // The place it takes, from the live line as it joins: the runs holding or waiting for a place before it.
    record.queuePosition = this.k.checkQueue.positionFor(record.queueOrder);
    // Queue membership is immediate; even paused submissions keep FIFO arrival order.
    void this.k.checkQueue.acquire(job.stop.signal, true, record.queueOrder, () => this.placeChanged(record), ownerOf(record)).then(place => {
      unsubscribe();
      job.release = place;
      if (job.stop.signal.aborted || this.k.stopped || this.k.taskAdmissionsClosed(record.taskId)) {
        // A rolled-back join is retried by the next scheduling pass, never immediately.
        place();
        forget();
        if (!this.k.stopped && job.stop.signal.reason !== "rollback") this.pump();
        return;
      }
      const work = this.execute(record, job.stop.signal).finally(() => {
        job.work = undefined;
        this.k.syncIdleSleep();
      });
      job.work = work;
      void this.k.trackWork(work);
      this.k.syncIdleSleep();
    }, () => {
      unsubscribe();
      forget();
      if (!this.k.stopped && job.stop.signal.reason !== "rollback") this.pump();
    })
      .catch(error => console.error("Could not update extra validation queue:", error));
  }

  cancelTask(taskId: string): void {
    for (const record of [...this.records].filter(record => record.taskId === taskId)) {
      const job = this.jobs.get(record.id);
      if (record.state === "queued") this.finish(record, "stopped", "The task stopped before this extra validation started.");
      else job?.stop.abort("task");
    }
  }

  private execute(record: Record, signal: AbortSignal): Promise<void> {
    const run = new ValidationRun({
      now: () => Date.now(),
      admissionClosed: taskId => this.k.taskAdmissionsClosed(taskId),
      persist: () => this.persist(),
      change: (record, apply) => this.change(record, apply),
      note: (record, kind, words) => this.note(record, kind, words),
      finish: (record, result, detail) => this.finish(record, result, detail),
      requeue: record => this.requeue(record),
      hold: (record, detail) => this.hold(record, detail),
    }, {
      prepare: record => this.container.prepare(record),
      snapshot: record => (this.k.options.validationSnapshots ?? this.container).snapshot(record),
      cleanup: record => this.container.cleanup(record),
      run: async (record, signal, callbacks) =>
        (
          await runCheckBatch({
            cwd: record.snapshot,
            checks: [{ name: record.name, argv: this.container.runCommand(record) }],
            env: containerEnv(),
            timeoutMs: this.k.options.checkTimeoutMs ?? CHECK_TIMEOUT_MS,
            signal,
            logDirectory: join(this.k.dataDir, "checks", record.taskId),
            machineRecords: this.k.options.machineRecords,
            onSpawn: callbacks.spawned,
            onLog: callbacks.log,
            beforeStart: callbacks.admitted,
            executeCommand: this.k.options.runCheckCommand,
          })
        )[0],
    });
    return run.execute(record, signal);
  }

  private hold(record: Record, detail: string): void {
    const job = this.jobs.get(record.id)!;
    record.state = "held";
    record.cleanupDetail ??= detail;
    job.unblock ??= this.k.checkQueue.block(ownerOf(record));
    this.note(record, "held", `Extra validation “${record.name}” is held: ${record.cleanupDetail}`);
    this.persist();
    this.k.checkQueue.pump();
  }

  private finish(record: Record, result: NonNullable<ExtraValidation["result"]>, detail: string): void {
    // Update the durable receipt and current ownership together before releasing capacity.
    this.change(record, () => {
      record.state = "finished";
      record.result = result;
      record.detail = detail;
      delete record.waitingReason;
      record.endedAt ??= Date.now();
      record.durationMs ??= 0;
      record.waitingMs ??= Math.max(0, (record.startedAt ?? record.endedAt) - record.queuedAt);
      this.note(
        record,
        "finished",
        `Extra validation “${record.name}” ${result} (${Math.round(record.durationMs / 1000)} seconds). This is extra evidence only.`
      );
      this.k.store.updateReceiptResult(record.requestId, JSON.stringify(this.reply(record)));
      this.k.s.extraValidations = this.records.filter(entry => entry.id !== record.id);
      this.persist();
    });
    const job = this.jobs.get(record.id);
    if (record.startedAt === undefined) job?.stop.abort("task");
    job?.release?.();
    job?.unblock?.();
    this.jobs.delete(record.id);
    if (!this.k.stopped) {
      this.k.schedule();
    }
  }

  /** A failed state/receipt write rolls back the matching in-memory owner and evidence too. */
  private change<T>(record: Record, apply: () => T): T {
    const records = this.k.s.extraValidations;
    const previous = structuredClone(record);
    const task = this.k.extraValidationTask(record.id) ?? this.k.task(record.taskId);
    const timeline = task?.timeline.slice();
    const node = task?.journey?.find(node => node.id === record.nodeId);
    const evidence = node?.extraValidations;
    const parent = this.notices;
    const notices: (() => void)[] = [];
    this.notices = notices;
    let result: T;
    try { result = this.k.store.inTransaction(apply); }
    catch (error) {
      this.k.s.extraValidations = records;
      for (const key of Object.keys(record)) Reflect.deleteProperty(record, key);
      Object.assign(record, previous);
      if (task && timeline) task.timeline = timeline;
      if (node) node.extraValidations = evidence;
      this.k.store.history.reloadMetadata();
      throw error;
    } finally { this.notices = parent; }
    if (parent) parent.push(...notices);
    else for (const notify of notices) notify();
    return result;
  }

  private note(record: Record, kind: "queued" | "started" | "stopping" | "held" | "finished", words: string): void {
    const task = this.k.extraValidationTask(record.id);
    if (task) {
      const node = task.journey?.find(node => node.id === record.nodeId);
      if (node) node.extraValidations = [...(node.extraValidations ?? []).filter(entry => entry.id !== record.id), structuredClone(record)];
      // Labelled with the product this run used, whichever product the task shows now.
      const work =
        [...(task.repositories ?? []), ...(task.excludedRepositories ?? [])].find(
          (entry) => entry.productId === record.productId,
        ) ?? (task.repository?.productId === record.productId ? task.repository : undefined);
      this.k.log(work ? { task, work } : task, kind === "held" ? "warn" : "milestone", words);
      this.k.saveExtraValidationTask(record.id, task, task.timeline.at(-1)!);
    }
    const event = { at: Date.now(), kind: `extra.${kind}` as const, taskId: record.taskId, productIds: [record.productId], productId: record.productId,
      summary: words, refs: { validation: { requestId: record.requestId } }, validationId: record.id, state: record.state };
    const notify = () => {
      try { this.k.events.log.append([event]); }
      catch (error) { console.error("Could not publish extra validation event:", error); }
    };
    if (this.notices) this.notices.push(notify);
    else notify();
  }
  private persist(): void {
    if (!this.k.stopped) this.k.commitNow();
    else this.k.store.saveExtraValidationOwnership(this.records, this.k.s.seq);
  }

  private async recover(records: Record[]): Promise<void> {
    for (const record of records) {
      if (record.startedAt === undefined && record.state === "preparing") record.resumeQueued = true;
      if (!record.resumeQueued) {
        record.result ??= "stopped";
        record.detail ??= "Petrina restarted; the uncertain run was not repeated.";
      }
      if (record.run && record.run.endedAt === undefined) {
        record.run.output = "Petrina restarted before the command outcome was recorded. This is incomplete extra evidence.";
        record.run.interrupted = true;
      }
      record.endedAt ??= Date.now();
      record.durationMs ??= record.startedAt ? record.endedAt - record.startedAt : 0;
      try {
        if (await this.container.cleanup(record)) {
          await this.sealLog(record);
          if (record.resumeQueued) this.requeue(record);
        else this.finish(
          record,
          record.result ?? "stopped",
          record.detail ?? "Petrina restarted."
        );
        }
        else this.hold(record, "Cleanup is unconfirmed.");
      } catch (error) { this.hold(record, `Cleanup is unconfirmed: ${String(error)}`); }
    }
  }
  private requeue(record: Record): void {
    const task = this.k.s.tasks.find(task => task.id === record.taskId);
    if (!task || ["done", "cancelled", "pr-open", "paused", "backlog"].includes(task.state)) {
      delete record.resumeQueued;
      this.finish(record, "stopped", "The task stopped before the container started.");
      return;
    }
    this.change(record, () => {
      record.state = "queued";
      delete record.resumeQueued;
      delete record.result;
      delete record.detail;
      delete record.cleanupDetail;
      delete record.endedAt;
      delete record.durationMs;
      this.persist();
    });
    const job = this.jobs.get(record.id);
    this.jobs.delete(record.id);
    // Restore the original FIFO entry while the recovery block still prevents handoff.
    if (!this.k.stopped) this.enqueue(record);
    job?.release?.();
    job?.unblock?.();
    if (!this.k.stopped && !this.k.extraRecovery) this.k.schedule();
  }

  private async sealLog(record: Record): Promise<void> {
    const run = record.run;
    if (!run || run.endedAt !== undefined) return;
    // A crash left this exact open log unfinished. After workload cleanup, settle its length
    // and beginning using its pre-spawn identity; never recover evidence from an unbound path.
    if (run.logPath && run.logFileIdentity) {
      try {
        const path = await realpath(run.logPath);
        if (!path.startsWith(resolve(await realpath(this.k.dataDir), "checks", record.taskId) + sep)) throw new Error("Diagnostic outside its task folder");
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await file.stat({ bigint: true });
          if (!info.isFile() || info.nlink !== 1n || info.dev.toString() !== run.logFileIdentity.device || info.ino.toString() !== run.logFileIdentity.inode) throw new Error("Diagnostic identity changed");
          run.logFileLength = Number(info.size);
          run.logFileBeginning = await checkLogBeginning(file, run.logFileLength);
        } finally { await file.close(); }
      } catch { run.logError = "The original interrupted diagnostic could not be verified."; }
    }
    // Cleanup settled the interrupted attempt even if creating its diagnostic failed.
    run.endedAt = record.endedAt;
    run.ms = record.durationMs ?? 0;
  }

  retryCleanup(): Promise<void> {
    if (this.k.stopped) return Promise.resolve();
    return this.retrying ??= this.ready.then(async () => {
      if (this.k.stopped) return;
      for (const record of [...this.records].filter(record => record.state === "held")) {
        const before = record.cleanupDetail;
        try {
          if (await this.container.cleanup(record)) {
            await this.sealLog(record);
            if (record.resumeQueued) this.requeue(record);
            else this.finish(
              record,
              record.result ?? "stopped",
              record.detail ?? "Cleanup confirmed."
            );
          } else if (record.cleanupDetail !== before) {
            // Capacity stays held. Waiting runs read the new evidence in the same words, with no new timeline line.
            this.persist();
            this.k.checkQueue.refresh();
          }
        } catch (error) { this.hold(record, `Cleanup is unconfirmed: ${String(error)}`); }
      }
    }).finally(() => { this.retrying = undefined; });
  }
  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    for (const job of this.jobs.values()) job.stop.abort("shutdown");
    await Promise.allSettled([this.ready, this.retrying, ...[...this.jobs.values()].map(job => job.work)]);
  }
}
