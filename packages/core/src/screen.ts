// "Agents may use the screen": the rules the engine, the simulator and the UI share.
// Agents work in the background. One that needs the running app on screen asks, and the engine
// decides: the screen goes to one agent at a time, first asked, first served, and only when the
// switch, the task's own allowance or the coordinator's Allow now lets it.

import type { Id, Pool, ScreenMode, State, Task } from "./model.js";

export const SCREEN_HOUR_MS = 60 * 60_000;

/** The switch as it stands at `now`: For an hour that ran out is Off. */
export function screenMode(pool: Pool, now: number): ScreenMode {
  const screen = pool.screen;
  if (!screen) return "off";
  if (screen.mode === "hour") return (screen.until ?? 0) > now ? "hour" : "off";
  return screen.mode;
}

/** Screen use is on: On, or For an hour before it runs out. */
export function screenOn(pool: Pool, now: number): boolean {
  return screenMode(pool, now) !== "off";
}

/** May this task's screen request go ahead: the switch, the task's own allowance, or Allow now. */
export function screenAllowed(task: Task, pool: Pool, now: number): boolean {
  return screenOn(pool, now) || task.screenAllowed === true || task.screen?.allowed === true;
}

/** The task whose agent is on the screen. It keeps it until its step ends. */
export function onScreen(tasks: readonly Task[]): Task | undefined {
  return tasks.find((task) => task.screen?.granted);
}

/** Requests still waiting for the screen, first asked first. */
export function screenQueue(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => (task.state === "waiting" || task.state === "needs-you") && task.screen && !task.screen.granted).sort((a, b) => a.screen!.at - b.screen!.at);
}

/** The request that gets the screen next: the earliest allowed one, once nobody is on the screen. */
export function screenNext(state: State, now: number): Id | undefined {
  if (onScreen(state.tasks)) return undefined;
  return screenQueue(state.tasks).find((task) => screenAllowed(task, state.pool, now))?.id;
}

/** As far as the screen goes, the task's next agent may start. */
export function screenReady(task: Task, state: State, now: number): boolean {
  return !task.screen || task.screen.granted === true || screenNext(state, now) === task.id;
}

/**
 * Why a task waits for the screen: "ask" until the coordinator allows it, "turn" while another
 * agent is on the screen (or asked first). Undefined when it does not wait for the screen.
 */
export function screenWait(task: Task, state: State, now: number): "ask" | "turn" | undefined {
  if ((task.state !== "waiting" && task.state !== "needs-you") || !task.screen || task.screen.granted) return undefined;
  if (!screenAllowed(task, state.pool, now)) return "ask";
  return screenNext(state, now) === task.id ? undefined : "turn";
}

/** The agent's reason as the app keeps it: one line, short. */
export function screenReason(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 159).trimEnd()}…` : line;
}

/** The words the engine and the simulator both use. */
export const SCREEN_WORDS = {
  flag: "Waiting for the screen",
  needs: (reason: string) => `Needs the screen for: ${reason}`,
  turn: "Waiting its turn on the screen",
  asked: (reason: string) => `Asked for the screen: ${reason}`,
  using: (reason: string) => `Using the screen for: ${reason}`,
  pickedUp: "Picked up where it left off, now using the screen",
  body: "It did what it could in the background. Allow now lets it run the app on your screen and click through it, one agent at a time. It closes what it opens when it is done.",
  allowedNow: "You allowed the screen for this request",
  taskOn: "You allowed the screen for this task",
  taskOff: "You no longer allow the screen for this task",
} as const;
