// Every command the window can send the engine, in one place. The engine implements them all (the
// compiler checks), its local API checks what arrives against one argument schema per command
// (packages/engine/src/server.ts, also checked), and the window's two clients, for the real engine and
// for the demo, are built from this list. Adding a command: one entry here and in COMMAND_NAMES, its
// argument schema, and its Engine method (and its Simulator method, if the demo should do something).

import type { DeliveryMode, Id, TaskKind } from "./model.js";
import type { ProductSettings } from "./products.js";
import type { HandBackPreview, Launched } from "./takeover.js";

/** A new task as the window sends it. */
export interface NewTaskInput {
  productId: Id;
  title: string;
  description?: string;
  kind?: TaskKind;
  position?: "top" | "bottom";
  approvePlan?: boolean;
  delivery?: DeliveryMode;
  approveDelivery?: boolean;
}

/** What the window adds to an answer, so it still counts when the question is gone (a restart dropped it). */
export interface SaidContext {
  taskId?: Id;
  /** The question, or what a "No" refused. */
  about?: string;
  /** The window's id for what it sent: a resend after a lost confirmation counts once. */
  clientId?: Id;
}

export interface Commands {
  // Products
  addProduct(path: string, name?: string): Promise<Id>;
  removeProduct(productId: Id): void;
  updateProduct(productId: Id, settings: ProductSettings): void;
  setProductDelivery(productId: Id, delivery: DeliveryMode, approveDelivery: boolean): void;
  setProductChecks(productId: Id, checks: { name: string; command: string }[] | null): void;
  // The queue and the pool
  addTask(input: NewTaskInput): Id;
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
  // A task
  pause(taskId: Id): void;
  resume(taskId: Id): void;
  cancel(taskId: Id): void;
  retry(itemId: Id): void;
  sendMessage(taskId: Id, text: string, mode?: "queue" | "interrupt", clientId?: Id): void;
  removeQueued(taskId: Id, messageId: Id): void;
  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void;
  addReviewer(taskId: Id, stageId: Id, profileId: Id): void;
  // The inbox
  answer(itemId: Id, answer: string, context?: SaidContext): void;
  decideForMe(itemId: Id): void;
  allow(itemId: Id, scope?: "once" | "always"): void;
  deny(itemId: Id, note?: string, context?: SaidContext): void;
  approve(itemId: Id): void;
  /** "Not this time" on an offer: a point for the review guide, or lessons for LEARNINGS.md. */
  decline(itemId: Id): void;
  requestChanges(itemId: Id, note: string): void;
  checkShipping(itemId: Id): void;
  shipAgain(itemId: Id): void;
  markDone(itemId: Id): void;
  // Take over in the terminal
  takeOver(taskId: Id, how?: "open" | "copy"): Promise<Launched>;
  reopenTerminal(taskId: Id, how?: "open" | "copy"): Promise<Launched>;
  handBackPreview(taskId: Id): Promise<HandBackPreview>;
  handBack(taskId: Id, note?: string, anyway?: boolean): Promise<void>;
}

export type CommandName = keyof Commands;

/** Every command by name, for the code that handles them all the same way. */
export const COMMAND_NAMES = [
  "addProduct",
  "removeProduct",
  "updateProduct",
  "setProductDelivery",
  "setProductChecks",
  "addTask",
  "moveInQueue",
  "moveToTop",
  "placeInQueue",
  "moveVisibleInQueue",
  "setHeld",
  "setAfter",
  "setPoolLimit",
  "setToolCap",
  "setPoolPaused",
  "setTerminal",
  "pause",
  "resume",
  "cancel",
  "retry",
  "sendMessage",
  "removeQueued",
  "setStageProfile",
  "addReviewer",
  "answer",
  "decideForMe",
  "allow",
  "deny",
  "approve",
  "decline",
  "requestChanges",
  "checkShipping",
  "shipAgain",
  "markDone",
  "takeOver",
  "reopenTerminal",
  "handBackPreview",
  "handBack",
] as const satisfies readonly CommandName[];

// Every command is in the list: a name left out fails here.
type Missing = Exclude<CommandName, (typeof COMMAND_NAMES)[number]>;
export const EVERY_COMMAND_LISTED: Missing extends never ? true : Missing = true;

/** The commands as the window calls them: the same arguments, and the answer now or once the engine sends it. */
export type WindowCommands = { [K in CommandName]: (...args: Parameters<Commands[K]>) => Awaited<ReturnType<Commands[K]>> | Promise<Awaited<ReturnType<Commands[K]>>> };
