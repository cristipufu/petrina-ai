import {
  CHECK_LABELS,
  checkOutcome,
  checkOutcomeLabel,
  COLUMNS,
  EFFORT_LABEL,
  landingOf,
  onScreen,
  profileModelName,
  PROVIDER_CATALOG,
  ROLE_RESULT_CATALOG,
  ROLE_RESULTS,
  RUN_STATES,
  SCREEN_WORDS,
  screenOn,
  screenWait,
  slotUses,
  TONES,
  type AgentProfile,
  type CheckRun,
  type CheckStatus,
  type Column,
  type Id,
  type JourneyProductCheck,
  type Role,
  type RoleIcon,
  type RoleResult,
  type RunState,
  type State,
  type Task,
  type Tone,
  type Tool,
} from "@petrina/core";
import { TONE_CATALOG } from "./themes/tones";

export { EFFORT_LABEL } from "@petrina/core";

export function lookup(state: State, task?: Pick<Task, "maintenance" | "direct">) {
  const roles = new Map(state.roles.map((role) => [role.id, role]));
  const profiles = new Map([...(state.retiredProfiles ?? []), ...state.profiles].map((profile) => [profile.id, profile]));
  const tools = new Map(state.tools.map((tool) => [tool.id, tool]));
  const products = new Map(state.products.map((product) => [product.id, product]));
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const finished = new Map(state.history?.dependencies?.map((task) => [task.id, task]) ?? []);
  return {
    role: (id?: Id): Role | undefined =>
      id
        ? task?.maintenance?.role.id === id
          ? task.maintenance.role
          : task?.direct?.role.id === id
            ? task.direct.role
            : roles.get(id)
        : undefined,
    profile: (id?: Id): AgentProfile | undefined =>
      id
        ? task?.maintenance?.profile.id === id
          ? task.maintenance.profile
          : task?.direct?.profile.id === id
            ? task.direct.profile
            : profiles.get(id)
        : undefined,
    tool: (id?: Id): Tool | undefined => (id ? tools.get(id) : undefined),
    product: (id?: Id) => (id ? products.get(id) : undefined),
    task: (id?: Id): Task | undefined => (id ? tasks.get(id) : undefined),
    finishedTask: (id?: Id) => (id ? finished.get(id) : undefined),
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

export interface RunStateDescriptor {
  readonly label: string;
  readonly activityLabel: string;
}

export const RUN_STATE_META: Readonly<Record<RunState, RunStateDescriptor>> = {
  backlog: { label: "Backlog", activityLabel: "Backlog" },
  queued: { label: "Queued", activityLabel: "Queued" },
  waiting: { label: "Waiting for a slot", activityLabel: "Waiting" },
  running: { label: "Working", activityLabel: "Working" },
  "needs-you": { label: "Needs you", activityLabel: "Needs you" },
  paused: { label: "Paused", activityLabel: "Paused" },
  failed: { label: "Failed", activityLabel: "Stuck" },
  "pr-open": { label: "Awaiting merge", activityLabel: "Awaiting merge" },
  done: { label: "Completed", activityLabel: "Done" },
  cancelled: { label: "Cancelled", activityLabel: "Cancelled" },
};

export const STATE_LABEL: Record<RunState, string> = Object.fromEntries(
  RUN_STATES.map((state) => [state, RUN_STATE_META[state].label]),
) as Record<RunState, string>;

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

/** A profile in words: "Opus 5.5", or in full "Claude Code · Opus 5.5 · high effort". */
export function profileText(profile: AgentProfile | undefined, find: Lookup, full = false): string {
  if (!profile) return "";
  if (!full) return profileModelName(profile);
  return `${find.tool(profile.toolId)?.name ?? profile.toolId} · ${profileModelName(profile)} · ${EFFORT_LABEL[profile.effort]}`;
}

/** Where delivered work stands, in words, or undefined before delivery. A closed pull request and "Mark as done" deliver nothing. */
export function deliveryText(task: Task): { text: string; done: boolean } | undefined {
  if (task.release) return { text: `Released ${task.release.tag}`, done: true };
  if (task.landed) {
    return {
      text: task.localUpdate?.pushed ? `Committed to ${task.landed.branch} · pushed to GitHub` : `Delivered locally to ${task.landed.branch}`,
      done: true,
    };
  }
  // A pull request found after you marked the work done does not deliver it.
  if (landingOf(task) === "marked-done") return { text: "Marked as done · delivery not confirmed", done: false };
  if (task.pr?.state === "merged") return { text: `Pull request #${task.pr.number} merged`, done: true };
  if (task.pr && (task.pr.state === "closed" || landingOf(task) === "closed")) {
    return { text: `Pull request #${task.pr.number} closed without merging`, done: false };
  }
  if (task.pr) {
    return {
      text: `${task.source?.start.kind === "pull-request" ? "Updated PR" : "Pull request"} #${task.pr.number} · awaiting merge`,
      done: false,
    };
  }
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

export const TOOL_COLORS: Record<string, string> = Object.fromEntries(
  PROVIDER_CATALOG.map((provider) => [provider.id, `var(--tool-${provider.id}, ${provider.theme.light})`]),
);

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
export const RESULT_WORDS = Object.fromEntries(
  ROLE_RESULTS.map((result) => [result, ROLE_RESULT_CATALOG[result].words]),
) as Record<RoleResult, { label: string; detail: string }>;

export interface ColumnDescriptor {
  readonly label: string;
  /** Short table column heading on the Products portfolio view (omitted for `done`, which has its own Shipped column). */
  readonly pipelineHeading?: string;
}

export const COLUMN_META: Readonly<Record<Column, ColumnDescriptor>> = {
  backlog: { label: "Backlog", pipelineHeading: "Backlog" },
  queue: { label: "Queue", pipelineHeading: "Queue" },
  planning: { label: "Planning", pipelineHeading: "Plan" },
  designing: { label: "Designing", pipelineHeading: "Design" },
  building: { label: "Building", pipelineHeading: "Build" },
  reviewing: { label: "Reviewing", pipelineHeading: "Review" },
  ready: { label: "Delivery", pipelineHeading: "Ready" },
  done: { label: "Done" },
};

/** The stage a task is in while a role works on it, as the Role details panel and Products page name them. */
export const COLUMN_LABEL: Record<Column, string> = Object.fromEntries(
  COLUMNS.map((column) => [column, COLUMN_META[column].label]),
) as Record<Column, string>;

export const PIPELINE_COLUMNS: readonly { readonly column: Column; readonly label: string }[] = COLUMNS.flatMap(
  (column) => {
    const heading = COLUMN_META[column].pipelineHeading;
    return heading ? [{ column, label: heading }] : [];
  },
);

export function emptyColumnCounts(): Record<Column, number> {
  return Object.fromEntries(COLUMNS.map((column) => [column, 0])) as Record<Column, number>;
}

export const TOOL_CHECK_TONE: Readonly<Record<CheckStatus, string>> = {
  ready: "ok",
  "not-installed": "warn",
  "logged-out": "warn",
  unknown: "",
  unchecked: "quiet",
};

export function toolStatusBadge(status: CheckStatus): { readonly label: string; readonly tone: string } {
  return {
    label: status === "unchecked" ? "Checking…" : CHECK_LABELS[status],
    tone: TOOL_CHECK_TONE[status],
  };
}

const JOURNEY_CHECK_META: Readonly<Record<JourneyProductCheck["result"], { readonly label: string; readonly tone: string }>> = {
  pass: { label: "Passed", tone: "ok" },
  fail: { label: "Failed", tone: "bad" },
  "did-not-finish": { label: "Timed out", tone: "bad" },
  running: { label: "Running", tone: "running" },
  pending: { label: "Pending", tone: "" },
  stopped: { label: "Stopped — verification incomplete", tone: "" },
  skipped: { label: "Skipped", tone: "" },
};

export function checkBadge(
  result: JourneyProductCheck["result"],
  options?: { readonly run?: CheckRun; readonly lifecycle?: boolean },
): { readonly label: string; readonly tone: string } {
  const lifecycle = options?.lifecycle ?? true;
  if (result === "stopped" && !lifecycle) {
    const words = options?.run ? checkOutcomeLabel(checkOutcome(options.run)) : undefined;
    return {
      label: words ? words[0]!.toUpperCase() + words.slice(1) : "Unverified — execution details were not recorded",
      tone: "",
    };
  }
  return JOURNEY_CHECK_META[result];
}

export function checkRunBadge(run: CheckRun): {
  readonly label: string;
  readonly tone: string;
  readonly passed: boolean;
  readonly failed: boolean;
} {
  const outcome = checkOutcome(run);
  const passed = outcome.kind === "passed";
  const failed = outcome.kind === "failed";
  const words = checkOutcomeLabel(outcome);
  return {
    label: words[0]!.toUpperCase() + words.slice(1),
    tone: passed ? "ok" : failed ? "bad" : "",
    passed,
    failed,
  };
}

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

export const TONE_NAME: Record<Tone, string> = Object.fromEntries(
  TONES.map((tone) => [tone, TONE_CATALOG[tone].name]),
) as Record<Tone, string>;
