// Every command the window can send the engine, in one place. The engine implements them all (the
// compiler checks), its local API checks what arrives against one argument schema per command
// (packages/engine/src/server.ts, also checked), and the window's two clients, for the real engine and
// for the demo, are built from this list. Adding a command: one entry here and in COMMAND_NAMES, its
// argument schema, and its Engine method (and its Simulator method, if the demo should do something).

import type { RoleDraft } from "./roles.js";
import type { CheckPrerequisite, DeliveryMode, Id, ScreenMode, TaskKind } from "./model.js";
import type { ProductSettings } from "./products.js";
import type { Clone, SetupStep } from "./setup.js";
import type { HandBackPreview, Launched } from "./takeover.js";
import type { UsageRequest, UsageViewFor } from "./analytics.js";
import type { StartFrom, WorkChoice } from "./source.js";
import type { HistoryPage, HistoryQuery } from "./history.js";
import type { Task } from "./model.js";
import type { TaskDetailsUpdate } from "./task-details-delta.js";

/** A new task as the window sends it. */
export interface NewTaskInput {
  /** Wait for the coordinator to review the request before it joins the work queue. */
  backlog?: boolean;
  /** Tasks that must land before admission, saved together with this request. */
  after?: readonly Id[];
  worksOn?: readonly WorkChoice[];
  startFrom?: StartFrom;
  productId: Id;
  title: string;
  description?: string;
  kind?: TaskKind;
  position?: "top" | "bottom";
  approvePlan?: boolean;
  delivery?: DeliveryMode;
  approveDelivery?: boolean;
  /** The window's id for this request: sending it again after a lost reply finds the task instead of adding another. */
  clientId?: Id;
}

/** What the window adds to an answer, so it still counts when the question is gone (a restart dropped it). */
export interface SaidContext {
  taskId?: Id;
  /** The question, or what a "No" refused. */
  about?: string;
  /** The coordinator chose “Decide for me”, rather than answering themselves. */
  decided?: boolean;
  /** The window's id for what it sent: a resend after a lost confirmation counts once. */
  clientId?: Id;
}

export interface Commands {
  profileChoices(request: import("./profiles.js").ProfileChoiceRequest): Promise<import("./profiles.js").ProfileChoices>;
  saveProfile(draft: import("./profiles.js").ProfileDraft, clientId: Id, profileId?: Id): Promise<Id>;
  removeProfile(profileId: Id): void;
  saveRoutine(draft: import("./routines.js").RoutineDraft, routineId?: Id): Id;
  setRoutineEnabled(routineId: Id, enabled: boolean): void;
  removeRoutine(routineId: Id): void;
  resolveMaintenanceSettings(taskId: Id, choice: "keep" | "stop"): void;
  historyPage(query: HistoryQuery): HistoryPage;
  taskDetails(taskId: Id): Task | undefined;
  taskDetailsDelta(taskId: Id, sinceRevision: string): TaskDetailsUpdate | undefined;
  publicMessage(taskId: Id, messageId: Id, offset?: number, limit?: number): import("./public-messages.js").MessagePage | undefined;
  previewImage(taskId: Id, path: string, productId?: Id): Promise<{ mime: string; data: string }>;
  saveRole(roleId: Id, draft: RoleDraft): void;
  addRole(draft: RoleDraft): Id;
  resetRole(roleId: Id): void;
  removeRole(roleId: Id): void;
  // Products
  addProduct(path: string, name?: string): Promise<Id>;
  removeProduct(productId: Id): void;
  updateProduct(productId: Id, settings: ProductSettings): void;
  setProductDelivery(productId: Id, delivery: DeliveryMode, approveDelivery: boolean): void;
  setProductChecks(productId: Id, checks: { name: string; command: string }[] | null): void;
  setProductCheckSetup(productId: Id, requirements: readonly CheckPrerequisite[]): void;
  setProductRemoteChecks(productId: Id, checks: readonly string[]): void;
  // First run and the tools check
  /** Check every tool again, each on its own. The answers arrive in the state, one by one. */
  checkTools(): Promise<void>;
  /** GitHub clones on this machine that are not added yet, most recently changed first. */
  findClones(): Promise<Clone[]>;
  /** The furthest first-run screen reached, so closing Petrina partway reopens there. */
  setSetupStep(step: SetupStep): void;
  /** "Skip setup": first run never comes back. */
  skipSetup(): void;
  /** First run's Start: the task and the end of setup, saved together. Sent again after a lost reply, it finds the same task. */
  startFirstTask(input: NewTaskInput & { clientId: Id }): Id;
  /** The board's one-time tip about the first task. */
  dismissTip(): void;
  /** Open one of the official guides a fix links to, outside the app. No other page. */
  openGuide(url: string): void;
  // The queue and the pool
  addTask(input: NewTaskInput): Id;
  queueTask(taskId: Id): void;
  combineBacklog(taskIds: Id[], title: string, clientId: Id): Promise<Id>;
  moveToBacklog(taskId: Id): void;
  updateBacklog(taskId: Id, changes: { title: string; description: string }): void;
  setTaskStart(taskId: Id, choice: WorkChoice): Promise<void>;
  setTaskProducts(taskId: Id, choices: readonly WorkChoice[]): Promise<void>;
  setTaskAddition(taskId: Id, repository: string, name: string, path: string): Promise<void>;
  setTaskApproval(taskId: Id, ask: boolean): void;
  moveInQueue(taskId: Id, index: number): void;
  moveToTop(taskId: Id): void;
  placeInQueue(taskId: Id, anchorId: Id, side: "before" | "after"): number;
  moveVisibleInQueue(taskId: Id, visibleIds: Id[], direction: -1 | 1): number;
  setHeld(taskId: Id, held: boolean): void;
  setAfter(taskId: Id, after: Id[]): void;
  setPoolLimit(limit: number): void;
  setToolCap(toolId: Id, cap: number): void;
  setPoolPaused(paused: boolean): void;
  setTerminal(terminalId: Id): void;
  /** "Agents may use the screen": Off, For an hour, or On. */
  setScreenUse(mode: ScreenMode): void;
  // A task
  pause(taskId: Id): void;
  resume(taskId: Id): void;
  cancel(taskId: Id): void;
  retry(itemId: Id): void;
  rerunChecks(itemId: Id): void;
  sendMessage(taskId: Id, text: string, mode?: "now" | "queue" | "interrupt", clientId?: Id): void;
  removeQueued(taskId: Id, messageId: Id): void;
  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void;
  addReviewer(taskId: Id, stageId: Id, profileId: Id): void;
  /** Allow now: this task's screen request may go ahead, still one agent at a time. */
  allowScreen(taskId: Id): void;
  /** "Allow the screen for this task". */
  setTaskScreen(taskId: Id, allowed: boolean): void;
  // The inbox
  answer(itemId: Id, answer: string, context?: SaidContext): void;
  decideForMe(itemId: Id): void;
  allow(itemId: Id, scope?: "once" | "always"): void;
  deny(itemId: Id, note?: string, context?: SaidContext): void;
  approve(itemId: Id): void;
  /** "Not this time" on an offer: a point for the review guide, or lessons for AGENTS.md. */
  decline(itemId: Id): void;
  /** "Add the ticked ones": the lessons of an offer the coordinator keeps, by their place in it. */
  addLessons(itemId: Id, keep: number[]): void;
  requestChanges(itemId: Id, note: string): void;
  checkShipping(itemId: Id): void;
  shipAgain(itemId: Id): void;
  markDone(itemId: Id): void;
  // Take over in the terminal
  takeOver(taskId: Id, how?: "open" | "copy"): Promise<Launched>;
  reopenTerminal(taskId: Id, how?: "open" | "copy"): Promise<Launched>;
  handBackPreview(taskId: Id): Promise<HandBackPreview>;
  handBack(taskId: Id, note?: string, anyway?: boolean): Promise<void>;
  // Numbers
  /** The numbers for one view, worked out from the work log. The log itself never reaches the window. */
  usage<R extends UsageRequest>(request: R): UsageViewFor<R>;
}

export type CommandName = keyof Commands;

export interface CommandMeta {
  readonly changes: boolean;
}

/** Every command with its mutation semantics, so read-only window calls never block behind the mutation queue. */
export const COMMAND_META = {
  profileChoices: { changes: false },
  saveProfile: { changes: true },
  removeProfile: { changes: true },
  saveRoutine: { changes: true },
  setRoutineEnabled: { changes: true },
  removeRoutine: { changes: true },
  resolveMaintenanceSettings: { changes: true },
  historyPage: { changes: false },
  taskDetails: { changes: false },
  taskDetailsDelta: { changes: false },
  publicMessage: { changes: false },
  previewImage: { changes: false },
  saveRole: { changes: true },
  addRole: { changes: true },
  resetRole: { changes: true },
  removeRole: { changes: true },
  addProduct: { changes: true },
  removeProduct: { changes: true },
  updateProduct: { changes: true },
  setProductDelivery: { changes: true },
  setProductChecks: { changes: true },
  setProductCheckSetup: { changes: true },
  setProductRemoteChecks: { changes: true },
  checkTools: { changes: true },
  findClones: { changes: false },
  setSetupStep: { changes: true },
  skipSetup: { changes: true },
  startFirstTask: { changes: true },
  dismissTip: { changes: true },
  openGuide: { changes: false },
  addTask: { changes: true },
  queueTask: { changes: true },
  moveToBacklog: { changes: true },
  updateBacklog: { changes: true },
  combineBacklog: { changes: true },
  setTaskStart: { changes: true },
  setTaskProducts: { changes: true },
  setTaskAddition: { changes: true },
  setTaskApproval: { changes: true },
  moveInQueue: { changes: true },
  moveToTop: { changes: true },
  placeInQueue: { changes: true },
  moveVisibleInQueue: { changes: true },
  setHeld: { changes: true },
  setAfter: { changes: true },
  setPoolLimit: { changes: true },
  setToolCap: { changes: true },
  setPoolPaused: { changes: true },
  setTerminal: { changes: true },
  setScreenUse: { changes: true },
  pause: { changes: true },
  resume: { changes: true },
  cancel: { changes: true },
  retry: { changes: true },
  rerunChecks: { changes: true },
  sendMessage: { changes: true },
  removeQueued: { changes: true },
  setStageProfile: { changes: true },
  addReviewer: { changes: true },
  allowScreen: { changes: true },
  setTaskScreen: { changes: true },
  answer: { changes: true },
  decideForMe: { changes: true },
  allow: { changes: true },
  deny: { changes: true },
  approve: { changes: true },
  decline: { changes: true },
  addLessons: { changes: true },
  requestChanges: { changes: true },
  checkShipping: { changes: true },
  shipAgain: { changes: true },
  markDone: { changes: true },
  takeOver: { changes: true },
  reopenTerminal: { changes: true },
  handBackPreview: { changes: false },
  handBack: { changes: true },
  usage: { changes: false },
} as const satisfies Readonly<Record<CommandName, CommandMeta>>;

/** Every command by name, derived directly from COMMAND_META. */
export const COMMAND_NAMES = Object.keys(COMMAND_META) as unknown as readonly [CommandName, ...CommandName[]];

// Every command is in COMMAND_META: a name left out fails here.
type Missing = Exclude<CommandName, keyof typeof COMMAND_META>;
export const EVERY_COMMAND_LISTED: Missing extends never ? true : Missing = true;

/** The commands as the window calls them: the same arguments, and the answer now or once the engine sends it. */
export type WindowCommands = { [K in CommandName]: (...args: Parameters<Commands[K]>) => Awaited<ReturnType<Commands[K]>> | Promise<Awaited<ReturnType<Commands[K]>>> };
