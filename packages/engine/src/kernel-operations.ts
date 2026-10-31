import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { detectTerminals, thisMachine, type FoundTerminal } from "@petrina/agent-runtime/terminal";
import { ADAPTERS, detectTools, ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import {
  AgentMessages,
  bindParticipantSessionLine,
  BUILT_IN_ROLES,
  clearRunningTools,
  clearTaskStep,
  finishTaskStep,
  immediateMessageClock,
  involvesProduct,
  isCheckId,
  libraryRoles,
  NO_ROLE_CHANGES,
  queueOf,
  restoreProfileCatalog,
  saySessionLine,
  stepTag,
  stopCheckProgress,
  withdrawAsks,
  type DeepMutable,
  type Id,
  type InboxItem,
  type State,
  type StepNote,
  type Task,
} from "@petrina/core";
import {
  drainRuntime,
  executionOf,
  inFlightWork,
  keepsIdleSleep,
  pauseAgentStep,
  restoreRepositoryState,
  type AgentSession,
  type RepositoryContext,
} from "@petrina/orchestrator";
import type { Store } from "@petrina/storage/store";
import type { IdleSleepAssertion } from "./awake.js";
import {
  Aborted,
  abortable,
  MAX_TIMELINE,
  PLANNER_PROFILE,
  renameRoles,
  setupOf,
  type EngineOptions,
  type RuntimeState,
  type RuntimeTask,
} from "./engine-options.js";
import type { Kernel } from "./kernel.js";

export type KernelMachine = ReturnType<typeof thisMachine>;

export function emptyKernelState(): State {
  return {
    now: Date.now(),
    seq: 0,
    products: [],
    roles: BUILT_IN_ROLES,
    tools: [],
    profiles: ENGINE_PROFILES,
    tasks: [],
    inbox: [],
    pool: {
      limit: 3,
      paused: false,
      toolCaps: Object.fromEntries(Object.keys(ADAPTERS).map((id) => [id, 3])),
    },
  };
}

export function initializeKernelState(
  store: Store,
  options: EngineOptions,
  machine: KernelMachine,
): { state: RuntimeState; loaded: boolean; found: FoundTerminal[] } {
  const loaded = store.loadActive((raw) => {
    for (const task of raw.tasks) restoreRepositoryState(task as RuntimeTask);
    renameRoles(raw as RuntimeState);
  });
  const state = (loaded ?? emptyKernelState()) as RuntimeState;
  state.backgroundAgents = [];
  if (loaded) {
    renameRoles(state);
    // Nothing worked while Petrina was stopped: a step's working time ends at the last moment it saved.
    for (const task of state.tasks) {
      pauseAgentStep(task, state.now);
      stopCheckProgress(task, state.now);
      clearRunningTools(task);
    }
    for (const item of state.inbox) {
      if (item.toolId && !isCheckId(item.toolId)) {
        delete item.toolId;
        delete item.toolProblem;
      }
    }
  }
  state.roleChanges = (loaded?.roleChanges ?? structuredClone(NO_ROLE_CHANGES)) as RuntimeState["roleChanges"];
  state.roles = libraryRoles(state.roleChanges) as RuntimeState["roles"];
  restoreProfileCatalog(state);
  // Tests stand in the tools' own apps: those count as installed.
  state.tools = detectTools(
    options.requireAgentCommand ? (id) => Boolean(options.toolPath?.(id) || options.agentCommand) : undefined,
  ).map((tool) => (options.toolPath?.(tool.id) ? { ...tool, status: "ready" as const } : tool)) as RuntimeState["tools"];
  state.setup = setupOf(loaded) as RuntimeState["setup"];
  if (state.setup && !loaded?.setup && store.history.info().total > 0) state.setup.done = true;
  const found = options.terminals?.() ?? detectTerminals(machine);
  state.terminals = found.map(({ id, name }) => ({ id, name }));
  return { state, loaded: Boolean(loaded), found };
}

export function closeFailedKernelResources(error: unknown, closers: ReadonlyArray<() => void>): never {
  const failures: unknown[] = [];
  for (const close of closers) {
    try {
      close();
    } catch (failure) {
      failures.push(failure);
    }
  }
  if (failures.length) {
    throw new AggregateError([error, ...failures], "Engine construction failed and its resources could not all be closed");
  }
  throw error;
}

export function holdKernelFollowUp(holds: Map<Id, number>, id: Id): () => void {
  holds.set(id, (holds.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (holds.get(id) ?? 1) - 1;
    if (next <= 0) holds.delete(id);
    else holds.set(id, next);
  };
}

export function kernelTaskInvolves(k: Kernel, taskId: Id, productId: Id): boolean {
  const task = k.s.tasks.find((entry) => entry.id === taskId);
  if (task) return involvesProduct(task, productId);
  const archived = k.store.history.item(taskId);
  return Boolean(archived && (archived.productIds ?? [archived.productId]).includes(productId));
}

export function isPausedKernelCheck(k: Kernel, taskId: Id): boolean {
  return (
    k.s.pool.paused
    && !k.draining
    && k.waitingChecks.has(taskId)
    && !k.runs.has(taskId)
    && !k.helperRuns.get(taskId)?.size
  );
}

export function recordKernelStepNote(
  k: Kernel,
  task: RuntimeTask,
  kind: StepNote["kind"],
  text: string,
  extra: { id?: Id; about?: string } = {},
): void {
  task.stepNotes = [
    ...(task.stepNotes ?? []),
    { id: extra.id ?? k.id(task.id), at: Date.now(), kind, text, ...(extra.about ? { about: extra.about } : {}) },
  ];
}

export function markFirstClientReceipt(task: RuntimeTask, clientId: Id | undefined): boolean {
  if (!clientId) return true;
  if (task.received?.includes(clientId)) return false;
  task.received = [...(task.received ?? []), clientId].slice(-50);
  return true;
}

export function takeKernelInboxItem(k: Kernel, itemId: Id): DeepMutable<InboxItem> | undefined {
  const item = k.s.inbox.find((entry) => entry.id === itemId);
  if (item) k.s.inbox = k.s.inbox.filter((entry) => entry.id !== itemId);
  return item;
}

export function renumberKernelQueue(k: Kernel): void {
  queueOf(k.s.tasks as Task[]).forEach((task, position) => {
    const entry = k.task(task.id);
    if (entry && entry.priority !== position) {
      entry.priority = position;
      k.projection.changed(entry);
    }
  });
}

export function kernelInFlight(k: Kernel, cleanupCount: number): number {
  const agents = k.runs.size + [...k.helperRuns.values()].reduce((sum, runs) => sum + runs.size, 0);
  return (
    agents
    || inFlightWork({
      agents: 0,
      settling: [...k.settling.keys()].filter((id) => !k.isPausedCheck(id)).length,
      copyCleanups: k.copyCleanups.size,
      background: k.backgroundWork.size + cleanupCount,
      terminals: k.s.tasks.filter((task) => task.driving && !k.isPausedCheck(task.id)).length,
    })
  );
}

export function syncKernelIdleSleep(k: Kernel, idleSleep: IdleSleepAssertion): void {
  if (k.stopped) {
    idleSleep.setActive(false);
    return;
  }
  const owned = {
    drivers: [...k.drivers.keys()].some((id) => !k.isPausedCheck(id)),
    settling: [...k.settling.keys()].some((id) => !k.isPausedCheck(id)),
    agents: k.runs.size > 0,
    helpers: [...k.helperRuns.values()].some((runs) => runs.size > 0) || k.agentCleanup.pending > 0,
    screenGroups: k.screenGroups.size > 0,
    switching: k.switching.size > 0,
    copyCleanups: k.copyCleanups.size > 0,
    cleanupJobs: k.cleanupJobs.size > 0,
  };
  const knownActive = keepsIdleSleep({ ...owned, stopped: k.stopped, extraChecks: false });
  const active =
    knownActive
    || keepsIdleSleep({
      ...owned,
      stopped: k.stopped,
      extraChecks: !k.stopped && Boolean(k.extraChecksActive?.()),
    });
  idleSleep.setActive(active);
}

export function drainKernel(k: Kernel, limitMs: number, onWait?: (left: number) => void): Promise<number> {
  return drainRuntime(
    {
      requestStop: () => {
        k.draining = true;
        k.stopRequested.abort();
        k.checkQueue.pump();
      },
      stopped: () => k.stopped,
      inFlight: () => k.drainObservation().pending,
      failure: () => k.agentCleanup.snapshot().failure,
    },
    { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) },
    limitMs,
    onWait,
  );
}

export function saveExtraValidationKernelTask(
  k: Kernel,
  id: Id,
  task: RuntimeTask,
  line: Task["timeline"][number],
): void {
  const record = k.s.extraValidations?.find((entry) => entry.id === id && entry.taskId === task.id);
  if (!record) throw new Error("Extra validation no longer owns this task's cleanup.");
  if (k.stopped) k.store.saveExtraValidationEvidence(record, line, MAX_TIMELINE, k.s.extraValidations, k.s.seq);
  else k.projection.saveArchivedTask(task);
}

export function rerunReviewedChanges(k: Kernel, task: RuntimeTask): boolean {
  const id = task.rereview;
  if (!id) return false;
  delete task.rereview;
  const index = task.plan?.stages.findIndex((stage) => stage.id === id) ?? -1;
  if (index < 0) return false;
  task.stageIndex = index;
  task.sub = 0;
  task.fixing = false;
  delete task.hunt;
  k.log(task, "milestone", "Reviewing your changes: the review starts again from the first reviewer");
  k.commit();
  return true;
}

export function finishKernelStep(k: Kernel, target: RuntimeTask | RepositoryContext): void {
  const scope = executionOf(target);
  const { task, work: repository } = scope;
  finishTaskStep(task, repository, Date.now());
  delete task.capacityResume;
  delete task.capacityRetries;
  delete task.capacityPaused;
  k.pendingAgentAdmissions.delete(task.id);
  k.releaseScreen(task);
}

export function clearKernelStep(k: Kernel, target: RuntimeTask | RepositoryContext): void {
  const scope = executionOf(target);
  const { task, work: repository } = scope;
  clearTaskStep(task, repository);
  delete task.capacityResume;
  delete task.capacityRetries;
  delete task.capacityPaused;
  k.releaseScreen(task);
  k.stopStep(task);
}

export async function waitForKernelReply(k: Kernel, id: Id, signal: AbortSignal): Promise<string> {
  let waiter!: { resolve: (answer: string) => void; reject: (error: unknown) => void };
  const reply = new Promise<string>((resolve, reject) => {
    waiter = { resolve, reject };
    k.waiting.set(id, waiter);
  });
  try {
    return await abortable(reply, signal);
  } finally {
    if (k.waiting.get(id) === waiter) k.waiting.delete(id);
  }
}

export function dropKernelBlockingItems(k: Kernel, taskId: Id): void {
  const task = k.task(taskId);
  const dropped = k.s.inbox.filter(
    (entry) => entry.taskId === taskId && entry.blocking && entry.kind !== "maintenance-settings",
  );
  if (task) withdrawAsks(task, dropped.map((item) => item.id), Date.now());
  for (const item of dropped) {
    k.waiting.get(item.id)?.reject(new Aborted());
    k.waiting.delete(item.id);
  }
  k.s.inbox = k.s.inbox.filter(
    (entry) => !(entry.taskId === taskId && entry.blocking && entry.kind !== "maintenance-settings"),
  );
}

export function stopKernelDriver(k: Kernel, taskId: Id): void {
  k.drivers.get(taskId)?.abort();
  k.drivers.delete(taskId);
  const run = k.runs.get(taskId);
  if (run) void k.stopAgent(taskId, run).catch(() => undefined);
  k.runs.delete(taskId);
  k.stopHelpers(taskId);
}

export function stopKernelHelpers(k: Kernel, taskId: Id): void {
  for (const run of k.helperRuns.get(taskId) ?? []) void k.stopAgent(taskId, run).catch(() => undefined);
  k.helperRuns.delete(taskId);
  k.syncIdleSleep();
}

export function stopKernelAgent(k: Kernel, taskId: Id, run: AgentSession): Promise<void> {
  const stopped = k.agentCleanup.stop(taskId, run);
  k.syncIdleSleep();
  void stopped.then(() => k.syncIdleSleep(), () => k.syncIdleSleep()).catch(() => undefined);
  return stopped;
}

export function namedKernelProfile(k: Kernel, profileId: Id): string {
  const profile = k.profile(profileId);
  const toolName =
    k.s.tools.find((tool) => tool.id === profile?.toolId)?.name
    ?? ADAPTERS[profile?.toolId ?? ""]?.name
    ?? profile?.toolId
    ?? "the tool";
  return `${toolName} · ${profile?.model}`;
}

export function describeKernelParticipant(k: Kernel, roleId: Id, profileId: Id): string {
  const profile = k.profile(profileId);
  const tool = k.s.tools.find((entry) => entry.id === profile?.toolId);
  return `${k.role(roleId)?.name ?? roleId} on ${tool?.name ?? profile?.toolId} · ${profile?.model} · ${profile?.effort}`;
}

export function appendTimelineLog(
  k: Kernel,
  target: RuntimeTask | RepositoryContext,
  tone: Task["timeline"][number]["tone"],
  text: string,
  roleId?: Id,
  profileId?: Id,
): void {
  const scope = executionOf(target);
  const { task, work: repository } = scope;
  const step = stepTag(task);
  task.timeline.push({
    ...(task.repositories ? { productId: repository.productId } : {}),
    id: k.id(task.id),
    at: Date.now(),
    text,
    tone,
    ...(roleId ? { roleId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(step ? { step } : {}),
  });
  if (task.timeline.length > MAX_TIMELINE) {
    task.timeline.splice(0, task.timeline.length - MAX_TIMELINE);
  }
}

export function appendSessionLine(
  k: Kernel,
  target: RuntimeTask | RepositoryContext,
  from: Task["session"][number]["from"],
  text: string,
  roleId?: Id,
  profileId?: Id,
  toolInvocationId?: Id,
  record = true,
): void {
  const scope = executionOf(target);
  if (from === "agent" && record) {
    recordPublicMessage(k, scope, text, (preview) => {
      appendSessionLine(k, scope, from, preview, roleId, profileId, toolInvocationId, false);
    });
    return;
  }
  const { task, work: repository } = scope;
  saySessionLine(task, repository.productId, from, text, roleId, profileId, toolInvocationId, {
    id: () => k.id(task.id),
    now: () => Date.now(),
    pendingReportIds: k.pendingReportIds,
    onRemoved: (removed) => k.store.publicText.remove(task.id, removed.id),
  });
}

export function appendParticipantLine(
  k: Kernel,
  target: RuntimeTask | RepositoryContext,
  from: "agent" | "activity",
  text: string,
  roleId: Id,
  profileId: Id,
  reviewerKey: string | undefined,
  toolInvocationId?: Id,
  record = true,
): void {
  if (from === "agent" && record) {
    recordPublicMessage(k, target, text, (preview) => {
      appendParticipantLine(k, target, from, preview, roleId, profileId, reviewerKey, toolInvocationId, false);
    });
    return;
  }
  appendSessionLine(k, target, from, text, roleId, profileId, toolInvocationId, false);
  const { task } = executionOf(target);
  bindParticipantSessionLine(task, from, roleId, profileId, reviewerKey);
}

/** Complete engine-created agent messages share capture limits, filtering and durable ownership with streams. */
function recordPublicMessage(
  k: Kernel,
  target: RuntimeTask | RepositoryContext,
  text: string,
  create: (preview: string) => void,
): void {
  const { task } = executionOf(target);
  let line: RuntimeTask["session"][number] | undefined;
  const messages = new AgentMessages(immediateMessageClock, (message) => {
    if (!line) {
      create(message.text);
      line = task.session.at(-1)!;
    } else {
      line.text = message.text;
    }
    const saved = k.store.publicText.append(task.id, line, message);
    line.recording = saved.recording;
    return saved.accepting;
  });
  messages.push(text);
  messages.boundary();
}

export async function ensureEmptyGhConfig(dataDir: string): Promise<string> {
  const dir = join(dataDir, "gh-none");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function appendAgentLog(dataDir: string, taskId: Id, text: string): Promise<void> {
  const dir = join(dataDir, "logs");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${taskId}.log`), text).catch(() => undefined);
}

export class KernelCommits {
  private todoPending = false;
  private readonly streamedTasks = new Set<RuntimeTask>();
  private streamTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly k: Kernel) {}

  commit(target?: RuntimeTask | RepositoryContext): void {
    if (this.k.stopped) return;
    this.flushStreamChanges();
    this.k.projection.changed(target);
    this.k.syncIdleSleep();
    this.savePendingTodo();
    this.k.s.planner = this.k.onUsable(PLANNER_PROFILE);
    this.k.s.now = Date.now();
    for (const listener of this.k.listeners) listener();
    this.armSave();
  }

  noteTodo(target?: RuntimeTask | RepositoryContext): void {
    if (this.k.stopped) return;
    this.flushStreamChanges();
    this.k.projection.changed(target);
    this.todoPending = true;
    this.k.s.planner = this.k.onUsable(PLANNER_PROFILE);
    this.k.s.now = Date.now();
    for (const listener of this.k.listeners) listener();
    this.armSave();
  }

  commitNow(target?: RuntimeTask | RepositoryContext): void {
    if (this.k.stopped) return;
    this.flushStreamChanges();
    this.k.projection.changed(target);
    this.k.syncIdleSleep();
    this.k.s.planner = this.k.onUsable(PLANNER_PROFILE);
    clearTimeout(this.k.saveTimer);
    this.k.saveTimer = undefined;
    this.todoPending = false;
    this.k.save(false);
    for (const listener of this.k.listeners) listener();
  }

  noteStream(target: RuntimeTask | RepositoryContext): void {
    if (this.k.stopped) return;
    this.streamedTasks.add(executionOf(target).task);
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.flushStreamChanges();
      if (this.k.stopped) return;
      this.k.s.now = Date.now();
      for (const listener of this.k.listeners) listener();
      this.armSave();
    }, 400);
  }

  save(all = true): void {
    const streamed = this.flushStreamChanges();
    this.todoPending = false;
    this.k.s.now = Date.now();
    const historyChanged = this.k.projection.save(all);
    if (!this.k.stopped && (streamed || historyChanged)) for (const listener of this.k.listeners) listener();
  }

  private flushStreamChanges(): boolean {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    const pending = this.streamedTasks.size > 0;
    for (const task of this.streamedTasks) if (this.k.task(task.id) === task) this.k.projection.changed(task);
    this.streamedTasks.clear();
    return pending;
  }

  private armSave(): void {
    if (this.k.saveTimer || this.k.stopped) return;
    this.k.saveTimer = setTimeout(() => {
      this.k.saveTimer = undefined;
      try {
        if (!this.k.stopped) this.k.save(false);
      } catch (error) {
        // A full disk, for example: the next change saves again.
        if (!this.k.stopped) console.warn("Deferred state save failed:", error);
      }
    }, 400);
  }

  private savePendingTodo(): void {
    if (!this.todoPending || this.k.stopped) return;
    clearTimeout(this.k.saveTimer);
    this.k.saveTimer = undefined;
    this.todoPending = false;
    this.k.save(false);
  }
}
