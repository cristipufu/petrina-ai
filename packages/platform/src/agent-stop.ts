import { pausedOrGone, ProcessObservations, readObservation, type ProcessListRead } from "./process-observations.js";
import { parseDescendants, stoppedProcessStates, type ObservedProcess } from "./process-snapshots.js";

export type AgentStopSignal = "SIGSTOP" | "SIGCONT" | "SIGTERM" | "SIGKILL";
export interface AgentStopTarget {
  readonly pid?: number;
  /** The adapter's actual, current native exit record, not a process-list inference. */
  running(): boolean;
}
export interface StopDiagnostic {
  stage: "graceful" | "forced";
  elapsedMs: number;
  lists: ("read" | "unreadable")[];
  processes: ObservedProcess[];
}
export interface StopConfirmationEffects {
  now(): number;
  sleep(ms: number): Promise<unknown>;
  /** Final confirmation conservatively retains every non-ESRCH native observation error. */
  possiblyPresent(target: number): boolean;
  readGroups: ProcessListRead;
  readonly selfPid: number;
}
export interface AgentStopEffects extends StopConfirmationEffects {
  /** Existing ownership-presence semantics distinguish EPERM from other native errors. */
  alive(target: number): boolean;
  signal(target: number, signal: AgentStopSignal): void;
  readParents: ProcessListRead;
  incomplete?(facts: StopDiagnostic): void;
}

const POLL_INTERVAL_MS = 50;
const FORCE_STOP_DEADLINE_MS = 6_000;
const RESCAN_BUDGET_MS = 3_200;
const INITIAL_COLLECT_BUDGET_MS = 4_800;
const COLLECT_READ_TIMEOUTS_MS = [4_000, 4_000, 4_000, 4_000, 4_000, 4_000, 4_000, 4_000] as const;
const MIN_GRACE_LEFT_MS = 500;
const FINAL_CONFIRMATION_MS = 1_000;

/** The actual stop policy, with all clocks, process observations and signal delivery supplied by its adapter. */
export async function stopAgentPrograms(target: AgentStopTarget, graceMs: number, collectPrograms: boolean, effects: AgentStopEffects): Promise<boolean> {
  if (target.pid === undefined) return true;
  const pid = target.pid;
  const send = (pids: readonly number[], signal: AgentStopSignal) => {
    for (const target of pids) try { effects.signal(target, signal); } catch { /* Already gone. */ }
  };
  const exited = async (pids: readonly number[], ms: number) => {
    for (const end = effects.now() + ms; effects.now() < end; await effects.sleep(POLL_INTERVAL_MS)) if (!pids.some(target => effects.alive(target))) return true;
    return !pids.some(target => effects.alive(target));
  };
  const forceBy = effects.now() + FORCE_STOP_DEADLINE_MS;
  const rescanBudget = collectPrograms ? RESCAN_BUDGET_MS : 0;
  const started = effects.now();
  const lists: ("read" | "unreadable")[] = [];
  let stage: StopDiagnostic["stage"] = "graceful";
  let remaining: ObservedProcess[] = [];
  const confirmed = (result: boolean) => {
    if (!result) effects.incomplete?.({ stage, elapsedMs: effects.now() - started, lists, processes: remaining });
    return result;
  };
  let complete = true;
  let pids = [pid];
  let paused = false;
  const resume = () => {
    if (!paused) return;
    send([-pid, ...pids], "SIGCONT");
    paused = false;
  };
  const observations = new ProcessObservations(() => effects.now());
  const collect = async (budget: number) => {
    const owners: number[] = [];
    const workers = await observations.descendantsKnown(owners, budget, async timeout => {
      const attemptStarted = effects.now();
      paused = true;
      owners.splice(0, owners.length, ...pids.filter(target => effects.alive(target)));
      send([-pid, ...pids], "SIGSTOP");
      const stdout = await effects.readParents(timeout);
      if (stdout !== undefined) {
        const found = parseDescendants(stdout, owners);
        send(found, "SIGSTOP");
        pids = [...new Set([...pids, ...found])];
      }
      if ((stdout === undefined || !pausedOrGone(stdout, owners)) && effects.now() - attemptStarted < POLL_INTERVAL_MS) {
        await effects.sleep(POLL_INTERVAL_MS);
      }
      return stdout;
    }, COLLECT_READ_TIMEOUTS_MS, true);
    lists.push(workers === undefined ? "unreadable" : "read");
    if (workers === undefined) complete = false;
  };
  try {
    if (collectPrograms && target.running()) await collect(INITIAL_COLLECT_BUDGET_MS);
    send([-pid], "SIGTERM");
    send(pids, "SIGTERM");
    resume();
    const graceLeft = Math.max(MIN_GRACE_LEFT_MS, forceBy - rescanBudget - effects.now());
    if (await exited([-pid, ...pids], Math.min(graceMs, graceLeft, Math.max(0, forceBy - effects.now())))) return confirmed(complete);
    stage = "forced";
    if (collectPrograms) await collect(Math.min(rescanBudget, Math.max(0, forceBy - effects.now())));
    pids = pids.filter(target => effects.alive(target));
    send([-pid], "SIGKILL");
    send(pids, "SIGKILL");
    const final = await confirmStoppedProcesses([-pid, ...pids], FINAL_CONFIRMATION_MS, effects);
    remaining = final.processes;
    return confirmed(final.ended && complete);
  } finally { resume(); }
}

/** Existing final-list timing and defunct interpretation, independent of native process APIs. */
export async function confirmStoppedProcesses(targets: readonly number[], ms: number, effects: StopConfirmationEffects): Promise<{
  ended: boolean;
  processes: ObservedProcess[]
}> {
  const end = effects.now() + ms;
  const from = effects.now() + ms / 4;
  let listing: Promise<string | undefined> | undefined;
  for (; effects.now() < end; await effects.sleep(POLL_INTERVAL_MS)) {
    if (!targets.some(target => effects.possiblyPresent(target))) return { ended: true, processes: [] };
    listing ??= effects.now() >= from ? readObservation(timeout => effects.readGroups(timeout), Math.max(POLL_INTERVAL_MS, end - effects.now())) : undefined;
  }
  const present = targets.filter(target => effects.possiblyPresent(target));
  if (!present.length) return { ended: true, processes: [] };
  return stoppedProcessStates(await listing, present, effects.selfPid);
}
