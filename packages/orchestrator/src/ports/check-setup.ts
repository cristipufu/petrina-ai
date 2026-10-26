import type { CheckEnvironmentIdentity, CheckExecutorFacts, CheckPrerequisite, CheckRun, CheckSetupAttempt, CheckSetupInput } from "@petrina/core";

export interface CheckSetupRequest {
  id: string;
  productId: string;
  queuedAt: number;
  position: CheckSetupAttempt["position"];
  input: CheckSetupInput;
  requirements: readonly CheckPrerequisite[];
}

export type CheckSetupExecution =
  | { kind: "recorded"; run: CheckRun }
  | { kind: "not-started"; reason: "cancelled" | "admission-lost" | "inputs-changed" };

/** Admission, credential-free native commands and source restoration belong to the composing host. */
export interface CheckSetupHost {
  now(): number;
  executor(): { kind: "observed"; facts: CheckExecutorFacts } | { kind: "unavailable"; message: string };
  execute(requirement: CheckPrerequisite, signal: AbortSignal): Promise<CheckSetupExecution>;
  finish(attempt: CheckSetupAttempt, activity: "none" | "commands"): Promise<Pick<CheckSetupAttempt, "afterInput" | "restoration" | "observationFailure">>;
  identity(attempt: CheckSetupAttempt): CheckEnvironmentIdentity;
  changed(attempt: CheckSetupAttempt): void;
}
