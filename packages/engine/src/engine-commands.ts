// Declarative command surface binding for Engine, keeping engine.ts focused on lifecycle and wiring.
import {
  SCREEN_HOUR_MS,
  type AskAnswer,
  type Commands,
  type Id,
  type NewTaskInput,
  type ProfileChoiceRequest,
  type ProfileChoices,
  type SaidContext,
  type ScreenMode,
  type UsageRequest,
  type UsageViewFor,
} from "@petrina/core";
import type { CatalogCommands } from "./catalog-commands.js";
import type { Driver } from "./driver.js";
import type { InboxCommands } from "./inbox-commands.js";
import type { EngineOptions, Kernel } from "./kernel.js";
import type { Learnings } from "./learnings.js";
import type { ProfileChoiceReader } from "./profile-choices.js";
import type { Shipping } from "./shipping.js";
import type { TakeOver } from "./take-over.js";
import type { TaskCommands } from "./task-commands.js";
import type { ToolChecks } from "./tool-checks.js";

type KernelOwnedCommandKeys = "historyPage" | "taskDetails" | "taskDetailsDelta" | "publicMessage";
type WidenedCommandKeys = "addTask" | "setAfter" | "answer" | "sendMessage" | "retry" | "approve";

export interface EngineBoundCommands extends Omit<Commands, KernelOwnedCommandKeys | WidenedCommandKeys> {
  addTask(input: NewTaskInput, schedule?: boolean): Id;
  setAfter(taskId: Id, after: readonly Id[]): void;
  answer(itemId: Id, answer: string, context?: SaidContext, how?: AskAnswer): void;
  sendMessage(taskId: Id, text: string, mode?: "now" | "queue" | "interrupt", clientId?: Id): Id | undefined;
  retry(itemId: Id): Promise<void>;
  approve(itemId: Id): void | Promise<void>;
  reportImage(taskId: string, imageId: string): Promise<Blob | undefined>;
  setRuntimeWait(taskId: Id, after: readonly Id[], reason: string, requestId: string): boolean;
}

export type EngineCommandSurface = EngineBoundCommands & Pick<Commands, KernelOwnedCommandKeys>;
export const ENGINE_SATISFIES_COMMANDS: EngineCommandSurface extends Commands ? true : never = true;

export interface EngineCommandOwners {
  readonly kernel: Kernel;
  readonly options: EngineOptions;
  readonly profileReader: ProfileChoiceReader;
  readonly tools: ToolChecks;
  readonly catalogCommands: CatalogCommands;
  readonly taskCommands: TaskCommands;
  readonly inboxCommands: InboxCommands;
  readonly driver: Driver;
  readonly takeover: TakeOver;
  readonly shipping: Shipping;
  readonly learnings: Learnings;
  readonly moveInQueue: (taskId: Id, index: number) => void;
}

export function bindEngineCommands(owners: EngineCommandOwners): EngineBoundCommands {
  const {
    kernel,
    options,
    profileReader,
    tools,
    catalogCommands,
    taskCommands,
    inboxCommands,
    driver,
    takeover,
    shipping,
    learnings,
  } = owners;

  return {
    profileChoices: ({ toolId, modelId, refresh = false }: ProfileChoiceRequest): Promise<ProfileChoices> =>
      profileReader.read(toolId, modelId, refresh),
    saveProfile: (draft, clientId, profileId) => catalogCommands.saveProfile(draft, clientId, profileId),
    removeProfile: (profileId) => catalogCommands.removeProfile(profileId),
    saveRoutine: (draft, routineId) => catalogCommands.saveRoutine(draft, routineId),
    setRoutineEnabled: (routineId, enabled) => catalogCommands.setRoutineEnabled(routineId, enabled),
    removeRoutine: (routineId) => catalogCommands.removeRoutine(routineId),
    resolveMaintenanceSettings: (taskId, choice) => catalogCommands.resolveMaintenanceSettings(taskId, choice),
    saveRole: (roleId, draft) => catalogCommands.saveRole(roleId, draft),
    addRole: (draft) => catalogCommands.addRole(draft),
    resetRole: (roleId) => catalogCommands.resetRole(roleId),
    removeRole: (roleId) => catalogCommands.removeRole(roleId),
    addProduct: (input, name) => catalogCommands.addProduct(input, name),
    setProductDelivery: (productId, delivery, approveDelivery) =>
      catalogCommands.setProductDelivery(productId, delivery, approveDelivery),
    setProductChecks: (productId, checks) => catalogCommands.setProductChecks(productId, checks),
    setProductCheckSetup: (productId, requirements) => catalogCommands.setProductCheckSetup(productId, requirements),
    setProductRemoteChecks: (productId, checks) => catalogCommands.setProductRemoteChecks(productId, checks),
    updateProduct: (productId, settings) => catalogCommands.updateProduct(productId, settings),
    removeProduct: (productId) => catalogCommands.removeProduct(productId),
    checkTools: () =>
      tools.checkAll().then(() => {
        if (!kernel.stopped) kernel.schedule();
      }),
    findClones: () => catalogCommands.findClones(),
    pickFolder: () => catalogCommands.pickFolder(),
    setSetupStep: (step) => catalogCommands.setSetupStep(step),
    skipSetup: () => catalogCommands.skipSetup(),
    dismissTip: () => catalogCommands.dismissTip(),
    openGuide: (url) => catalogCommands.openGuide(url),
    setTerminal: (terminalId) => catalogCommands.setTerminal(terminalId),
    usage: <R extends UsageRequest>(request: R): UsageViewFor<R> => kernel.tracking.usage(request),
    reportImage: (taskId, imageId) => taskCommands.reportImage(taskId, imageId),
    previewImage: (taskId, path, productId) => taskCommands.previewImage(taskId, path, productId),
    startFirstTask: (input) => taskCommands.startFirstTask(input),
    addTask: (input, schedule = true) => taskCommands.addTask(input, schedule),
    queueTask: (taskId) => taskCommands.queueTask(taskId),
    combineBacklog: (taskIds, title, clientId) => taskCommands.combineBacklog(taskIds, title, clientId),
    moveToBacklog: (taskId) => taskCommands.moveToBacklog(taskId),
    updateBacklog: (taskId, changes) => taskCommands.updateBacklog(taskId, changes),
    setTaskStart: (taskId, choice) => taskCommands.setTaskStart(taskId, choice),
    setTaskProducts: (taskId, choices) => taskCommands.setTaskProducts(taskId, choices),
    setTaskAddition: (taskId, repository, name, path) => taskCommands.setTaskAddition(taskId, repository, name, path),
    setTaskApproval: (taskId, ask) => taskCommands.setTaskApproval(taskId, ask),
    moveInQueue: (taskId, index) => taskCommands.moveInQueue(taskId, index),
    moveToTop: (taskId) => owners.moveInQueue(taskId, 0),
    placeInQueue: (taskId, anchorId, side) => taskCommands.placeInQueue(taskId, anchorId, side),
    moveVisibleInQueue: (taskId, visibleIds, direction) =>
      taskCommands.moveVisibleInQueue(taskId, visibleIds, direction),
    setHeld: (taskId, held) => taskCommands.setHeld(taskId, held),
    setAfter: (taskId, after) => taskCommands.setAfter(taskId, after),
    setRuntimeWait: (taskId, after, reason, requestId) =>
      taskCommands.setRuntimeWait(taskId, after, reason, requestId),
    setStageProfile: (taskId, stageId, list, index, profileId) =>
      taskCommands.setStageProfile(taskId, stageId, list, index, profileId),
    addReviewer: (taskId, stageId, profileId) => taskCommands.addReviewer(taskId, stageId, profileId),
    setPoolLimit: (limit) => driver.workflow.setPoolLimit(limit),
    setToolCap: (toolId, cap) => driver.workflow.setToolCap(toolId, cap),
    setPoolPaused: (paused) => driver.workflow.setPoolPaused(paused),
    setScreenUse: (mode: ScreenMode) => kernel.screens.setScreenUse(mode, options.screenHourMs ?? SCREEN_HOUR_MS),
    allowScreen: (taskId) => kernel.screens.allowScreen(taskId),
    setTaskScreen: (taskId, allowed) => kernel.screens.setTaskScreen(taskId, allowed),
    pause: (taskId) => inboxCommands.pause(taskId),
    resume: (taskId) => inboxCommands.resume(taskId),
    cancel: (taskId) => inboxCommands.cancel(taskId),
    retry: (itemId) => inboxCommands.retry(itemId),
    rerunChecks: (itemId) => inboxCommands.rerunChecks(itemId),
    sendMessage: (taskId, text, mode = "now", clientId) => inboxCommands.sendMessage(taskId, text, mode, clientId),
    removeQueued: (taskId, messageId) => inboxCommands.removeQueued(taskId, messageId),
    answer: (itemId, answer, context = {}, how = "answered") => inboxCommands.answer(itemId, answer, context, how),
    decideForMe: (itemId) => inboxCommands.decideForMe(itemId),
    allow: (itemId, scope = "once") => inboxCommands.allow(itemId, scope),
    deny: (itemId, note, context = {}) => inboxCommands.deny(itemId, note, context),
    approve: (itemId) => inboxCommands.approve(itemId),
    requestChanges: (itemId, note) => inboxCommands.requestChanges(itemId, note),
    decline: (itemId) => inboxCommands.decline(itemId),
    takeOver: (taskId, how = "open") => takeover.takeOver(taskId, how),
    reopenTerminal: (taskId, how = "open") => takeover.reopenTerminal(taskId, how),
    handBackPreview: (taskId) => takeover.handBackPreview(taskId),
    handBack: (taskId, note = "", anyway = false) => takeover.handBack(taskId, note, anyway),
    checkShipping: (itemId) => shipping.checkShipping(itemId),
    shipAgain: (itemId) => shipping.shipAgain(itemId),
    markDone: (itemId) => shipping.markDone(itemId),
    addLessons: (itemId, keep) => learnings.accept(itemId, keep),
  };
}
