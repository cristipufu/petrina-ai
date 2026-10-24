import type { Id, ReviewEvidenceInput, Role, Stage } from "@petrina/core";
import type { RuntimeTask } from "../model.js";

/** Parsed observations, independent of provider messages, schema libraries and native sessions. */
export interface ReviewReport extends ReviewEvidenceInput {
  verdict: "pass" | "fail";
  findings: readonly {
    text: string;
    severity: "important" | "nit" | "pre-existing";
    productIds?: readonly Id[];
    where?: string;
    evidence?: string;
    steps?: string;
    sameBug?: string;
  }[];
}

/** Native admission and durable recording remain with the host, bound to this task and participant. */
export interface ReviewReportHost {
  roles(): readonly Role[];
  hasPendingReviewers(task: RuntimeTask, stage: Stage): boolean;
  id(task: RuntimeTask): Id;
  now(): number;
  verdict(task: RuntimeTask, roleId: Id, profileId: Id, round: number, verdict: ReviewReport["verdict"], count: number, blocking: number): void;
  note(task: RuntimeTask, tone: "warn" | "done", text: string, roleId: Id, profileId: Id): void;
}
