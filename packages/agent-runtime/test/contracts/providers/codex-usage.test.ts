import { expectRejection, rejectionOf } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readCodexUsage } from "../../../src/codex-usage.js";
import { waitFor } from "@petrina/test-support/fixtures";
import { appServer as fixtureServer } from "../../fixtures/codex-account.js";
import type { CodexScript } from "../../fixtures/fake-codex.js";
import { usageActors } from "../../fixtures/usage-actors.js";
const actors = usageActors(), releases = new Set<() => void>();
afterAll(async () => {
  const errors: unknown[] = [];
  for (const release of releases) try { release(); } catch (error) { errors.push(error); }
  try { await actors.close(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Account startup control cleanup failed");
});
function appServer(plan: CodexScript) { return fixtureServer(plan); }
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const soon = Math.floor(Date.now() / 1000) + 3600;

describe("what Codex's app-server says about usage", () => {
  it("forces an app-server that reports usage but ignores its normal stop", async () => {
    const server = appServer({ ignoreTerm: true, primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.round(Date.now() / 1000) + 3600 } });
    await actors.use(server.dir, async f => {
      let child: import("node:child_process").ChildProcess | undefined;
      try {
        const command = await f.command(server.command);
        const reports = await f.run(() => readCodexUsage({ command, env: process.env, signal: f.signal, onProcess: process => { f.observe(process); child = process; } }));
        const expectedSignal = process.platform === "win32" ? "SIGTERM" : "SIGKILL";
        expect(reports[0]!.utilization).toBe(0.1);
        expect(child!.signalCode).toBe(expectedSignal);
        expect(child!.stdout!.closed && child!.stderr!.closed).toBe(true);
        await waitFor(() => child?.signalCode === expectedSignal, "the stubborn app-server to be forced closed", 5000);
        expect(alive(child!.pid!)).toBe(false);
      } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    });
  });

  it("does the adapter's handshake first, reads once, and stops the process", async () => {
    const server = appServer({ primary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: soon } });
    await actors.use(server.dir, async f => {
      let child: import("node:child_process").ChildProcess | undefined;
      const command = await f.command(server.command);
      const reports = await f.run(() => readCodexUsage({ command, env: process.env, signal: f.signal, onProcess: actual => { f.observe(actual); child = actual; } }));
      expect(reports).toEqual([{ toolId: "codex", kind: "codex:primary", windowMinutes: 10080, status: "allowed", utilization: 0.85, resetsAt: soon * 1000 }]);
      const asked = server.asked();
      expect(asked.map((entry) => entry.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
      expect(asked[0]!.params?.clientInfo?.name).toBe("petrina");
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      expect(child!.stdout!.closed && child!.stderr!.closed).toBe(true);
      await waitFor(() => !alive(asked[0]!.pid), "the app-server to be gone", 5_000);
    });
  });

  it("gives up within its time limit when Codex does not answer, and says plainly when it refuses or is missing", async () => {
    const hanging = appServer({ hang: true });
    for (const server of [hanging, appServer({ hang: true, bootDelayMs: 1500 })]) await actors.use(server.dir, async f => {
      let pid: number | undefined, child: import("node:child_process").ChildProcess | undefined;
      const command = await f.command(server.command), started = Date.now();
      await f.inspect(() => readCodexUsage({ command, env: process.env, timeoutMs: 700, signal: f.signal, onProcess: actual => { f.observe(actual); child = actual; pid = actual.pid; } }), raw => expectRejection(raw, "Codex did not answer within 1 seconds"));
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(pid).toBeGreaterThan(0);
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      await waitFor(() => !alive(pid!), "the hanging app-server to be gone", 5_000);
    });
    const refusing = appServer({ error: "not logged in" });
    await actors.use(refusing.dir, async f => {
      const command = await f.command(refusing.command);
      await f.inspect(() => readCodexUsage({ command, env: process.env, signal: f.signal, onProcess: f.observe }), raw => expectRejection(raw, "not logged in"));
      await f.inspect(() => readCodexUsage({ command: [join(hanging.dir, "no-such-codex"), "app-server"], env: process.env, onProcess: f.observe }), raw => expectRejection(raw, "Codex is not installed"));
    });
  });
});


for (const failure of [new Error("Captured account observer failed"), undefined]) it(`owns a native Codex child when its observer rejects ${String(failure)}`, async () => {
  const server = appServer({});
  await actors.use(server.dir, async f => {
    const command = await f.command(server.command);
    let child: import("node:child_process").ChildProcess | undefined;
    await f.inspect(() => readCodexUsage({ command, env: process.env, onProcess(actual) {
      f.observe(actual); child = actual; throw failure;
    } }), async raw => { expect(await rejectionOf(raw)).toBe(failure); });
    expect(child).toBeDefined();
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(child!.stdout!.closed && child!.stderr!.closed).toBe(true);
    expect(server.asked()).toEqual([]);
  });
});

it("joins a missing executable's delayed close without converting its native startup failure into cleanup uncertainty", async () => {
  const server = appServer({});
  let holding = true, released = false, heldClose: (() => void) | undefined, restore: (() => void) | undefined;
  const release = () => { holding = false; released = true; restore?.(); const deliver = heldClose; heldClose = undefined; deliver?.(); };
  releases.add(release);
  try {
    await actors.use(server.dir, async f => {
      let child: import("node:child_process").ChildProcess | undefined, nativeFailure: unknown, closed = false;
      await f.inspect(() => readCodexUsage({ command: [join(server.dir, "no-delayed-codex")], env: process.env, signal: f.signal,
        onProcess(actual) {
          f.observe(actual); child = actual;
          actual.once("error", error => { nativeFailure = error; });
          actual.once("close", () => { closed = true; });
          const emit = actual.emit, descriptor = Object.getOwnPropertyDescriptor(actual, "emit");
          restore = () => { if (descriptor) Object.defineProperty(actual, "emit", descriptor); else Reflect.deleteProperty(actual, "emit"); };
          actual.emit = function (this: import("node:child_process").ChildProcess, event: string | symbol, ...args: unknown[]) {
            if (event === "close" && holding) { heldClose = () => { Reflect.apply(emit, this, [event, ...args]); }; return false; }
            return Reflect.apply(emit, this, [event, ...args]);
          };
        },
      }), async raw => {
        let reportedAfterRelease = false;
        void raw.then(() => { reportedAfterRelease = released; }, () => { reportedAfterRelease = released; });
        try {
          await waitFor(() => heldClose, "the actual failed-spawn close notification", 5_000, { during: raw });
          expect(nativeFailure).toBeDefined(); expect(closed).toBe(false);
          release();
          const error = await rejectionOf(raw);
          expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(AggregateError);
          expect((error as Error).message).toContain("Codex is not installed");
          expect(reportedAfterRelease).toBe(true);
          expect(closed).toBe(true);
          expect(child!.pid).toBeUndefined(); expect(child!.exitCode).toBeNull(); expect(child!.signalCode).toBeNull();
          expect(child!.stdout!.closed && child!.stderr!.closed).toBe(true);
          expect(server.asked()).toEqual([]);
        } finally { release(); }
      });
    });
  } finally { release(); releases.delete(release); }
});
