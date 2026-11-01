// Agent turn stepping, stage transitions, and pool scheduling for Simulator.

import { addAsk, AFTER_WORDS, beginAgentStep, syncWait } from "./journey.js";
import type { ActiveAgent, Id, State, Task } from "./model.js";
import { getProviderDescriptor } from "./providers.js";
import * as library from "./roles.js";
import { admitRoutines, prepareMaintenanceTask } from "./routines.js";
import { balanced, extraSlot, pickStarts, queueOf, slotUses, slotWait, type Candidate } from "./scheduler.js";
import { onScreen, SCREEN_WORDS, screenAllowed, screenQueue, screenReady, screenReason } from "./screen.js";
import { simGate, simOpenPullRequest, simPetrinaDelivers, simShip } from "./sim-delivery.js";
import {
  simBeginStage, simColumnFor, simEndTurn, simFollowing, simId, simLog,
  simNextAgent, simOpenTurn, simPlanner, simRaise, simRound, simRunChecks,
  simSay, simStage, simSyncScreen, type Draft, type DraftTask, type SimRuntime,
} from "./sim-runtime.js";
import { scriptFor } from "./sim-script.js";
import { simFinishStage } from "./sim-stage-completion.js";
import type { Trigger } from "./sim-types.js";
import { pauseClock, plainTodo, startClock } from "./summary.js";
import { blockingDependencies, createTaskState } from "./task-transitions.js";

export function simStartAgent(rt: SimRuntime, d: Draft, task: DraftTask): void {
  const next = simNextAgent(d, task);
  if (!next) return;
  const profile = d.profiles.find((profile) => profile.id === next.profileId);
  const toolId = profile?.toolId ?? "unknown";
  const waiting = slotWait(d as State, { ...profile, taskId: task.id, toolId });
  if (waiting) {
    task.state = "waiting";
    task.holdsSlot = false;
    delete task.agent;
    delete task.helpers;
    task.column = simColumnFor(d, task);
    task.statusLine = waiting;
    return;
  }
  const current = simStage(task);
  // A review round starts with Petrina's own run of the product's checks, as the engine's does.
  const round = simRound(task);
  if (current?.kind === "review-chain" && (task.hunt?.stageId !== current.id || task.hunt.round !== round)) {
    simRunChecks(d, task);
    task.hunt = { stageId: current.id, round, reported: {}, findings: task.findings.length };
  }
  if (current?.kind === "do" && d.roles.find((role) => role.id === current.roleId)?.result === "checks"
    && (task.repositories ?? [task]).some((work) => !work.checks?.current)) simRunChecks(d, task);
  // Back from waiting for the screen: the same agent picks up where it left off, on the screen.
  const screen = task.screen?.granted && !task.screen.heard && task.screen.roleId === next.roleId ? task.screen : undefined;
  // A review round's reviewers share its step on the journey; each joins it as it starts.
  beginAgentStep(
    task,
    current?.kind === "review-chain" ? current.roleId : next.roleId,
    next.profileId,
    d.now,
    d.roles,
    current?.kind === "review-chain" ? current.profileIds : undefined
  );
  // Providers that report sandbox state get a known sandbox setting; other tools keep their own setup.
  const agent: ActiveAgent = {
    ...next,
    since: d.now,
    step: screen?.step ?? 0,
    ...(getProviderDescriptor(toolId)?.capabilities.reportsSandbox ? { sandbox: { on: true as const } } : {})
  };
  task.agent = agent;
  // Reviewers look at the change together, as the engine's do: the ones still to report work beside this
  // one, each in a slot of its own while the pool and its tool allow.
  delete task.helpers;
  for (const [index, profileId] of (current?.kind === "review-chain" ? current.profileIds.slice(task.sub + 1) : []).entries()) {
    const helper = d.profiles.find((profile) => profile.id === profileId);
    const tool = helper?.toolId ?? "unknown";
    if (!extraSlot(d as State, tool, helper)) break;
    task.helpers = [...(task.helpers ?? []), { roleId: library.reviewerAt(current!, task.sub + 1 + index), profileId, since: d.now, step: 0 }];
  }
  // Each start is a fresh one: a step started again after a pause leaves no record.
  delete task.todo;
  task.stepAttempts = (task.stepAttempts ?? 0) + 1;
  task.stepClock = startClock(task, next.roleId, d.now);
  task.state = "running";
  task.holdsSlot = true;
  task.column = simColumnFor(d, task);
  const role = d.roles.find((entry) => entry.id === next.roleId)?.name ?? next.roleId;
  if (screen) {
    screen.heard = true;
    task.statusLine = SCREEN_WORDS.using(screen.reason);
    simSay(d, task, "system", `${role} picked up where it left off`, next.roleId, next.profileId);
    simLog(d, task, "milestone", SCREEN_WORDS.pickedUp, next.roleId, next.profileId);
    simOpenTurn(rt, d, task, "continue");
    return;
  }
  task.statusLine = `${role} is starting`;
  simSay(d, task, "system", `${role} joined`, next.roleId, next.profileId);
  simLog(d, task, "milestone", `${role} started`, next.roleId, next.profileId);
  simBeginStage(rt, d, task);
  simOpenTurn(rt, d, task, "first");
}

export function simStep(rt: SimRuntime, d: Draft, task: DraftTask): void {
  const agent = task.agent;
  if (!agent) return;

  const next = task.queued[0];
  // Live guidance the tool already accepted stays until the turn finishes. A later note waits behind it.
  if (next && next.deliveries?.main?.state !== "accepted") {
    task.queued.shift();
    simDeliver(rt, d, task, next.text);
    return;
  }

  const product = d.products.find((entry) => entry.id === task.productId)?.name ?? "the product";
  const round = simRound(task);
  const following = !!simFollowing(task);
  const moments = scriptFor(
    d.roles.find((role) => role.id === agent.roleId),
    {
    area: task.area,
    product,
    round,
    fixing: task.fixing,
    following,
    objecting: rt.disagree.has(task.id)
  }
  );
  const moment = moments[agent.step];
  if (moment === undefined) {
    simFinishStage(rt, d, task, { startAgent: simStartAgent, advance: simAdvance });
    return;
  }

  // As with real agents: the to-do item goes on the timeline, actions are the status line and the session's activity.
  agent.step += 1;
  if ("action" in moment) {
    task.statusLine = moment.action;
    simSay(d, task, "activity", moment.action, agent.roleId, agent.profileId);
    return;
  }
  const todo = plainTodo(moment.todo);
  if (todo) task.todo = todo;
  simLog(d, task, "status", todo ?? moment.todo, agent.roleId, agent.profileId);
  const item = moments.slice(0, agent.step).filter((entry) => "todo" in entry).length - 1;
  const trigger = rt.triggers[`${task.id}|${agent.roleId}|${round}|${item}`] ?? rt.triggers[`${task.id}|${agent.roleId}|${round}|${agent.step - 1}`];
  if (trigger?.kind === "screen") simAskScreen(rt, d, task, trigger.title);
  else if (trigger) simAsk(rt, d, task, trigger);
}

/** The agent did what it could in the background and needs the screen. */
function simAskScreen(rt: SimRuntime, d: Draft, task: DraftTask, text: string): void {
  const agent = task.agent;
  if (!agent) return;
  const reason = screenReason(text);
  simEndTurn(rt, d, task, "finished");
  task.screen = { reason, at: d.now, roleId: agent.roleId, profileId: agent.profileId, step: agent.step };
  simLog(d, task, "status", SCREEN_WORDS.asked(reason), agent.roleId, agent.profileId);
  const free = !onScreen(d.tasks as Task[]) && !screenQueue(d.tasks as Task[]).some((other) => screenAllowed(other, d.pool, d.now));
  if (screenAllowed(task as Task, d.pool, d.now) && free) {
    task.screen.granted = true;
    task.screen.heard = true;
    task.statusLine = SCREEN_WORDS.using(reason);
    simLog(d, task, "milestone", SCREEN_WORDS.using(reason), agent.roleId, agent.profileId);
    simOpenTurn(rt, d, task, "continue");
    return;
  }
  task.state = "waiting";
  task.holdsSlot = false;
  delete task.agent;
  delete task.helpers;
  simSyncScreen(d);
}

export function simDeliver(rt: SimRuntime, d: Draft, task: DraftTask, text: string, interrupt = false): void {
  if (rt.openTurns.has(task.id)) {
    simEndTurn(rt, d, task, interrupt ? "interrupted" : "finished");
    simOpenTurn(rt, d, task, "message");
  }
  simSay(d, task, "you", text);
  simLog(d, task, "you", `You said: ${text}`);
  simSay(d, task, "agent", "Got it. I'll take that into account from here.", task.agent?.roleId, task.agent?.profileId);
}

function simAsk(rt: SimRuntime, d: Draft, task: DraftTask, trigger: Trigger): void {
  if (trigger.kind === "screen") return;
  const agent = task.agent;
  // A question ends the agent's turn; a permission is answered inside it, and the wait is not work.
  if (trigger.kind === "question") simEndTurn(rt, d, task, "finished");
  else {
    const open = rt.openTurns.get(task.id);
    if (open) open.waitingSince = d.now;
  }
  const id = simRaise(rt, d, task, trigger.kind, trigger.title, true, trigger);
  addAsk(task, { id, kind: trigger.kind, title: trigger.title, at: d.now });
  task.statusLine = trigger.kind === "question" ? "Waiting for your answer" : "Waiting for your permission";
  if (task.stepClock) task.stepClock = pauseClock(task.stepClock, d.now);
  simSay(d, task, "agent", trigger.title, agent?.roleId, agent?.profileId);
  simLog(
    d,
    task,
    "warn",
    trigger.kind === "question" ? `Asked you: ${trigger.title}` : `Asked your permission: ${trigger.title}`,
    agent?.roleId,
    agent?.profileId
  );
}

export function simAdvance(rt: SimRuntime, d: Draft, task: DraftTask): void {
  delete task.helpers;
  task.stageIndex += 1;
  task.sub = 0;
  delete task.agent;
  const stage = simStage(task);
  if (!stage) {
    simOpenPullRequest(rt, d, task);
    return;
  }
  if (stage.kind === "gate" && stage.gate) {
    simGate(rt, d, task, stage.gate);
    return;
  }
  if (simPetrinaDelivers(d, task)) {
    simShip(rt, d, task);
    return;
  }
  simStartAgent(rt, d, task);
}

/** Fill free slots: tasks already in progress first (the tool with more of its limit left first), then the queue, in priority order. */
export function simSchedule(rt: SimRuntime, d: Draft): void {
  admitRoutines(d, d.now, (routine, scheduledAt) => {
    const id = simId(d, "task");
    const task = createTaskState(
      {
      productId: routine.productId,
      title: routine.name,
      kind: "chore"
    },
      d.products,
      {
      id,
      timelineId: simId(
      d,
      id
    ),
      now: d.now,
      priority: queueOf(d.tasks).length
    }
    );
    prepareMaintenanceTask(task, routine, d as State, scheduledAt, d.now);
    d.tasks.push(task as DraftTask);
    return id;
  });
  simSyncScreen(d);
  const profiles = new Map(d.profiles.map((profile) => [profile.id, profile]));
  const find = (id: Id) => d.tasks.find((entry) => entry.id === id);
  // A task waiting for others to land stays out of the running and says what it waits for.
  const blocked = (task: DraftTask): boolean => {
    const waitingFor = blockingDependencies(task, find);
    syncWait(task, waitingFor, find, d.now);
    if (!waitingFor.length) {
      if (task.state === "queued" && task.statusLine.startsWith("Waiting for “")) task.statusLine = task.held ? "On hold" : "In the queue";
      return false;
    }
    task.statusLine = AFTER_WORDS.waiting(waitingFor.map((other) => other.title));
    return true;
  };
  const inProgress = d.tasks.filter((task) => task.state === "waiting").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const continuing: Candidate[] = [];
  for (const task of inProgress) {
    if (blocked(task)) continue;
    // Waiting for the screen: for the coordinator's OK, or its turn. Its status line says which.
    if (!screenReady(task as Task, d as State, d.now)) continue;
    const next = simNextAgent(d, task);
    if (next) {
      const profile = profiles.get(next.profileId);
      const candidate = { ...profile, taskId: task.id, toolId: profile?.toolId ?? "unknown" };
      task.statusLine = slotWait(d as State, candidate) ?? "Waiting for a free slot";
      continuing.push(candidate);
    }
  }
  const candidates = balanced(continuing, d.pool, d.now);
  for (const queued of queueOf(d.tasks as Task[])) {
    const task = find(queued.id)!;
    // On hold too, a task stops waiting the moment the tasks it waits for land; it just does not start.
    if (blocked(task) || task.held) continue;
    const profile = profiles.get(task.maintenance?.profile.id ?? task.direct?.profile.id ?? simPlanner(d));
    candidates.push({ ...profile, taskId: task.id, toolId: profile?.toolId ?? "unknown" });
  }

  const starts = pickStarts({ candidates, inUse: slotUses(d), pool: d.pool, now: d.now });
  for (const taskId of starts) {
    const task = d.tasks.find((entry) => entry.id === taskId);
    if (!task) continue;
    if (task.state === "queued") {
      task.startedAt = d.now;
      task.stageIndex = task.maintenance || task.direct ? 0 : -1;
      simLog(d, task, "milestone", "Started from the queue");
    }
    // The screen is this agent's from now until its step ends.
    const asked = task.screen && !task.screen.granted ? task.screen : undefined;
    if (asked) asked.granted = true;
    simStartAgent(rt, d, task);
    if (asked && task.state !== "running") delete asked.granted;
  }
}
