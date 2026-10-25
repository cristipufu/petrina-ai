import { describe, afterAll, expect, it, spyOn } from "bun:test";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { AGENT_CHECK_TIMEOUT_MS, checkAgentTool } from "@petrina/agent-runtime/probe";
import { CHECK_TIMEOUT_MS } from "../../../../repositories/src/tool-readiness.js";
import { ADAPTERS, ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

const temp = tempDir("petrina-probe-diagnostics-");
afterAll(() => removeDir(temp));
describe("Tool status", () => {
for (const timedOut of [false, true]) {
    it(`keeps the ${timedOut ? "deadline" : "startup error"} ahead of noisy connector logs`, async () => {
      let budget: number | undefined;
      const starting = spyOn(AgentRun, "start").mockImplementation(async (options) => {
        budget = options.startTimeoutMs;
        options.callbacks.onLog?.("earlier debug\n".repeat(200) + "last connector diagnostic");
        if (timedOut) await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("The connector could not open a session.");
      });
      try {
        const result = await checkAgentTool({
          adapter: ADAPTERS["claude-code"]!, profile: ENGINE_PROFILES[0]!, command: ["test-only"],
          cwd: temp, env: {}, which: () => null, ...(timedOut ? { timeoutMs: 500 } : {}),
        });
        expect(result.status).toBe("unknown");
        expect(result.detail?.startsWith(timedOut ? "Claude Code did not answer within " : "The connector could not open a session.")).toBe(true);
        expect(result.detail).toContain("last connector diagnostic");
        expect(result.detail!.length).toBeLessThan(802);
        expect(budget).toBe(timedOut ? 500 : AGENT_CHECK_TIMEOUT_MS);
        expect(AGENT_CHECK_TIMEOUT_MS).toBe(30_000);
        expect(CHECK_TIMEOUT_MS).toBe(8_000);
      } finally { starting.mockRestore(); }
    });
  }
});
