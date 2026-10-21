// Claude Code's local get_usage control request. No user prompt or AI turn is sent.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { ReadOptions } from "./codex-usage.js";
import type { UsageInfo } from "./usage.js";
import { UsageReader } from "./usage-reader.js";
import type { ReaderOptions } from "./tool-adapter.js";
import { claudeWindow } from "@petrina/core";

export const CLAUDE_USAGE_COMMAND = ["claude", "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'] as const;
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

export async function readClaudeUsage(options: ReadOptions & { cwd: string }): Promise<UsageInfo[]> {
  await mkdir(options.cwd, { recursive: true, mode: 0o700 });
  const [program, ...args] = options.command ?? CLAUDE_USAGE_COMMAND;
  const child = spawn(program!, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<UsageInfo[]>((resolve, reject) => {
      let buffer = "";
      const send = (id: string, request: object) => child.stdin!.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
      child.on("error", () => reject(new Error("Claude Code could not start its account usage check")));
      child.on("exit", () => reject(new Error("Claude Code stopped before reporting account usage")));
      child.stdin!.on("error", () => reject(new Error("Claude Code closed its account usage connection")));
      child.stderr!.resume();
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 2_000_000) { reject(new Error("Claude Code's account response was too large")); return; }
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let message: Record<string, unknown>;
          try { message = object(JSON.parse(line)); } catch { continue; }
          if (message.type !== "control_response") continue;
          const response = object(message.response);
          if (response.request_id !== "usage-init" && response.request_id !== "usage-read") continue;
          if (response.subtype !== "success") { reject(new Error("Claude Code could not read account usage; check its login")); return; }
          if (response.request_id === "usage-init") send("usage-read", { subtype: "get_usage", skip_behaviors: true });
          else resolve(claudeAccountReports(response.response));
        }
      });
      timer = setTimeout(() => reject(new Error("Claude Code did not answer its account usage check in time")), options.timeoutMs ?? 30_000);
      options.onProcess?.(child);
      send("usage-init", { subtype: "initialize", hooks: {} });
    });
  } finally {
    clearTimeout(timer);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill();
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2000);
      child.once("exit", () => clearTimeout(force));
    }
  }
}

export class ClaudeUsage extends UsageReader {
  constructor(options: ReaderOptions) {
    super({ name: "Claude Code", record: options.record, log: options.log, changed: options.changed,
      read: onProcess => readClaudeUsage({ command: options.command, cwd: options.cwd, env: options.env(), onProcess }),
    });
  }
}
