import { ModelAtCapacity, UsageLimited } from "@petrina/agent-runtime/failures";
import { WaitingForCapacity, WaitingForUsage } from "./usage.js";

export function failureReason(error: unknown): "limit" | "agent-stopped" | "unusable" | "other" {
  // A full model waits and retries. It is not the account running out, even though the wait is a kind of WaitingForUsage.
  if (error instanceof WaitingForCapacity || error instanceof ModelAtCapacity) return "other";
  if (error instanceof UsageLimited || error instanceof WaitingForUsage) return "limit";
  const message = error instanceof Error ? error.message : String(error);
  if (/usage limit|rate limit|spend limit|extra usage|limit reached|quota|too many requests|\b429\b/i.test(message)) return "limit";
  if (/usable result/i.test(message)) return "unusable";
  if (/stopped \(exit|agent stopped|stopped \(signal/i.test(message)) return "agent-stopped";
  return "other";
}
