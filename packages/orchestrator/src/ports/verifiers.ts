import type { AgentProfile, Finding, Id, Role, Stage, VerifierPanel, VerifierSeat, Vote } from "@petrina/core";
import type { RuntimeTask } from "../model.js";

/** The actual selector's answer, without its native readiness objects or presentation parsing. */
export type VerifierResolution =
  | { kind: "selected"; profile: Pick<AgentProfile, "id" | "toolId"> }
  | { kind: "capacity" | "unavailable"; waiting: string };

/** Findings and exact saved places owed by the next phase; no process is admitted by this decision. */
export interface PendingVerification {
  findings: readonly Finding[];
  seats: VerifierSeat[];
  voters: Id[];
  phase?: VerifierSeat[];
  panel?: VerifierPanel;
  third?: boolean;
}

/** Validated provider output, independent of a schema library or ACP payload. */
export type VerifierVerdict = Pick<Vote, "verdict" | "reason"> & { id: Id };
export interface VerifierAnswerSource {
  profileId: Id;
  plannedProfileId: Id;
  place: VerifierSeat;
  findingIds: readonly Id[];
}

/** Current identity/wording queries; missing historical identity stays unknown. */
export interface VerifierCatalog {
  profile(id: Id): Pick<AgentProfile, "id" | "toolId"> | undefined;
  profileName(id: Id): string;
  toolName(id: Id): string;
  roleResult(id: Id, task: RuntimeTask): Role["result"] | undefined;
}

/** Selection owns readiness, usage and available profiles; this does not start or reserve an agent. */
export interface VerifierSelection {
  candidates(stage: Stage): readonly Id[];
  resolve(task: RuntimeTask, profileId: Id): VerifierResolution | undefined;
  admissionsClosed(task: RuntimeTask): boolean;
}

/** Every mutation/record remains bound to the same task. No Git, agent or database handle crosses it. */
export interface VerifierRecording {
  checkpoint(task: RuntimeTask): void;
  changed(task: RuntimeTask): void;
  note(task: RuntimeTask, tone: "milestone" | "warn" | "done", text: string): void;
  now(): number;
}
