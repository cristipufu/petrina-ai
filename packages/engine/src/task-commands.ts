// Coordinator commands for task creation, backlog, plan choices, queue order, waits and images.

import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AFTER_WORDS,
  appendFutureReviewer,
  assertTaskDependenciesEditable,
  assignFutureProfile,
  changeRuntimeWait,
  combineBacklogTasks,
  combinedBacklogInput,
  completeAll,
  createTaskState,
  editBacklogRequest,
  queueBacklogTask,
  queueNeighbour,
  queueOf,
  queuePlacement,
  returnQueuedTaskToBacklog,
  syncWait,
  validateRuntimeWait,
  validateTaskDependencies,
  type Id,
  type NewTaskInput,
  type Task,
  type WorkChoice,
} from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import type { Cleanup } from "./cleanup.js";
import type { Engine } from "./engine.js";
import { readTaskImage } from "./image-preview.js";
import { stepKey } from "./kernel.js";
import type { Sources } from "./sources.js";

export class TaskCommands {
  constructor(
    private readonly engine: Engine,
    private readonly sources: Sources,
    private readonly cleanup: Cleanup,
  ) {}

  addTask(input: NewTaskInput, schedule = true): Id {
    const id = this.createTask(input);
    this.engine.commitNow();
    // The outside operation schedules after its enclosing request-receipt transaction commits.
    if (schedule) this.engine.schedule();
    return id;
  }

  startFirstTask(input: NewTaskInput & { clientId: Id }): Id {
    const id = this.engine.addTask(input);
    const setup = this.engine.s.setup;
    if (setup) {
      setup.done = true;
      setup.firstTaskId ??= id;
    }
    this.engine.commitNow();
    return id;
  }

  createTask(input: NewTaskInput): Id {
    const known = input.clientId
      ? this.engine.s.tasks.find((task) => task.clientId === input.clientId)?.id
        ?? this.engine.store.history.byClient(input.clientId)
      : undefined;
    if (known) return known;
    // Validate before reserving ids, so a refused request changes no state.
    const task = createTaskState(
      input,
      this.engine.s.products,
      { id: "", timelineId: "", now: Date.now(), priority: queueOf(this.engine.s.tasks).length },
      (id) => this.engine.task(id),
    );
    let id = this.engine.id("task");
    while (this.engine.tracking.taskIdTaken(id)) id = this.engine.id("task");
    task.id = id;
    task.timeline[0]!.id = this.engine.id(id);
    const product = this.engine.s.products.find((entry) => entry.id === task.productId);
    task.repository = {
      productId: task.productId,
      delivery: task.delivery,
      workChoice: structuredClone(task.workChoice),
      ...(product
        ? {
          workProduct: {
            id: product.id,
            name: product.name,
            repo: product.repo,
            path: product.path,
            remote: product.remote,
            defaultBranch: product.defaultBranch ?? "main",
          },
        }
        : {}),
    };
    this.engine.s.tasks.push(task);
    if (task.after?.length) {
      if (task.state === "queued") {
        syncWait(task, this.engine.blockers(task), (depId) => this.engine.task(depId), Date.now());
      }
      this.engine.log(task, "you", AFTER_WORDS.starts(task.after.map((depId) => this.engine.task(depId)!.title)));
    }
    this.engine.renumberQueue();
    return id;
  }

  queueTask(taskId: Id): void {
    const task = this.engine.task(taskId);
    if (!task || !queueBacklogTask(task, queueOf(this.engine.s.tasks).length)) return;
    this.engine.log(task, "you", "You reviewed the request and queued it for work");
    this.engine.commitNow(task);
    this.engine.schedule();
  }

  combineBacklog(taskIds: Id[], title: string, clientId: Id): Promise<Id> {
    return this.engine.trackWork(this.combineBacklogRequests(taskIds, title, clientId));
  }

  private async combineBacklogRequests(taskIds: Id[], title: string, clientId: Id): Promise<Id> {
    const known = this.engine.s.tasks.find((task) => task.clientId === clientId)
      ?? (() => {
        const id = this.engine.store.history.byClient(clientId);
        return id ? this.engine.task(id) : undefined;
      })();
    if (known) {
      if (JSON.stringify(known.combinedFrom?.map((entry) => entry.id)) !== JSON.stringify(taskIds)) {
        throw new Error("This request reference was already used for a different selection.");
      }
      return known.id;
    }
    const input = combinedBacklogInput(this.engine.s.tasks as Task[], taskIds, title);
    const sources = taskIds.map((id) => this.engine.task(id)!);
    const before = JSON.stringify(sources);
    const captures = join(this.engine.dataDir, "captures");
    await mkdir(captures, { recursive: true });
    const tempName = `combine-${randomUUID()}`;
    const release = this.engine.holdFollowUp(tempName);
    const temp = join(captures, tempName);
    try {
      await mkdir(temp);
      const images = await completeAll(
        sources.flatMap((source) =>
          source.session.flatMap((line) =>
            (line.images ?? [])
              .filter((image) => /^[a-f0-9-]{36}$/.test(image.id))
              .map(async (image) => {
                const id = randomUUID();
                await this.engine.files.copyFile(join(captures, source.id, `${image.id}.png`), join(temp, `${id}.png`));
                return {
                  id,
                  caption: `${source.title}: ${image.caption}`,
                  ...(image.from ? { from: { ...image.from } } : {}),
                };
              }),
          ),
        ),
      );
      // Other commands may have edited or queued a request while the pictures were copied.
      if (this.engine.stopped || JSON.stringify(taskIds.map((id) => this.engine.task(id))) !== before) {
        throw new Error("A selected task changed. Review the selection and try again.");
      }
      combinedBacklogInput(this.engine.s.tasks as Task[], taskIds, title);
      const id = this.createTask({ ...input, clientId });
      const combined = this.engine.task(id)!;
      try {
        renameSync(temp, join(captures, id));
      } catch (error) {
        this.engine.s.tasks = this.engine.s.tasks.filter((task) => task.id !== id);
        throw error;
      }
      if (images.length) {
        combined.session.push({
          id: this.engine.id(id),
          from: "system",
          at: Date.now(),
          text: "Pictures from the original requests",
          images,
        });
      }
      combineBacklogTasks(combined, sources, Date.now(), queueOf(this.engine.s.tasks).length);
      for (const source of sources) this.engine.log(source, "you", source.statusLine);
      this.engine.log(combined, "you", `You combined ${sources.length} backlog requests and queued them as one task`);
      this.engine.renumberQueue();
      this.engine.commitNow();
      for (const source of sources) void this.engine.trackWork(this.cleanup.removeCaptures(source.id));
      this.engine.schedule();
      return id;
    } finally {
      release();
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  moveToBacklog(taskId: Id): void {
    const task = this.engine.task(taskId);
    if (!task || !returnQueuedTaskToBacklog(task)) return;
    syncWait(task, [], () => undefined, Date.now());
    this.engine.renumberQueue();
    this.engine.log(task, "you", "You moved it to the backlog for review");
    this.engine.commitNow(task);
  }

  updateBacklog(taskId: Id, changes: { title: string; description: string }): void {
    const task = this.engine.task(taskId);
    if (!task) throw new Error("Only backlog requests can be edited before work starts.");
    editBacklogRequest(task, changes);
    this.engine.log(task, "you", "You updated the backlog request");
    this.engine.commitNow(task);
  }

  async setTaskStart(taskId: Id, choice: WorkChoice): Promise<void> {
    const task = this.engine.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (task?.workValidating) throw new Error("Wait for validation to finish, then edit the choices.");
    if (task?.workRows) {
      if (!task.workRows.some((row) => row.choice.productId === choice.productId)) {
        throw new Error(
          "That product is not in this task's product choices. Add it to the task before changing its starting point.",
        );
      }
      return this.engine.setTaskProducts(
        taskId,
        task.workRows.map((row) =>
          row.choice.productId === choice.productId
            ? choice
            : choice.lead
              ? { ...row.choice, lead: false }
              : row.choice,
        ),
      );
    }
    if (!task || scope!.work.worktree || !this.engine.s.inbox.some((item) => item.taskId === taskId && item.kind === "plan")) {
      throw new Error("The starting point can be edited at the plan check before work starts.");
    }
    await this.sources.propose(task, [choice]);
    this.engine.commitNow();
  }

  async setTaskProducts(taskId: Id, choices: readonly WorkChoice[]): Promise<void> {
    const task = this.engine.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    const editableAtPlan = !!task
      && !task.repositories?.some((entry) => entry.completedStages.length)
      && (!!task.repositories || !scope!.work.worktree)
      && this.engine.s.inbox.some((item) => item.taskId === taskId && ["plan", "stuck"].includes(item.kind));
    if (!editableAtPlan) throw new Error("Change products at the plan check before work starts.");
    if (task.workValidating) throw new Error("Wait for validation to finish, then edit the choices.");
    if (!task.approveDelivery) {
      const added = choices.find(
        (choice) =>
          !task.workRows?.some((row) => row.choice.productId === choice.productId)
          && this.engine.s.products.find((product) => product.id === choice.productId)?.approveDelivery !== false,
      );
      if (added) {
        task.approveDelivery = true;
        task.approvalExplanation =
          "The added product asks before shipping, so shared delivery approval is on. You can change it here.";
      }
    }
    for (const choice of choices) {
      const prepared = task.repositories?.find(
        (work) => work.productId === choice.productId && (work.worktree || work.preparingCopy),
      );
      if (
        prepared?.workChoice
        && (JSON.stringify(prepared.workChoice.startFrom) !== JSON.stringify(choice.startFrom)
          || prepared.delivery !== choice.delivery)
      ) {
        throw new Error(
          "Keep the approved source and delivery for a prepared product. You can leave it out while revising this saved plan.",
        );
      }
    }
    task.selectedProducts = [...choices];
    await this.sources.propose(task, choices, true);
    if (!this.engine.s.inbox.some((item) => item.taskId === taskId && item.kind === "plan")) {
      this.engine.s.inbox = this.engine.s.inbox.filter((item) => !(item.taskId === taskId && item.kind === "stuck"));
      task.stageIndex = -1;
      this.engine.gate(task, "plan");
    }
    this.engine.commitNow();
  }

  async setTaskAddition(taskId: Id, repository: string, name: string, path: string): Promise<void> {
    const task = this.engine.task(taskId);
    if (!task) throw new Error("Unknown task.");
    await this.sources.configureAddition(task, repository, name, path);
  }

  setTaskApproval(taskId: Id, ask: boolean): void {
    const task = this.engine.task(taskId);
    if (!task || !this.engine.s.inbox.some((item) => item.taskId === taskId && item.kind === "plan")) {
      throw new Error("Change this choice at the plan check.");
    }
    task.approveDelivery = ask;
    delete task.approvalExplanation;
    this.engine.commitNow();
  }

  moveInQueue(taskId: Id, index: number): void {
    const queue = queueOf(this.engine.s.tasks as Task[]).map((task) => task.id);
    const from = queue.indexOf(taskId);
    if (from < 0) return;
    queue.splice(from, 1);
    queue.splice(Math.max(0, Math.min(queue.length, index)), 0, taskId);
    queue.forEach((id, position) => {
      const task = this.engine.task(id);
      if (task) task.priority = position;
    });
    this.engine.commit();
    this.engine.schedule();
  }

  placeInQueue(taskId: Id, anchorId: Id, side: "before" | "after"): number {
    const queue = queueOf(this.engine.s.tasks).map((task) => task.id);
    const index = queuePlacement(queue, taskId, anchorId, side);
    if (index === undefined) return -1;
    const hidden = Math.max(0, Math.abs(queue.indexOf(taskId) - queue.indexOf(anchorId)) - 1);
    this.engine.moveInQueue(taskId, index);
    return hidden;
  }

  moveVisibleInQueue(taskId: Id, visibleIds: Id[], direction: -1 | 1): number {
    const queue = queueOf(this.engine.s.tasks).map((task) => task.id);
    const anchor = queueNeighbour(queue, visibleIds, taskId, direction);
    return anchor ? this.engine.placeInQueue(taskId, anchor, direction < 0 ? "before" : "after") : -1;
  }

  setHeld(taskId: Id, held: boolean): void {
    const task = this.engine.task(taskId);
    if (!task) return;
    task.held = held;
    this.engine.log(task, "you", held ? "You put it on hold" : "You released the hold");
    this.engine.commit(task);
    this.engine.schedule();
  }

  setAfter(taskId: Id, after: readonly Id[]): void {
    const task = this.engine.task(taskId);
    assertTaskDependenciesEditable(task);
    const ids = validateTaskDependencies(taskId, after, (id) => this.engine.task(id));
    task.after = ids;
    if (task.state === "queued") {
      syncWait(task, this.engine.blockers(task), (id) => this.engine.task(id), Date.now());
    }
    this.engine.log(
      task,
      "you",
      ids.length ? AFTER_WORDS.starts(ids.map((id) => this.engine.task(id)!.title)) : AFTER_WORDS.none,
    );
    this.engine.commitNow(task);
    this.engine.schedule();
  }

  setRuntimeWait(taskId: Id, after: readonly Id[], reason: string, requestId: string): boolean {
    const task = this.engine.task(taskId);
    if (!task) throw new Error("That task does not exist.");
    const input = validateRuntimeWait(task, after, reason, (id) => this.engine.task(id) ?? this.engine.taskDetails(id));
    if (!changeRuntimeWait(task, { ...input, requestId }, Date.now())) return false;
    // Save the admitted step with the decision, even if the coordinator clears the wait
    // before scheduling runs again or that step fails before the next scheduler pass.
    if (input.after.length && !task.runtimeWait!.refreshAfterStep && this.engine.taskStepStarted(task)) {
      task.runtimeWait!.refreshAfterStep = stepKey(task);
    }
    task.runtimeWait!.titles = {
      ...task.runtimeWait!.titles,
      ...Object.fromEntries(input.after.map((id) => [id, this.engine.taskDetails(id)!.title])),
    };
    const waitedNames = input.after
      .map((id) => `“${this.engine.task(id)?.title ?? this.engine.taskDetails(id)?.title ?? id}”`)
      .join(", ");
    this.engine.log(
      task,
      "you",
      input.after.length
        ? `You asked this task to wait for ${waitedNames} to land. ${input.reason}`
        : `You cleared the prerequisite wait. ${input.reason}`,
    );
    task.runtimeWait!.changes.at(-1)!.timelineId = task.timeline.at(-1)!.id;
    this.engine.commitNow(task);
    // The named operation schedules only after its wait and retry receipt commit together.
    return true;
  }

  setStageProfile(
    taskId: Id,
    stageId: Id,
    list: "profileIds" | "reviewerProfileIds",
    index: number,
    profileId: Id,
  ): void {
    const task = this.engine.task(taskId);
    const title = task && assignFutureProfile(task, this.engine.s.profiles, stageId, list, index, profileId);
    if (title === undefined) return;
    this.engine.log(task!, "you", `You changed who works on “${title}”`);
    this.engine.commit(task!);
  }

  addReviewer(taskId: Id, stageId: Id, profileId: Id): void {
    const task = this.engine.task(taskId);
    const title = task && appendFutureReviewer(task, this.engine.s.profiles, stageId, profileId);
    if (title === undefined) return;
    this.engine.log(task!, "you", `You added a reviewer to “${title}”`);
    this.engine.commit(task!);
  }

  async reportImage(taskId: string, imageId: string): Promise<Blob | undefined> {
    // Finished records retain captions and references, never accessible image bytes.
    const task = this.engine.s.tasks.find((entry) => entry.id === taskId);
    if (!task || task.state === "done" || task.state === "cancelled") return;
    if (
      !/^[a-zA-Z0-9_-]+$/.test(taskId)
      || !/^[a-f0-9-]{36}$/.test(imageId)
      || !task.session.some((line) => line.images?.some((image) => image.id === imageId))
    ) {
      return;
    }
    const file = Bun.file(join(this.engine.dataDir, "captures", taskId, `${imageId}.png`));
    return (await file.exists()) ? file : undefined;
  }

  async previewImage(taskId: Id, path: string, productId?: Id): Promise<{ mime: string; data: string }> {
    const task = this.engine.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (!task || task.state === "done" || task.state === "cancelled") {
      throw new Error("Images are available while the task's working copy exists.");
    }
    const works = task.repositories?.filter((entry) => !entry.removed) ?? [];
    const work = works.find((entry) => entry.productId === productId);
    if (productId && !work && (task.repositories || scope!.work.productId !== productId)) {
      throw new Error("This product is outside the task.");
    }
    const root = work ? work.worktree : scope!.work.worktree;
    const products = new Set([scope!.work.productId, ...works.map((entry) => entry.productId)]);
    const absoluteRoots = [
      scope!.work.worktree,
      ...works.map((entry) => entry.worktree),
      ...[...products].map((id) => join(this.engine.dataDir, "worktrees", id, `${task.id}.copies`)),
    ].filter((folder): folder is string => !!folder);
    return readTaskImage(root, path, absoluteRoots);
  }
}
