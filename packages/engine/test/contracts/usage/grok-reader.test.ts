import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import * as processes from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Engine } from "../../engine.js";
import { directDrivers } from "../../fixtures/direct-drivers.js";
import { usageActors } from "../../../../agent-runtime/test/fixtures/usage-actors.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { tempDir, waitFor } from "../../fixtures.js";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { billing } from "../../../../agent-runtime/test/fixtures/grok-account-report.js";
import { server as fixtureServer } from "../../../../agent-runtime/test/fixtures/grok-account.js";
const actors = usageActors(); afterAll(() => actors.close());
function server(plan: unknown) { return fixtureServer(plan); }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function withReader(fake: ReturnType<typeof server>, body: (engine: Engine, child: () => ChildProcess) => Promise<void>) {
  const root = tempDir("petrina-grok-reader-engine-"), owner = directDrivers(root);
  await actors.use(fake.dir, async f => {
    let restore: (() => void) | undefined, latest: ChildProcess | undefined;
    const finish = async () => {
      const errors: unknown[] = [];
      try { await owner.close(); } catch (error) { errors.push(error); }
      try { restore?.(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Account Engine fixture cleanup was not confirmed");
    };
    await setupWithCleanup(() => owner.prepare(async () => {
      const command = await f.command(fake.command), original = processes.spawn;
      const capture = spyOn(processes, "spawn"); restore = () => capture.mockRestore();
      capture.mockImplementation(((...args: Parameters<typeof processes.spawn>) => {
        const child = Reflect.apply(original, processes, args) as ChildProcess;
        if (args[0] === command[0] && JSON.stringify(args[1]) === JSON.stringify(command.slice(1))) { f.observe(child); latest = child; }
        return child;
      }) as typeof processes.spawn);
      const engine = owner.open(join(root, "data"), { agentCommand: () => [], usageCommands: { grok: command }, toolPath: () => "/fake/tool" });
      await owner.run(engine, () => body(engine, () => latest!));
    }), finish);
    await finish();
  });
}

describe("Grok account usage", () => {
  it("shares one cached reader across engine startup, Analytics and agent refreshes, and retains the chart history", async () => {
    const fake = server(billing(85));
    await withReader(fake, async (engine, child) => {
      await waitFor(() => engine.getState().pool.usage?.some(r => r.toolId === "grok"), "Grok's startup reading");
      for (let n = 0; n < 5; n++) { engine.readUsage("grok"); engine.usage({ view: "analytics", period: "today" }); }
      await engine.usageCoordinator.readers.get("grok")!.refresh(60_000);
      expect(fake.asked().filter(r => r.method === "_x.ai/billing")).toHaveLength(1);
      expect(engine.usage({ view: "analytics", period: "today" }).limits.tools.find(t => t.toolId === "grok")?.limits[0]?.latest.utilization).toBe(0.85);
      writeFixtureJson(join(fake.dir, "billing.json"), { hang: true, ignoreStop: true });
      const reading = engine.usageCoordinator.readers.get("grok")!.refresh();
      await waitFor(() => fake.asked().filter(r => r.method === "_x.ai/billing").length === 2, "a pending account read", undefined, { during: reading });
      const pid = fake.asked().at(-1)!.pid;
      await engine.shutdown();
      expect(child().exitCode !== null || child().signalCode !== null).toBe(true);
      expect(child().stdout!.closed && child().stderr!.closed).toBe(true);
      await waitFor(() => !alive(pid), "shutdown to stop its account reader", 5000);
      await reading;
    });
  });

  it("shows failed account refreshes to the window without changing the last confirmed percentage or its age", async () => {
    const fake = server(billing(57));
    await withReader(fake, async (engine, child) => {
      await waitFor(() => engine.windowState().pool.usageReads?.grok?.state === "reported", "a confirmed account reading");
      const report = engine.windowState().pool.usage!.find((entry) => entry.toolId === "grok")!;
      writeFixtureJson(join(fake.dir, "billing.json"), { error: "Meter unavailable" });
      await engine.usageCoordinator.readers.get("grok")!.refresh();
      expect(child().exitCode !== null || child().signalCode !== null).toBe(true);
      expect(child().stdout!.closed && child().stderr!.closed).toBe(true);
      const pool = engine.windowState().pool;
      expect(pool.usageReads?.grok?.state).toBe("unavailable");
      expect(pool.usage!.find((entry) => entry.toolId === "grok")).toEqual(report);
      expect(report.utilization).toBe(0.57);
    });
  });
});
