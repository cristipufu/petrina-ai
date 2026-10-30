import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { mkdirSync } from "node:fs";
import { afterAll, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { chooseProfile, limitOf } from "@petrina/core";
import { AgentRun } from "@petrina/agent-runtime/acp-run";

import { claudeAccountReports } from "@petrina/agent-runtime/claude-account-report";
import { ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import { UsageLimited, type UsageInfo } from "@petrina/agent-runtime/failures";
import { Fakes } from "../../fixtures.js";

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());
const opus = ENGINE_PROFILES.find(profile => profile.id === "opus-high")!;
const sonnet = ENGINE_PROFILES.find(profile => profile.id === "sonnet-high")!;

it("keeps a refused model or shared window until reset despite later account and live readings", async () => {
  return engineCases.use("petrina-claude-refusal-refresh-", async caseOwner => {
  for (const kind of ["seven_day_opus", "five_hour"]) {
    const root = join(caseOwner.root, kind);
    mkdirSync(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ limited: [{ model: "opus", type: kind, resetsInMs: 72 * 3_600_000 }] });
    const engine = caseOwner.open(join(root, "data"), { admissionsClosed: true, agentCommand: () => undefined, toolPath: () => process.execPath });
    await caseOwner.run(engine, async () => { await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]); });
    engine.setPoolPaused(true);
    engine.s.products.push({ id: "p", name: "Product", repo: "local/p", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title: "A task", backlog: true }))!;
    const reports: UsageInfo[] = [];
    const opening = engine.agentCleanup.opening(task.id, root);
    let run: AgentRun | undefined;
    const closeRun = caseOwner.onStop(async () => { if (run) await engine.stopAgent(task.id, run); });
    const started = await caseOwner.prepare(() => AgentRun.start({ profile: opus, cwd: root, command: [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir], browser: false,
      signal: caseOwner.signal, onGone: opening.onGone, callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny", onCleanupIncomplete: opening.onCleanupIncomplete, onUsage: report => { reports.push(report); engine.recordUsage(report); } },
    }));
    run = started; opening.attach(started);
    let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
    try {
      const failure = await caseOwner.prepare(() => started.prompt("You are the Builder in Petrina.").catch(error => error));
      expect(failure).toBeInstanceOf(UsageLimited);
      const report = reports.find(report => report.kind === kind)!;
      const refusedAt = Date.now();
      engine.recordLimit(task, "builder", opus.id, failure);
      clock = spyOn(Date, "now");
      caseOwner.onStop(() => clock?.mockRestore());
      clock.mockReturnValue(refusedAt + 10_000);
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
    } finally { clock?.mockRestore(); await closeRun(); await caseOwner.stop(engine); }
  }
  });
});
