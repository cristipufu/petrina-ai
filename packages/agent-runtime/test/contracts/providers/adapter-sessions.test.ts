import { afterAll, expect, it } from "bun:test";
import { AgentRun, reportOf } from "../../../src/acp-run.js";
import { ADAPTERS, type ToolAdapter } from "../../../src/tools.js";
import { limitFromFailure } from "../../../src/usage.js";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { nativeSession } from "../../fixtures/native-session.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
it("drives a newly registered adapter's sessions and reports without provider branches", async () => {
  const id = "fixture-session-provider", path = tempDir("petrina-adapter-contract-"); roots.push(path);
  const peer = nativeSession(path, { reopen: "resume" });
  const profile = { id: "fixture-high", toolId: id, model: "Fixture", modelId: "opus", effort: "high" as const };
  let environments = 0, metas = 0, verified = 0;
  const adapters = ADAPTERS as Record<string, ToolAdapter>;
  adapters[id] = {
    id, name: "Fixture", cli: "bun", command: [process.execPath], login: "open", models: ["Fixture"],
    options: { model: "model", effort: "effort", mode: "mode" }, mode: "auto",
    prepareEnv: env => { expect(env).not.toBe(process.env); environments++; },
    prepareSessionMeta: async (meta, { cwd, browser }) => { expect(cwd).toBe(path); expect(browser).toBe(false); metas++; return meta; },
    verifySessionSettings: (_profile, settings) => { expect(settings).toMatchObject({ model: "opus", effort: "high" }); verified++; },
    parseTurnReport: () => ({ main: { total: 42 } }),
    parseLimitError: data => data.fixtureOut ? { kind: "rate" } : undefined,
  };
  let run: AgentRun | undefined;
  try {
    const options = { profile, cwd: path, browser: false, command: peer.command, env: {}, signal: new AbortController().signal,
      callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const } };
    run = await AgentRun.start(options);
    const session = run.sessionId; await run.stop();
    run = await AgentRun.start({ ...options, reopen: session });
    expect(run.reopened).toBe("resume");
    expect([environments, metas, verified]).toEqual([2, 2, 2]);
    expect(reportOf({}, id)).toEqual({ main: { total: 42 } });
    expect(limitFromFailure(profile, { data: { fixtureOut: true } }, "", Date.now())?.reason).toBe("Fixture's rate limit");
  } finally { await run?.stop(); delete adapters[id]; }
});
