import { afterAll, expect, it, spyOn } from "bun:test";
import { chooseProfile, HOLDING_BACK, headroom, limitOf, nearLimit, pickStarts, toolCapNow, usageLines, type AgentProfile } from "@petrina/core";
import { Engine } from "./engine.js";
import { claudeReports } from "@petrina/agent-runtime/claude-usage-report";
import { claudeAccountReports } from "@petrina/agent-runtime/claude-account-report";
import { limitFromFailure } from "@petrina/agent-runtime/usage";
import { removeDir, tempDir } from "./fixtures.js";

const NOW = Date.parse("2026-10-21T12:00:00Z"), HOUR = 3_600_000;
const claude: AgentProfile = { id: "opus-high", toolId: "claude-code", model: "Opus", modelId: "opus", effort: "high" };
const codex: AgentProfile = { id: "sol-high", toolId: "codex", model: "Sol", effort: "high" };
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture() {
  const root = tempDir("petrina-claude-allowances-"); roots.push(root);
  const engine = new Engine(root, { admissionsClosed: true, agentCommand: () => undefined, toolPath: () => process.execPath });
  await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
  engine.setPoolPaused(true);
  engine.s.products.push({ id: "p", name: "Product", repo: "local/p", tone: "blue" });
  const task = engine.task(engine.addTask({ productId: "p", title: "A task", backlog: true }))!;
  engine.s.pool.toolCaps["claude-code"] = 4;
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  return { engine, task, clock, close: async () => { clock.mockRestore(); await engine.shutdown(); } };
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

function view(engine: Engine) {
  const pool = engine.s.pool;
  const line = usageLines({ pool, tools: [{ id: "claude-code", name: "Claude Code", command: ["claude"], models: [], status: "ready" }] }, Date.now())[0];
  const analytics = engine.usage({ view: "analytics", period: "today" }).limits.tools.find(tool => tool.toolId === "claude-code");
  return {
    blocked: !!limitOf(pool, claude, Date.now()), room: headroom(pool, claude, Date.now()), cap: toolCapNow(pool, "claude-code", Date.now(), claude), near: nearLimit(pool, claude, Date.now()),
    choice: chooseProfile({ pool, tools: [], profiles: [claude, codex] }, claude, Date.now()).kind, line,
    latest: analytics?.limits.map(limit => [limit.label, limit.latest.utilization, limit.latest.resetsAt]),
  };
}

it("does not turn unavailable paid usage into an included-quota report", () => {
  // Native rate_limit_event payloads are forwarded verbatim by claude-agent-acp 0.89.1.
  const reports = claudeReports("claude-code", { "_claude/rateLimit": {
    status: "allowed", rateLimitType: "five_hour", utilization: 0.05,
    isUsingOverage: false, overageDisabledReason: "org_level_disabled", overageStatus: "rejected",
  } });
  expect(reports.filter(report => !("claudeOverage" in report))).toEqual([
    { toolId: "claude-code", kind: "five_hour", status: "allowed", utilization: 0.05 },
  ]);
});

it("keeps the pool and Analytics consistent for included and paid allowance combinations in either order", async () => {
  const run = await fixture();
  try {
    for (const used of [5, 100]) for (const enabled of [false, true]) for (const paid of [25, 95, 100]) {
      let expected: ReturnType<typeof view> | undefined;
      for (const order of ["account-first", "live-first"]) {
        delete run.engine.s.pool.usage; delete run.engine.s.pool.limited;
        const snapshot = () => run.engine.recordAccountUsage("claude-code", claudeAccountReports(account(used, enabled, paid)));
        const update = () => stream(run.engine, live(used, enabled, paid));
        if (order === "account-first") { snapshot(); update(); } else { update(); snapshot(); }
        update(); update();
        const actual = view(run.engine);
        expect(actual.blocked).toBe(used === 100 && (!enabled || paid === 100));
        expect(actual.choice).toBe(actual.blocked ? "substitute" : "planned");
        expect(actual.cap).toBe(used === 100 ? 2 : 4);
        expect(actual.near).toBe(false);
        expect(actual.room).toBe(used === 100 ? 0 : 0.98 / 24);
        expect(run.engine.s.pool.usage!.some(report => report.kind === "overage")).toBe(false);
        if (expected) expect(actual).toEqual(expected);
        expected = actual;
      }
    }
  } finally { await run.close(); }
});

it("keeps a healthy low-usage Claude window on its plan as account readings and live warnings alternate", async () => {
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
    const run = await fixture();
    try {
      run.engine.s.pool.toolCaps["claude-code"] = 7;
      run.engine.s.pool.limit = 10;
      // Admission, the actual profile and the displayed status agree after every update.
      const healthy = (shown: string, step: string) => {
        const pool = run.engine.s.pool, opus = run.engine.profile("opus-xhigh")!;
        expect(nearLimit(pool, opus, NOW), step).toBe(false);
        expect(toolCapNow(pool, "claude-code", NOW, opus), step).toBe(7);
        expect(pickStarts({ candidates: [fifth], inUse: running, pool: { ...pool, paused: false }, now: NOW }), step).toEqual(["fifth"]);
        expect(run.engine.choose("opus-xhigh"), step).toMatchObject({ kind: "planned", profile: { id: "opus-xhigh" } });
        const line = view(run.engine).line!;
        expect(line.tone, step).toBe("fine");
        expect(line.text, step).toContain(shown);
        expect(line.text, step).not.toContain(HOLDING_BACK);
      };
      const account = (step: string) => { run.engine.recordAccountUsage("claude-code", claudeAccountReports(snapshot(27))); healthy("weekly 27%, resets", step); };
      const live = (step: string) => { stream(run.engine, warning); healthy("weekly 26%, provider warning, resets", step); };
      if (order === "account-first") { account("account"); live("live warning"); account("account again"); }
      else { live("live warning"); account("account"); live("live warning again"); }
      // A notice that omits the percentage retains it only from the same warning window; otherwise usage is unknown.
      live("live warning before an omitted percentage");
      stream(run.engine, { status: "allowed_warning", rateLimitType: "seven_day" });
      expect(run.engine.s.pool.usage!.find(report => report.kind === "seven_day")).toMatchObject({ status: "allowed_warning", utilization: 0.26, resetsAt: weeklyReset });
      account("account after the retained warning");
      stream(run.engine, { status: "allowed_warning", rateLimitType: "seven_day" });
      expect(run.engine.s.pool.usage!.find(report => report.kind === "seven_day")!.utilization).toBeUndefined();
      healthy("weekly provider warning, percentage not reported", "warning without a percentage");
      expect(headroom(run.engine.s.pool, claude, NOW)).toBeCloseTo(0.98);
      // A partial account reading updates only its own windows.
      run.engine.recordAccountUsage("claude-code", claudeAccountReports({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 3 } } }));
      healthy("weekly provider warning, percentage not reported", "partial account");
      run.engine.recordAccountUsage("claude-code", claudeAccountReports(snapshot(27, false)));
      healthy("weekly 27%, resets", "account without a model list");
      // Real measurements still slow and move new agents, whichever status reports them.
      run.engine.recordAccountUsage("claude-code", claudeAccountReports(snapshot(85)));
      expect(toolCapNow(run.engine.s.pool, "claude-code", NOW, claude)).toBe(4);
      expect(run.engine.choose("opus-xhigh")).toMatchObject({ kind: "planned", profile: { id: "opus-xhigh" } });
      stream(run.engine, { ...warning, utilization: 0.85 });
      expect(toolCapNow(run.engine.s.pool, "claude-code", NOW, claude)).toBe(4);
      expect(view(run.engine).line).toMatchObject({ tone: "near", text: expect.stringContaining(HOLDING_BACK) });
      stream(run.engine, { ...warning, utilization: 0.9 });
      expect(run.engine.choose("opus-xhigh")).toMatchObject({ kind: "substitute", profile: { toolId: "codex", effort: "xhigh" } });
      // A request refusal outlives healthy readings and low warnings.
      run.engine.s.pool.limited = [{ toolId: "claude-code", source: "refusal", until: NOW + HOUR, reason: "Claude Code refused the request", at: NOW }];
      run.engine.recordAccountUsage("claude-code", claudeAccountReports(snapshot(27)));
      stream(run.engine, warning);
      expect(limitOf(run.engine.s.pool, claude, NOW)).toMatchObject({ source: "refusal", until: NOW + HOUR });
      expect(run.engine.choose("opus-xhigh")).toMatchObject({ kind: "substitute", profile: { toolId: "codex" } });
    } finally { await run.close(); }
  }
});

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

it("uses paid-only notices only to end known paid continuation, without inventing included readings", async () => {
  const run = await fixture();
  try {
    // Representative native partial event: anthropics/claude-agent-sdk-python#601.
    const notice = { isUsingOverage: false, overageDisabledReason: "org_level_disabled", overageStatus: "rejected" };
    stream(run.engine, notice);
    expect(run.engine.s.pool.usage).toEqual([]);
    expect(run.engine.s.pool.limited).toEqual([]);
    expect(headroom(run.engine.s.pool, claude, NOW)).toBeUndefined();
    run.engine.recordAccountUsage("claude-code", claudeAccountReports(account(100, true, 25)));
    expect(limitOf(run.engine.s.pool, claude, NOW)).toBeUndefined();
    // Not currently using paid allowance does not revoke an account-confirmed usable balance.
    stream(run.engine, { status: "rejected", rateLimitType: "five_hour", isUsingOverage: false, overageStatus: "allowed" });
    expect(limitOf(run.engine.s.pool, claude, NOW)).toBeUndefined();
    stream(run.engine, notice);
    expect(limitOf(run.engine.s.pool, claude, NOW)?.until).toBe(NOW + HOUR);
    const readings = structuredClone(run.engine.s.pool.usage);
    stream(run.engine, { overageStatus: "allowed" });
    expect(run.engine.s.pool.usage).toEqual(readings);
    expect(limitOf(run.engine.s.pool, claude, NOW)).toBeDefined();
    stream(run.engine, { status: "rejected", rateLimitType: "five_hour", isUsingOverage: true });
    expect(limitOf(run.engine.s.pool, claude, NOW)).toBeUndefined();
    expect(run.engine.s.pool.usage!.find(report => report.kind === "five_hour")).toMatchObject({ utilization: 1, resetsAt: NOW + HOUR, overage: true });
    stream(run.engine, { overageStatus: "rejected", overageResetsAt: (NOW - 1) / 1000 });
    expect(limitOf(run.engine.s.pool, claude, NOW)).toBeUndefined();
    stream(run.engine, { status: "rejected", rateLimitType: "overage", resetsAt: (NOW - 1) / 1000 });
    expect(limitOf(run.engine.s.pool, claude, NOW)).toBeUndefined();
  } finally { await run.close(); }
});

it("does not infer paid continuation from entitlement or unknown fields", () => {
  for (const fields of [{ overageStatus: "allowed" }, { overageEnabled: true }, { overageInUse: false }, { overageDisabledReason: "unknown" }, { overageDisabledReason: "fetch_error" }]) {
    expect(claudeReports("claude-code", { "_claude/rateLimit": { status: "rejected", rateLimitType: "seven_day", ...fields } })[0]?.overage).not.toBe(true);
  }
  expect(claudeReports("claude-code", { "_claude/rateLimit": { status: "rejected", rateLimitType: "seven_day", overageInUse: true } })[0]?.overage).toBe(true);
  expect(claudeReports("claude-code", { "_claude/rateLimit": { status: "rejected", rateLimitType: "seven_day", isUsingOverage: true, overageStatus: "rejected" } })[0]?.overage).toBe(false);
  for (const invalid of [undefined, null, -1, 101, NaN, Infinity]) {
    expect(claudeAccountReports(account(100, true, invalid))[0]?.overage).not.toBe(true);
  }
});

it("retains unrelated windows and known percentages across partial account and live readings", async () => {
  const run = await fixture();
  try {
    run.engine.recordAccountUsage("claude-code", claudeAccountReports(account(5, false, 100)));
    stream(run.engine, { status: "allowed", rateLimitType: "five_hour", overageStatus: "rejected" });
    expect(headroom(run.engine.s.pool, claude, NOW)).toBe(0.98 / 24);
    run.engine.recordAccountUsage("claude-code", claudeAccountReports({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 7 } } }));
    expect(run.engine.s.pool.usage!.map(report => report.kind).sort()).toEqual(["five_hour", "seven_day"]);
    stream(run.engine, { status: "rejected", rateLimitType: "seven_day_opus", utilization: 1, resetsAt: (NOW + HOUR) / 1000 });
    run.engine.recordAccountUsage("claude-code", claudeAccountReports(account(5, false, 100)));
    expect(limitOf(run.engine.s.pool, claude, NOW)?.model).toBe("opus");
    const complete = account(5, false, 100);
    run.engine.recordAccountUsage("claude-code", claudeAccountReports({ ...complete, rate_limits: { ...complete.rate_limits, model_scoped: [] } }));
    expect(limitOf(run.engine.s.pool, claude, NOW)).toBeUndefined();
    expect(run.engine.s.pool.usage!.some(report => "claudeAccountComplete" in report)).toBe(false);
    stream(run.engine, { status: "allowed_warning", rateLimitType: "seven_day_opus" });
    const scoped = run.engine.s.pool.usage!.find(report => report.model === "opus")!;
    expect(scoped.utilization).toBeUndefined();
    expect(scoped.resetsAt).toBeUndefined();
    // Kept and shown as the provider's warning, with no percentage invented for it.
    expect(scoped.status).toBe("allowed_warning");
    expect(view(run.engine).line!.text).toContain("weekly Opus provider warning, percentage not reported");
    expect(nearLimit(run.engine.s.pool, claude, NOW)).toBe(false);
    expect(nearLimit(run.engine.s.pool, { ...claude, model: "Sonnet", modelId: "sonnet" }, NOW)).toBe(false);
  } finally { await run.close(); }
});

it("keeps admission and percentage consistent when the live reset has seconds and the account reset has milliseconds", async () => {
  const reset = NOW + HOUR + 118;
  for (const order of ["account-first", "live-first"]) {
    const run = await fixture();
    try {
      const raw = account(85, false, 100);
      raw.rate_limits.five_hour.resets_at = new Date(reset).toISOString();
      const snapshot = () => run.engine.recordAccountUsage("claude-code", claudeAccountReports(raw));
      const notice = () => stream(run.engine, { status: "allowed", rateLimitType: "five_hour", resetsAt: Math.floor(reset / 1000) });
      if (order === "account-first") { snapshot(); notice(); } else { notice(); snapshot(); }
      const reading = run.engine.s.pool.usage!.find(report => report.kind === "five_hour")!;
      expect(reading.utilization).toBe(0.85);
      expect(reading.resetsAt).toBe(reset);
      expect(toolCapNow(run.engine.s.pool, "claude-code", NOW, claude)).toBe(2);
      // An actually different reset or two distinct precise timestamps establish a different reading.
      for (const nextReset of [NOW + HOUR + 1_000, NOW + HOUR + 219]) {
        snapshot();
        run.engine.recordUsage({ toolId: "claude-code", kind: "five_hour", status: "allowed", resetsAt: nextReset });
        expect(run.engine.s.pool.usage!.find(report => report.kind === "five_hour")!.utilization).toBeUndefined();
      }
      snapshot();
      stream(run.engine, { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(reset / 1000) });
      expect(run.engine.s.pool.usage!.find(report => report.kind === "five_hour")!.utilization).toBeUndefined();
      expect(limitOf(run.engine.s.pool, claude, NOW)).toBeDefined();
    } finally { await run.close(); }
  }
});

it("releases included quota at its reset even when paid usage stays exhausted and repeats expired notices", async () => {
  const run = await fixture();
  try {
    run.engine.recordAccountUsage("claude-code", claudeAccountReports(account(100, false, 100)));
    run.clock.mockReturnValue(NOW + HOUR + 1);
    stream(run.engine, live(100, false, 100));
    stream(run.engine, { status: "rejected", rateLimitType: "overage", resetsAt: (NOW + 10 * HOUR) / 1000 });
    stream(run.engine, { overageStatus: "rejected", overageResetsAt: (NOW - HOUR) / 1000 });
    expect(limitOf(run.engine.s.pool, claude, Date.now())).toBeUndefined();
    expect(headroom(run.engine.s.pool, claude, Date.now())).toBeGreaterThan(0);
    expect(toolCapNow(run.engine.s.pool, "claude-code", Date.now(), claude)).toBe(4);
    // With no reset, paid-only notices also cannot renew the included cooldown.
    run.clock.mockReturnValue(NOW);
    stream(run.engine, { status: "rejected", rateLimitType: "five_hour" });
    const until = limitOf(run.engine.s.pool, claude, NOW)!.until;
    run.clock.mockReturnValue(NOW + 60_000);
    stream(run.engine, { overageStatus: "rejected" });
    expect(limitOf(run.engine.s.pool, claude, Date.now())!.until).toBe(until);
    run.clock.mockReturnValue(until + 1);
    stream(run.engine, { overageStatus: "rejected" });
    expect(limitOf(run.engine.s.pool, claude, Date.now())).toBeUndefined();
  } finally { await run.close(); }
});

it("keeps real rate, billing, account and synthetic refusals despite healthy readings in either order", async () => {
  const run = await fixture();
  try {
    // Older saved refusals without report provenance must survive a longer inferred quota block.
    const legacy = { toolId: "claude-code", reason: "Claude Code's rate limit", until: NOW + 5 * 60_000, at: NOW - 1 };
    run.engine.s.pool.limited = [legacy];
    stream(run.engine, live(100, false, 100));
    run.engine.recordAccountUsage("claude-code", claudeAccountReports(account(5, false, 100)));
    expect(limitOf(run.engine.s.pool, claude, NOW)).toMatchObject(legacy);
    for (const error of [
      { data: { errorKind: "rate_limit" } }, { data: { errorKind: "billing_error" } }, { data: { errorKind: "account_on_hold" } },
      new Error("Internal error: You're out of extra usage"), new Error("Internal error: You've hit your usage limit · resets 8pm"),
    ]) for (const first of [true, false]) {
      delete run.engine.s.pool.usage; delete run.engine.s.pool.limited;
      const refresh = () => { run.engine.recordAccountUsage("claude-code", claudeAccountReports(account(5, false, 100))); stream(run.engine, live(5, false, 100)); };
      if (first) refresh();
      const failure = limitFromFailure(claude, error, "", NOW)!;
      run.engine.recordLimit(run.task, "builder", claude.id, failure);
      if (!first) refresh();
      // Even another report-derived block at the same instant must not replace the refusal.
      stream(run.engine, live(100, false, 100)); refresh();
      stream(run.engine, { overageStatus: "allowed" });
      expect(limitOf(run.engine.s.pool, claude, NOW)).toMatchObject({ source: "refusal", reason: failure.reason, until: failure.until });
      expect(run.engine.s.pool.limited!.filter(limit => limit.source === "refusal")).toHaveLength(1);
    }
  } finally { await run.close(); }
});

it("reconciles live and account model windows in both recovery directions and wakes waiting work", async () => {
  const run = await fixture();
  const wake = spyOn(run.engine, "schedule").mockImplementation(() => {});
  try {
    const reset = NOW + 72 * HOUR;
    for (const [model, kind] of [["opus", "seven_day_opus"], ["sonnet", "seven_day_sonnet"], ["fable", "seven_day_overage_included"]]) {
      const profile = { ...claude, model: model!, modelId: model };
      const snapshot = (used: number) => {
        const value = account(5, false, 100);
        run.engine.recordAccountUsage("claude-code", claudeAccountReports({ ...value, rate_limits: { ...value.rate_limits,
          model_scoped: [{ display_name: model, utilization: used, resets_at: new Date(reset).toISOString() }],
        } }));
      };
      const update = (used: number) => stream(run.engine, { status: used === 100 ? "rejected" : "allowed", rateLimitType: kind, utilization: used / 100, resetsAt: reset / 1000 });
      for (const accountFirst of [false, true]) {
        delete run.engine.s.pool.usage; delete run.engine.s.pool.limited;
        if (accountFirst) snapshot(100); else update(100);
        expect(limitOf(run.engine.s.pool, profile, NOW)?.model).toBe(model);
        const before = wake.mock.calls.length;
        if (accountFirst) update(10); else snapshot(10);
        expect(limitOf(run.engine.s.pool, profile, NOW)).toBeUndefined();
        expect(toolCapNow(run.engine.s.pool, "claude-code", NOW, profile)).toBe(4);
        expect(nearLimit(run.engine.s.pool, profile, NOW)).toBe(false);
        expect(headroom(run.engine.s.pool, profile, NOW)).toBeGreaterThan(0);
        expect(run.engine.s.pool.usage!.filter(report => report.model === model)).toHaveLength(1);
        const chart = run.engine.usage({ view: "analytics", period: "today" }).limits.tools.find(tool => tool.toolId === "claude-code")!;
        expect(chart.limits.find(line => line.key === `claude-code|${kind}|${model}`)?.latest.utilization).toBe(0.1);
        expect(wake.mock.calls.length).toBeGreaterThan(before);
      }
    }
  } finally { wake.mockRestore(); await run.close(); }
});

it("normalizes saved model aliases and leaves missing or invalid account lists partial", async () => {
  const run = await fixture();
  try {
    const reset = NOW + 72 * HOUR;
    // Earlier snapshots used generic model kinds, or left the native Fable kind tool-wide.
    run.engine.s.pool.usage = [
      { toolId: "claude-code", kind: "seven_day_model", model: "opus", name: "opus", windowMinutes: 10_080, status: "rejected", utilization: 1, resetsAt: reset, at: NOW - 1000 },
      { toolId: "claude-code", kind: "seven_day_overage_included", status: "rejected", utilization: 1, resetsAt: reset, at: NOW - 1000 },
    ];
    run.engine.s.pool.limited = [{ toolId: "claude-code", reason: "Claude Code's weekly limit", until: reset, at: NOW - 1000 }];
    stream(run.engine, { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1, resetsAt: reset / 1000 });
    expect(limitOf(run.engine.s.pool, claude, NOW)).toBeUndefined();
    expect(limitOf(run.engine.s.pool, { ...claude, model: "Fable", modelId: "fable" }, NOW)?.model).toBe("fable");
    const value = account(5, false, 100);
    for (const model_scoped of [undefined, [{ display_name: "Fable", utilization: null }], [{ display_name: "Opus", utilization: 10 }, {}]]) {
      run.engine.recordAccountUsage("claude-code", claudeAccountReports({ ...value, rate_limits: { ...value.rate_limits, model_scoped } }));
      expect(limitOf(run.engine.s.pool, { ...claude, model: "Fable", modelId: "fable" }, NOW)?.model).toBe("fable");
    }
  } finally { await run.close(); }
});

it("keeps Fable notices scoped to Fable and accepts a complete nonempty account model list", async () => {
  const run = await fixture();
  try {
    const value = account(5, false, 100);
    const snapshot = (used: number) => run.engine.recordAccountUsage("claude-code", claudeAccountReports({ ...value, rate_limits: { ...value.rate_limits,
      model_scoped: [{ display_name: "Fable", utilization: used, resets_at: new Date(NOW + 72 * HOUR).toISOString() }],
    } }));
    const fable = { ...claude, model: "Fable", modelId: "fable" };
    for (const status of ["allowed_warning", "rejected"] as const) {
      snapshot(30);
      stream(run.engine, { status, rateLimitType: "seven_day_overage_included", utilization: status === "rejected" ? 1 : 0.8, resetsAt: (NOW + 72 * HOUR) / 1000 });
      expect(limitOf(run.engine.s.pool, claude, NOW)).toBeUndefined();
      expect(nearLimit(run.engine.s.pool, claude, NOW)).toBe(false);
      expect(toolCapNow(run.engine.s.pool, "claude-code", NOW, claude)).toBe(4);
      expect(toolCapNow(run.engine.s.pool, "claude-code", NOW, fable)).toBe(2);
      snapshot(30);
      expect(limitOf(run.engine.s.pool, fable, NOW)).toBeUndefined();
      expect(toolCapNow(run.engine.s.pool, "claude-code", NOW, fable)).toBe(4);
    }
    // A complete account list retires obsolete groups without removing independent refusals.
    run.engine.recordUsage({ toolId: "claude-code", kind: "old_plan_window", model: "retired-model", status: "rejected", resetsAt: NOW + 72 * HOUR });
    snapshot(30);
    expect(run.engine.s.pool.usage!.some(report => report.model === "retired-model")).toBe(false);
    expect(run.engine.s.pool.limited!.some(limit => limit.model === "retired-model")).toBe(false);
  } finally { await run.close(); }
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

it("clears legacy failed-turn extra-usage blocks even when their time differs from the paid notice", async () => {
  const run = await fixture();
  try {
    for (const source of [undefined, "refusal"] as const) {
      run.engine.s.pool.usage = [{ toolId: "claude-code", kind: "overage", status: "rejected", at: NOW - 60_000 }];
      const real = { toolId: "claude-code", source: "refusal" as const, reason: "Claude Code's spend limit", at: NOW - 55_000, until: NOW + HOUR };
      run.engine.s.pool.limited = [{ toolId: "claude-code", source, reason: "Claude Code's extra usage limit", at: NOW - 55_000, until: NOW + HOUR }, real];
      stream(run.engine, live(5, false, 100));
      run.engine.recordAccountUsage("claude-code", claudeAccountReports(account(5, false, 100)));
      expect(run.engine.s.pool.limited).toEqual([real]);
      expect(run.engine.s.pool.usage!.some(report => report.kind === "overage")).toBe(false);
    }
  } finally { await run.close(); }
});
