import {
  claudeWindow,
  currentReport,
  kindWords,
  UNKNOWN_LIMIT_MS,
  withLimit,
  withReport,
  type DeepMutable,
  type Id,
  type Pool,
  type UsageInfo,
  type UsageReport
} from "@petrina/core";

/** Own reconciliation of observed allowances; native readers, timers and persistence stay with the host. */
export interface UsageRecordingHost {
  pool(): DeepMutable<Pool>;
  record(report: UsageReport): void;
  toolName(toolId: Id): string;
  wake(): void;
}

export class UsageRecording {
  constructor(private readonly host: UsageRecordingHost) {}

  record(info: UsageInfo, now: number): void {
    if (info.toolId === "claude-code") this.reconcileClaude([info], now);
    else this.noteUsage(info, now);
  }

  /** A successful complete account snapshot replaces quotas and blocks from the previous subscription. */
  account(toolId: Id, reports: readonly UsageInfo[], now: number): boolean {
    // Empty or mismatched data cannot establish that an old restriction ended.
    if (!reports.length || reports.some(report => report.toolId !== toolId)) return false;
    if (toolId === "claude-code") {
      // A partial native response establishes only its reported windows.
      const complete = reports.some(report => report.claudeAccountComplete);
      this.reconcileClaude(reports, now, complete);
      return true;
    }
    const previous = (this.host.pool().usage ?? []).filter(report => report.toolId === toolId);
    this.host.pool().usage = (this.host.pool().usage ?? []).filter(report => report.toolId !== toolId);
    // Only retire blocks created by the reports being replaced (same scope and report time).
    // A turn-only refusal can have its own cooldown despite an available account balance.
    this.host.pool().limited = (this.host.pool().limited ?? []).filter(limit => limit.toolId !== toolId || limit.source === "refusal" || limit.retry || !previous.some(report =>
      report.status === "rejected" && !report.overage && report.at === limit.at && (report.model ?? "") === (limit.model ?? "")));
    for (const report of reports) this.noteUsage(report, now);
    return true;
  }

  private noteUsage(info: UsageInfo, now: number): void {
    const report = { ...info, at: now };
    this.host.pool().usage = withReport(this.host.pool().usage, report) as DeepMutable<Pool>["usage"];
    this.host.record(report);
    this.restrictUsage(report, now);
  }

  /** Reconcile Claude's alternative allowances before any shared scheduling or Analytics reading. */
  private reconcileClaude(infos: readonly UsageInfo[], now: number, complete = false): void {
    const pool = this.host.pool();
    const before = pool.limited ?? [];
    const previous = (pool.usage ?? []).filter(report => report.toolId === "claude-code");
    const previousWindows = previous.map(report => claudeWindow(report));
    // Retire only report-derived blocks. Old saved state has no source, so require its exact
    // report time, scope and reason; a real refusal has an independent lifetime.
    // The old failed-turn path stamped synthetic extra-usage blocks later than their notice.
    // This exact reason came only from that obsolete mapping, including its former migration.
    pool.limited = (pool.limited ?? []).filter(limit => limit.toolId !== "claude-code" || limit.reason !== "Claude Code's extra usage limit")
      .filter(limit => limit.toolId !== "claude-code" || limit.source === "refusal" || limit.retry || !(limit.source === "report" || previous.some(report =>
      report.status === "rejected" && !report.overage && report.at === limit.at && (report.model ?? "") === (limit.model ?? "") && limit.reason === `Claude Code's ${kindWords(
        report.kind,
        report.windowMinutes,
        report.name
      )} limit`)))
      .map(limit => limit.toolId === "claude-code" && limit.source === undefined ? { ...limit, source: "refusal" as const } : limit);
    pool.usage = (pool.usage ?? []).filter(report => report.toolId !== "claude-code" || !complete && report.kind !== "overage")
      .reduce<UsageReport[]>((reports, report) => withReport(reports, report.toolId === "claude-code" ? claudeWindow(report) : report), []);
    for (const raw of infos) {
      const info = claudeWindow(raw);
      if (info.claudeOverage) {
        if (info.claudeOverage === "unavailable") {
          for (const report of pool.usage) {
            if (report.toolId !== "claude-code" || report.status !== "rejected" || !report.overage || !currentReport(report, now)) continue;
            report.overage = false;
            this.host.record({ ...report, at: now });
          }
        }
        continue;
      }
      const older = previousWindows.findLast(report => report.kind === info.kind && (report.model ?? "") === (info.model ?? "") && currentReport(report, now));
      // Account resets include milliseconds; live notices can truncate them to whole seconds.
      // Match that precision difference only: two distinct precise resets still start a new reading.
      const priorReset = older?.resetsAt;
      const reset = info.resetsAt;
      const sameReset = reset === undefined || priorReset === reset || priorReset !== undefined
        && Number.isFinite(priorReset) && Number.isFinite(reset)
        && (priorReset % 1000 === 0 || reset % 1000 === 0) && Math.floor(priorReset / 1000) === Math.floor(reset / 1000);
      const sameWindow = older?.status === info.status && sameReset;
      const report = { ...(sameWindow ? older : {}), ...info, at: now };
      if (sameWindow && priorReset !== undefined && reset !== undefined && priorReset % 1000 !== 0 && reset % 1000 === 0) report.resetsAt = priorReset;
      delete report.claudeAccountComplete;
      pool.usage = withReport(pool.usage, report);
      this.host.record(report);
    }
    // Rebuild from the windows still current, using their original report times for unknown
    // resets. Paid-only notices cannot extend a cooldown or hold included quota past its reset.
    for (const report of pool.usage) if (report.toolId === "claude-code" && currentReport(report, now)) this.restrictUsage(report, now);
    if (before.some(limit => limit.toolId === "claude-code" && limit.until > now && !(pool.limited ?? []).some(next => next.toolId === limit.toolId && (next.model ?? "") === (limit.model ?? "") && next.until > now))) this.host.wake();
  }

  private restrictUsage(info: UsageReport, now: number): void {
    // Not when the tool goes on with usage paid beyond the plan: the window is spent, the usage line says so, and
    // the balancer prefers tools with room, but the agents keep working.
    if (info.status === "rejected" && !info.overage) {
      const until = info.resetsAt && info.resetsAt > now ? info.resetsAt : (info.toolId === "claude-code" ? info.at : now) + UNKNOWN_LIMIT_MS;
      this.host.pool().limited = withLimit(
        this.host.pool().limited,
        {
        toolId: info.toolId,
        source: "report",
        ...(info.model ? { model: info.model } : {}),
        until,
        reason: `${this.host.toolName(info.toolId)}'s ${kindWords(
        info.kind,
        info.windowMinutes,
        info.name
      )} limit`,
        at: info.at
      }
      ) as DeepMutable<Pool>["limited"];
    }
  }
}
