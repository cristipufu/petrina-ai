// One bounded readiness recheck before a saved participant's conversation is given up only because its tool's
// last answer was uncertain. Selection decides here; the engine records the wait and runs the shared check.

import type { Id } from "./model.js";
import type { CheckStatus, ToolCheck } from "./setup.js";

/** How long a completed Couldn't check answer stays recent: within it, selection decides without another automatic probe. */
export const READINESS_FRESH_MS = 5 * 60_000;

/**
 * The first time a pending return waited for its saved tool's readiness, kept with that saved conversation. Its
 * presence spends the return's one automatic recheck and anchors its time limit; the next saved continuation replaces it.
 */
export interface ReadinessWait {
  at: number;
  toolId: Id;
  /** The tool's readiness answer before this wait, and when it was given. */
  previous: { status: CheckStatus; at?: number };
  /** Whether this wait started the tool's check or joined one already running. */
  check: "started" | "joined";
}

/** What a bounded recheck found, for the journey: the tool's answer since the wait, or no answer within its limit. */
export interface ReadinessRecheck extends ReadinessWait {
  outcome: CheckStatus | "no answer";
}

/**
 * The decision for a saved participant whose tool readiness alone stands in the way. `wait`: keep the participant
 * pending; `record` when this return has not waited yet (the caller records the wait and starts or joins the check).
 * `fresh`: follow the usual selection, with the reason.
 */
export type ReadinessGate = { kind: "wait"; record: boolean } | { kind: "fresh"; reason: string };

/** An answer that a recheck can change: Couldn't check, or none yet. Logged out and Not installed are real answers. */
export function uncertain(status: CheckStatus | undefined): boolean {
  return status === undefined || status === "unknown" || status === "unchecked";
}

/** The tool answered after this wait began. */
function answeredSince(check: ToolCheck | undefined, wait: ReadinessWait): boolean {
  return !check?.checking && check?.at !== undefined && check.at >= wait.at;
}

/**
 * `settles`: the participant already lets a running ordinary check answer before a permanent fresh start (a returning
 * Builder, a saved stand-in); that protection outlasts the recheck's limit. Otherwise a running check is waited for only
 * within it. Recent Couldn't check answers, and a return that already waited, are never probed again automatically.
 */
export function readinessGate(check: ToolCheck | undefined, wait: ReadinessWait | undefined, now: number, limitMs: number, settles: boolean): ReadinessGate {
  // A check under way may still replace a login or install answer (after the coordinator fixed it): it is joined.
  if (check?.status === "logged-out" && !check.checking) return { kind: "fresh", reason: "its saved tool is logged out" };
  if (check?.status === "not-installed" && !check.checking) return { kind: "fresh", reason: "its saved tool is not installed" };
  if (!wait) {
    const stale = !check || check.status === "unchecked" || check.at === undefined || now - check.at >= READINESS_FRESH_MS;
    if (check?.checking || stale) return { kind: "wait", record: true };
    return { kind: "fresh", reason: "its saved tool's recent readiness check was inconclusive" };
  }
  if (answeredSince(check, wait)) return { kind: "fresh", reason: "its saved tool's readiness recheck was inconclusive" };
  if (now < wait.at + limitMs || (check?.checking && settles)) return { kind: "wait", record: false };
  return { kind: "fresh", reason: "its saved tool did not answer its readiness recheck in time" };
}

/** The result of a recorded wait: the tool's answer since, no answer once the limit passed, or undefined before that. */
export function readinessOutcome(check: ToolCheck | undefined, wait: ReadinessWait, now: number, limitMs: number): ReadinessRecheck | undefined {
  if (answeredSince(check, wait)) return { ...wait, outcome: check!.status };
  return now < wait.at + limitMs ? undefined : { ...wait, outcome: "no answer" };
}
