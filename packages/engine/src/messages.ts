// A coordinator message belongs to every unfinished member of a parallel step. One member
// hearing it never takes it away from a peer, including a saved screen conversation.
import type { QueuedMessage } from "@petrina/core";
import type { MTask } from "./kernel.js";

export function routeMessages(task: MTask, members: readonly string[]): void {
  if (!members.length) return;
  for (const message of task.queued) {
    const recipients = message.recipients ??= {};
    // A replacement conversation reads the task's notes too. Retarget an unfinished old seat,
    // while keeping delivered seats so a peer is never sent the same instruction twice.
    for (const [member, heard] of Object.entries(recipients)) if (!heard && !members.includes(member)) delete recipients[member];
    for (const member of members) recipients[member] ??= false;
  }
}

/** Seats skipped because their tool cannot run no longer hold a completed group's queue open. */
export function finishMessageGroup(task: MTask, members: readonly string[]): void {
  for (const message of task.queued) for (const member of members) if (message.recipients) delete message.recipients[member];
  task.queued = task.queued.filter((message) => !message.recipients || Object.values(message.recipients).some((heard) => !heard));
}

/** Take only this conversation's messages. A fresh prompt may acknowledge all the notes it includes. */
export function takeMessages(task: MTask, member?: string, limit = 12_000): (QueuedMessage & { firstDelivery: boolean })[] {
  const batch: (QueuedMessage & { firstDelivery: boolean })[] = [];
  let size = 0;
  for (const message of task.queued) {
    if (message.recipients ? member === undefined || message.recipients[member] !== false : member !== undefined) continue;
    if (batch.length && size + message.text.length > limit) break;
    const firstDelivery = !Object.values(message.recipients ?? {}).some(Boolean);
    if (message.recipients && member !== undefined) message.recipients[member] = true;
    batch.push({ ...message, firstDelivery });
    size += message.text.length;
  }
  const ids = new Set(batch.map((message) => message.id));
  task.queued = task.queued.filter((message) => !ids.has(message.id) || (message.recipients && Object.values(message.recipients).some((heard) => !heard)));
  return batch;
}
