// Coordinator instructions belong to durable participant seats, never a process or profile.
import {
  messageMember,
  settleInterruptedMessageDeliveries,
  unresolvedMessage,
  removeHeardMessages,
  addAsk,
  openStep,
  pauseClock,
  resumeClock,
  type AgentProfile,
  type QueuedMessage
} from "@petrina/core";
import { Aborted, type Kernel, type RuntimeTask } from "./kernel.js";
import type { RepositoryContext } from "@petrina/orchestrator";
import type { TurnResult, AgentSession } from "@petrina/orchestrator";

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

export const MESSAGE_RECOVERY_OPTIONS = ["Continue without sending again", "Send again"] as const;

/** Uncertain input needs an explicit decision, never an endless wait or an automatic duplicate. */
export async function holdUnconfirmed(k: Kernel, scope: RepositoryContext, member: string | undefined, signal: AbortSignal, reviewKey?: string): Promise<void> {
  if (signal.aborted) throw new Aborted();
  const { task } = scope;
  const key = messageMember(member);
  // Only this participant. A peer may still be reserving its own prompt.
  if (settleInterruptedMessageDeliveries(task, key)) k.commitNow(scope);
  for (const message of task.queued) {
    if (!unresolvedMessage(message, key)) continue;
    const receipt = message.deliveries![key]!;
    const work = reviewKey ? task.hunt?.work?.[reviewKey] : undefined;
    const by = reviewKey ? [task.agent, ...(task.helpers ?? [])].find(agent => agent?.reviewKey === reviewKey) : task.agent;
    try {
      for (;;) {
        if (signal.aborted) throw new Aborted();
        const saved = task.journey?.flatMap(step => step.asks ?? []).find(ask => ask.id === receipt.decisionId);
        let answer = saved?.answer;
        if (!answer) {
          let item = k.s.inbox.find(item => item.id === receipt.decisionId && item.taskId === task.id && item.kind === "question");
          if (!item) {
            const id = k.raise(scope, "question", "Could not confirm delivery of your message", true, {
              body: "The tool may already have received this message. Continue without sending it again, or explicitly send another copy. Sending again may repeat an instruction the agent already received.",
              detail: message.text, options: [...MESSAGE_RECOVERY_OPTIONS], ...(reviewKey ? { reviewKey } : {}),
            }, by);
            receipt.decisionId = id;
            addAsk(task, { id, kind: "question", title: "Could not confirm delivery of your message", at: Date.now() });
            item = k.s.inbox.find(item => item.id === id)!;
          }
          const status = "Your call on an unconfirmed message";
          if (work) {
            if (work.clock) work.clock = pauseClock(work.clock, Date.now());
            work.waiting = status;
            k.showReviewWork(task);
          } else {
            k.pauseStep(task);
            task.statusLine = status;
          }
          k.commitNow(scope);
          answer = await k.waitForReply(item.id, signal);
        }
        if (signal.aborted) throw new Aborted();
        if (answer === MESSAGE_RECOVERY_OPTIONS[0]) {
          receipt.state = "skipped";
          (message.recipients ??= {})[key] = true;
          // Keep the uncertainty visible in the exact input, without claiming the agent heard it.
          for (const step of task.journey ?? []) for (const input of step.agentInputs ?? []) for (const update of input.updates ?? []) {
            const reviewer = key.startsWith("review-") ? key.slice("review-".length) : undefined;
            if (update.messageId === message.id && input.reviewerKey === reviewer && k.profile(input.profileId)?.toolId === receipt.toolId) update.delivery = "skipped";
          }
          k.log(scope, "you", "You continued without sending an unconfirmed message again", by?.roleId, by?.profileId);
          break;
        }
        if (answer === MESSAGE_RECOVERY_OPTIONS[1]) {
          // Only this recipient retries, through the next ordinary tracked prompt.
          message.deliveries![key] = { state: "waiting" };
          k.log(scope, "you", "You asked to send an unconfirmed message again", by?.roleId, by?.profileId);
          break;
        }
        // Free text must not silently authorize another delivery.
        delete receipt.decisionId;
      }
    } finally {
      if (work && !signal.aborted) {
        const pending = k.s.inbox.find(item => item.taskId === task.id && item.blocking && item.reviewKey === reviewKey);
        if (pending) work.waiting = pending.kind === "permission" ? "Waiting for your permission" : "Waiting for your answer";
        else {
          delete work.waiting;
          if (work.clock) work.clock = resumeClock(work.clock, Date.now());
        }
        k.showReviewWork(task);
      }
      k.commitNow(scope);
    }
  }
  removeHeardMessages(task);
}

/** A queued instruction on the live task, writable the same way ordinary prompt handoff writes it. */
type LaneMessage = RuntimeTask["queued"][number];

/** One ordered delivery lane for a participant, alongside its ordinary tracked prompt. */
export class MessageTurn {
  private pumping?: Promise<void>;
  private attempted = new Set<string>();
  private joined = new Set<string>();
  private promptMessages = new Set<string>();
  private disposed = false;
  readonly member: string;

  constructor(private k: Kernel, private scope: RepositoryContext, private run: AgentSession,
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
        if (!this.promptMessages.has(message.id)) continue;
        const receipt = message.deliveries?.[this.member];
        if (receipt?.state !== "sending" || receipt.via !== "prompt") continue;
        // The prompt now contains this instruction. That participant has it; a later
        // pause or restart must not wait on it or hand it over again.
        receipt.toolId = this.profile.toolId;
        receipt.sessionId = this.run.sessionId;
        // The follow-up prompt now contains it, so the step record is heard too.
        this.markHeard(message);
      }
      this.promptMessages.clear();
      this.k.commitNow(this.scope);
      void this.deliver();
    };
  }

  /** Only these reserved instructions were included in the prompt about to start. */
  preparePrompt(messages: readonly QueuedMessage[]): void {
    this.promptMessages = new Set(messages.map(message => message.id));
  }

  dispose(): void {
    this.disposed = true;
    this.run.onPromptStarted = undefined;
    // Pause and stop still know which messages joined. A crash never gets here, so that acceptance stays unconfirmed.
    const heard = this.hearJoined();
    if (settleInterruptedMessageDeliveries(this.scope.task, this.member) || heard) this.k.commitNow(this.scope);
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
      if (unresolvedMessage(message, this.member)) return;
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
      const update = {
        at: Date.now(),
        reason: "message" as const,
        text: message.text,
        messageId: message.id,
        delivery: "sending" as import("@petrina/core").MessageDelivery["state"]
      };
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
        if (!receipt || !this.joined.has(message.id)) continue;
        this.markHeard(message);
      }
      removeHeardMessages(this.scope.task);
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
    if (heard) removeHeardMessages(this.scope.task);
    return heard;
  }
}
