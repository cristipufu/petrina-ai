import type { UsageReport } from "./model.js";

/** One report from a tool, before the engine stamps it with the time. */
export type UsageInfo = Omit<UsageReport, "at"> & {
  /** Claude's separate paid allowance, not a subscription window. Consumed before storing pool readings. */
  claudeOverage?: "available" | "unavailable";
  /** Both shared windows and a valid explicit model list establish a complete account reading. */
  claudeAccountComplete?: true;
};
