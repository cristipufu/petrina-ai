// Coordinator action handlers (inbox decisions, product settings, task lifecycle, messages) for Simulator.

import { CALL_WORDS } from "./call.js";
import { afterChangesAsked, type DeepMutable } from "./flow.js";
import { AFTER_WORDS, endYouStep, JOURNEY_WORDS, syncWait, withdrawAsks } from "./journey.js";
import type { CheckPrerequisite, Id, InboxItem, Task } from "./model.js";
import { configureProductChecks, configureProductCheckSetup } from "./products.js";
import { involvesProduct, taskProductIds, withoutProduct } from "./repositories.js";
import { queueOf } from "./scheduler.js";
import { SCREEN_WORDS } from "./screen.js";
import { simContinueAfterGate } from "./sim-delivery.js";
import { simAdvance, simDeliver, simSchedule } from "./sim-engine.js";
import {
  simColumnFor, simEndStage, simEndTurn, simId, simLog, simMoment, simReleaseScreen, simRemoveCopy,
  simRunChecks, simSay, simStage, simUnblock, simWrote, type Draft, type DraftTask, type SimRuntime,
} from "./sim-runtime.js";
import { areaFromTitle, briefFor, demoSource } from "./sim-script.js";
import type { MessageMode, NewTask } from "./sim-types.js";
import { deliveryLabel, type WorkChoice } from "./source.js";
import { blockingDependencies, cancelTaskState, combineBacklogTasks, createTaskState, pauseTaskState } from "./task-transitions.js";

export function simApproveItem(rt: SimRuntime, d: Draft, task: DraftTask, item: DeepMutable<InboxItem>): void {
  switch (item.kind) {
    case "plan":
      if (task.workRows && (!task.workRows.length || task.workRows.some((row) => row.error || !row.source))) throw new Error("Correct every product choice first.");
      if (task.workRows) {
        task.repositories = task.workRows.map((row) => ({
          productId: row.choice.productId,
          workChoice: row.choice,
          delivery: row.choice.delivery,
          source: {
          ...row.source!,
          confirmed: true
        },
          completedStages: [],
          preparation: "ready"
        }));
        task.leadProductId = task.workRows.find((row) => row.choice.lead)?.choice.productId ?? task.repositories[0]!.productId;
        const first = task.repositories[0]!;
        task.productId = first.productId;
        task.workChoice = first.workChoice;
        task.source = first.source;
        task.delivery = first.delivery;
        for (const stage of task.plan?.stages ?? []) if (stage.kind === "do" && d.roles.find(role => role.id === stage.roleId)?.result === "delivery") stage.title = task.repositories.length > 1 ? `Deliver across ${task.repositories.length} products` : deliveryLabel(task);
      }
      task.confirmWork = false;
      if (task.source) task.source.confirmed = true;
      simLog(d, task, "you", "You approved the plan");
      endYouStep(task, { outcome: JOURNEY_WORDS.approved, reason: JOURNEY_WORDS.youApproved }, d.now);
      simContinueAfterGate(rt, d, task);
      break;
    case "design":
      simLog(d, task, "you", "You approved the design");
      endYouStep(task, { outcome: JOURNEY_WORDS.approved, reason: JOURNEY_WORDS.youApproved }, d.now);
      simContinueAfterGate(rt, d, task);
      break;
    case "disagreement":
      simLog(d, task, "you", "You sided with the architect");
      endYouStep(task, { outcome: JOURNEY_WORDS.sided, reason: JOURNEY_WORDS.youSided }, d.now);
      for (const objection of task.objections) {
        if (objection.status !== "open") continue;
        objection.status = "rejected";
        objection.decidedBy = "coordinator";
      }
      task.brief = briefFor(task);
      simAdvance(rt, d, task);
      break;
    case "delivery":
      if (task.reviewDecision?.accepted === false) {
        task.reviewDecision.accepted = true;
        simLog(d, task, "you", "You accepted the unresolved review for final verification; delivery is not approved");
        endYouStep(task, { outcome: "Continue to final checks", reason: "unresolved review accepted; delivery is not approved" }, d.now);
        simContinueAfterGate(rt, d, task, false);
        break;
      }
      simLog(d, task, "you", "You approved the delivery");
      endYouStep(task, { outcome: JOURNEY_WORDS.approved, reason: JOURNEY_WORDS.youApproved }, d.now);
      // After review rounds ran out, the check was raised on the delivery stage itself.
      simContinueAfterGate(rt, d, task, simStage(task)?.kind === "gate");
      break;
    case "guide": {
      const product = d.products.find((entry) => entry.id === task.productId);
      if (product && item.body) product.reviewGuide = [...(product.reviewGuide ?? []), { text: item.body, at: d.now, fromTask: task.id }];
      simLog(d, task, "you", `You added to the review guide: ${item.body ?? ""}`);
      break;
    }
    case "learnings": {
      const product = d.products.find((entry) => entry.id === task.productId);
      const lessons = (item.body ?? "").split("\n").map((line) => line.replace(/^- /, "").trim()).filter(Boolean);
      if (product) product.learnings = [...(product.learnings ?? []), ...lessons.map((text) => ({ text, at: d.now, fromTask: task.id }))];
      simLog(d, task, "you", `You added ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} to AGENTS.md`);
      break;
    }
    case "screen":
      if (task.screen && !task.screen.granted) {
        task.screen.allowed = true;
        simLog(d, task, "you", SCREEN_WORDS.allowedNow);
      }
      break;
    default:
      break;
  }
}

export function simRerunChecks(d: Draft, task: DraftTask, item: DeepMutable<InboxItem>): void {
  if (item.kind !== "delivery") return;
  endYouStep(task, { outcome: "Run checks again", reason: JOURNEY_WORDS.checkAgain }, d.now);
  simLog(d, task, "you", "You asked to run checks again; delivery is not approved");
  simRunChecks(d, task);
  for (const finding of task.findings) if (finding.raisedBy === "petrina" && finding.text.startsWith("Check failed")) finding.status = "fixed";
  delete task.checkReturns;
  simUnblock(d, task);
}

export function simAddLessons(d: Draft, task: DraftTask, item: DeepMutable<InboxItem>, keep: readonly number[]): void {
  const product = d.products.find((entry) => entry.id === task.productId);
  const lessons = (item.body ?? "")
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean)
    .filter((_, index) => keep.includes(index));
  if (product) product.learnings = [...(product.learnings ?? []), ...lessons.map((text) => ({ text, at: d.now, fromTask: task.id }))];
  simLog(
    d,
    task,
    "you",
    lessons.length ? `You added ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} to AGENTS.md` : "You left AGENTS.md as it is"
  );
}

export function simRequestChanges(d: Draft, task: DraftTask, item: DeepMutable<InboxItem>, note: string): void {
  const call = item.kind === "disagreement";
  simLog(d, task, "you", call ? CALL_WORDS.made(note) : `You asked for changes: ${note}`);
  simSay(d, task, "you", note);
  endYouStep(
    task,
    call ? {
    outcome: JOURNEY_WORDS.madeCall,
    reason: JOURNEY_WORDS.yourCall,
    tone: "back"
  } : {
    outcome: JOURNEY_WORDS.changes,
    reason: JOURNEY_WORDS.changesAsked,
    tone: "back"
  },
    d.now
  );
  task.notes = [...(task.notes ?? []), { at: d.now, text: note }];
  afterChangesAsked(task, item.kind, note, d.now, d.roles);
  task.state = "waiting";
  task.statusLine = "Waiting for a free slot";
  task.column = simColumnFor(d, task);
}

export function simSetProductChecks(d: Draft, productId: Id, checks: readonly { name: string; command: string }[] | null): void {
  const executions = function* () {
    for (const task of d.tasks) for (const work of task.repositories ?? [task]) yield work;
  };
  configureProductChecks(d.products.find(product => product.id === productId), checks, executions());
}

export function simSetProductCheckSetup(d: Draft, productId: Id, requirements: readonly CheckPrerequisite[]): void {
  const executions = function* () {
    for (const task of d.tasks) for (const work of task.repositories ?? [task]) yield { taskId: task.id, work };
  };
  configureProductCheckSetup(d.products.find(product => product.id === productId), requirements, executions(), {
    id: prefix => simId(d, prefix), now: () => d.now,
  });
}

export function simRemoveProduct(rt: SimRuntime, d: Draft, productId: Id): void {
  const product = d.products.find((entry) => entry.id === productId);
  // Its entry stays, marked removed, so its history keeps its name and its id is never reused.
  if (product) rt.work.recordProduct({ id: product.id, name: product.name, repo: product.repo, removedAt: d.now });
  const ids = new Set(d.tasks.filter((task) => involvesProduct(task, productId) && taskProductIds(task).length === 1).map((task) => task.id));
  for (const id of ids) rt.pullRequestAges.delete(id);
  d.inbox = d.inbox.filter((item) => !ids.has(item.taskId));
  d.tasks = d.tasks.flatMap((task) => {
    const retained = withoutProduct(task, productId);
    return retained ? [retained as DraftTask] : [];
  });
  d.products = d.products.filter((entry) => entry.id !== productId);
  simWrote(rt, d);
}

export function simMoveInQueue(rt: SimRuntime, d: Draft, taskId: Id, index: number): void {
  const queue = queueOf(d.tasks as Task[]).map((task) => task.id);
  const from = queue.indexOf(taskId);
  if (from < 0) return;
  queue.splice(from, 1);
  queue.splice(Math.max(0, Math.min(queue.length, index)), 0, taskId);
  queue.forEach((id, position) => {
    const task = d.tasks.find((entry) => entry.id === id);
    if (task) task.priority = position;
  });
  simSchedule(rt, d);
}

export function simPauseTask(rt: SimRuntime, d: Draft, task: DraftTask): void {
  if (!["running", "needs-you", "waiting"].includes(task.state)) return;
  simEndTurn(rt, d, task, "stopped");
  pauseTaskState(task, task, d.now);
  withdrawAsks(task, d.inbox.filter((item) => item.taskId === task.id && item.blocking).map((item) => item.id), d.now);
  simReleaseScreen(d, task);
  d.inbox = d.inbox.filter((item) => item.taskId !== task.id || !item.blocking);
  simLog(d, task, "you", "You paused it");
  simSchedule(rt, d);
}

export function simCancelTask(rt: SimRuntime, d: Draft, task: DraftTask): void {
  simEndTurn(rt, d, task, "stopped");
  simEndStage(rt, d, task, "cancelled");
  simMoment(rt, d, task, { kind: "task-end", outcome: "cancelled" });
  cancelTaskState(task, task, d.now);
  simReleaseScreen(d, task);
  d.inbox = d.inbox.filter((item) => item.taskId !== task.id);
  simLog(d, task, "you", "You cancelled it");
  // Only started tasks have a working copy to remove.
  if (task.startedAt !== undefined) simRemoveCopy(rt, d, task);
  simSchedule(rt, d);
}

export function simSendMessage(rt: SimRuntime, d: Draft, task: DraftTask, trimmed: string, mode: MessageMode): void {
  if (mode === "interrupt" && task.agent && task.state === "running") {
    simSay(d, task, "system", "You interrupted the current step");
    simDeliver(rt, d, task, trimmed, true);
    return;
  }
  const message = { id: simId(d, task.id), text: trimmed, at: d.now, mode };
  const tool = d.profiles.find(profile => profile.id === task.agent?.profileId)?.toolId;
  if (mode === "now" && task.agent && task.state === "running" && tool !== "antigravity") {
    simSay(d, task, "you", trimmed);
    task.session.at(-1)!.coordinatorMessageId = message.id;
    simLog(d, task, "you", "You sent a message");
    const step = task.journey?.at(-1);
    const agent = task.agent;
    if (step?.kind === "agent" && agent) {
      if (!step.agentInputs?.length) step.agentInputs = [{
        at: d.now,
        roleId: agent.roleId,
        profileId: agent.profileId,
        taskTitle: task.title,
        sections: [],
        mode: "fresh"
      }];
      const input = step.agentInputs.at(-1)!;
      input.updates = [...(input.updates ?? []), { at: d.now, reason: "message", text: trimmed, messageId: message.id, delivery: "accepted" }];
    }
    // Accepted, not heard, until this turn finishes. The next beat must not drop it.
    task.queued.push({ ...message, recipients: { main: false }, deliveries: { main: { state: "accepted", via: "live", ...(tool ? { toolId: tool } : {}) } } });
    return;
  }
  task.queued.push({
    ...message,
    ...(mode === "now" && tool === "antigravity" ? { deliveries: { main: {
    state: "waiting" as const,
    reason: "unsupported" as const,
    toolId: tool
  } } } : {})
  });
}

export function simSetTaskStartSingle(d: Draft, task: DraftTask, choice: WorkChoice): void {
  const product = d.products.find((entry) => entry.id === choice.productId);
  if (!product) throw new Error("Add the product first.");
  task.workChoice = choice;
  task.productId = choice.productId;
  task.delivery = choice.delivery;
  task.source = demoSource(product, choice);
  for (const stage of task.plan?.stages ?? []) if (stage.kind === "do" && d.roles.find(role => role.id === stage.roleId)?.result === "delivery") stage.title = deliveryLabel(task);
  delete task.workError;
}

export function simSetTaskProducts(d: Draft, task: DraftTask, choices: readonly WorkChoice[]): void {
  task.selectedProducts = [...choices];
  task.workRows = choices.map((choice) => {
    const earlier = task.workRows?.find((row) => row.choice.productId === choice.productId);
    const product = d.products.find((entry) => entry.id === choice.productId);
    return {
      ...earlier,
      choice: {
      ...choice,
      reason: choice.reason ?? earlier?.choice.reason
    },
      error: undefined,
      ...(product ? { source: demoSource(
      product,
      choice
    ) } : { error: "Needs adding" })
    };
  });
  task.confirmWork = true;
  task.approvePlan = true;
}

export function simAddTask(rt: SimRuntime, d: Draft, input: NewTask): Id {
  const id = simId(d, "task");
  const task = createTaskState(
    input,
    d.products,
    {
    id,
    timelineId: simId(
    d,
    id
  ),
    now: d.now,
    priority: queueOf(d.tasks).length,
    area: input.area?.trim() || areaFromTitle(input.title)
  },
    (id) => d.tasks.find((task) => task.id === id)
  );
  // Only source resolution is scripted; task defaults and validation are shared with the engine.
  const product = d.products.find((entry) => entry.id === task.productId) ?? d.products[0];
  if (product) {
    if (!task.productId) {
      task.productId = product.id;
      task.workChoice = { ...task.workChoice!, productId: product.id };
      task.approveDelivery = input.approveDelivery ?? product.approveDelivery ?? true;
    }
    Object.assign(task, { source: demoSource(product, task.workChoice!) });
  }
  if (input.worksOn) task.workRows = input.worksOn.map((choice) => ({
    choice: {
    ...choice,
    startFrom: { ...choice.startFrom }
  },
    source: demoSource(
    d.products.find((product) => product.id === choice.productId)!,
    choice
  )
  }));
  task.confirmWork = (input.worksOn ? input.worksOn.length !== 1 : !input.productId) || task.workChoice?.startFrom.kind === "pull-request";
  d.tasks.push(task);
  if (task.after?.length) {
    const find = (id: Id) => d.tasks.find((entry) => entry.id === id);
    if (task.state === "queued") syncWait(task, blockingDependencies(task, find), find, d.now);
    simLog(d, task, "you", AFTER_WORDS.starts(task.after.map((id) => find(id)!.title)));
  }
  if (input.position === "top") queueOf(d.tasks).forEach((task, priority) => { d.tasks.find((entry) => entry.id === task.id)!.priority = priority; });
  simSchedule(rt, d);
  return id;
}

export function simFinalizeCombineBacklog(rt: SimRuntime, d: Draft, id: Id, taskIds: readonly Id[], clientId: Id): void {
  const combined = d.tasks.find((task) => task.id === id)!;
  combined.clientId = clientId;
  combineBacklogTasks(combined, taskIds.map((id) => d.tasks.find((task) => task.id === id)!), d.now, queueOf(d.tasks).length);
  simLog(d, combined, "you", `You combined ${taskIds.length} backlog requests and queued them as one task`);
  simSchedule(rt, d);
}
