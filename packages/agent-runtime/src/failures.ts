import type { UsageReport } from "@petrina/core";

/** Public refusal prefix reported by a full model, distinct from account usage. */
export const CAPACITY_WAIT = "The selected model is at capacity";

/** One report from a tool, before the engine stamps it with the time. */
export type UsageInfo = Omit<UsageReport, "at"> & {
  /** Claude's separate paid allowance, not a subscription window. Consumed before storing pool readings. */
  claudeOverage?: "available" | "unavailable";
  /** Both shared windows and a valid explicit model list establish a complete account reading. */
  claudeAccountComplete?: true;
};

/** A turn ended on a usage refusal. `until` is a reset, or a cooldown before retrying. */
export class UsageLimited extends Error {
  constructor(
    readonly toolId: string,
    /** Milliseconds. */
    readonly until: number,
    /** Plain words: "Claude Code's weekly Opus limit". */
    readonly reason: string,
    /** Set when only this model family is out ("opus"). */
    readonly model?: string,
    /** The provider refused a request without reporting a reset; `until` is our retry time. */
    readonly retry?: boolean,
    readonly source: "report" | "refusal" = "refusal",
  ) {
    super(retry ? reason : `${reason} is used up`);
  }

  /** What the agent had said in the turn before it stopped, when its tool lets that through. */
  said?: string;
  /** A billing refusal or account hold is independent of any reported subscription window. */
  independent?: true;
  /** The public text is already saved in the task's live conversation. */
  streamed?: boolean;
}

/**
 * The selected model is full, as the tool's own connector reported it (see provider-interruptions.ts).
 * The account's usage is unchanged. `modelId` covers every effort of that model.
 */
export class ModelAtCapacity extends Error {
  /** What the agent had said in the turn before it stopped. */
  said?: string;
  /** The public text is already saved in the task's live conversation. */
  streamed?: boolean;
  /** Milliseconds the provider named as its own retry delay. Absent when it named none. */
  retryAfterMs?: number;
  constructor(
    readonly toolId: string,
    readonly modelId: string,
    readonly profileId: string,
    readonly sessionId?: string,
  ) {
    super(`${CAPACITY_WAIT}.`);
    this.name = "ModelAtCapacity";
  }
}
