// Workflow policy for provider limits and model-capacity waits; native refusals are adapter-owned.
import { capacityWaitingWords } from "@petrina/orchestrator";
export { MODEL_CAPACITY_WAIT_MS, CAPACITY_RETRY_DELAYS_MS, capacityRetryDelay, sameCapacityModel } from "@petrina/orchestrator";
import { CAPACITY_WAIT } from "@petrina/agent-runtime/failures";

/** What the task says while it waits to try the same model again. */
export function capacityWaiting(until: number, now: number): string {
  return capacityWaitingWords(until, now, CAPACITY_WAIT);
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
