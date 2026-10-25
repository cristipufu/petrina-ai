import { codexLimits } from "@petrina/core";
import type { UsageInfo } from "./failures.js";

/** Codex's windows as shared usage reports, including named limits and their lengths. */
export function codexReports(result: unknown): UsageInfo[] {
  return codexLimits(result, Date.now()).map(({ at: _at, ...report }) => report);
}
