import { landingOf, type AgentProfile, type Effort, type Id, type Role, type RunState, type State, type Task, type Tool } from "@petrina/core";

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
  "pr-open": "Awaiting merge",
  done: "Completed",
  cancelled: "Cancelled",
};

const EFFORT_LABEL: Record<Effort, string> = {
  low: "low effort",
  medium: "medium effort",
  high: "high effort",
  xhigh: "extra high effort",
};

/** A profile in words: "Opus 5.5", or in full "Claude Code · Opus 5.5 · high effort". */
export function profileText(profile: AgentProfile | undefined, find: Lookup, full = false): string {
  if (!profile) return "";
  if (!full) return profile.model;
  return `${find.tool(profile.toolId)?.name ?? profile.toolId} · ${profile.model} · ${EFFORT_LABEL[profile.effort]}`;
}

/** Where delivered work stands, in words, or undefined before delivery. A closed pull request and "Mark as done" deliver nothing. */
export function deliveryText(task: Task): { text: string; done: boolean } | undefined {
  if (task.release) return { text: `Released ${task.release.tag}`, done: true };
  if (task.landed) return { text: `Delivered locally to ${task.landed.branch}`, done: true };
  if (task.pr?.state === "merged") return { text: `Pull request #${task.pr.number} merged`, done: true };
  if (task.pr && (task.pr.state === "closed" || landingOf(task) === "closed")) return { text: `Pull request #${task.pr.number} closed without merging`, done: false };
  if (task.pr) return { text: `Pull request #${task.pr.number} · awaiting merge`, done: false };
  if (landingOf(task) === "marked-done") return { text: "Marked as done · delivery not confirmed", done: false };
  return undefined;
}

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
  grok: "#5b6cff",
  gemini: "#4285f4",
  opencode: "#6b7079",
};

/** Agents waiting on the coordinator while keeping their slot. A step the coordinator is driving is not waiting on them. */
export function blockingCount(state: State): number {
  return state.tasks.filter((task) => task.state === "needs-you" && task.holdsSlot && !task.driving).length;
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
