import type { CheckRun } from "./model.js";

/** Extra evidence is deliberately outside product-check evidence and every delivery gate. */
export interface ExtraValidation {
  id: string;
  requestId: string;
  taskId: string;
  productId: string;
  productName: string;
  repository: string;
  source: string;
  nodeId?: string;
  name: string;
  reason: string;
  image: string;
  argv: readonly string[];
  commit: string;
  tree: string;
  versionNote: string;
  workingEdits: boolean;
  host: { system: string; arch: string };
  container?: { tool: string; endpoint: string; service: string; imageId: string; os: string; arch: string };
  containerName: string;
  owner: string;
  snapshot: string;
  clientPid?: number;
  state: "queued" | "preparing" | "running" | "stopping" | "held" | "finished";
  result?: "passed" | "failed" | "did not finish" | "stopped" | "not run";
  detail?: string;
  cleanupDetail?: string;
  /** A crash interrupted only snapshot preparation; execute once after cleanup. */
  resumeQueued?: boolean;
  queuedAt: number;
  startedAt?: number;
  stoppingAt?: number;
  endedAt?: number;
  waitingMs?: number;
  durationMs?: number;
  /** Place when joining the shared line; absent while deferred for prerequisites. */
  queuePosition?: number;
  waitingReason?: string;
  /** Shared queue arrival order, retained through pre-execution recovery. */
  queueOrder: number;
  run?: CheckRun;
}
