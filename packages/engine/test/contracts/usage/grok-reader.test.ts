import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { removeDir, waitFor } from "../../fixtures.js";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { billing } from "../../../../agent-runtime/test/fixtures/grok-account-report.js";
import { server as fixtureServer } from "../../../../agent-runtime/test/fixtures/grok-account.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
function server(plan: unknown) { const value = fixtureServer(plan); roots.push(value.dir); return value; }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
describe("Grok account usage", () => {
  it("shares one cached reader across engine startup, Analytics and agent refreshes, and retains the chart history", async () => {
    const fake = server(billing(85));
    const engine = new Engine(join(fake.dir, "data"), { agentCommand: () => [], usageCommands: { grok: fake.command }, toolPath: () => "/fake/tool" });
    try {
      await waitFor(() => engine.getState().pool.usage?.some(r => r.toolId === "grok"), "Grok's startup reading");
      for (let n = 0; n < 5; n++) { engine.readUsage("grok"); engine.usage({ view: "analytics", period: "today" }); }
      await engine.usageCoordinator.readers.get("grok")!.refresh(60_000);
      expect(fake.asked().filter(r => r.method === "_x.ai/billing")).toHaveLength(1);
      expect(engine.usage({ view: "analytics", period: "today" }).limits.tools.find(t => t.toolId === "grok")?.limits[0]?.latest.utilization).toBe(0.85);
      writeFixtureJson(join(fake.dir, "billing.json"), { hang: true, ignoreStop: true });
      const reading = engine.usageCoordinator.readers.get("grok")!.refresh();
      await waitFor(() => fake.asked().filter(r => r.method === "_x.ai/billing").length === 2, "a pending account read");
      const pid = fake.asked().at(-1)!.pid;
      await engine.shutdown();
      await waitFor(() => !alive(pid), "shutdown to stop its account reader", 5000);
      await reading;
    } finally { await engine.shutdown(); }
  });

  it("shows failed account refreshes to the window without changing the last confirmed percentage or its age", async () => {
    const fake = server(billing(57));
    const engine = new Engine(join(fake.dir, "data"), { agentCommand: () => [], usageCommands: { grok: fake.command }, toolPath: () => "/fake/tool" });
    try {
      await waitFor(() => engine.windowState().pool.usageReads?.grok?.state === "reported", "a confirmed account reading");
      const report = engine.windowState().pool.usage!.find((entry) => entry.toolId === "grok")!;
      writeFixtureJson(join(fake.dir, "billing.json"), { error: "Meter unavailable" });
      await engine.usageCoordinator.readers.get("grok")!.refresh();
      const pool = engine.windowState().pool;
      expect(pool.usageReads?.grok?.state).toBe("unavailable");
      expect(pool.usage!.find((entry) => entry.toolId === "grok")).toEqual(report);
      expect(report.utilization).toBe(0.57);
    } finally { await engine.shutdown(); }
  });
});
