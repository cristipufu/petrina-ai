// Bounded account-history views, shared by the engine and simulator. Source reports stay intact.
import type { UsageReport } from "./model.js";
import type { Bucket } from "./charts.js";
import { claudeWindow, kindWords } from "./usage.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
export const READING_PAGE_SIZE = 20;
export const MAX_READING_OFFSET = 100_000;

export interface LimitBucket extends Bucket {
  highest?: number;
  highestAt?: number;
  reports: number;
  numericCount: number;
  possibleResets: number;
  statuses: string[];
  firstAt?: number;
  future: boolean;
}
export interface AllowanceHistory {
  key: string;
  label: string;
  current: boolean;
  windowMinutes: number;
  latest: UsageReport;
  /** Earliest retained reading of this allowance, across the available history. */
  firstAt: number;
  buckets: LimitBucket[];
}
export interface LimitsOverTime {
  from: number;
  to: number;
  now: number;
  hourly: boolean;
  buckets: Bucket[];
  tools: { toolId: string; label: string; limits: AllowanceHistory[] }[];
}
export interface ReadingsRequest {
  view: "readings";
  toolId: string;
  allowanceKey: string;
  from: number;
  to: number;
  /** Freeze the latest pool reading too: later refreshes cannot shift an open page. */
  snapshotAt: number;
  latest?: UsageReport;
  offset: number;
}
export interface ReadingDetail {
  report: UsageReport;
  change: string;
  resetUnchanged: boolean;
}
export interface ReadingsView {
  view: "readings";
  rows: ReadingDetail[];
  older: boolean;
}

export const allowanceKey = (raw: UsageReport): string => {
  const report = claudeWindow(raw);
  return `${report.toolId}|${report.kind}|${report.model ?? ""}`;
};
export const reportedLevel = (report: UsageReport): number | undefined => report.utilization === undefined || !Number.isFinite(report.utilization) ? undefined : Math.max(0, Math.min(1, report.utilization));
export const percentWords = (value: number): string => `${Math.round(value * 100)}%`;
export function reportedUsage(report: UsageReport): string {
  const level = reportedLevel(report);
  if (level !== undefined) return percentWords(level);
  if (report.toolId === "claude-code" && report.kind === "overage" && report.status === "rejected") return "Extra usage unavailable · percentage not reported";
  if (report.status === "allowed_warning") return "Provider warning · percentage not reported";
  return report.status === "rejected" ? "Limit reached (reported) · no percentage" : "No percentage";
}

/** Local calendar days; real elapsed hours between local midnights on 23/25-hour days. */
export function limitBuckets(period: "today" | "7d" | "30d", now: number): Bucket[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = (offset: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset).getTime();
  if (period !== "today") {
    const count = period === "7d" ? 7 : 30;
    return Array.from({ length: count }, (_, index) => {
      const start = day(index - count + 1);
      return { start, end: day(index - count + 2), label: new Date(start).toLocaleDateString(undefined, { day: "numeric", month: "short" }) };
    });
  }
  const slots: Bucket[] = [];
  for (let start = day(0); start < day(1); start += HOUR) slots.push({ start, end: Math.min(start + HOUR, day(1)), label: new Date(start).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }) });
  for (const slot of slots) {
    if (slots.filter(other => new Date(other.start).getHours() === new Date(slot.start).getHours()).length > 1) {
      const offset = -new Date(slot.start).getTimezoneOffset();
      slot.label += ` UTC${offset >= 0 ? "+" : "−"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
    }
  }
  return slots;
}

/** Precision jitter is the same reported schedule; raw UTC timestamps remain untouched. */
export function sameResetSchedule(a: number | undefined, b: number | undefined): boolean {
  return a !== undefined && b !== undefined && Math.abs(a - b) < MINUTE;
}

/** A fall is evidence only. Forecast jitter and drifting rolling windows are not cycles. */
export function readingChange(previous: UsageReport | undefined, report: UsageReport): { text: string; possible: boolean } {
  const value = reportedLevel(report);
  const before = previous && reportedLevel(previous);
  if (value === undefined) return { text: "Percentage not reported", possible: false };
  if (before === undefined || !previous) return { text: "First reading", possible: false };
  const lower = value < before;
  const reset = previous.resetsAt;
  const advanced = reset !== undefined && report.resetsAt !== undefined && report.resetsAt - reset - (report.at - previous.at) >= MINUTE;
  const possible = lower && reset !== undefined && (reset <= report.at || advanced);
  return { text: possible ? `Possible reset (was ${percentWords(before)})` : lower ? `Lower (was ${percentWords(before)})` : value > before ? `Higher (was ${percentWords(before)})` : "Same level", possible };
}

function mergedReports(history: readonly UsageReport[], current: readonly UsageReport[], snapshotAt: number): UsageReport[] {
  const reports = history.filter(report => report.at <= snapshotAt).map(report => claudeWindow(report));
  const latest = new Map<string, number>();
  for (const report of reports) latest.set(allowanceKey(report), Math.max(latest.get(allowanceKey(report)) ?? -Infinity, report.at));
  for (const raw of current) {
    const report = claudeWindow(raw);
    const key = allowanceKey(report);
    if (report.at <= snapshotAt && report.at > (latest.get(key) ?? -Infinity)) {
      reports.push(report);
      latest.set(key, report.at);
    }
  }
  return reports.sort((a, b) => a.at - b.at);
}

function allowanceLabel(report: UsageReport): string {
  const minutes = report.windowMinutes ?? (report.kind === "five_hour" ? 300 : report.kind.startsWith("seven_day") ? 10080 : undefined);
  const window = kindWords(report.kind, minutes);
  const group = report.name ?? report.model ?? "All models";
  // Native Claude kinds already name their family in kindWords.
  const base = report.kind === "seven_day_opus" || report.kind === "seven_day_sonnet" ? "Weekly" : window.charAt(0).toUpperCase() + window.slice(1);
  return `${base} · ${group.charAt(0).toUpperCase()}${group.slice(1)}`;
}

export function limitsOverTime(history: readonly UsageReport[], current: readonly UsageReport[], buckets: Bucket[], hourly: boolean, now: number, toolName: (id: string) => string, toolOrder: readonly string[] = []): LimitsOverTime {
  const from = buckets[0]!.start;
  const to = buckets.at(-1)!.end;
  const currentKeys = new Set(current.map(allowanceKey));
  const groups = new Map<string, AllowanceHistory>();
  const previous = new Map<string, UsageReport>();
  for (const report of mergedReports(history, current, now)) {
    const key = allowanceKey(report);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: allowanceLabel(report), current: currentKeys.has(key), latest: report, firstAt: report.at,
        windowMinutes: report.windowMinutes ?? (report.kind === "five_hour" ? 300 : report.kind.startsWith("seven_day") ? 10080 : Number.MAX_SAFE_INTEGER),
        buckets: buckets.map(bucket => ({ ...bucket, reports: 0, numericCount: 0, possibleResets: 0, statuses: [], future: bucket.start > now })) };
      groups.set(key, group);
    }
    group.latest = report;
    group.label = allowanceLabel(report);
    const change = readingChange(previous.get(key), report);
    if (reportedLevel(report) !== undefined) previous.set(key, report);
    const bucket = group.buckets.find(bucket => report.at >= bucket.start && report.at < bucket.end);
    if (!bucket) continue;
    bucket.reports++;
    bucket.firstAt ??= report.at;
    // Keep the provider's status too, without retaining a list of numeric readings.
    const status = reportedLevel(report) === undefined ? reportedUsage(report) : report.status === "rejected" ? "Limit reached (reported)" : report.status === "allowed_warning" ? "Provider warning (reported)" : "Allowed (reported)";
    if (!bucket.statuses.includes(status)) bucket.statuses.push(status);
    if (change.possible) bucket.possibleResets++;
    const level = reportedLevel(report);
    if (level === undefined) continue;
    bucket.numericCount++;
    if (bucket.highest === undefined || level > bucket.highest) { bucket.highest = level; bucket.highestAt = report.at; }
  }
  const tools = new Map<string, AllowanceHistory[]>();
  for (const group of groups.values()) (tools.get(group.latest.toolId) ?? tools.set(group.latest.toolId, []).get(group.latest.toolId)!).push(group);
  const order = (id: string) => { const index = toolOrder.indexOf(id); return index < 0 ? toolOrder.length : index; };
  return { from, to, now, hourly, buckets, tools: [...tools.entries()].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b)).map(([toolId, limits]) => {
    const labels = new Map<string, AllowanceHistory[]>();
    for (const limit of limits) (labels.get(limit.label) ?? labels.set(limit.label, []).get(limit.label)!).push(limit);
    for (const matching of labels.values()) {
      if (matching.length < 2) continue;
      const scopes = matching.map(limit => limit.latest.model ?? "All models");
      if (new Set(scopes).size > 1) {
        const titled = scopes.map(scope => scope.charAt(0).toUpperCase() + scope.slice(1));
        matching.forEach((limit, index) => { limit.label += ` (scope: ${titled.filter(scope => scope === titled[index]).length > 1 ? scopes[index] : titled[index]})`; });
      }
      const remaining = new Map<string, AllowanceHistory[]>();
      for (const limit of matching) (remaining.get(limit.label) ?? remaining.set(limit.label, []).get(limit.label)!).push(limit);
      for (const duplicates of remaining.values()) if (duplicates.length > 1) {
        // With no provider name to distinguish them, keep identities separate using plain labels.
        duplicates.sort((a, b) => a.key.localeCompare(b.key)).forEach((limit, index) => { limit.label += ` · Allowance ${index + 1}`; });
      }
    }
    return { toolId, label: toolName(toolId), limits: limits.sort((a, b) => Number(b.current) - Number(a.current) || a.windowMinutes - b.windowMinutes || a.label.localeCompare(b.label)) };
  }) };
}

export function initialAllowance(limits: AllowanceHistory[]): AllowanceHistory | undefined {
  const current = limits.filter(limit => limit.current);
  return current.filter(limit => limit.buckets.some(bucket => bucket.highest !== undefined)).sort((a, b) => a.windowMinutes - b.windowMinutes || b.latest.at - a.latest.at)[0]
    ?? [...(current.length ? current : limits)].sort((a, b) => b.latest.at - a.latest.at)[0];
}

export function readingsView(history: readonly UsageReport[], current: readonly UsageReport[], request: ReadingsRequest): ReadingsView {
  const reports = mergedReports(history, request.latest ? [request.latest] : current, request.snapshotAt).filter(report => report.toolId === request.toolId && allowanceKey(report) === request.allowanceKey);
  let previous: UsageReport | undefined;
  let previousReport: UsageReport | undefined;
  const rows: ReadingDetail[] = [];
  for (const report of reports) {
    const change = readingChange(previous, report);
    if (report.at >= request.from && report.at < request.to) rows.push({ report, change: change.text, resetUnchanged: sameResetSchedule(previousReport?.resetsAt, report.resetsAt) });
    if (reportedLevel(report) !== undefined) previous = report;
    previousReport = report;
  }
  rows.reverse();
  return { view: "readings", rows: rows.slice(request.offset, request.offset + READING_PAGE_SIZE), older: rows.length > request.offset + READING_PAGE_SIZE };
}
