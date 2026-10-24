import type { JourneyStep } from "./model.js";
import type { RepositoryState, Task } from "./task-model.js";

/** The same bounded navigation contract is read from live tasks and archived SQLite rows. */
export const EVIDENCE_TASK_LIMIT = 24;
export const EVIDENCE_STEP_LIMIT = 64;

export type CheckEvidenceStep = Pick<JourneyStep, "id" | "kind" | "startedAt" | "endedAt" | "end" | "productChecks" | "checkAttempts" | "checkRepairs" | "checkReviews" | "buildVersions" | "buildProductId">;

export interface CheckEvidenceTask {
  id: string;
  state: Task["state"];
  held?: boolean;
  journey: readonly CheckEvidenceStep[];
  delivery?: RepositoryState["confirmedDelivery"];
}
