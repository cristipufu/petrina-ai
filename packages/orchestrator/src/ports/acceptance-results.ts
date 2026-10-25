import type { Id } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";

/** Normalized consumed output. Schema/provider envelopes and native cleanup stay outside this owner. */
export interface AcceptanceObservation {
  text: string;
  result: "pass" | "fail" | "blocked";
  productIds?: readonly Id[];
  evidence?: string;
  reason?: string;
}
export interface AcceptanceProofAnswer { id: Id; result: "pass" | "fail" | "blocked"; evidence?: string; reason?: string }
export type AcceptanceLearning = string | { productId: Id; text: string };
export interface AcceptanceReply { summary: string; checks: readonly AcceptanceObservation[]; proofAnswers: readonly AcceptanceProofAnswer[]; learnings: readonly AcceptanceLearning[] }
export interface AcceptanceResultInput {
  roleId: Id; profileId: Id; report: AcceptanceReply;
  run: NonNullable<RuntimeTask["acceptanceRun"]>;
  testedVersions: Readonly<Record<Id, string>>;
  currentVersions: Readonly<Record<Id, string>>;
}
/** Native effects keep their precise existing positions between accepted-record mutations. */
export interface AcceptanceResultHost {
  id(task: RuntimeTask): Id;
  now(): number;
  note(scope: RepositoryContext, tone: "warn" | "done", text: string, roleId: Id, profileId: Id): void;
  noteLearnings(scope: RepositoryContext, lessons: readonly AcceptanceLearning[], roleId: Id, profileId: Id): Promise<void>;
  acceptancePatch(scope: RepositoryContext, testedVersions: Readonly<Record<Id, string>>): Promise<string | undefined>;
}
