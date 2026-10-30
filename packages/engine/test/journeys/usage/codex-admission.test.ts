import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { ScriptedAgents, scriptedResult } from "../../scripted-agents.js";
import { ReleaseEvents } from "../../release-events.js";
import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { FEWER_START, slotUses, type State } from "@petrina/core";
import { makeProduct, waitFor } from "../../fixtures.js";
import { appServer as fixtureServer } from "../../../../agent-runtime/test/fixtures/codex-account.js";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { removeFixtureRoot } from "@petrina/test-support/fixture-roots";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

const soon = Math.floor(Date.now() / 1000) + 3600;

describe("the engine slows a tool down before its limit", () => {
  it("reads Codex's usage when it starts and when a Codex agent starts, and a pool of 4 with Codex at 85% starts at most 2 Codex agents", async () => {
  return engineCases.use("petrina-slow-", async caseOwner => {
    const root = caseOwner.root;

    const server = fixtureServer({ primary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: soon } });
    registerFixtureRoot(server.dir);
    let stopAccount: (() => Promise<void>) | undefined;
    caseOwner.afterBody(async () => {
      if (!stopAccount) throw new Error("The Codex account fixture has no confirmed Engine stop");
      await stopAccount();
      removeFixtureRoot(server.dir);
    });
    const releases = new ReleaseEvents();
    const agents = new ScriptedAgents(async (prompt, signal) => {
      if (prompt.turn === 1) await releases.wait(prompt.sessionId, signal);
      if (prompt.result === "plan") return scriptedResult({ rationale: "Read quotas before admission.", stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
      ] });
      throw new Error(`Unexpected released quota fixture work: ${prompt.result}`);
    });
    const repo = await makeProduct(root);
    appendFileSync(join(repo, ".git", "config"), "\n[branch]\n\tautoSetupMerge = false\n");
    const engine = caseOwner.open(join(root, "data"), { agentCommand: () => ["unused-scripted-session"], startAgentSession: agents.start, usageCommands: { codex: server.command }, toolPath: () => process.execPath });
    stopAccount = () => caseOwner.stop(engine);
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
      await caseOwner.run(engine, async () => { await engine.usageCoordinator.readers.get("codex")!.refresh(); });
      expect(server.asked().filter((entry) => entry.method === "account/rateLimits/read")).toHaveLength(2);
      const chart = engine.usage({ view: "analytics", period: "today" });
      expect(chart.limits.tools.find((tool) => tool.toolId === "codex")!.limits[0]!.latest.utilization).toBe(0.85);
      await engine.waitUntilReady();
      caseOwner.check();
      const productId = installPreparedProduct(engine, privateCloneProduct(repo));
      const ids = Array.from({ length: 4 }, (_, index) => engine.addTask({ productId, title: `Change ${index}`, description: "[no-check]" }));
      engine.setPoolPaused(false);
      // Four planners on Claude Code, which has room.
      await waitFor(() => agents.received("plan").length === 4, "four planners");
      for (const prompt of agents.received("plan")) releases.release(prompt.sessionId);
      const codexSeats = (state: State) => slotUses(state).filter((use) => use.toolId === "codex").length;
      let most = 0;
      const unsub = engine.subscribe(() => {
        most = Math.max(most, codexSeats(engine.getState()));
      });
      caseOwner.onStop(unsub);
      try {
        const state = await waitFor(() => {
          const current = engine.getState();
          expect(current.tasks.filter((task) => task.state === "failed").map((task) => task.error)).toEqual([]);
          const waiting = current.tasks.filter((task) => task.state === "waiting");
          return agents.received("build").length === 2 && waiting.length === 2 && current;
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
      await caseOwner.stop(engine);
    }

  });
});
});
