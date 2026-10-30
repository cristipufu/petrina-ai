export type CoordinationOutcome =
  | "completed"
  | "pending"
  | "invalid"
  | "missing"
  | "conflict"
  | "changed"
  | "handled"
  | "timed-out"
  | "failed"
  | "disconnected"
  | "continuity-lost"
  | "superseded"
  | "unavailable";
export interface CoordinationResult {
  outcome: CoordinationOutcome;
  message?: string;
  [key: string]: unknown;
}

export interface LifecycleOperation {
  id: string;
  kind: string;
  phase: "starting" | "draining" | "stopping" | "completed" | "failed";
  scheduling: "paused" | "running";
  version?: string;
  error?: string;
  launcherPid?: number;
}
