// Native provider composition; workflow retry schedules and waiting decisions stay with the host.
import { ADAPTERS } from "./tool-catalog.js";
import { createLimitParsing } from "./provider-refusals.js";

export { UsageLimited, ModelAtCapacity, CAPACITY_WAIT } from "./failures.js";
export type { UsageInfo } from "./failures.js";
export { clockTime } from "./provider-refusals.js";
export { CODEX_MODEL_CAPACITY, codexCapacityFailure, codexModelAtCapacity } from "./provider-interruptions.js";
export { claudeReports, claudeReport } from "./claude-usage-report.js";

export const { limitFromReport, limitFromFailure } = createLimitParsing(id => ADAPTERS[id]);
