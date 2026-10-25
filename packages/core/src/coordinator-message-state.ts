// Coordinator instructions belong to durable participant seats, never a process or profile.
import type { DeepMutable } from "./flow.js";
import type { JourneyAgentInput, QueuedMessage, SessionLine } from "./model.js";

/** Only queued delivery records are mutable; process and agent ownership belong to callers. */
export interface MessageQueueState { queued: DeepMutable<QueuedMessage>[] }
export interface ReadonlyMessageQueue { readonly queued: readonly QueuedMessage[] }
export interface MessagePromptState extends MessageQueueState {
  readonly session: readonly Pick<SessionLine, "coordinatorMessageId">[];
}
export interface MessageRecoveryState extends MessageQueueState {
  readonly journey?: readonly {
    readonly agentInputs?: readonly {
      readonly updates?: readonly Pick<NonNullable<JourneyAgentInput["updates"]>[number], "delivery">[];
    }[];
  }[];
}

export const messageMember = (member?: string) => member ?? "main";

/** A resolved delivery decision preserves task guidance without certifying it was heard. */
export function backgroundMessage(task: ReadonlyMessageQueue, id: string | undefined, member?: string): boolean {
  const message = task.queued.find(message => message.id === id);
  const key = messageMember(member);
  const state = message?.deliveries?.[key]?.state;
  return !message || (message.recipients?.[key] === true && (state === undefined || state === "applied" || state === "skipped"));
}

export const unresolvedMessage = (message: QueuedMessage, member: string) => {
  const state = message.deliveries?.[member]?.state;
  return state === "sending" || state === "accepted" || state === "unconfirmed";
};

/**
 * A prompt reservation is not a live acceptance. One the agent was already given counts as heard.
 * One that never started can go out with the next prompt. Live input still in flight stays
 * unconfirmed and is not sent again. `member` limits this to one participant, so a peer's
 * reservation for a prompt it is about to send is left alone.
 */
export function settleInterruptedMessageDeliveries(task: MessageQueueState, member?: string): boolean {
  let changed = false;
  for (const message of task.queued) {
    for (const [key, receipt] of Object.entries(message.deliveries ?? {})) {
      if (member !== undefined && key !== member) continue;
      if (receipt.state !== "sending") continue;
      if (receipt.via === "prompt") {
        if (receipt.sessionId) {
          receipt.state = "applied";
          (message.recipients ??= {})[key] = true;
        } else delete message.deliveries![key];
      } else {
        receipt.state = "unconfirmed";
        receipt.reason ??= "unknown";
      }
      changed = true;
    }
  }
  return changed;
}

export function recoverMessages(task: MessageRecoveryState): void {
  for (const message of task.queued) {
    // Older grouped messages already wrote the first delivery to the transcript.
    if (message.recorded === undefined && Object.values(message.recipients ?? {}).some(Boolean)) message.recorded = true;
  }
  // No prompt is still running: every leftover reservation belongs to the attempt that died.
  settleInterruptedMessageDeliveries(task);
  for (const message of task.queued) {
    for (const receipt of Object.values(message.deliveries ?? {})) {
      if (receipt.state === "accepted" || receipt.state === "unconfirmed") receipt.reason ??= "unknown";
    }
  }
  for (const step of task.journey ?? []) for (const input of step.agentInputs ?? []) for (const update of input.updates ?? []) {
    if (update.delivery === "sending") update.delivery = "unconfirmed";
  }
}

export function routeMessages(task: MessageQueueState, members: readonly string[]): void {
  if (!members.length) return;
  for (const message of task.queued) {
    const recipients = message.recipients ??= {};
    for (const [member, heard] of Object.entries(recipients)) {
      if (!heard && !unresolvedMessage(message, member) && !members.includes(member)) {
        delete recipients[member];
        if (message.deliveries) delete message.deliveries[member];
      }
    }
    for (const member of members) recipients[member] ??= false;
  }
}

export function removeHeardMessages(task: MessageQueueState): void {
  task.queued = task.queued.filter(message => !message.recipients || !Object.values(message.recipients).every(Boolean));
}

/** Skipped seats can retire only instructions the provider does not own. */
export function finishMessageGroup(task: MessageQueueState, members: readonly string[]): void {
  for (const message of task.queued) for (const member of members) {
    if (message.recipients && !unresolvedMessage(message, member)) delete message.recipients[member];
  }
  removeHeardMessages(task);
}

/** Reserve ordinary prompt input. Keep it durable until that tracked prompt acknowledges it. */
export function takeMessages(task: MessagePromptState, member?: string, limit = 12_000): (QueuedMessage & { firstDelivery: boolean })[] {
  const key = messageMember(member);
  const batch: (QueuedMessage & { firstDelivery: boolean })[] = [];
  let size = 0;
  for (const message of task.queued) {
    if (!message.recipients && member === undefined) message.recipients = { [key]: false };
    if (message.recipients?.[key] !== false) continue;
    if (unresolvedMessage(message, key)) break;
    if (batch.length && size + message.text.length > limit) break;
    const firstDelivery = !message.recorded && !task.session.some(line => line.coordinatorMessageId === message.id);
    (message.deliveries ??= {})[key] = { state: "sending", via: "prompt" };
    batch.push({ ...message, firstDelivery });
    size += message.text.length;
  }
  return batch;
}
