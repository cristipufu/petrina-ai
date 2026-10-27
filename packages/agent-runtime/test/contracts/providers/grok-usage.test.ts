import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { readGrokUsage } from "../../../src/grok-usage.js";
import { grokReports } from "../../../src/grok-report.js";
import { waitFor } from "@petrina/test-support/fixtures";
import { server as fixtureServer } from "../../fixtures/grok-account.js";
import { billing } from "../../fixtures/grok-account-report.js";
import { usageActors } from "../../fixtures/usage-actors.js";
const actors = usageActors(); afterAll(() => actors.close());
function server(plan: unknown) { return fixtureServer(plan); }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

it("reads the installed CLI extension without creating a session or sending a prompt, then stops", async () => {
  const fake = server(billing());
  await actors.use(fake.dir, async f => {
    let child: ChildProcess | undefined;
    const command = await f.command(fake.command);
    expect(await f.run(() => readGrokUsage({ command, env: process.env, signal: f.signal, onProcess: actual => { f.observe(actual); child = actual; } }))).toEqual(grokReports(billing()));
    expect(fake.asked().map(r => r.method)).toEqual(["initialize", "_x.ai/billing"]);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(child!.stdout!.closed && child!.stderr!.closed).toBe(true);
    await waitFor(() => !alive(fake.asked()[0]!.pid), "the account reader to stop", 5000);
  });
});

it("stops an unresponsive CLI, and reports refusal and missing executables without an AI turn", async () => {
  const hanging = server({ hang: true, ignoreStop: true });
  await actors.use(hanging.dir, async f => {
    let pid: number | undefined, child: ChildProcess | undefined;
    const command = await f.command(hanging.command);
    await f.inspect(() => readGrokUsage({ command, env: process.env, timeoutMs: 500, signal: f.signal, onProcess: actual => { f.observe(actual); child = actual; pid = actual.pid; } }), raw => expectRejection(raw, "in time"));
    expect(pid).toBeGreaterThan(0);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    await waitFor(() => !alive(pid!), "the hanging Grok reader to stop", 5000);
  });
  const refused = server({ error: "Authentication required" });
  await actors.use(refused.dir, async f => {
    const command = await f.command(refused.command);
    await f.inspect(() => readGrokUsage({ command, env: process.env, signal: f.signal, onProcess: f.observe }), raw => expectRejection(raw, "Authentication required"));
    await f.inspect(() => readGrokUsage({ command: [join(refused.dir, "no-such-grok")], env: process.env, onProcess: f.observe }), raw => expectRejection(raw, "could not start"));
  });
});

it("cancels a held billing report after a lost exit notification and joins actual native cleanup", async () => {
  const fake = server({ hang: true });
  await actors.use(fake.dir, async f => {
    const command = await f.command(fake.command), controller = new AbortController();
    let child: ChildProcess | undefined, lostExits = 0, closed = false, restore: (() => void) | undefined;
    try {
      await f.inspect(() => readGrokUsage({ command, env: process.env, signal: AbortSignal.any([f.signal, controller.signal]), onProcess(actual) {
        f.observe(actual); child = actual;
        actual.once("close", () => { closed = true; });
        const emit = actual.emit, descriptor = Object.getOwnPropertyDescriptor(actual, "emit");
        restore = () => { if (descriptor) Object.defineProperty(actual, "emit", descriptor); else Reflect.deleteProperty(actual, "emit"); };
        actual.emit = function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
          if (event === "exit") { lostExits++; return false; }
          return Reflect.apply(emit, this, [event, ...args]);
        };
      } }), async raw => {
        try {
          await waitFor(() => fake.asked().some(request => request.method === "_x.ai/billing"), "the actual held billing request", 5_000, { during: raw });
          const cancelled = Date.now(); controller.abort();
          await expectRejection(raw, "The account usage read was stopped");
          // Native stop allows at most 2s graceful + 2s force + 2s output closure; the 20s report timeout is unchanged.
          expect(Date.now() - cancelled).toBeLessThan(10_000);
          expect(lostExits).toBe(1);
          expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
          expect(closed).toBe(true);
          expect(child!.stdout!.closed && child!.stderr!.closed).toBe(true);
          expect(fake.asked().map(request => request.method)).toEqual(["initialize", "_x.ai/billing"]);
        } finally { controller.abort(); }
      });
    } finally { controller.abort(); restore?.(); }
  });
});
