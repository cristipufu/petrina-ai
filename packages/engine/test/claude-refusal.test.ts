import { afterAll, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { chooseProfile, limitOf, UNKNOWN_LIMIT_MS, type Pool } from "@petrina/core";
import { AgentRun } from "../src/acp-run.js";
import { Engine } from "./engine.js";
import { claudeAccountReports } from "../src/claude-usage.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { UsageLimited, type UsageInfo } from "../src/usage.js";
import { Fakes, removeDir, tempDir } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const opus = ENGINE_PROFILES.find(profile => profile.id === "opus-high")!;
const sonnet = ENGINE_PROFILES.find(profile => profile.id === "sonnet-high")!;

it("keeps a refused model or shared window until reset despite later account and live readings", async () => {
  for (const kind of ["seven_day_opus", "five_hour"]) {
    const root = tempDir("petrina-claude-refusal-refresh-"); roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ limited: [{ model: "opus", type: kind, resetsInMs: 72 * 3_600_000 }] });
    const engine = new Engine(join(root, "data"), { admissionsClosed: true, agentCommand: () => undefined, toolPath: () => "/bin/true" });
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    engine.setPoolPaused(true);
    engine.s.products.push({ id: "p", name: "Product", repo: "local/p", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title: "A task", backlog: true }))!;
    const reports: UsageInfo[] = [];
    const run = await AgentRun.start({ profile: opus, cwd: root, command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], browser: false,
      signal: new AbortController().signal, callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny", onUsage: report => { reports.push(report); engine.recordUsage(report); } },
    });
    let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
    try {
      const failure = await run.prompt("You are the Builder in Petrina.").catch(error => error);
      expect(failure).toBeInstanceOf(UsageLimited);
      const report = reports.find(report => report.kind === kind)!;
      const refusedAt = Date.now();
      engine.recordLimit(task, "builder", opus.id, failure);
      clock = spyOn(Date, "now").mockReturnValue(refusedAt + 10_000);
      // The native account shape may omit Opus/Sonnet, or report a little shared room.
      engine.recordAccountUsage("claude-code", claudeAccountReports({ rate_limits_available: true, rate_limits: {
        five_hour: { utilization: kind === "five_hour" ? 99 : 38 }, seven_day: { utilization: 6 },
        seven_day_opus: null, seven_day_sonnet: null,
        model_scoped: [{ display_name: "Fable", utilization: 9 }], extra_usage: { is_enabled: false, utilization: 100 },
      } }));
      const check = () => {
        expect(limitOf(engine.s.pool, opus, Date.now())).toMatchObject({ source: "refusal", until: report.resetsAt, reason: failure.reason });
        expect(chooseProfile({ pool: engine.s.pool, tools: [], profiles: ENGINE_PROFILES }, opus, Date.now()).kind).toBe("substitute");
        expect(!!limitOf(engine.s.pool, sonnet, Date.now())).toBe(kind === "five_hour");
      };
      check();
      engine.recordUsage({ ...report, status: "allowed", utilization: 0.1 });
      engine.recordUsage({ toolId: "claude-code", kind: "overage", status: "allowed", claudeOverage: "available" });
      check();
      clock.mockReturnValue(report.resetsAt! + 1);
      expect(limitOf(engine.s.pool, opus, Date.now())).toBeUndefined();
      expect(chooseProfile({ pool: engine.s.pool, tools: [], profiles: ENGINE_PROFILES }, opus, Date.now()).kind).toBe("planned");
    } finally { clock?.mockRestore(); await run.stop(); await engine.shutdown(); }
  }
});

it("keeps the live model scope, real reset and unstreamed words with native and synthetic turn refusals", async () => {
  for (const refusal of [undefined, "synthetic", "unrecognized"] as const) {
    const root = tempDir("petrina-claude-refusal-"); roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ limited: [{ model: "opus", type: "seven_day_opus", resetsInMs: 72 * 3_600_000, refusal }] });
    const reports: UsageInfo[] = [];
    const run = await AgentRun.start({ profile: opus, cwd: root, command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], browser: false,
      signal: new AbortController().signal, callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny", onUsage: report => reports.push(report) },
    });
    try {
      const failure = await run.prompt("You are the Builder in Petrina.").catch(error => error);
      expect(failure).toBeInstanceOf(UsageLimited);
      const report = reports.find(report => report.kind === "seven_day_opus")!;
      expect(failure).toMatchObject({ model: "opus", until: report.resetsAt, source: refusal === "unrecognized" ? "report" : "refusal" });
      expect(failure.reason).toContain("weekly");
      expect(failure.said).toContain("I drafted notes.txt");
      expect(failure.streamed).not.toBe(true);
      const pool: Pool = { limit: 4, toolCaps: {}, paused: false, limited: [{ toolId: failure.toolId, model: failure.model, until: failure.until, reason: failure.reason, source: failure.source }] };
      expect(limitOf(pool, opus, Date.now())).toBeDefined();
      expect(limitOf(pool, sonnet, Date.now())).toBeUndefined();
    } finally { await run.stop(); }
  }
});

it("keeps independent billing and account refusals actionable with available or exhausted included quota", async () => {
  for (const settings of [{ refusal: "billing" as const }, { refusal: "hold" as const }, { spendCap: true }]) {
    const root = tempDir("petrina-claude-account-refusal-"); roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ limited: [{ model: "opus", type: "seven_day_opus", resetsInMs: 72 * 3_600_000, ...settings }] });
    const run = await AgentRun.start({ profile: opus, cwd: root, command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], browser: false,
      signal: new AbortController().signal, callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" },
    });
    try {
      const before = Date.now();
      const failure = await run.prompt("You are the Builder in Petrina.").catch(error => error);
      expect(failure).toBeInstanceOf(UsageLimited);
      expect(failure.model).toBeUndefined();
      expect(failure.source).toBe("refusal");
      expect(failure.until).toBeGreaterThanOrEqual(before + UNKNOWN_LIMIT_MS);
      expect(failure.until).toBeLessThanOrEqual(Date.now() + UNKNOWN_LIMIT_MS);
      expect(failure.said).toContain("I drafted notes.txt");
    } finally { await run.stop(); }
  }
});

it("does not attribute a stopped Opus turn to another model's reported window", async () => {
  for (const refusal of [undefined, "unrecognized"] as const) {
    const root = tempDir("petrina-claude-other-window-"); roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ limited: [{ model: "opus", type: "seven_day_sonnet", refusal }] });
    const run = await AgentRun.start({ profile: opus, cwd: root, command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], browser: false,
      signal: new AbortController().signal, callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" },
    });
    try {
      const failure = await run.prompt("You are the Builder in Petrina.").catch(error => error);
      if (refusal === "unrecognized") expect(failure).not.toBeInstanceOf(UsageLimited);
      else {
        expect(failure).toBeInstanceOf(UsageLimited);
        expect(failure.model).toBeUndefined();
        expect(failure.source).toBe("refusal");
      }
    } finally { await run.stop(); }
  }
});
