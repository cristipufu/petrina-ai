import type { AgentProfile, Id, Role, RunState, Stage, State, Task, Tool } from "@petrina/core";

export const PHASES = ["Plan", "Design", "Build", "Review", "Ship"] as const;

const DESIGN_ROLES = new Set(["researcher", "architect", "design-reviewer", "ux-designer"]);

/** Which of the five phases a stage belongs to. */
export function phaseOfStage(stage: Stage): number {
  if (stage.kind === "gate") return stage.gate === "plan" ? 0 : stage.gate === "design" ? 1 : 4;
  if (stage.kind === "converge" || DESIGN_ROLES.has(stage.roleId)) return 1;
  if (stage.kind === "review-chain") return 3;
  return 2;
}

/** The phase the task is in: -1 queued, 0..4, or 5 when everything is done. */
export function currentPhase(task: Task): number {
  if (task.state === "queued") return -1;
  if (task.state === "done") return 5;
  if (task.state === "pr-open") return 4;
  if (task.stageIndex < 0) return 0;
  const stage = task.plan?.stages[task.stageIndex];
  return stage ? phaseOfStage(stage) : 4;
}

/** Phases the plan actually uses. Planning and shipping are always there. */
export function phasesInPlan(task: Task): Set<number> {
  const used = new Set<number>([0, 4]);
  if (!task.plan) return new Set([0, 1, 2, 3, 4]);
  for (const stage of task.plan.stages) used.add(phaseOfStage(stage));
  return used;
}

export function lookup(state: State) {
  const roles = new Map(state.roles.map((role) => [role.id, role]));
  const profiles = new Map(state.profiles.map((profile) => [profile.id, profile]));
  const tools = new Map(state.tools.map((tool) => [tool.id, tool]));
  const products = new Map(state.products.map((product) => [product.id, product]));
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  return {
    role: (id?: Id): Role | undefined => (id ? roles.get(id) : undefined),
    profile: (id?: Id): AgentProfile | undefined => (id ? profiles.get(id) : undefined),
    tool: (id?: Id): Tool | undefined => (id ? tools.get(id) : undefined),
    product: (id?: Id) => (id ? products.get(id) : undefined),
    task: (id?: Id): Task | undefined => (id ? tasks.get(id) : undefined),
  };
}

export type Lookup = ReturnType<typeof lookup>;

export const STATE_LABEL: Record<RunState, string> = {
  queued: "Queued",
  waiting: "Waiting for a slot",
  running: "Working",
  "needs-you": "Needs you",
  paused: "Paused",
  failed: "Failed",
  "pr-open": "Pull request open",
  done: "Done",
  cancelled: "Cancelled",
};

export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function duration(from: number | undefined, to: number): string {
  return from === undefined ? "" : ago(from, to) === "now" ? "<1m" : ago(from, to);
}

export const TOOL_COLORS: Record<string, string> = {
  "claude-code": "#d97757",
  codex: "#10a37f",
  gemini: "#4285f4",
  opencode: "#6b7079",
};

/** Agents waiting on the coordinator while keeping their slot. */
export function blockingCount(state: State): number {
  return state.tasks.filter((task) => task.state === "needs-you" && task.holdsSlot).length;
}

/** Only https links leave the app. */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}
