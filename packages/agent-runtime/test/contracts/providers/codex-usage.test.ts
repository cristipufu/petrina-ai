import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readCodexUsage } from "../../../src/codex-usage.js";
import { removeDir, waitFor } from "@petrina/test-support/fixtures";
import { appServer as fixtureServer } from "../../fixtures/codex-account.js";
import type { CodexScript } from "../../fixtures/fake-codex.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
function appServer(plan: CodexScript) { const server = fixtureServer(plan); roots.push(server.dir); return server; }

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const soon = Math.floor(Date.now() / 1000) + 3600;

describe("what Codex's app-server says about usage", () => {
  it("forces an app-server that reports usage but ignores its normal stop", async () => {
    const server = appServer({ ignoreTerm: true, primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.round(Date.now() / 1000) + 3600 } });
    let child: import("node:child_process").ChildProcess | undefined;
    try {
      const reports = await readCodexUsage({ command: server.command, env: process.env, onProcess: process => { child = process; } });
      expect(reports[0]!.utilization).toBe(0.1);
      await waitFor(() => child?.signalCode === "SIGKILL", "the stubborn app-server to be forced closed", 5000);
      expect(alive(child!.pid!)).toBe(false);
    } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });

  it("does the adapter's handshake first, reads once, and stops the process", async () => {
    const server = appServer({ primary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: soon } });
    const reports = await readCodexUsage({ command: server.command, env: process.env });
    expect(reports).toEqual([{ toolId: "codex", kind: "codex:primary", windowMinutes: 10080, status: "allowed", utilization: 0.85, resetsAt: soon * 1000 }]);
    const asked = server.asked();
    expect(asked.map((entry) => entry.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(asked[0]!.params?.clientInfo?.name).toBe("petrina");
    await waitFor(() => !alive(asked[0]!.pid), "the app-server to be gone", 5_000);
  });

  it("gives up within its time limit when Codex does not answer, and says plainly when it refuses or is missing", async () => {
    const hanging = appServer({ hang: true });
    for (const server of [hanging, appServer({ hang: true, bootDelayMs: 1500 })]) {
      let pid: number | undefined;
      const started = Date.now();
      await expectRejection(readCodexUsage({ command: server.command, env: process.env, timeoutMs: 700, onProcess: (child) => { pid = child.pid; } }), "Codex did not answer within 1 seconds");
      expect(Date.now() - started).toBeLessThan(10_000);
      // The deadline may pass before the executable handles even its first request.
      expect(pid).toBeGreaterThan(0);
      await waitFor(() => !alive(pid!), "the hanging app-server to be gone", 5_000);
    }
    const refusing = appServer({ error: "not logged in" });
    await expectRejection(readCodexUsage({ command: refusing.command, env: process.env }), "not logged in");
    await expectRejection(readCodexUsage({ command: [join(hanging.dir, "no-such-codex"), "app-server"], env: process.env }), "Codex is not installed");
  });
});
