import { afterAll, expect, it } from "bun:test";
import { limitOf, UNKNOWN_LIMIT_MS, type Pool } from "@petrina/core";
import { AgentRun } from "../../../src/acp-run.js";
import { ENGINE_PROFILES } from "../../../src/tools.js";
import { UsageLimited, type UsageInfo } from "../../../src/failures.js";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { nativeSession } from "../../fixtures/native-session.js";
import type { NativeStep } from "../../fixtures/protocol-actions.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const opus = ENGINE_PROFILES.find(profile => profile.id === "opus-high")!;
const sonnet = ENGINE_PROFILES.find(profile => profile.id === "sonnet-high")!;
function refusalPeer(root: string, options: { model: string; type: string; resetsInMs?: number; spendCap?: boolean; refusal?: "synthetic" | "unrecognized" | "billing" | "hold" }) {
  const resetsAt = Math.ceil((Date.now() + (options.resetsInMs ?? 3_600_000)) / 1000);
  const info = options.spendCap ? { status: "allowed", rateLimitType: "five_hour", utilization: 0.4, overageStatus: "rejected", overageResetsAt: resetsAt }
    : { status: "rejected", rateLimitType: options.type, utilization: 1, resetsAt };
  const errorKind = options.spendCap || options.refusal === "billing" ? "billing_error" : options.refusal === "hold" ? "account_on_hold" : "rate_limit";
  const message = options.spendCap ? "Internal error" : options.refusal === "unrecognized" ? "Claude usage limit reached" : `Internal error: You've hit your ${options.type === "seven_day_opus" ? "Opus" : "usage"} limit`;
  const steps: NativeStep[] = [
    { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I drafted notes.txt and started on the greeting file before running out." } } },
    { update: { sessionUpdate: "usage_update", used: 100, size: 1000, _meta: { "_claude/rateLimit": info } } },
    { fail: { code: -32603, message, data: options.refusal === "synthetic" || options.refusal === "unrecognized" ? {} : { errorKind } } },
  ];
  return nativeSession(root, { prompt: { steps } });
}
it("keeps the live model scope, real reset and unstreamed words with native and synthetic turn refusals", async () => {
  for (const refusal of [undefined, "synthetic", "unrecognized"] as const) {
    const root = tempDir("petrina-claude-refusal-"); roots.push(root);
    const peer = refusalPeer(root, { model: "opus", type: "seven_day_opus", resetsInMs: 72 * 3_600_000, refusal } );
    const reports: UsageInfo[] = [];
    const run = await AgentRun.start({ profile: opus, cwd: root, command: peer.command, browser: false,
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
    const peer = refusalPeer(root, { model: "opus", type: "seven_day_opus", resetsInMs: 72 * 3_600_000, ...settings } );
    const run = await AgentRun.start({ profile: opus, cwd: root, command: peer.command, browser: false,
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
    const peer = refusalPeer(root, { model: "opus", type: "seven_day_sonnet", refusal } );
    const run = await AgentRun.start({ profile: opus, cwd: root, command: peer.command, browser: false,
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
