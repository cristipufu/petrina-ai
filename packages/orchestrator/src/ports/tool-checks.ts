import type { CheckId, CheckStatus, ToolCheck } from "@petrina/core";

/** A probe's observation, never an inference from the tool's previous status. */
export interface ToolProbeResult {
  status: CheckStatus;
  account?: string;
  detail?: string;
}

export interface ToolProbeRequest {
  signal: AbortSignal;
  /** Register owned cleanup before returning. Only fulfillment confirms that ownership ended. */
  onGone(gone: Promise<void>): void;
}

/** The native host or a scripted fixture owns installation lookup and actual probing. */
export interface ToolProbe {
  absent(id: CheckId): boolean;
  run(id: CheckId, request: ToolProbeRequest): Promise<ToolProbeResult>;
}

export interface ToolCheckHost {
  stopped(): boolean;
  current(id: CheckId): ToolCheck;
  /** Publish and persist one complete observation, or the previous result marked as checking. */
  publish(check: ToolCheck): void;
}

export interface ToolCheckClock {
  now(): number;
  /** Settle on deadline or abort, releasing the owned deadline in either case. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
}
