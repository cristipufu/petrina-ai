// Shared task bookkeeping. Callers own I/O, persistence, clocks and scheduling; these
// transitions only validate and change the supplied records, with an explicit time.
import type { NewTaskInput } from "./commands.js";
import type { DeepMutable } from "./flow.js";
import { endOpenStep, JOURNEY_WORDS as W, openStep, stopCheckProgress } from "./journey.js";
import type { AgentProfile, Id, Product, RepositoryState, Stage, TaskState } from "./model.js";
import type { WorkChoice } from "./source.js";
import { blocksDependents } from "./repositories.js";
import { reviewerAt } from "./roles.js";
import { clearRunningTools, MAX_STEP_RECORDS, stepRecord } from "./summary.js";

type MutableTask = DeepMutable<TaskState>;
type Execution = DeepMutable<Pick<RepositoryState, "stepAttempts" | "conversation" | "sideStep">>;

/** One request shape for coordinator-created real and scripted tasks. */
export function createTaskState(input: NewTaskInput, products: readonly Product[], seed: { id: Id; timelineId: Id; now: number; priority: number; area?: string }, find: (id: Id) => Pick<TaskState, "id" | "after"> | undefined = () => undefined): MutableTask {
  const selected = input.worksOn ?? (input.productId ? [{ productId: input.productId, startFrom: input.startFrom ?? { kind: "default" as const }, delivery: input.delivery ?? products.find((entry) => entry.id === input.productId)?.delivery ?? "pull-request" }] : []);
  if (selected.some((choice) => !products.some((entry) => entry.id === choice.productId))) throw new Error("Choose registered products.");
  if (new Set(selected.map((entry) => entry.productId)).size !== selected.length) throw new Error("Choose each product once.");
  const product = products.find((entry) => entry.id === (selected[0]?.productId ?? input.productId));
  if (!product && input.productId) throw new Error("Unknown product");
  const title = input.title.trim();
  if (!title) throw new Error("A task needs a title");
  const choice: WorkChoice = selected[0] ?? { productId: product?.id ?? "", startFrom: input.startFrom ?? { kind: "default" }, delivery: input.delivery ?? product?.delivery ?? "pull-request" };
  const after = validateTaskDependencies(seed.id, input.after ?? [], (id) => id === seed.id ? { id } : find(id));
  return {
    ...(input.after ? { after } : {}),
    id: seed.id, productId: product?.id ?? "", selectedProducts: selected.map((choice) => ({ ...choice, startFrom: { ...choice.startFrom } })),
    explicitStart: input.startFrom !== undefined || (selected.length > 0 && input.worksOn !== undefined),
    workChoice: { ...choice, startFrom: { ...choice.startFrom } }, title, description: input.description?.trim() ?? "", area: seed.area ?? title.toLowerCase(),
    kind: input.kind ?? "feature", priority: input.position === "top" ? -1 : seed.priority, held: false,
    state: input.backlog ? "backlog" : "queued", column: input.backlog ? "backlog" : "queue", holdsSlot: false,
    approvePlan: selected.length > 1 || (input.approvePlan ?? selected.length !== 1), delivery: choice.delivery,
    approveDelivery: input.approveDelivery ?? selected.some((choice) => products.find((entry) => entry.id === choice.productId)?.approveDelivery !== false),
    stageIndex: -1, rounds: {}, sub: 0, fixing: false,
    statusLine: input.backlog ? "Review the request before queueing" : "In the queue", createdAt: seed.now,
    timeline: [{ id: seed.timelineId, at: seed.now, text: input.backlog ? "You added it to the backlog" : "You added it to the queue", tone: "you" }],
    session: [], queued: [], objections: [], findings: [], ...(input.clientId ? { clientId: input.clientId } : {}),
  };
}

export function queueBacklogTask(task: MutableTask, priority: number): boolean {
  if (task.state !== "backlog") return false;
  Object.assign(task, { priority, state: "queued", column: "queue", held: false, statusLine: "In the queue" });
  return true;
}

export function returnQueuedTaskToBacklog(task: MutableTask): boolean {
  if (task.state !== "queued" || task.startedAt !== undefined) return false;
  Object.assign(task, { state: "backlog", column: "backlog", held: false, statusLine: "Review the request before queueing" });
  return true;
}

export function editBacklogRequest(task: MutableTask, changes: { title: string; description: string }): void {
  if (task.state !== "backlog") throw new Error("Only backlog requests can be edited before work starts.");
  const title = changes.title.trim();
  if (!title || title.length > 200 || changes.description.length > 8000) throw new Error("Give the task a title and a shorter request.");
  task.title = title; task.description = changes.description.trim(); task.area = title.toLowerCase();
}

/** Used after the complete selection has been validated and any picture copies have succeeded. */
export function combineBacklogTasks(combined: MutableTask, sources: MutableTask[], now: number, priority: number): void {
  combined.combinedFrom = sources.map(({ id, title }) => ({ id, title }));
  const reports = sources.flatMap((task) => task.followUp?.reports ?? []);
  if (reports.length) combined.followUp = { reports };
  for (const source of sources) {
    source.combinedInto = combined.id;
    Object.assign(source, { state: "cancelled", column: "done", holdsSlot: false, finishedAt: now, statusLine: `Combined into ${combined.title}` });
  }
  queueBacklogTask(combined, priority);
}

/** Admission is the boundary: opening an editor never reserves or holds the task. */
export function canEditTaskDependencies(task: Pick<TaskState, "state" | "startedAt">): boolean {
  return task.startedAt === undefined && (task.state === "backlog" || task.state === "queued");
}

export function assertTaskDependenciesEditable(task: Pick<TaskState, "state" | "startedAt"> | undefined): asserts task is Pick<TaskState, "state" | "startedAt"> {
  if (!task) throw new Error("This task is unavailable. Return to the board and choose another task.");
  if (!canEditTaskDependencies(task)) throw new Error("This task has already started or finished. Prerequisites can only change in Backlog or before queued work starts.");
}

/** Validate the complete dependency graph before changing the task. Archived records can be looked up lazily. */
export function validateTaskDependencies(taskId: Id, after: readonly Id[], find: (id: Id) => Pick<TaskState, "id" | "after"> | undefined): Id[] {
  if (!find(taskId)) throw new Error("Unknown task");
  const ids = [...new Set(after)];
  if (ids.length > 20) throw new Error("Choose up to 20 prerequisites. Remove a task before adding another.");
  for (const id of ids) {
    if (id === taskId) throw new Error("A task cannot wait for itself. Remove it from the prerequisites.");
    if (!find(id)) throw new Error("Unknown task. Remove the unavailable prerequisite and choose another task.");
  }
  const reaches = (from: Id, seen = new Set<Id>()): boolean => {
    if (from === taskId) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (find(from)?.after ?? []).some((next) => reaches(next, seen));
  };
  if (ids.some((id) => reaches(id))) throw new Error("Those tasks would wait for each other. Remove a prerequisite that already waits on this task.");
  return ids;
}

export function blockingDependencies<T extends TaskState>(task: Pick<TaskState, "after">, find: (id: Id) => T | undefined): T[] {
  return (task.after ?? []).flatMap((id) => { const other = find(id); return other && blocksDependents(other) ? [other] : []; });
}

export function assignFutureProfile(task: MutableTask, profiles: readonly AgentProfile[], stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): string | undefined {
  const at = task.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
  const stage = task.plan?.stages[at], selected = stage?.[list];
  if (!stage || at <= task.stageIndex || !profiles.some((profile) => profile.id === profileId) || !selected || index < 0 || index >= selected.length) return;
  selected[index] = profileId;
  const key = list === "profileIds" ? "assignments" : "reviewerAssignments";
  stage[key] = selected.map((id, at) => at === index ? { profileId: id, by: "coordinator", reason: "Chosen by you." } : stage[key]?.[at] ?? { profileId: id, by: "engine" });
  return stage.title;
}

export function appendFutureReviewer(task: MutableTask, profiles: readonly AgentProfile[], stageId: Id, profileId: Id): string | undefined {
  const at = task.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
  const stage = task.plan?.stages[at];
  if (!stage || stage.kind !== "review-chain" || at <= task.stageIndex || !profiles.some((profile) => profile.id === profileId)) return;
  if (stage.roleIds) stage.roleIds = [...stage.profileIds.map((_, index) => reviewerAt(stage as Stage, index)), "code-reviewer"];
  stage.profileIds.push(profileId);
  stage.assignments = stage.profileIds.map((id, at) => at === stage.profileIds.length - 1 ? { profileId: id, by: "coordinator", reason: "Added to the review by you." } : stage.assignments?.[at] ?? { profileId: id, by: "engine" });
  return stage.title;
}

/** Step-local activity is never allowed to outlive the step, including grouped reviewer clocks. */
export function stopTaskActivity(task: MutableTask): void {
  clearRunningTools(task);
  delete task.toolActivity;
  delete task.todo; delete task.stepClock;
  for (const work of Object.values(task.hunt?.work ?? {})) {
    delete work.todo; delete work.activity; delete work.toolActivity; delete work.clock; delete work.waiting;
  }
}

export function clearTaskStep(task: MutableTask, execution: Execution): void {
  delete task.stepNotes; delete execution.stepAttempts; delete execution.conversation;
  stopTaskActivity(task);
}

export function finishTaskStep(task: MutableTask, execution: Execution, now: number): void {
  if (task.stepClock && execution.stepAttempts === 1) task.steps = [...(task.steps ?? []), stepRecord(task.stepClock, now)].slice(-MAX_STEP_RECORDS);
  clearTaskStep(task, execution);
}

export function pauseTaskState(task: MutableTask, execution: Execution, now: number): boolean {
  if (!["running", "needs-you", "waiting"].includes(task.state)) return false;
  task.state = "paused"; task.holdsSlot = false; task.statusLine = "Paused by you";
  delete task.agent; delete task.helpers; delete execution.conversation;
  delete task.reviewSessions;
  if (execution.sideStep) delete execution.sideStep.conversation;
  stopTaskActivity(task); stopCheckProgress(task, now);
  return true;
}

export function resumeTaskState(task: MutableTask, hasGate: boolean): boolean {
  if (task.state !== "paused") return false;
  task.state = hasGate ? "needs-you" : "waiting";
  task.statusLine = hasGate ? "Waiting for you" : "Waiting for a free slot";
  return true;
}

export function cancelTaskState(task: MutableTask, execution: Execution, now: number): void {
  task.state = "cancelled"; task.column = "done"; task.holdsSlot = false;
  task.finishedAt = now; task.statusLine = "Cancelled";
  delete task.agent; delete task.helpers; delete execution.conversation;
  delete task.reviewSessions;
  delete execution.sideStep;
  stopTaskActivity(task); stopCheckProgress(task, now);
  endOpenStep(task, { outcome: openStep(task)?.kind === "agent" ? W.stopped : W.cancelled, end: "cancelled" }, now);
}
