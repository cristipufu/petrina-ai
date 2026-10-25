import { claudeWindow } from "@petrina/core";
import type { UsageInfo } from "./failures.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const validPercent = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

/** Missing account numbers stay missing; native percentages are 0–100, ours are 0–1. */
export function claudeAccountReports(value: unknown): UsageInfo[] {
  const data = object(value);
  if (data.rate_limits_available !== true) return [];
  const limits = object(data.rate_limits);
  const reports: UsageInfo[] = [];
  const add = (kind: string, value: unknown, model?: string) => {
    const window = object(value);
    const percent = window.utilization;
    if (!validPercent(percent)) return;
    const reset = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : NaN;
    const report = claudeWindow({ toolId: "claude-code", kind, ...(model ? { model, name: model, windowMinutes: 10_080 } : {}),
      status: percent >= 100 ? "rejected" : percent >= 90 ? "allowed_warning" : "allowed", utilization: percent / 100,
      ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
    });
    const previous = reports.findIndex(entry => entry.kind === report.kind && entry.model === report.model);
    if (previous >= 0) reports.splice(previous, 1);
    reports.push(report);
  };
  add("five_hour", limits.five_hour);
  add("seven_day", limits.seven_day);
  add("seven_day_opus", limits.seven_day_opus, "opus");
  add("seven_day_sonnet", limits.seven_day_sonnet, "sonnet");
  const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : [];
  for (const entry of scoped) {
    const window = object(entry);
    if (typeof window.display_name === "string" && window.display_name.trim()) add("seven_day_model", window, window.display_name.trim().toLowerCase());
  }
  // A disabled extra-usage balance is not a limit on the subscription's included work.
  const extra = object(limits.extra_usage);
  const percent = extra.utilization;
  if (extra.is_enabled === false || extra.is_enabled === true && typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
    // Native is_enabled means extra usage can cover sends; a valid balance confirms usable continuation.
    for (const report of reports) if (report.status === "rejected") report.overage = extra.is_enabled === true && (percent as number) < 100;
  }
  // A reported model list can be nonempty. Missing or invalid rows cannot establish a
  // complete replacement, but a valid list and both shared windows can retire old groups.
  if (Array.isArray(limits.model_scoped) && scoped.every(entry => {
    const window = object(entry);
    return typeof window.display_name === "string" && !!window.display_name.trim() && validPercent(window.utilization);
  }) && [limits.seven_day_opus, limits.seven_day_sonnet].every(value => value == null || validPercent(object(value).utilization))
    && ["five_hour", "seven_day"].every(kind => reports.some(report => report.kind === kind))) {
    reports[0]!.claudeAccountComplete = true;
  }
  return reports;
}
