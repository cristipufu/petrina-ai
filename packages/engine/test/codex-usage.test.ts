import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FEWER_START, slotUses, type State } from "@petrina/core";
import { codexReports, readCodexUsage } from "../src/codex-usage.js";
import { Engine } from "../src/engine.js";
import type { CodexScript } from "./fake-codex.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const fakeCodex = join(import.meta.dir, "fake-codex.ts");
const fakeAgent = join(import.meta.dir, "fake-agent.ts");
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** A folder with the fake app-server's script, and what it was asked. */
function appServer(plan: CodexScript) {
  const dir = tempDir("petrina-codex-");
  roots.push(dir);
  writeFileSync(join(dir, "codex.json"), JSON.stringify(plan));
  const asked = () => (existsSync(join(dir, "codex.jsonl")) ? readFileSync(join(dir, "codex.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { pid: number; method: string; params?: { clientInfo?: { name: string } } }) : []);
  return { dir, command: [process.execPath, fakeCodex, dir], asked };
}

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

  it("maps each window by its length, with the reset time in milliseconds, and the status by how much is used", () => {
    const result = { rateLimits: { primary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: soon }, secondary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: null } } };
    expect(codexReports(result)).toEqual([
      { toolId: "codex", kind: "codex:primary", windowMinutes: 10080, status: "allowed", utilization: 0.88, resetsAt: soon * 1000 },
      { toolId: "codex", kind: "codex:secondary", windowMinutes: 300, status: "allowed", utilization: 0.125 },
    ]);
    expect(codexReports({ rateLimits: { primary: { usedPercent: 90, windowDurationMins: 10080, resetsAt: soon }, secondary: null } })[0]).toMatchObject({ status: "allowed_warning" });
    expect(codexReports({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: soon } } })[0]).toMatchObject({ status: "rejected", utilization: 1 });
    expect(codexReports({})).toEqual([]);
    expect(codexReports(undefined)).toEqual([]);
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
      await expect(readCodexUsage({ command: server.command, env: process.env, timeoutMs: 700, onProcess: (child) => { pid = child.pid; } })).rejects.toThrow("Codex did not answer within 1 seconds");
      expect(Date.now() - started).toBeLessThan(10_000);
      // The deadline may pass before the executable handles even its first request.
      expect(pid).toBeGreaterThan(0);
      await waitFor(() => !alive(pid!), "the hanging app-server to be gone", 5_000);
    }
    const refusing = appServer({ error: "not logged in" });
    await expect(readCodexUsage({ command: refusing.command, env: process.env })).rejects.toThrow("not logged in");
    await expect(readCodexUsage({ command: [join(hanging.dir, "no-such-codex"), "app-server"], env: process.env })).rejects.toThrow("Codex is not installed");
  });
});

describe("the engine slows a tool down before its limit", () => {
  it("reads Codex's usage when it starts and when a Codex agent starts, and a pool of 4 with Codex at 85% starts at most 2 Codex agents", async () => {
    const root = tempDir("petrina-slow-");
    roots.push(root);
    const server = appServer({ primary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: soon } });
    const fakes = new Fakes(join(root, "fake"));
    // Planned on Claude Code, built on Codex; each fresh agent waits for its release file.
    fakes.scenario({ planner: "short", builder: "plain", controlled: true });
    const repo = makeProduct(root);
    git(repo, "config", "branch.autoSetupMerge", "false");
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, fakeAgent, fakes.dir], usageCommands: { codex: server.command }, toolPath: () => "/bin/true" });
    try {
      engine.setPoolPaused(true);
      engine.setPoolLimit(4);
      engine.setToolCap("claude-code", 4);
      engine.setToolCap("codex", 4);
      // Read at the start, before anything runs.
      const usage = await waitFor(() => engine.getState().pool.usage?.find((report) => report.toolId === "codex"), "Codex's usage to be read at the start");
      expect(usage).toMatchObject({ kind: "codex:primary", windowMinutes: 10080, status: "allowed", utilization: 0.85 });
      expect(server.asked().filter((entry) => entry.method === "account/rateLimits/read")).toHaveLength(1);
      // The charts and scheduler share one reader and the same recorded reports.
      engine.usage({ view: "analytics", period: "today" });
      engine.usage({ view: "analytics", period: "today" });
      await engine.usageCoordinator.readers.get("codex")!.refresh();
      expect(server.asked().filter((entry) => entry.method === "account/rateLimits/read")).toHaveLength(2);
      const chart = engine.usage({ view: "analytics", period: "today" });
      expect(chart.limits.tools.find((tool) => tool.toolId === "codex")!.limits[0]!.latest.utilization).toBe(0.85);
      const productId = await engine.addProduct(repo);
      const ids = Array.from({ length: 4 }, (_, index) => engine.addTask({ productId, title: `Change ${index}`, description: "[no-check]" }));
      engine.setPoolPaused(false);
      // Four planners on Claude Code, which has room.
      await waitFor(() => fakes.received("planner").length === 4, "four planners");
      for (const prompt of fakes.received("planner")) writeFileSync(join(fakes.dir, `release-${prompt.session}`), "go");
      const codexSeats = (state: State) => slotUses(state).filter((use) => use.toolId === "codex").length;
      let most = 0;
      const unsub = engine.subscribe(() => {
        most = Math.max(most, codexSeats(engine.getState()));
      });
      try {
        const state = await waitFor(() => {
          const current = engine.getState();
          expect(current.tasks.filter((task) => task.state === "failed").map((task) => task.error)).toEqual([]);
          const waiting = current.tasks.filter((task) => task.state === "waiting");
          return fakes.received("builder").length === 2 && waiting.length === 2 && current;
        }, "two builders on Codex and two tasks waiting for it", 60_000);
        expect(codexSeats(state)).toBe(2);
        expect(most).toBe(2);
        for (const task of state.tasks.filter((task) => task.state === "waiting")) expect(task.statusLine).toBe(`Waiting for a free Codex slot (${FEWER_START})`);
        expect(ids.every((id) => state.tasks.some((task) => task.id === id))).toBe(true);
        // Read again as the Codex agents started (two starting together share one read).
        expect(server.asked().filter((entry) => entry.method === "account/rateLimits/read").length).toBeGreaterThanOrEqual(2);
      } finally {
        unsub();
      }
    } finally {
      engine.shutdown();
    }
  });
});
