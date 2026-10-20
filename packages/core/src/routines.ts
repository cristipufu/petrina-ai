import type { AgentProfile, Id, Product, Role, State, Task } from "./model.js";
import type { DeepMutable } from "./flow.js";
import { displayTask } from "./repositories.js";
import { needsPullRequestCheck } from "./cleanup.js";
import { deliveryStages } from "./library.js";

export type RoutineSchedule = { kind: "daily"; time: string } | { kind: "weekly"; time: string; weekdays: readonly number[] } | { kind: "cron"; expression: string };
export interface RoutineDraft { name: string; productId: Id; roleId: Id; profileId: Id; focus: string; zone: string; schedule: RoutineSchedule; enabled: boolean }
export interface Routine extends RoutineDraft {
  id: Id;
  /** Admission watermark lives independently of task history. Never moved backwards by a tick. */
  handledThrough: number;
  nextAt: number;
  latestTaskId?: Id;
  message?: string;
  blockingTaskId?: Id;
  attention?: string;
}
export interface MaintenanceRun {
  routineId: Id; routineName: string; scheduledAt: number; queuedAt: number; zone: string;
  catchUp?: string; focus: string; role: Role; profile: AgentProfile; input: string;
  product: Product;
  noProductChanges?: boolean;
  readOnlyWrites?: boolean;
  pendingResult?: { stageId: Id; value: unknown };
  pendingReply?: { stageId: Id; text: string; stopReason: string; streamed?: boolean };
  settingsDecision?: { requested: string; actual: string; at: number; choice?: "keep" | "stop" };
}

const copy = <T>(value: T): DeepMutable<T> => JSON.parse(JSON.stringify(value)) as DeepMutable<T>;

type Calendar = { minutes: number[]; hours: number[]; dates: number[]; months: number[]; weekdays: number[]; anyDate: boolean; anyWeekday: boolean };
const fields = [[0, 59, "minutes"], [0, 23, "hours"], [1, 31, "dates"], [1, 12, "months"], [0, 7, "weekdays"]] as const;
function field(text: string, min: number, max: number, name: string): number[] {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`Check the ${name} field: use numbers, lists, ranges or steps.`);
    const step = Number(match[2] ?? 1);
    const range = match[1] === "*" ? [min, max] : match[1]!.split("-").map(Number);
    const start = range[0]!, end = range[1] ?? (match[2] ? max : start);
    if (start < min || end > max || start > end || step < 1 || step > max - min + 1) throw new Error(`The ${name} field needs values from ${min} to ${max}, with a positive step.`);
    for (let n = start; n <= end; n += step) values.add(name === "weekdays" && n === 7 ? 0 : n);
  }
  return [...values].sort((a, b) => a - b);
}
function calendar(schedule: RoutineSchedule): Calendar {
  let expression: string;
  if (schedule.kind === "cron") expression = schedule.expression.trim();
  else {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error("Choose a time from 00:00 to 23:59.");
    const [hour, minute] = schedule.time.split(":").map(Number);
    if (schedule.kind === "weekly" && (!schedule.weekdays.length || schedule.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6))) throw new Error("Choose at least one weekday.");
    expression = `${minute} ${hour} * * ${schedule.kind === "weekly" ? [...new Set(schedule.weekdays)].join(",") : "*"}`;
  }
  const parts = expression.split(/\s+/);
  if (parts.length !== 5) throw new Error("Custom schedules need five fields: minute, hour, date, month and weekday.");
  const values = fields.map(([min, max, name], i) => field(parts[i]!, min, max, name));
  return { minutes: values[0]!, hours: values[1]!, dates: values[2]!, months: values[3]!, weekdays: values[4]!, anyDate: parts[2] === "*", anyWeekday: parts[4] === "*" };
}
function dayMatches(c: Calendar, day: Date): boolean {
  if (!c.months.includes(day.getUTCMonth() + 1)) return false;
  const date = c.dates.includes(day.getUTCDate()), weekday = c.weekdays.includes(day.getUTCDay());
  return c.anyDate ? weekday : c.anyWeekday ? date : date || weekday;
}
function formatter(zone: string): Intl.DateTimeFormat {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { throw new Error("Choose a recognized time zone, such as Europe/Bucharest."); }
}
function localStamp(f: Intl.DateTimeFormat, at: number): number {
  const p = Object.fromEntries(f.formatToParts(at).map(part => [part.type, part.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
}
const DAY = 86_400_000;
/** Calendar iteration avoids scanning millions of minutes for infrequent valid schedules. */
function occurrence(schedule: RoutineSchedule, zone: string, at: number, direction: 1 | -1): number {
  const c = calendar(schedule), f = formatter(zone);
  const today = Math.floor(localStamp(f, at) / DAY) * DAY;
  for (let n = 0; n <= 146_097; n++) { // One full Gregorian cycle, including leap-century rules.
    const day = new Date(today + n * direction * DAY);
    if (!dayMatches(c, day)) continue;
    const offsets = new Set([-2, -1, 0, 1, 2].map(delta => {
      const sample = day.getTime() + delta * DAY + 12 * 3_600_000;
      return localStamp(f, sample) - sample;
    }));
    const hours = direction === 1 ? c.hours : [...c.hours].reverse();
    const minutes = direction === 1 ? c.minutes : [...c.minutes].reverse();
    for (const hour of hours) for (const minute of minutes) {
      const wall = day.getTime() + hour * 3_600_000 + minute * 60_000;
      // No match in a DST gap. Always use the first instant in a repeated local minute.
      const instants = [...offsets].map(offset => wall - offset).filter(candidate => localStamp(f, candidate) === wall);
      if (!instants.length) continue;
      const first = Math.min(...instants);
      if (direction === 1 ? first > at : first <= at) return first;
    }
  }
  throw new Error("This schedule has no possible date. Check the date and month fields.");
}
export const nextOccurrence = (schedule: RoutineSchedule, zone: string, after: number): number => occurrence(schedule, zone, after, 1);
export const latestOccurrence = (schedule: RoutineSchedule, zone: string, at: number): number => occurrence(schedule, zone, at, -1);
export function routinePreview(schedule: RoutineSchedule, zone: string, after: number): number[] {
  const times: number[] = [];
  for (let n = 0; n < 3; n++) times.push(nextOccurrence(schedule, zone, times.at(-1) ?? after));
  return times;
}
export function occurrenceText(at: number, zone: string): string {
  return `${new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(at)} · ${zone} · ${new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find(p => p.type === "timeZoneName")?.value}`;
}
export function frequencyText(schedule: RoutineSchedule): string {
  if (schedule.kind === "daily") return `Daily at ${schedule.time}`;
  if (schedule.kind === "weekly") return `${[...new Set(schedule.weekdays)].sort().map(n => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][n]).join(", ")} at ${schedule.time}`;
  return "Custom schedule";
}
export function routineReferenceProblem(draft: RoutineDraft, state: Pick<State, "products" | "roles" | "profiles">): string | undefined {
  if (!state.products.some(p => p.id === draft.productId)) return "The product was removed. Edit this routine to choose a saved product, or remove it.";
  const role = state.roles.find(r => r.id === draft.roleId && !r.removed);
  if (!role) return "The role was removed. Edit this routine to choose a maintenance role, or remove it.";
  if (role.category !== "maintenance") return "Choose a maintenance role. Workflow roles cannot run from a routine.";
  if (!state.profiles.some(p => p.id === draft.profileId)) return "The saved agent profile is unavailable. Edit the routine to choose an available profile.";
  return undefined;
}
export function saveRoutine(draft: RoutineDraft, state: Pick<State, "products" | "roles" | "profiles">, id: Id, now: number, previous?: Routine): DeepMutable<Routine> {
  const problem = routineReferenceProblem(draft, state);
  if (problem) throw new Error(problem);
  const name = draft.name.trim();
  if (!name || name.length > 100) throw new Error("Give the routine a name of up to 100 characters.");
  if (draft.focus.length > 4000) throw new Error("Keep focus instructions to 4,000 characters.");
  const reset = !previous || (!previous.enabled && draft.enabled) || previous.zone !== draft.zone || JSON.stringify(previous.schedule) !== JSON.stringify(draft.schedule) || !!previous.attention || !!routineReferenceProblem(previous, state);
  const handledThrough = reset ? Math.max(now, previous?.handledThrough ?? now) : previous.handledThrough;
  const nextAt = nextOccurrence(draft.schedule, draft.zone, handledThrough);
  return { name, productId: draft.productId, roleId: draft.roleId, profileId: draft.profileId, focus: draft.focus.trim(), zone: draft.zone, schedule: copy(draft.schedule), enabled: draft.enabled, id, handledThrough, nextAt, ...(previous?.latestTaskId ? { latestTaskId: previous.latestTaskId } : {}), ...(!reset && previous?.message ? { message: previous.message, blockingTaskId: previous.blockingTaskId } : {}) };
}
export function unfinishedRoutineTask(tasks: readonly Task[], routineId: Id): Task | undefined {
  return tasks.find(task => {
    if (task.maintenance?.routineId !== routineId) return false;
    const work = displayTask(task);
    return !["done", "cancelled"].includes(task.state) || work.pr?.state === "open" || !!work.shipping?.step || !!work.shipping?.carriedOver || work.localUpdate?.pushed === false || !!work.cleanup?.foreignPullRequest || needsPullRequestCheck(work);
  });
}

/** Queue intent is a value snapshot, never a pointer into the editable Library. */
export function prepareMaintenanceTask(task: DeepMutable<import("./task-model.js").TaskState>, routine: Routine, state: State, scheduledAt: number, now: number): void {
  const role = state.roles.find(r => r.id === routine.roleId)!, profile = state.profiles.find(p => p.id === routine.profileId)!, product = state.products.find(p => p.id === routine.productId)!;
  const catchUp = now - routine.nextAt >= 60_000 ? "Missed occurrences were combined into this one catch-up task, representing the latest missed time." : undefined;
  const input = `Scheduled maintenance: ${routine.name}\nProduct: ${product.name}\nRole: ${role.name}\nScheduled for: ${occurrenceText(scheduledAt, routine.zone)}\nQueued: ${new Date(now).toISOString()}${catchUp ? `\n${catchUp}` : ""}\nFocus: ${routine.focus || "Use the role's bounded maintenance instructions."}\n${role.instructions}`;
  task.maintenance = copy({ routineId: routine.id, routineName: routine.name, scheduledAt, queuedAt: now, zone: routine.zone, ...(catchUp ? { catchUp } : {}), focus: routine.focus, role, profile, product, input });
  task.description = input;
  task.stageIndex = 0;
  task.approvePlan = false;
  task.approveDelivery = true;
  task.risk = { level: "medium", why: "Maintenance changes require checks, independent review and delivery approval." };
  const available = state.profiles.filter(p => !p.standby && state.tools.some(t => t.id === p.toolId && t.status === "ready"));
  const other = available.filter(p => p.toolId !== profile.toolId);
  const first = other[0] ?? available[0] ?? profile;
  const second = other.find(p => p.toolId !== first.toolId) ?? available.find(p => p.toolId !== first.toolId && p.id !== profile.id) ?? first;
  task.plan = { rationale: "Run the selected maintenance agent directly. Changes receive the normal quality checks and delivery approval.", plannerProfileId: profile.id, stages: [
    { id: `${task.id}:maintenance`, title: role.name, kind: "do", roleId: role.id, profileIds: [profile.id], assignments: [{ profileId: profile.id, by: "coordinator", reason: "Chosen in the saved maintenance routine." }] },
    { id: `${task.id}:review`, title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: [first.id, second.id], assignments: [first, second].map(p => ({ profileId: p.id, by: "engine" as const, reason: "Selected for independent review of maintenance changes." })), maxRounds: 2 },
    ...copy(deliveryStages(task, "opus-high")).map(stage => ({ ...stage, assignments: stage.profileIds.map(profileId => ({ profileId, by: "engine" as const, reason: "Selected by the workflow rules." })) })),
  ] };
}

/** Both callers persist the watermark and new task together before any agent admission. */
export function admitRoutines(state: DeepMutable<State>, now: number, enqueue: (routine: Routine, scheduledAt: number) => Id): boolean {
  let changed = false;
  for (const routine of state.routines ?? []) {
    if (!routine.enabled) continue;
    const attention = routineReferenceProblem(routine, state);
    if (attention !== routine.attention) { routine.attention = attention; changed = true; }
    if (attention || now <= routine.handledThrough || routine.nextAt > now) continue;
    const scheduledAt = latestOccurrence(routine.schedule, routine.zone, now);
    const blocking = unfinishedRoutineTask(state.tasks, routine.id);
    if (blocking) {
      routine.message = "Skipped this occurrence because an earlier run is unfinished. Skipped work will not replay.";
      routine.blockingTaskId = blocking.id;
    } else {
      routine.latestTaskId = enqueue(routine, scheduledAt);
      routine.message = now - routine.nextAt >= 60_000 ? "Missed occurrences were combined into one catch-up task." : "Added the latest occurrence to the Queue.";
      delete routine.blockingTaskId;
    }
    routine.handledThrough = now;
    routine.nextAt = nextOccurrence(routine.schedule, routine.zone, now);
    changed = true;
  }
  return changed;
}
