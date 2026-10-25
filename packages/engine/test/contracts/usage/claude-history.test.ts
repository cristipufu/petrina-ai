import { afterAll, expect, it, spyOn } from "bun:test";
import { limitOf, type AgentProfile } from "@petrina/core";
import { Engine } from "../../engine.js";
import { claudeReports } from "@petrina/agent-runtime/claude-usage-report";
import { claudeAccountReports } from "@petrina/agent-runtime/claude-account-report";

import { removeDir, tempDir } from "../../fixtures.js";

const NOW = Date.parse("2026-10-21T12:00:00Z"), HOUR = 3_600_000;
const claude: AgentProfile = { id: "opus-high", toolId: "claude-code", model: "Opus", modelId: "opus", effort: "high" };
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture() {
  const root = tempDir("petrina-claude-allowances-"); roots.push(root);
  const engine = new Engine(root, { admissionsClosed: true, agentCommand: () => undefined, toolPath: () => process.execPath });
  await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
  engine.setPoolPaused(true);
  engine.s.pool.toolCaps["claude-code"] = 4;
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  return { engine, clock, close: async () => { clock.mockRestore(); await engine.shutdown(); } };
}

const account = (used: number, enabled: boolean, paid: unknown) => ({ rate_limits_available: true, rate_limits: {
  five_hour: { utilization: used, resets_at: new Date(NOW + HOUR).toISOString() },
  seven_day: { utilization: 2, resets_at: new Date(NOW + 24 * HOUR).toISOString() },
  extra_usage: { is_enabled: enabled, utilization: paid },
} });
const live = (used: number, enabled: boolean, paid: number) => ({
  status: used === 100 ? "rejected" : "allowed", rateLimitType: "five_hour", utilization: used / 100, resetsAt: (NOW + HOUR) / 1000,
  overageStatus: enabled && paid < 100 ? paid >= 90 ? "allowed_warning" : "allowed" : "rejected",
  isUsingOverage: used === 100 && enabled && paid < 100,
  ...(!enabled ? { overageDisabledReason: "org_level_disabled" } : paid === 100 ? { overageDisabledReason: "out_of_credits" } : {}),
  overageResetsAt: (NOW + 10 * HOUR) / 1000,
});
function stream(engine: Engine, info: unknown) {
  for (const report of claudeReports("claude-code", { "_claude/rateLimit": info })) engine.recordUsage(report);
}

it("retires an old false extra-usage cooldown immediately while keeping history and independent limits", async () => {
  const run = await fixture();
  const wake = spyOn(run.engine, "schedule").mockImplementation(() => {});
  try {
    const report = { toolId: "claude-code", kind: "overage", status: "rejected" as const, at: NOW - 1000, resetsAt: NOW + 10 * HOUR };
    const unrelated = { toolId: "codex", reason: "Codex's rate limit", until: NOW + HOUR };
    const scoped = { toolId: "claude-code", model: "opus", kind: "seven_day_opus", status: "rejected" as const, utilization: 1, at: NOW - 500, resetsAt: NOW + 2 * HOUR };
    run.engine.s.pool.usage = [report, scoped];
    run.engine.tracking.usageReported(report);
    run.engine.s.pool.limited = [
      { toolId: "claude-code", reason: "Claude Code's extra usage limit", until: report.resetsAt, at: report.at }, unrelated,
    ];
    stream(run.engine, live(5, false, 100));
    expect(wake).toHaveBeenCalled();
    expect(run.engine.s.pool.usage!.some(entry => entry.kind === "overage")).toBe(false);
    expect(run.engine.s.pool.limited!.some(entry => entry.reason.includes("extra usage"))).toBe(false);
    expect(run.engine.s.pool.limited).toContainEqual(unrelated);
    expect(limitOf(run.engine.s.pool, claude, NOW)?.model).toBe("opus");
    expect(limitOf(run.engine.s.pool, { ...claude, model: "Sonnet", modelId: "sonnet" }, NOW)).toBeUndefined();
    expect(run.engine.tracking.log.usageHistory({})).toContainEqual(report);
  } finally { wake.mockRestore(); await run.close(); }
});

it("continues saved Fable history on one Analytics line after a native account refresh", async () => {
  const run = await fixture();
  try {
    const reset = NOW + HOUR;
    const saved = [0.05, 0.06, 0.08].map((utilization, index) => ({
      toolId: "claude-code", kind: "seven_day_model", model: "fable", name: "fable", windowMinutes: 10_080,
      status: "allowed" as const, utilization, at: NOW - (3 - index) * HOUR, resetsAt: reset,
    }));
    for (const report of saved) run.engine.tracking.usageReported(report);
    const value = account(5, false, 100);
    run.engine.recordAccountUsage("claude-code", claudeAccountReports({ ...value, rate_limits: { ...value.rate_limits,
      model_scoped: [{ display_name: "Fable", utilization: 9, resets_at: new Date(reset).toISOString() }],
    } }));
    const chart = run.engine.usage({ view: "analytics", period: "today" }).limits.tools.find(tool => tool.toolId === "claude-code")!;
    const lines = chart.limits.filter(line => line.label === "Weekly · Fable");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.buckets.reduce((sum, bucket) => sum + bucket.numericCount, 0)).toBe(4);
    expect(lines[0]!.latest.utilization).toBe(0.09);
    expect(lines[0]!.latest.resetsAt).toBe(reset);
    expect(run.engine.tracking.log.usageHistory({}).filter(report => report.at < NOW)).toEqual(saved);
  } finally { await run.close(); }
});
