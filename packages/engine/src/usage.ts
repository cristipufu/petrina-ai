// Workflow policy for provider limits and model-capacity waits; native refusals are adapter-owned.
import { untilWords, type AgentProfile } from "@petrina/core";
import { CAPACITY_WAIT, type ModelAtCapacity } from "@petrina/agent-runtime/failures";

/** How long the same conversation waits after the short retries, when nothing else can take the step. */
export const MODEL_CAPACITY_WAIT_MS = 5 * 60_000;

/**
 * Same-conversation retries before anyone else takes the step: five seconds, then ten, then thirty.
 * A later stop uses the five-minute wait instead of starting this schedule over.
 */
export const CAPACITY_RETRY_DELAYS_MS = [5_000, 10_000, 30_000] as const;

/**
 * How long to wait before the next same-conversation continue. `tried` is how many continues were already sent.
 * Undefined once those retries are used up. An explicit provider delay waits at least that long.
 */
export function capacityRetryDelay(tried: number, providerMs?: number): number | undefined {
  const slot = CAPACITY_RETRY_DELAYS_MS[tried];
  if (slot === undefined) return undefined;
  return Math.max(slot, providerMs ?? 0);
}

/** What the task says while it waits to try the same model again. */
export function capacityWaiting(until: number, now: number): string {
  return `${CAPACITY_WAIT}. Trying again after ${untilWords(until, now)}`;
}

/** Whether this profile is one effort of the model that just filled up. */
export function sameCapacityModel(error: ModelAtCapacity, profile: Pick<AgentProfile, "toolId" | "model" | "modelId">): boolean {
  return error.toolId === profile.toolId && error.modelId === (profile.modelId ?? profile.model);
}

/** Nobody can work the step until a limit ends: the task waits, and the driver lets go of it quietly. */
export class WaitingForUsage extends Error {
  /** What the task's status line says. */
  constructor(readonly words: string) {
    super(words);
  }
}

/** The selected model is full and nothing else can take the step. The task waits, then retries that same profile. */
export class WaitingForCapacity extends WaitingForUsage {
  constructor(words: string) {
    super(words);
    this.name = "WaitingForCapacity";
  }
}

/** The wait a choice with nobody to work named: a full model's, or a usage or seat wait, including when the account is out as well. */
export function waitingFor(words: string): WaitingForUsage {
  return words.startsWith(CAPACITY_WAIT) ? new WaitingForCapacity(words) : new WaitingForUsage(words);
}
