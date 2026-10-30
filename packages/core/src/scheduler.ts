import type { AgentProfile, Id, Pool, State, Task } from "./model.js";
import { byRoom, currentReport, headroom, pastSlowDown, toolCapNow, usageCovers } from "./usage.js";
import { screenReady } from "./screen.js";
import { blocksDependents } from "./repositories.js";
import { runtimeWaitHolds } from "./runtime-wait.js";

/** A pool slot in use: which task holds it, on which tool, and the agent in it when there is one. */
export interface SlotUse {
  taskId: Id;
  toolId: Id;
  roleId?: Id;
  profileId?: Id;
  model?: string;
  modelId?: string;
  label?: string;
}

/** A task that could start (or continue) if a slot were free. */
export interface Candidate {
  taskId: Id;
  /** The tool its next agent runs on. */
  toolId: Id;
  model?: string;
  modelId?: string;
}

/** A configured tool cap is shared; a reported quota only counts the agents it covers. */
function fullQuota(pool: Pool, candidate: Candidate, uses: readonly SlotUse[], now: number): { held: boolean; model?: string } | undefined {
  const cap = pool.toolCaps[candidate.toolId];
  if (cap !== undefined && uses.filter(use => use.toolId === candidate.toolId).length >= cap) return { held: false };
  const slowed = toolCapNow(pool, candidate.toolId, now, candidate);
  if (slowed === undefined) return undefined;
  for (const report of pool.usage ?? []) {
    if (!currentReport(report, now) || !usageCovers(report, candidate) || !pastSlowDown(report)) continue;
    if (uses.filter(use => usageCovers(report, use)).length >= slowed) return { held: true, ...(report.model ? { model: report.model } : {}) };
  }
  return undefined;
}

export interface PickInput {
  /** In priority order: tasks already in progress first, then the queue. */
  candidates: readonly Candidate[];
  inUse: readonly SlotUse[];
  pool: Pool;
  /** The time, for the usage reports that slow a tool down. Default: now. */
  now?: number;
}

/**
 * Which tasks start now. Pure: the pool limit, the per-tool caps and the order decide.
 * A candidate whose tool is at its cap is skipped, so a lower task on another tool can go.
 * A tool past the slow-down mark of a usage window has half its cap for new agents (`toolCapNow`).
 */
export function pickStarts({ candidates, inUse, pool, now = Date.now() }: PickInput): Id[] {
  if (pool.paused) return [];
  let free = pool.limit - inUse.length;
  if (free <= 0) return [];

  const uses = [...inUse];

  const starts: Id[] = [];
  for (const candidate of candidates) {
    if (free === 0) break;
    if (fullQuota(pool, candidate, uses, now)) continue;
    starts.push(candidate.taskId);
    uses.push(candidate);
    free -= 1;
  }
  return starts;
}

/**
 * Candidates with those on the tool that has more of its limit left first (see `headroom`), so when the pool
 * cannot take them all, the slots go to the quota group with the most room. Equal groups keep their order.
 */
export function balanced(candidates: readonly Candidate[], pool: Pool, now: number): Candidate[] {
  return byRoom(candidates, (candidate) => headroom(pool, candidate, now));
}

/** The slots in use: one per task holding a slot, and one more for each agent working beside its main one. */
export function slotUses(state: State): SlotUse[] {
  const toolOf = new Map([...(state.retiredProfiles ?? []), ...state.profiles].map((profile) => [profile.id, profile.toolId]));
  const profiles = new Map([...(state.retiredProfiles ?? []), ...state.profiles].map(profile => [profile.id, profile]));
  return [...state.tasks
    .filter((task) => task.holdsSlot)
    .flatMap((task) => [
      { taskId: task.id, toolId: (task.agent && toolOf.get(task.agent.profileId)) ?? "unknown", ...(task.agent ? { roleId: task.agent.roleId, profileId: task.agent.profileId } : {}) },
      ...(task.helpers ?? []).map((helper) => ({ taskId: task.id, toolId: toolOf.get(helper.profileId) ?? "unknown", roleId: helper.roleId, profileId: helper.profileId })),
    ]), ...(state.backgroundAgents ?? []).map((agent) => ({ taskId: agent.id, toolId: toolOf.get(agent.profileId) ?? "unknown", roleId: agent.roleId, profileId: agent.profileId, label: agent.label }))].map(use => {
      const profile = use.profileId ? profiles.get(use.profileId) : undefined;
      return { ...use, ...(profile ? { model: profile.model, ...(profile.modelId ? { modelId: profile.modelId } : {}) } : {}) };
    });
}

/** Whether a task that already holds its slot may start one more agent on this tool now: every slot in use counts. */
export function extraSlot(state: State, toolId: Id, profile?: Pick<AgentProfile, "model" | "modelId">): boolean {
  if (state.pool.paused) return false;
  const uses = slotUses(state);
  if (uses.length >= state.pool.limit) return false;
  return !fullQuota(state.pool, { toolId, taskId: "", ...profile }, uses, state.now);
}

/** What a task waits for when its tool slows down near a usage limit. */
export const FEWER_START = "fewer start on it this close to its limit";

/** Rechecked for every agent, including one on the same tool. The task's old slot does not count. */
export function slotWait(state: State, candidate: Candidate): string | undefined {
  const task = state.tasks.find(task => task.id === candidate.taskId);
  if (task && runtimeWaitHolds(task)) return task.statusLine;
  const others = slotUses(state).filter((use) => use.taskId !== candidate.taskId);
  if (state.pool.paused) return "Waiting for the pool to resume";
  if (others.length >= state.pool.limit) return "Waiting for a free slot";
  const full = fullQuota(state.pool, candidate, others, state.now);
  if (full) {
    const tool = state.tools.find((entry) => entry.id === candidate.toolId)?.name ?? candidate.toolId;
    // Fewer seats than the cap says: the tool is slowing down, and the task says so.
    const model = full.model ? ` · ${candidate.model ?? full.model}` : "";
    return `Waiting for a free ${tool}${model} slot${full.held ? ` (${FEWER_START})` : ""}`;
  }
  return undefined;
}

/** The queue in priority order, held tasks included (they show, they just do not start). */
export function queueOf<T extends Pick<Task, "state" | "priority">>(tasks: readonly T[]): T[] {
  return tasks.filter((task) => task.state === "queued").sort((a, b) => a.priority - b.priority);
}

/** Queue entries whose dependencies have actually landed, in the scheduler's order. */
export function readyQueue(state: Pick<State, "tasks" | "history">): Task[] {
  const live = new Map(state.tasks.map(task => [task.id, task]));
  const history = new Map(state.history?.dependencies?.map(task => [task.id, task]) ?? []);
  return queueOf(state.tasks).filter(task => !task.held && !(task.after ?? []).some(id => {
    const task = live.get(id);
    return task ? blocksDependents(task) : history.get(id)?.blocksDependents === true;
  }));
}

/** How many queued tasks will start as soon as slots allow: the "starts next" line. */
export function startsNextCount(state: State): number {
  if (state.pool.paused) return 0;
  // A task waiting for the screen holds no claim on a slot until the screen is its turn.
  const waiting = state.tasks.filter((task) => task.state === "waiting" && !runtimeWaitHolds(task) && screenReady(task, state, state.now)).length;
  const free = Math.max(0, state.pool.limit - slotUses(state).length - waiting);
  return readyQueue(state).slice(0, free).length;
}
