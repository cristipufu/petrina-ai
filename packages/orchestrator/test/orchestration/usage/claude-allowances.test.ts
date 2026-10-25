import { expect, it, vi } from "vitest";
import { chooseProfile, HOLDING_BACK, headroom, limitOf, nearLimit, pickStarts, toolCapNow, usageLines, limitBuckets, limitsOverTime, DEFAULT_PROFILES, KNOWN_TOOLS, withLimit, type AgentProfile, type DeepMutable, type Pool, type UsageInfo, type UsageReport } from "@petrina/core";
import { UsageRecording } from "../../../src/usage-recording.js";
import { claudeReports } from "../../../../agent-runtime/src/claude-usage-report.js";
import { claudeAccountReports } from "../../../../agent-runtime/src/claude-account-report.js";
import { limitFromFailure } from "../../../../agent-runtime/test/fixtures/limit-parsing.js";

const NOW = Date.parse("2026-10-21T12:00:00Z"), HOUR = 3_600_000;
const claude: AgentProfile = { id: "opus-high", toolId: "claude-code", model: "Opus", modelId: "opus", effort: "high" };
const codex: AgentProfile = { id: "sol-high", toolId: "codex", model: "Sol", effort: "high" };
function fixture() {
  const pool: DeepMutable<Pool> = { limit: 3, paused: true, toolCaps: { "claude-code": 4 } };
  const recorded: UsageReport[] = [], wake = vi.fn();
  const clock = { value: NOW, set(value: number) { this.value = value; } };
  const now = () => clock.value;
  const recording = new UsageRecording({ pool: () => pool, record: report => recorded.push(structuredClone(report)), toolName: id => id === "claude-code" ? "Claude Code" : id, wake });
  const state = () => ({ pool, profiles: DEFAULT_PROFILES, tools: KNOWN_TOOLS.map(tool => ({ ...tool, status: "ready" as const })) });
  return { pool, recorded, now, clock, wake, record: (info: UsageInfo) => recording.record(info, now()),
    account: (tool: string, reports: readonly UsageInfo[]) => recording.account(tool, reports, now()),
    profile: (id: string) => DEFAULT_PROFILES.find(profile => profile.id === id),
    choose: (id: string) => chooseProfile(state(), DEFAULT_PROFILES.find(profile => profile.id === id)!, now()),
    refuse: (failure: { toolId: string; source: "report" | "refusal"; model?: string; until: number; reason: string }) => {
      pool.limited = withLimit(pool.limited, { toolId: failure.toolId, source: failure.source, model: failure.model, until: failure.until, reason: failure.reason, at: now() });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
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
function stream(run: Fixture, info: unknown) {
  for (const report of claudeReports("claude-code", { "_claude/rateLimit": info })) run.record(report);
}
function overview(run: Fixture) { return limitsOverTime(run.recorded, run.pool.usage ?? [], limitBuckets("today", run.now()), true, run.now(), id => id); }
function view(run: Fixture) {
  const pool = run.pool;
  const line = usageLines({ pool, tools: [{ id: "claude-code", name: "Claude Code", command: ["claude"], models: [], status: "ready" }] }, run.now())[0];
  const analytics = overview(run).tools.find(tool => tool.toolId === "claude-code");
  return {
    blocked: !!limitOf(pool, claude, run.now()), room: headroom(pool, claude, run.now()), cap: toolCapNow(pool, "claude-code", run.now(), claude), near: nearLimit(pool, claude, run.now()),
    choice: chooseProfile({ pool, tools: [], profiles: [claude, codex] }, claude, run.now()).kind, line,
    latest: analytics?.limits.map(limit => [limit.label, limit.latest.utilization, limit.latest.resetsAt]),
  };
}

it("keeps the pool and Analytics consistent for included and paid allowance combinations in either order", () => {
  const run = fixture();

    for (const used of [5, 100]) for (const enabled of [false, true]) for (const paid of [25, 95, 100]) {
      let expected: ReturnType<typeof view> | undefined;
      for (const order of ["account-first", "live-first"]) {
        delete run.pool.usage; delete run.pool.limited;
        const snapshot = () => run.account("claude-code", claudeAccountReports(account(used, enabled, paid)));
        const update = () => stream(run, live(used, enabled, paid));
        if (order === "account-first") { snapshot(); update(); } else { update(); snapshot(); }
        update(); update();
        const actual = view(run);
        expect(actual.blocked).toBe(used === 100 && (!enabled || paid === 100));
        expect(actual.choice).toBe(actual.blocked ? "substitute" : "planned");
        expect(actual.cap).toBe(used === 100 ? 2 : 4);
        expect(actual.near).toBe(false);
        expect(actual.room).toBe(used === 100 ? 0 : 0.98 / 24);
        expect(run.pool.usage!.some(report => report.kind === "overage")).toBe(false);
        if (expected) expect(actual).toEqual(expected);
        expected = actual;
      }
    }
});


it("keeps a healthy low-usage Claude window on its plan as account readings and live warnings alternate", () => {
  const weeklyReset = Date.parse("2026-10-28T12:00:00Z");
  const snapshot = (weekly: number, complete = true) => ({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 2, resets_at: new Date(NOW + HOUR).toISOString() },
    seven_day: { utilization: weekly, resets_at: new Date(weeklyReset).toISOString() },
    ...(complete ? { model_scoped: [] } : {}),
  } });
  const warning = { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.26, resetsAt: weeklyReset / 1000 };
  const running = Array.from({ length: 4 }, (_, index) => ({ taskId: `running-${index}`, toolId: "claude-code", model: "Opus 5.5", modelId: "opus" }));
  const fifth = { taskId: "fifth", toolId: "claude-code", model: "Opus 5.5", modelId: "opus" };
  for (const order of ["account-first", "live-first"]) {
    const run = fixture();

      run.pool.toolCaps["claude-code"] = 7;
      run.pool.limit = 10;
      // Admission, the actual profile and the displayed status agree after every update.
      const healthy = (shown: string, step: string) => {
        const pool = run.pool, opus = run.profile("opus-xhigh")!;
        expect(nearLimit(pool, opus, NOW), step).toBe(false);
        expect(toolCapNow(pool, "claude-code", NOW, opus), step).toBe(7);
        expect(pickStarts({ candidates: [fifth], inUse: running, pool: { ...pool, paused: false }, now: NOW }), step).toEqual(["fifth"]);
        expect(run.choose("opus-xhigh"), step).toMatchObject({ kind: "planned", profile: { id: "opus-xhigh" } });
        const line = view(run).line!;
        expect(line.tone, step).toBe("fine");
        expect(line.text, step).toContain(shown);
        expect(line.text, step).not.toContain(HOLDING_BACK);
      };
      const account = (step: string) => { run.account("claude-code", claudeAccountReports(snapshot(27))); healthy("weekly 27%, resets", step); };
      const live = (step: string) => { stream(run, warning); healthy("weekly 26%, provider warning, resets", step); };
      if (order === "account-first") { account("account"); live("live warning"); account("account again"); }
      else { live("live warning"); account("account"); live("live warning again"); }
      // A notice that omits the percentage retains it only from the same warning window; otherwise usage is unknown.
      live("live warning before an omitted percentage");
      stream(run, { status: "allowed_warning", rateLimitType: "seven_day" });
      expect(run.pool.usage!.find(report => report.kind === "seven_day")).toMatchObject({ status: "allowed_warning", utilization: 0.26, resetsAt: weeklyReset });
      account("account after the retained warning");
      stream(run, { status: "allowed_warning", rateLimitType: "seven_day" });
      expect(run.pool.usage!.find(report => report.kind === "seven_day")!.utilization).toBeUndefined();
      healthy("weekly provider warning, percentage not reported", "warning without a percentage");
      expect(headroom(run.pool, claude, NOW)).toBeCloseTo(0.98);
      // A partial account reading updates only its own windows.
      run.account("claude-code", claudeAccountReports({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 3 } } }));
      healthy("weekly provider warning, percentage not reported", "partial account");
      run.account("claude-code", claudeAccountReports(snapshot(27, false)));
      healthy("weekly 27%, resets", "account without a model list");
      // Real measurements still slow and move new agents, whichever status reports them.
      run.account("claude-code", claudeAccountReports(snapshot(85)));
      expect(toolCapNow(run.pool, "claude-code", NOW, claude)).toBe(4);
      expect(run.choose("opus-xhigh")).toMatchObject({ kind: "planned", profile: { id: "opus-xhigh" } });
      stream(run, { ...warning, utilization: 0.85 });
      expect(toolCapNow(run.pool, "claude-code", NOW, claude)).toBe(4);
      expect(view(run).line).toMatchObject({ tone: "near", text: expect.stringContaining(HOLDING_BACK) });
      stream(run, { ...warning, utilization: 0.9 });
      expect(run.choose("opus-xhigh")).toMatchObject({ kind: "substitute", profile: { toolId: "codex", effort: "xhigh" } });
      // A request refusal outlives healthy readings and low warnings.
      run.pool.limited = [{ toolId: "claude-code", source: "refusal", until: NOW + HOUR, reason: "Claude Code refused the request", at: NOW }];
      run.account("claude-code", claudeAccountReports(snapshot(27)));
      stream(run, warning);
      expect(limitOf(run.pool, claude, NOW)).toMatchObject({ source: "refusal", until: NOW + HOUR });
      expect(run.choose("opus-xhigh")).toMatchObject({ kind: "substitute", profile: { toolId: "codex" } });
  }
});


it("uses paid-only notices only to end known paid continuation, without inventing included readings", () => {
  const run = fixture();

    // Representative native partial event: anthropics/claude-agent-sdk-python#601.
    const notice = { isUsingOverage: false, overageDisabledReason: "org_level_disabled", overageStatus: "rejected" };
    stream(run, notice);
    expect(run.pool.usage).toEqual([]);
    expect(run.pool.limited).toEqual([]);
    expect(headroom(run.pool, claude, NOW)).toBeUndefined();
    run.account("claude-code", claudeAccountReports(account(100, true, 25)));
    expect(limitOf(run.pool, claude, NOW)).toBeUndefined();
    // Not currently using paid allowance does not revoke an account-confirmed usable balance.
    stream(run, { status: "rejected", rateLimitType: "five_hour", isUsingOverage: false, overageStatus: "allowed" });
    expect(limitOf(run.pool, claude, NOW)).toBeUndefined();
    stream(run, notice);
    expect(limitOf(run.pool, claude, NOW)?.until).toBe(NOW + HOUR);
    const readings = structuredClone(run.pool.usage);
    stream(run, { overageStatus: "allowed" });
    expect(run.pool.usage).toEqual(readings);
    expect(limitOf(run.pool, claude, NOW)).toBeDefined();
    stream(run, { status: "rejected", rateLimitType: "five_hour", isUsingOverage: true });
    expect(limitOf(run.pool, claude, NOW)).toBeUndefined();
    expect(run.pool.usage!.find(report => report.kind === "five_hour")).toMatchObject({ utilization: 1, resetsAt: NOW + HOUR, overage: true });
    stream(run, { overageStatus: "rejected", overageResetsAt: (NOW - 1) / 1000 });
    expect(limitOf(run.pool, claude, NOW)).toBeUndefined();
    stream(run, { status: "rejected", rateLimitType: "overage", resetsAt: (NOW - 1) / 1000 });
    expect(limitOf(run.pool, claude, NOW)).toBeUndefined();
});


it("retains unrelated windows and known percentages across partial account and live readings", () => {
  const run = fixture();

    run.account("claude-code", claudeAccountReports(account(5, false, 100)));
    stream(run, { status: "allowed", rateLimitType: "five_hour", overageStatus: "rejected" });
    expect(headroom(run.pool, claude, NOW)).toBe(0.98 / 24);
    run.account("claude-code", claudeAccountReports({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 7 } } }));
    expect(run.pool.usage!.map(report => report.kind).sort()).toEqual(["five_hour", "seven_day"]);
    stream(run, { status: "rejected", rateLimitType: "seven_day_opus", utilization: 1, resetsAt: (NOW + HOUR) / 1000 });
    run.account("claude-code", claudeAccountReports(account(5, false, 100)));
    expect(limitOf(run.pool, claude, NOW)?.model).toBe("opus");
    const complete = account(5, false, 100);
    run.account("claude-code", claudeAccountReports({ ...complete, rate_limits: { ...complete.rate_limits, model_scoped: [] } }));
    expect(limitOf(run.pool, claude, NOW)).toBeUndefined();
    expect(run.pool.usage!.some(report => "claudeAccountComplete" in report)).toBe(false);
    stream(run, { status: "allowed_warning", rateLimitType: "seven_day_opus" });
    const scoped = run.pool.usage!.find(report => report.model === "opus")!;
    expect(scoped.utilization).toBeUndefined();
    expect(scoped.resetsAt).toBeUndefined();
    // Kept and shown as the provider's warning, with no percentage invented for it.
    expect(scoped.status).toBe("allowed_warning");
    expect(view(run).line!.text).toContain("weekly Opus provider warning, percentage not reported");
    expect(nearLimit(run.pool, claude, NOW)).toBe(false);
    expect(nearLimit(run.pool, { ...claude, model: "Sonnet", modelId: "sonnet" }, NOW)).toBe(false);
});


it("keeps admission and percentage consistent when the live reset has seconds and the account reset has milliseconds", () => {
  const reset = NOW + HOUR + 118;
  for (const order of ["account-first", "live-first"]) {
    const run = fixture();

      const raw = account(85, false, 100);
      raw.rate_limits.five_hour.resets_at = new Date(reset).toISOString();
      const snapshot = () => run.account("claude-code", claudeAccountReports(raw));
      const notice = () => stream(run, { status: "allowed", rateLimitType: "five_hour", resetsAt: Math.floor(reset / 1000) });
      if (order === "account-first") { snapshot(); notice(); } else { notice(); snapshot(); }
      const reading = run.pool.usage!.find(report => report.kind === "five_hour")!;
      expect(reading.utilization).toBe(0.85);
      expect(reading.resetsAt).toBe(reset);
      expect(toolCapNow(run.pool, "claude-code", NOW, claude)).toBe(2);
      // An actually different reset or two distinct precise timestamps establish a different reading.
      for (const nextReset of [NOW + HOUR + 1_000, NOW + HOUR + 219]) {
        snapshot();
        run.record({ toolId: "claude-code", kind: "five_hour", status: "allowed", resetsAt: nextReset });
        expect(run.pool.usage!.find(report => report.kind === "five_hour")!.utilization).toBeUndefined();
      }
      snapshot();
      stream(run, { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(reset / 1000) });
      expect(run.pool.usage!.find(report => report.kind === "five_hour")!.utilization).toBeUndefined();
      expect(limitOf(run.pool, claude, NOW)).toBeDefined();
  }
});


it("releases included quota at its reset even when paid usage stays exhausted and repeats expired notices", () => {
  const run = fixture();

    run.account("claude-code", claudeAccountReports(account(100, false, 100)));
    run.clock.set(NOW + HOUR + 1);
    stream(run, live(100, false, 100));
    stream(run, { status: "rejected", rateLimitType: "overage", resetsAt: (NOW + 10 * HOUR) / 1000 });
    stream(run, { overageStatus: "rejected", overageResetsAt: (NOW - HOUR) / 1000 });
    expect(limitOf(run.pool, claude, run.now())).toBeUndefined();
    expect(headroom(run.pool, claude, run.now())).toBeGreaterThan(0);
    expect(toolCapNow(run.pool, "claude-code", run.now(), claude)).toBe(4);
    // With no reset, paid-only notices also cannot renew the included cooldown.
    run.clock.set(NOW);
    stream(run, { status: "rejected", rateLimitType: "five_hour" });
    const until = limitOf(run.pool, claude, NOW)!.until;
    run.clock.set(NOW + 60_000);
    stream(run, { overageStatus: "rejected" });
    expect(limitOf(run.pool, claude, run.now())!.until).toBe(until);
    run.clock.set(until + 1);
    stream(run, { overageStatus: "rejected" });
    expect(limitOf(run.pool, claude, run.now())).toBeUndefined();
});


it("keeps real rate, billing, account and synthetic refusals despite healthy readings in either order", () => {
  const run = fixture();

    // Older saved refusals without report provenance must survive a longer inferred quota block.
    const legacy = { toolId: "claude-code", reason: "Claude Code's rate limit", until: NOW + 5 * 60_000, at: NOW - 1 };
    run.pool.limited = [legacy];
    stream(run, live(100, false, 100));
    run.account("claude-code", claudeAccountReports(account(5, false, 100)));
    expect(limitOf(run.pool, claude, NOW)).toMatchObject(legacy);
    for (const error of [
      { data: { errorKind: "rate_limit" } }, { data: { errorKind: "billing_error" } }, { data: { errorKind: "account_on_hold" } },
      new Error("Internal error: You're out of extra usage"), new Error("Internal error: You've hit your usage limit · resets 8pm"),
    ]) for (const first of [true, false]) {
      delete run.pool.usage; delete run.pool.limited;
      const refresh = () => { run.account("claude-code", claudeAccountReports(account(5, false, 100))); stream(run, live(5, false, 100)); };
      if (first) refresh();
      const failure = limitFromFailure(claude, error, "", NOW)!;
      run.refuse(failure);
      if (!first) refresh();
      // Even another report-derived block at the same instant must not replace the refusal.
      stream(run, live(100, false, 100)); refresh();
      stream(run, { overageStatus: "allowed" });
      expect(limitOf(run.pool, claude, NOW)).toMatchObject({ source: "refusal", reason: failure.reason, until: failure.until });
      expect(run.pool.limited!.filter(limit => limit.source === "refusal")).toHaveLength(1);
    }
});


it("reconciles live and account model windows in both recovery directions and wakes waiting work", () => {
  const run = fixture();
  const wake = run.wake;

    const reset = NOW + 72 * HOUR;
    for (const [model, kind] of [["opus", "seven_day_opus"], ["sonnet", "seven_day_sonnet"], ["fable", "seven_day_overage_included"]]) {
      const profile = { ...claude, model: model!, modelId: model };
      const snapshot = (used: number) => {
        const value = account(5, false, 100);
        run.account("claude-code", claudeAccountReports({ ...value, rate_limits: { ...value.rate_limits,
          model_scoped: [{ display_name: model, utilization: used, resets_at: new Date(reset).toISOString() }],
        } }));
      };
      const update = (used: number) => stream(run, { status: used === 100 ? "rejected" : "allowed", rateLimitType: kind, utilization: used / 100, resetsAt: reset / 1000 });
      for (const accountFirst of [false, true]) {
        delete run.pool.usage; delete run.pool.limited;
        if (accountFirst) snapshot(100); else update(100);
        expect(limitOf(run.pool, profile, NOW)?.model).toBe(model);
        const before = wake.mock.calls.length;
        if (accountFirst) update(10); else snapshot(10);
        expect(limitOf(run.pool, profile, NOW)).toBeUndefined();
        expect(toolCapNow(run.pool, "claude-code", NOW, profile)).toBe(4);
        expect(nearLimit(run.pool, profile, NOW)).toBe(false);
        expect(headroom(run.pool, profile, NOW)).toBeGreaterThan(0);
        expect(run.pool.usage!.filter(report => report.model === model)).toHaveLength(1);
        const chart = overview(run).tools.find(tool => tool.toolId === "claude-code")!;
        expect(chart.limits.find(line => line.key === `claude-code|${kind}|${model}`)?.latest.utilization).toBe(0.1);
        expect(wake.mock.calls.length).toBeGreaterThan(before);
      }
    }
});


it("normalizes saved model aliases and leaves missing or invalid account lists partial", () => {
  const run = fixture();

    const reset = NOW + 72 * HOUR;
    // Earlier snapshots used generic model kinds, or left the native Fable kind tool-wide.
    run.pool.usage = [
      { toolId: "claude-code", kind: "seven_day_model", model: "opus", name: "opus", windowMinutes: 10_080, status: "rejected", utilization: 1, resetsAt: reset, at: NOW - 1000 },
      { toolId: "claude-code", kind: "seven_day_overage_included", status: "rejected", utilization: 1, resetsAt: reset, at: NOW - 1000 },
    ];
    run.pool.limited = [{ toolId: "claude-code", reason: "Claude Code's weekly limit", until: reset, at: NOW - 1000 }];
    stream(run, { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1, resetsAt: reset / 1000 });
    expect(limitOf(run.pool, claude, NOW)).toBeUndefined();
    expect(limitOf(run.pool, { ...claude, model: "Fable", modelId: "fable" }, NOW)?.model).toBe("fable");
    const value = account(5, false, 100);
    for (const model_scoped of [undefined, [{ display_name: "Fable", utilization: null }], [{ display_name: "Opus", utilization: 10 }, {}]]) {
      run.account("claude-code", claudeAccountReports({ ...value, rate_limits: { ...value.rate_limits, model_scoped } }));
      expect(limitOf(run.pool, { ...claude, model: "Fable", modelId: "fable" }, NOW)?.model).toBe("fable");
    }
});


it("keeps Fable notices scoped to Fable and accepts a complete nonempty account model list", () => {
  const run = fixture();

    const value = account(5, false, 100);
    const snapshot = (used: number) => run.account("claude-code", claudeAccountReports({ ...value, rate_limits: { ...value.rate_limits,
      model_scoped: [{ display_name: "Fable", utilization: used, resets_at: new Date(NOW + 72 * HOUR).toISOString() }],
    } }));
    const fable = { ...claude, model: "Fable", modelId: "fable" };
    for (const status of ["allowed_warning", "rejected"] as const) {
      snapshot(30);
      stream(run, { status, rateLimitType: "seven_day_overage_included", utilization: status === "rejected" ? 1 : 0.8, resetsAt: (NOW + 72 * HOUR) / 1000 });
      expect(limitOf(run.pool, claude, NOW)).toBeUndefined();
      expect(nearLimit(run.pool, claude, NOW)).toBe(false);
      expect(toolCapNow(run.pool, "claude-code", NOW, claude)).toBe(4);
      expect(toolCapNow(run.pool, "claude-code", NOW, fable)).toBe(2);
      snapshot(30);
      expect(limitOf(run.pool, fable, NOW)).toBeUndefined();
      expect(toolCapNow(run.pool, "claude-code", NOW, fable)).toBe(4);
    }
    // A complete account list retires obsolete groups without removing independent refusals.
    run.record({ toolId: "claude-code", kind: "old_plan_window", model: "retired-model", status: "rejected", resetsAt: NOW + 72 * HOUR });
    snapshot(30);
    expect(run.pool.usage!.some(report => report.model === "retired-model")).toBe(false);
    expect(run.pool.limited!.some(limit => limit.model === "retired-model")).toBe(false);
});


it("clears legacy failed-turn extra-usage blocks even when their time differs from the paid notice", () => {
  const run = fixture();

    for (const source of [undefined, "refusal"] as const) {
      run.pool.usage = [{ toolId: "claude-code", kind: "overage", status: "rejected", at: NOW - 60_000 }];
      const real = { toolId: "claude-code", source: "refusal" as const, reason: "Claude Code's spend limit", at: NOW - 55_000, until: NOW + HOUR };
      run.pool.limited = [{ toolId: "claude-code", source, reason: "Claude Code's extra usage limit", at: NOW - 55_000, until: NOW + HOUR }, real];
      stream(run, live(5, false, 100));
      run.account("claude-code", claudeAccountReports(account(5, false, 100)));
      expect(run.pool.limited).toEqual([real]);
      expect(run.pool.usage!.some(report => report.kind === "overage")).toBe(false);
    }
});
