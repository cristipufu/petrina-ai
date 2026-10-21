// Coordinator instructions belong to durable participant seats, never a process or profile.
import { openStep, type AgentProfile, type QueuedMessage } from "@petrina/core";
import { Aborted, type Kernel, type MTask } from "./kernel.js";
import type { RepositoryContext } from "./repository-context.js";
import type { AgentRun, TurnResult } from "./acp-run.js";

export const messageMember = (member?: string) => member ?? "main";
const unresolved = (message: QueuedMessage, member: string) => {
  const state = message.deliveries?.[member]?.state;
  return state === "sending" || state === "accepted" || state === "unconfirmed";
};

/**
 * A prompt reservation is not a live acceptance. One the agent was already given counts as heard.
 * One that never started can go out with the next prompt. Live input still in flight stays
 * unconfirmed and is not sent again. `member` limits this to one participant, so a peer's
 * reservation for a prompt it is about to send is left alone.
 */
function settleInterruptedDeliveries(task: MTask, member?: string): boolean {
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

export function recoverMessages(task: MTask): void {
  for (const message of task.queued) {
    // Older grouped messages already wrote the first delivery to the transcript.
    if (message.recorded === undefined && Object.values(message.recipients ?? {}).some(Boolean)) message.recorded = true;
  }
  // No prompt is still running: every leftover reservation belongs to the attempt that died.
  settleInterruptedDeliveries(task);
  for (const message of task.queued) {
    for (const receipt of Object.values(message.deliveries ?? {})) {
      if (receipt.state === "accepted" || receipt.state === "unconfirmed") receipt.reason ??= "unknown";
    }
  }
  for (const step of task.journey ?? []) for (const input of step.agentInputs ?? []) for (const update of input.updates ?? []) {
    if (update.delivery === "sending") update.delivery = "unconfirmed";
  }
}

export function routeMessages(task: MTask, members: readonly string[]): void {
  if (!members.length) return;
  for (const message of task.queued) {
    const recipients = message.recipients ??= {};
    for (const [member, heard] of Object.entries(recipients)) {
      if (!heard && !unresolved(message, member) && !members.includes(member)) {
        delete recipients[member];
        if (message.deliveries) delete message.deliveries[member];
      }
    }
    for (const member of members) recipients[member] ??= false;
  }
}

function removeHeard(task: MTask): void {
  task.queued = task.queued.filter(message => !message.recipients || !Object.values(message.recipients).every(Boolean));
}

/** Skipped seats can retire only instructions the provider does not own. */
export function finishMessageGroup(task: MTask, members: readonly string[]): void {
  for (const message of task.queued) for (const member of members) {
    if (message.recipients && !unresolved(message, member)) delete message.recipients[member];
  }
  removeHeard(task);
}

/** Reserve ordinary prompt input. Keep it durable until that tracked prompt acknowledges it. */
export function takeMessages(task: MTask, member?: string, limit = 12_000): (QueuedMessage & { firstDelivery: boolean })[] {
  const key = messageMember(member);
  const batch: (QueuedMessage & { firstDelivery: boolean })[] = [];
  let size = 0;
  for (const message of task.queued) {
    if (!message.recipients && member === undefined) message.recipients = { [key]: false };
    if (message.recipients?.[key] !== false) continue;
    if (unresolved(message, key)) break;
    if (batch.length && size + message.text.length > limit) break;
    const firstDelivery = !message.recorded && !task.session.some(line => line.coordinatorMessageId === message.id);
    (message.deliveries ??= {})[key] = { state: "sending", via: "prompt" };
    batch.push({ ...message, firstDelivery });
    size += message.text.length;
  }
  return batch;
}

export function recordMessage(k: Kernel, scope: RepositoryContext, message: QueuedMessage, via: "prompt" | "live" = "prompt"): void {
  const saved = scope.task.queued.find(entry => entry.id === message.id);
  if (message.recorded || saved?.recorded) return;
  message.recorded = true;
  if (saved) saved.recorded = true;
  if (scope.task.session.some(line => line.coordinatorMessageId === message.id)) return;
  k.say(scope, "you", message.text);
  scope.task.session.at(-1)!.coordinatorMessageId = message.id;
  // A live send is one short board line. A note handed over in the next prompt keeps its words.
  k.log(scope, "you", via === "live" ? "You sent a message" : `You said: ${message.text}`);
}

/** On restart/failover a possibly accepted instruction stays with its original participant. */
export async function holdUnconfirmed(k: Kernel, scope: RepositoryContext, member: string | undefined, signal: AbortSignal, reviewKey?: string): Promise<void> {
  // Only this participant. A peer may still be reserving its own prompt.
  if (settleInterruptedDeliveries(scope.task, messageMember(member))) k.commitNow(scope);
  if (!scope.task.queued.some(message => unresolved(message, messageMember(member)))) return;
  const text = "Waiting for the tool to confirm your message; it will not be sent again automatically";
  const work = reviewKey ? scope.task.hunt?.work?.[reviewKey] : undefined;
  if (work) { work.activity = text; k.showReviewWork(scope.task); }
  else scope.task.statusLine = text;
  k.commitNow(scope);
  await new Promise<never>((_, reject) => {
    const abort = () => reject(new Aborted());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** A queued instruction on the live task, writable the same way ordinary prompt handoff writes it. */
type LaneMessage = MTask["queued"][number];

/** One ordered delivery lane for a participant, alongside its ordinary tracked prompt. */
export class MessageTurn {
  private pumping?: Promise<void>;
  private attempted = new Set<string>();
  private joined = new Set<string>();
  private disposed = false;
  readonly member: string;

  constructor(private k: Kernel, private scope: RepositoryContext, private run: AgentRun,
    private profile: AgentProfile, private roleId: string, member: string | undefined,
    private reviewerKey: string | undefined, private signal: AbortSignal) {
    this.member = messageMember(member);
  }

  start(): void {
    const lanes = this.k.messageTurns.get(this.scope.task.id) ?? new Map<string, MessageTurn>();
    lanes.set(this.member, this);
    this.k.messageTurns.set(this.scope.task.id, lanes);
    this.run.onPromptStarted = () => {
      for (const message of this.scope.task.queued) {
        const receipt = message.deliveries?.[this.member];
        if (receipt?.state !== "sending" || receipt.via !== "prompt") continue;
        // The prompt now contains this instruction. That participant has it; a later
        // pause or restart must not wait on it or hand it over again.
        receipt.toolId = this.profile.toolId;
        receipt.sessionId = this.run.sessionId;
        // The follow-up prompt now contains it, so the step record is heard too.
        this.markHeard(message);
      }
      this.k.commitNow(this.scope);
      void this.deliver();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.run.onPromptStarted = undefined;
    // Pause and stop still know which messages joined. A crash never gets here, so that acceptance stays unconfirmed.
    const heard = this.hearJoined();
    if (settleInterruptedDeliveries(this.scope.task, this.member) || heard) this.k.commitNow(this.scope);
    const lanes = this.k.messageTurns.get(this.scope.task.id);
    if (lanes?.get(this.member) === this) lanes.delete(this.member);
    if (!lanes?.size) this.k.messageTurns.delete(this.scope.task.id);
  }

  deliver(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = this.pump().finally(() => { this.pumping = undefined; });
    return this.pumping;
  }

  /** The next live message in the queue as it stands now. An earlier unresolved or waiting note stops the scan. */
  private nextLive(): LaneMessage | undefined {
    for (const message of this.scope.task.queued) {
      if (!message.recipients && this.member === "main") message.recipients = { main: false };
      if (message.recipients?.[this.member] !== false) continue;
      const prior = message.deliveries?.[this.member];
      if (prior?.state === "sending" && prior.via === "prompt") continue;
      if (this.joined.has(message.id)) continue;
      if (unresolved(message, this.member)) return;
      // A waiting earlier instruction must not be overtaken by a later live one.
      if (message.mode !== "now" || this.attempted.has(message.id)) return;
      return message;
    }
    return undefined;
  }

  private async pump(): Promise<void> {
    const { task } = this.scope;
    // Read the queue again after each acknowledgement. Removal replaces the list while a send is in flight.
    while (!this.disposed && !this.signal.aborted && !this.k.stopped && this.run.prompting) {
      const message = this.nextLive();
      if (!message) return;
      const deliveries = message.deliveries ??= {};
      if (!this.run.liveInput) {
        deliveries[this.member] = { state: "waiting", reason: "unsupported", toolId: this.profile.toolId };
        this.k.commitNow(this.scope);
        return;
      }
      this.attempted.add(message.id);
      deliveries[this.member] = { state: "sending", via: "live", toolId: this.profile.toolId, sessionId: this.run.sessionId };
      // Save ownership before crossing the process boundary.
      const step = openStep(task);
      const input = step?.agentInputs?.findLast(entry => entry.roleId === this.roleId && entry.profileId === this.profile.id && entry.reviewerKey === this.reviewerKey);
      const update = { at: Date.now(), reason: "message" as const, text: message.text, messageId: message.id, delivery: "sending" as import("@petrina/core").MessageDelivery["state"] };
      if (input) input.updates = [...(input.updates ?? []), update];
      this.k.commitNow(this.scope);
      const result = await this.run.guide(message.text, message.id);
      if (this.signal.aborted || this.disposed || this.k.stopped) return;
      if (!task.queued.some(entry => entry.id === message.id)) {
        if (input?.updates) input.updates = input.updates.filter(entry => entry.messageId !== message.id);
        this.k.commitNow(this.scope);
        continue;
      }
      const receipt = deliveries[this.member]!;
      if (result === "rejected" || result === "prompt-required" || result === "unsupported") {
        receipt.state = "waiting";
        receipt.reason = result === "unsupported" ? "unsupported" : "rejected";
      } else {
        receipt.state = result === "unknown" ? "unconfirmed" : "accepted";
        if (result === "separate-turn") receipt.reason = "separate-turn";
        if (result === "unknown") receipt.reason = "unknown";
        if (result === "current-turn") this.joined.add(message.id);
        recordMessage(this.k, this.scope, message, "live");
      }
      update.delivery = receipt.state;
      this.k.commitNow(this.scope);
      if (result !== "current-turn") return;
    }
  }

  /** Wait for in-flight acknowledgements before deciding whether an old result can end the step. */
  async settled(reply: TurnResult): Promise<void> {
    await this.pumping;
    if (this.signal.aborted || this.k.stopped) throw new Aborted();
    if (reply.stopReason === "end_turn" || reply.stopReason === "cancelled") {
      for (const message of this.scope.task.queued) {
        const receipt = message.deliveries?.[this.member];
        // Stopping the turn counts: the tool already accepted this message into it. A queued acknowledgement did not join, so it stays open.
        if (!receipt || !(this.joined.has(message.id) || (receipt.via === "prompt" && receipt.state === "sending"))) continue;
        this.markHeard(message);
      }
      removeHeard(this.scope.task);
      this.joined.clear();
      this.k.commitNow(this.scope);
    }
  }

  /** The participant has the message. The step's further instructions say so too. */
  private markHeard(message: LaneMessage): void {
    const receipt = message.deliveries?.[this.member];
    if (!receipt) return;
    receipt.state = "applied";
    const input = openStep(this.scope.task)?.agentInputs?.findLast(entry => entry.roleId === this.roleId && entry.profileId === this.profile.id && entry.reviewerKey === this.reviewerKey);
    const update = input?.updates?.findLast(update => update.messageId === message.id);
    if (update) update.delivery = "applied";
    (message.recipients ??= {})[this.member] = true;
    recordMessage(this.k, this.scope, message, receipt.via === "live" ? "live" : "prompt");
  }

  /** Hear messages that joined this turn, then drop that memory. Returns whether any were newly heard. */
  private hearJoined(): boolean {
    let heard = false;
    for (const message of this.scope.task.queued) {
      if (!this.joined.has(message.id)) continue;
      this.markHeard(message);
      heard = true;
    }
    this.joined.clear();
    if (heard) removeHeard(this.scope.task);
    return heard;
  }
}
