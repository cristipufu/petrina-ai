import { profileModelName } from "@petrina/core";
import {
  landingOf,
  onScreen,
  SCREEN_WORDS,
  screenOn,
  screenWait,
  slotUses,
  type AgentProfile,
  type Column,
  type Effort,
  type Id,
  type Role,
  type RoleIcon,
  type RoleResult,
  type RunState,
  type State,
  type Task,
  type Tone,
  type Tool
} from "@petrina/core";

export function lookup(state: State, task?: Pick<Task, "maintenance">) {
  const roles = new Map(state.roles.map((role) => [role.id, role]));
  const profiles = new Map([...(state.retiredProfiles ?? []), ...state.profiles].map((profile) => [profile.id, profile]));
  const tools = new Map(state.tools.map((tool) => [tool.id, tool]));
  const products = new Map(state.products.map((product) => [product.id, product]));
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const finished = new Map(state.history?.dependencies?.map((task) => [task.id, task]) ?? []);
  return {
    role: (id?: Id): Role | undefined => (id ? task?.maintenance?.role.id === id ? task.maintenance.role : roles.get(id) : undefined),
    profile: (id?: Id): AgentProfile | undefined => (id ? task?.maintenance?.profile.id === id ? task.maintenance.profile : profiles.get(id) : undefined),
    tool: (id?: Id): Tool | undefined => (id ? tools.get(id) : undefined),
    product: (id?: Id) => (id ? products.get(id) : undefined),
    task: (id?: Id): Task | undefined => (id ? tasks.get(id) : undefined),
    finishedTask: (id?: Id) => id ? finished.get(id) : undefined,
  };
}

export type Lookup = ReturnType<typeof lookup>;

/** Preserve every seat, including two helpers using the same role and profile. */
export function agentSlots(state: State, find: Lookup) {
  const positions = new Map<string, number>();
  return slotUses(state).map((use, index) => {
    const task = find.task(use.taskId);
    const position = positions.get(use.taskId) ?? 0;
    positions.set(use.taskId, position + 1);
    const agent = position === 0 ? task?.agent : task?.helpers?.[position - 1];
    const work = agent?.reviewKey ? task?.hunt?.work?.[agent.reviewKey] : undefined;
    return { ...use, task, agent, work, key: `${use.taskId}:${use.profileId ?? "unknown"}:${index}` };
  });
}

export const STATE_LABEL: Record<RunState, string> = {
  backlog: "Backlog",
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

/** A task's state in words. A task waiting for the screen says so instead of waiting for a slot. */
export function stateLabel(task: Task, state: State): string {
  return screenWait(task, state, state.now) ? SCREEN_WORDS.flag : STATE_LABEL[task.state];
}

/**
 * What the top bar's screen mark says: an agent is on the screen, or agents may use it. Nothing when
 * the switch is off and nobody is on the screen.
 */
export function screenMark(state: State): { label: string; inUse: boolean } | undefined {
  if (onScreen(state.tasks)) return { label: "An agent is using the screen", inUse: true };
  if (screenOn(state.pool, state.now)) return { label: "Agents may use the screen", inUse: false };
  return undefined;
}

/** A time of day, for "On until 15:40". */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const EFFORT_LABEL: Record<Effort, string> = {
  ultra: "ultra effort",
  low: "low effort",
  medium: "medium effort",
  high: "high effort",
  xhigh: "extra high effort",
};

/** A profile in words: "Opus 5.5", or in full "Claude Code · Opus 5.5 · high effort". */
export function profileText(profile: AgentProfile | undefined, find: Lookup, full = false): string {
  if (!profile) return "";
  if (!full) return profileModelName(profile);
  return `${find.tool(profile.toolId)?.name ?? profile.toolId} · ${profileModelName(profile)} · ${EFFORT_LABEL[profile.effort]}`;
}

/** Where delivered work stands, in words, or undefined before delivery. A closed pull request and "Mark as done" deliver nothing. */
export function deliveryText(task: Task): { text: string; done: boolean } | undefined {
  if (task.release) return { text: `Released ${task.release.tag}`, done: true };
  if (task.landed) return {
    text: task.localUpdate?.pushed ? `Committed to ${task.landed.branch} · pushed to GitHub` : `Delivered locally to ${task.landed.branch}`,
    done: true
  };
  // A pull request found after you marked the work done does not deliver it.
  if (landingOf(task) === "marked-done") return { text: "Marked as done · delivery not confirmed", done: false };
  if (task.pr?.state === "merged") return { text: `Pull request #${task.pr.number} merged`, done: true };
  if (task.pr && (task.pr.state === "closed" || landingOf(task) === "closed")) return {
    text: `Pull request #${task.pr.number} closed without merging`,
    done: false
  };
  if (task.pr) return {
    text: `${task.source?.start.kind === "pull-request" ? "Updated PR" : "Pull request"} #${task.pr.number} · awaiting merge`,
    done: false
  };
  if (landingOf(task) === "no-changes") return { text: "Completed · No product changes", done: true };
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
  antigravity: "var(--tool-antigravity)",
  "claude-code": "#d97757",
  codex: "#10a37f",
  grok: "#5b6cff",
  gemini: "#4285f4",
  opencode: "var(--tool-opencode)",
  pi: "var(--tool-pi)",
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

/** What each kind of result is, in the Library's words. */
export const RESULT_WORDS: Record<RoleResult, { label: string; detail: string }> = {
  plan: { label: "A plan", detail: "The steps for the task, with a reason for each." },
  notes: { label: "Notes", detail: "A summary and a list that every later agent on the task reads." },
  brief: { label: "A design brief", detail: "What changes for users, the parts that change, an acceptance checklist and risks." },
  objections: { label: "Objections", detail: "Each one blocking or not. The architect answers every one." },
  build: { label: "A change ready for review", detail: "With a plain-language summary that goes into the pull request." },
  checks: { label: "Pass or fail per acceptance item", detail: "Failed checks go back to the builder." },
  findings: { label: "Pass-or-fail findings", detail: "It joins the review next to the code reviewers. Its blocking findings go back to the builder." },
  delivery: { label: "Release notes", detail: "Notes for a release that Petrina publishes itself." },
  "check-discovery": { label: "Product checks", detail: "The checks Petrina runs on the work." },
  guide: { label: "Review guide point", detail: "A proposed point to help future reviews." },
  votes: { label: "Verdicts on findings", detail: "An independent check of important findings." },
};

/** The stage a task is in while a role works on it, as the Products page counts them. */
export const COLUMN_LABEL: Record<Column, string> = {
  backlog: "Backlog",
  queue: "Queue",
  planning: "Planning",
  designing: "Designing",
  building: "Building",
  reviewing: "Reviewing",
  ready: "Delivery",
  done: "Done",
};

export const ICON_NAME: Record<RoleIcon, string> = {
  lightbulb: "Light bulb",
  shield: "Shield",
  pen: "Pen",
  megaphone: "Megaphone",
  chart: "Chart",
  globe: "Globe",
  users: "People",
  bug: "Bug",
  book: "Book",
  compass: "Compass",
  scale: "Scales",
  palette: "Palette",
  hammer: "Hammer",
  flask: "Flask",
  search: "Magnifier",
  map: "Map",
  rocket: "Rocket",
};

export const TONE_NAME: Record<Tone, string> = {
  blue: "Blue",
  teal: "Teal",
  green: "Green",
  orange: "Orange",
  amber: "Amber",
  pink: "Pink",
  purple: "Purple",
  violet: "Violet",
  indigo: "Indigo",
  slate: "Slate",
};
