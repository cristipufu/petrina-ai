// Coordinator commands for pause/resume/cancel, retries, messages and inbox decisions.

import * as library from "@petrina/core";
import {
  cancelTaskState,
  endYouStep,
  JOURNEY_WORDS,
  messageRemovable,
  pauseTaskState,
  resumeTaskState,
  routeMessages,
  settleAsk,
  type AskAnswer,
  type Id,
  type SaidContext,
} from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import type { Checkpoints } from "./checkpoints.js";
import type { Cleanup } from "./cleanup.js";
import type { Engine } from "./engine.js";
import type { GuideKeeper } from "./guide-keeper.js";
import type { Learnings } from "./learnings.js";
import type { ProductChecks } from "./product-checks.js";
import { CARRIED_OVER, type Shipping } from "./shipping.js";
import type { TakeOver } from "./take-over.js";
import type { ToolChecks } from "./tool-checks.js";

export class InboxCommands {
  constructor(
    private readonly engine: Engine,
    private readonly takeover: TakeOver,
    private readonly tools: ToolChecks,
    private readonly checks: ProductChecks,
    private readonly shipping: Shipping,
    private readonly cleanup: Cleanup,
    private readonly guide: GuideKeeper,
    private readonly learnings: Learnings,
    private readonly checkpoints: Checkpoints,
  ) {}

  pause(taskId: Id): void {
    const task = this.engine.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    this.takeover.notDriving(task);
    if (!task || !["running", "needs-you", "waiting"].includes(task.state)) return;
    this.engine.extraValidations.cancelTask(taskId);
    this.engine.stopDriver(taskId);
    pauseTaskState(task, scope!.work, Date.now());
    this.engine.discardScreenTurns(task);
    this.engine.releaseScreen(task);
    this.engine.stopStep(task);
    this.engine.dropBlockingItems(taskId);
    this.engine.log(task, "you", "You paused it");
    this.engine.commit(task);
    this.engine.schedule();
  }

  resume(taskId: Id): void {
    const task = this.engine.task(taskId);
    const hasNonBlockingItem = this.engine.s.inbox.some((item) => item.taskId === taskId && !item.blocking);
    if (!task || !resumeTaskState(task, hasNonBlockingItem)) return;
    if (task.state === "waiting") task.statusLine = this.engine.waitingLine(task);
    this.engine.log(task, "you", "You resumed it");
    this.engine.commit(task);
    this.engine.schedule();
  }

  cancel(taskId: Id): void {
    const task = this.engine.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (!task) return;
    this.takeover.notDriving(task);
    this.engine.extraValidations.cancelTask(taskId);
    this.engine.stopDriver(taskId);
    this.engine.tracking.cancelled(task);
    cancelTaskState(task, scope!.work, Date.now());
    this.engine.discardScreenTurns(task);
    this.engine.releaseScreen(task);
    this.engine.stopStep(task);
    // A delivery from before the update keeps its note: what went out is for the coordinator to check.
    task.statusLine = scope!.work.shipping?.carriedOver
      ? `Cancelled. ${CARRIED_OVER}: check GitHub for what went out`
      : "Cancelled";
    this.engine.dropBlockingItems(taskId);
    this.engine.s.inbox = this.engine.s.inbox.filter((item) => item.taskId !== taskId);
    this.engine.log(task, "you", "You cancelled it");
    this.engine.commit(task);
    // Pictures need no delivery lookup or agent shutdown before they can be discarded.
    void this.engine.trackWork(this.cleanup.removeCaptures(taskId));
    // Stopped mid-delivery with no step running (it failed, say): what went out is looked up now, then the copy goes.
    // With an agent still stopping, its driver removes the copy once it has let go of it.
    void this.engine.trackWork(this.shipping.monitor.settleCancelled(taskId).then(() => this.engine.tidy(taskId)));
    this.engine.schedule();
  }

  async retry(itemId: Id): Promise<void> {
    const stuck = this.engine.s.inbox.find((entry) => entry.id === itemId);
    if (stuck?.kind !== "stuck") return;
    this.takeover.notDrivingItem(itemId);
    if (stuck.toolId && (await this.tools.stillNotReady(stuck.toolId, this.engine.task(stuck.taskId)))) return;
    const item = this.engine.s.inbox.find((entry) => entry.id === itemId);
    const task = item && this.engine.task(item.taskId);
    const scope = task ? executionFor(task) : undefined;
    if (item !== stuck || item.kind !== "stuck" || !task) return;
    this.takeover.notDrivingItem(itemId);
    this.engine.s.inbox = this.engine.s.inbox.filter((entry) => entry.id !== itemId);
    if (task.state === "failed" && task.maintenance) delete task.maintenance.readOnlyWrites;
    delete task.error;
    // An explicit Retry refreshes checks, pass or fail, even on unchanged work. Keep the output visible
    // until that run finishes; ordinary stage changes and restarts keep its identity and reuse it.
    scope!.work.checkSetupInvalidated = { id: this.engine.id(task.id), kind: "explicit-rerun", at: Date.now() };
    if (scope!.work.checks) {
      scope!.work.checks.current = false;
      delete scope!.work.checks.sha;
      delete scope!.work.checks.tree;
    }
    this.engine.tracking.retried(task);
    task.state = "waiting";
    task.statusLine = this.engine.waitingLine(task);
    this.engine.log(task, "you", "You asked to try again");
    endYouStep(task, { outcome: JOURNEY_WORDS.triedAgain, reason: JOURNEY_WORDS.tryAgain }, Date.now());
    this.engine.commit();
    this.engine.schedule();
  }

  rerunChecks(itemId: Id): void {
    const item = this.engine.s.inbox.find((entry) => entry.id === itemId);
    const task = item && this.engine.task(item.taskId);
    if (!item || !task) return;
    if (item.kind !== "delivery") {
      throw new Error("Run checks again is only available for a delivery check problem.");
    }
    if (!library.deliveryDecisionProblem({ repositories: task.repositories, journey: task.journey, ...executionFor(task).work })) {
      throw new Error("This delivery has no failed or unverified product checks to rerun.");
    }
    this.takeover.notDrivingItem(itemId);
    this.engine.takeItem(itemId);
    this.checks.rerun(task);
    this.engine.toWaiting(task);
    this.engine.commitNow();
    this.engine.schedule();
  }

  sendMessage(
    taskId: Id,
    text: string,
    mode: "now" | "queue" | "interrupt" = "now",
    clientId?: Id,
  ): Id | undefined {
    const task = this.engine.task(taskId);
    const trimmed = text.trim();
    if (!task || !trimmed || !this.engine.firstTime(task, clientId)) return;
    const message = { id: this.engine.id(taskId), text: trimmed, at: Date.now(), mode };
    this.engine.remember(task, trimmed, message.id);
    const run = this.engine.runs.get(taskId);
    const runs = new Set(this.engine.helperRuns.get(taskId) ?? []);
    if (run) runs.add(run);
    const interrupt = mode === "interrupt" && runs.size > 0;
    this.engine.stepNote(task, interrupt ? "interrupt" : "message", trimmed, { id: message.id });
    if (interrupt) {
      // Heard next, ahead of notes that were already waiting.
      task.queued.unshift(message);
      this.engine.say(task, "system", "You interrupted the current step");
    } else {
      task.queued.push(message);
    }
    routeMessages(
      task,
      this.engine.screenGroups.get(taskId)?.recipients() ?? Object.keys(task.hunt?.screenTurns ?? {}),
    );
    this.engine.commitNow(task);
    if (mode === "now") {
      for (const lane of this.engine.messageTurns.get(taskId)?.values() ?? []) void lane.deliver();
    }
    if (interrupt) {
      for (const active of runs) void active.cancel();
    }
    return message.id;
  }

  removeQueued(taskId: Id, messageId: Id): void {
    const task = this.engine.task(taskId);
    if (!task || !task.queued.some((message) => message.id === messageId && messageRemovable(message))) return;
    task.queued = task.queued.filter((message) => message.id !== messageId);
    task.stepNotes = task.stepNotes?.filter((note) => note.id !== messageId);
    task.notes = task.notes?.filter((note) => note.id !== messageId);
    task.session = task.session.filter((line) => line.coordinatorMessageId !== messageId);
    this.engine.commitNow(task);
  }

  answer(itemId: Id, answer: string, context: SaidContext = {}, how: AskAnswer = "answered"): void {
    this.takeover.notDrivingItem(itemId);
    const item = this.engine.s.inbox.find((entry) => entry.id === itemId);
    if (item && item.kind !== "question") {
      throw new Error("Use Answer only for a question. The request is still in your inbox.");
    }
    const task = this.engine.task(item?.taskId ?? context.taskId ?? "");
    const scope = task ? executionFor(task) : undefined;
    const about = item?.title ?? context.about;
    if (!task || !this.engine.firstTime(task, context.clientId)) return;
    if (!item && (!about || ["done", "cancelled"].includes(task.state))) return;
    this.engine.takeItem(itemId);
    const answerKind = context.decided ? "decided" : how;
    this.engine.tracking.answered(task, item ?? itemId, answerKind);
    settleAsk(task, itemId, answerKind === "decided" ? "decided" : "answered", Date.now(), answer);
    // Message recovery is an engine decision, not another instruction for the model.
    const deliveryDecision = task.queued.some((message) =>
      Object.values(message.deliveries ?? {}).some((receipt) => receipt.decisionId === itemId),
    );
    if (!deliveryDecision) this.engine.stepNote(task, "answer", answer, { ...(about ? { about } : {}) });
    this.engine.say(task, "you", answer);
    this.engine.log(task, "you", `You answered: ${answer}`);
    const asked = scope!.work.conversation?.asked;
    if (item && asked?.itemId === itemId) asked.answer = answer;
    const waiter = this.engine.waiting.get(itemId);
    if (item || waiter) this.engine.unblock(task);
    else {
      task.queued.push({
        id: this.engine.id(task.id),
        text: `About your question “${about}”: ${answer}`,
        at: Date.now(),
      });
    }
    this.engine.commitNow(task);
    this.engine.waiting.delete(itemId);
    waiter?.resolve(answer);
    // Asked before a restart: no agent holds a slot for it, so the step waits for one.
    if (item && !waiter) this.engine.schedule();
  }

  decideForMe(itemId: Id): void {
    const item = this.engine.s.inbox.find((entry) => entry.id === itemId);
    if (!item) return;
    this.engine.answer(itemId, item.options?.[0] ?? "Use your best judgment.", {}, "decided");
  }

  allow(itemId: Id, _scope: "once" | "always" = "once"): void {
    this.takeover.notDrivingItem(itemId);
    const item = this.engine.s.inbox.find((entry) => entry.id === itemId);
    if (!item) return;
    if (item.kind !== "permission") {
      throw new Error("Use Allow only for a permission request. The request is still in your inbox.");
    }
    this.engine.takeItem(itemId);
    const task = this.engine.task(item.taskId);
    if (task) {
      this.engine.tracking.answered(task, item, "allowed");
      settleAsk(task, itemId, "allowed", Date.now());
      this.engine.log(task, "you", `You allowed: ${item.title}`);
      this.engine.unblock(task);
    }
    this.engine.waiting.get(itemId)?.resolve("allow");
    this.engine.waiting.delete(itemId);
    this.engine.commit();
  }

  deny(itemId: Id, note?: string, context: SaidContext = {}): void {
    this.takeover.notDrivingItem(itemId);
    const item = this.engine.s.inbox.find((entry) => entry.id === itemId);
    if (item && item.kind !== "permission") {
      throw new Error("Use Deny only for a permission request. The request is still in your inbox.");
    }
    const task = this.engine.task(item?.taskId ?? context.taskId ?? "");
    const said = note?.trim();
    const about = item?.title ?? context.about;
    if (!task || !this.engine.firstTime(task, context.clientId)) return;
    // A plain "No" to a request a restart already dropped changes nothing.
    if (!item && (!said || ["done", "cancelled"].includes(task.state))) return;
    this.engine.takeItem(itemId);
    if (item) this.engine.tracking.answered(task, item, "denied");
    settleAsk(task, itemId, "denied", Date.now(), said);
    this.engine.log(task, "you", said ? `You said no: ${said}` : `You said no to: ${about}`);
    if (said) {
      const id = this.engine.id(task.id);
      this.engine.remember(task, said, id);
      this.engine.stepNote(task, "denied", said, { id, ...(about ? { about } : {}) });
      task.queued.push({ id, text: said, at: Date.now() });
    }
    if (item) this.engine.unblock(task);
    this.engine.commitNow(task);
    this.engine.waiting.get(itemId)?.resolve("deny");
    this.engine.waiting.delete(itemId);
  }

  approve(itemId: Id): void | Promise<void> {
    this.takeover.notDrivingItem(itemId);
    const kind = this.engine.s.inbox.find((entry) => entry.id === itemId)?.kind;
    if (kind === "stuck") return this.engine.retry(itemId);
    if (kind === "shipping") {
      this.shipping.checkShipping(itemId);
      return;
    }
    if (kind === "guide") {
      this.guide.acceptGuideLine(itemId);
      return;
    }
    if (kind === "learnings") {
      this.learnings.accept(itemId);
      return;
    }
    if (kind === "screen") {
      this.engine.allowScreen(this.engine.s.inbox.find((entry) => entry.id === itemId)!.taskId);
      return;
    }
    this.checkpoints.approve(itemId);
  }

  requestChanges(itemId: Id, note: string): void {
    this.takeover.notDrivingItem(itemId);
    this.checkpoints.requestChanges(itemId, note);
  }

  decline(itemId: Id): void {
    if (this.engine.s.inbox.find((entry) => entry.id === itemId)?.kind === "learnings") {
      return this.learnings.decline(itemId);
    }
    return this.guide.declineGuide(itemId);
  }
}
