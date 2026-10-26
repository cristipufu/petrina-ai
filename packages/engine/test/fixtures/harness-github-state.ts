import type { LeasedProgramRecord } from "@petrina/test-support/leased-program-records";
import type { ChildState } from "@petrina/platform/process-tree";

export const GH_ATTEMPT = "PETRINA_TEST_GH_ATTEMPT", GH_REGISTRATION_GATE = "PETRINA_TEST_GH_REGISTRATION_GATE";
export interface GitHubStart {
  id: string;
  state: "entered" | "start-unknown" | "started" | "exited" | "exit-unknown";
  pid?: number;
  code?: number;
}
export interface GitHubLink { attempt: string; actor: string; pid: number }
export type GitHubSettlement = { kind: "settled" } | { kind: "pending" } | { kind: "uncertain"; reason: string };

/** Disposal facts only; no GH answer, command success or saved PID stop authority is derived here. */
export function githubSettlement(starts: readonly GitHubStart[], actors: readonly LeasedProgramRecord[], links: readonly GitHubLink[],
  native: ReadonlyMap<number, ChildState>, uncertain: ReadonlySet<string>): GitHubSettlement {
  if (new Set(starts.map(start => start.id)).size !== starts.length) return { kind: "uncertain", reason: "Duplicate native GitHub start identity" };
  for (const start of starts) {
    if (!start.id || !["entered", "start-unknown", "started", "exited", "exit-unknown"].includes(start.state))
      return { kind: "uncertain", reason: "Malformed native GitHub start" };
    if (start.state === "entered" || start.state === "start-unknown" || start.state === "exit-unknown")
      return { kind: "uncertain", reason: "Native GitHub start or exit was not confirmed" };
    if (!Number.isSafeInteger(start.pid) || start.pid! <= 0) return { kind: "uncertain", reason: "Native GitHub start has no actual returned PID" };
    if (start.state === "exited" && (!Number.isSafeInteger(start.code) || start.code! < 0))
      return { kind: "uncertain", reason: "Native GitHub exit was not reported" };
  }
  for (const actor of actors) {
    const linked = links.filter(link => link.actor === actor.id && link.pid === actor.pid);
    if (!linked.length && starts.some(start => start.pid === actor.pid)) return { kind: "pending" };
    if (linked.length !== 1 || !starts.some(start => start.id === linked[0]!.attempt && start.pid === actor.pid))
      return { kind: "uncertain", reason: "GitHub actor has no matching actual native start" };
  }
  for (const link of links) {
    if (!starts.some(start => start.id === link.attempt && start.pid === link.pid)) return { kind: "uncertain", reason: "GitHub registration does not match its native start" };
    if (!actors.some(actor => actor.id === link.actor && actor.pid === link.pid)) return { kind: "pending" };
  }
  for (const start of starts) {
    const linked = links.filter(link => link.attempt === start.id);
    if (!linked.length) return { kind: "pending" };
    if (linked.length !== 1) return { kind: "uncertain", reason: "Duplicate GitHub registration" };
    const actor = actors.find(actor => actor.id === linked[0]!.actor)!;
    if (uncertain.has(actor.id)) return { kind: "uncertain", reason: "GitHub native work did not confirm cleanup" };
    if (actor.state !== "ended") return { kind: "pending" };
    if (actor.code !== 0 && actor.code !== 1) return { kind: "uncertain", reason: "GitHub helper did not finish its own work naturally" };
    if (native.get(start.pid!) !== "ended") return { kind: "pending" };
  }
  return { kind: "settled" };
}
