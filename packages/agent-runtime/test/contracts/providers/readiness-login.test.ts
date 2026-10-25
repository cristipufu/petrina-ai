import { describe, afterAll, expect, it, spyOn } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type AgentProfile } from "@petrina/core";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { checkAgentTool } from "@petrina/agent-runtime/probe";
import { ADAPTERS, ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { testGitEnv } from "@petrina/test-support/test-git-env";
import { readinessPeer } from "../../fixtures/readiness-peer.js";

const temp = tempDir("petrina-probe-login-");
afterAll(() => removeDir(temp));
let serial = 0;
const fresh = (name: string) => join(temp, `${name}-${++serial}`);
describe("Tool status", () => {
it("takes the tool's own word on its login: a conversation that opens is not enough for Ready", async () => {
    const fakes = readinessPeer(fresh("fakes"));
    const cwd = fresh("checks"); mkdirSync(cwd);
    const deadline = new AbortController();
    let opened!: () => void;
    const codexOpened = new Promise<void>((resolve) => { opened = resolve; });
    const original = AgentRun.start.bind(AgentRun);
    const gone: Promise<void>[] = [];
    const starting = spyOn(AgentRun, "start").mockImplementation(async (options) => {
      const run = await original(options);
      if (options.profile.toolId === "codex") opened();
      return run;
    });
    const command = (profile: AgentProfile) => fakes.command(profile.toolId === "claude-code" ? "none" : "silent");
    let checking: Promise<Awaited<ReturnType<typeof checkAgentTool>>[]> | undefined;
    try {
      checking = Promise.all(["claude-code", "codex"].map((id) => {
        const profile = ENGINE_PROFILES.find((profile) => profile.toolId === id)!;
        return checkAgentTool({ adapter: ADAPTERS[id]!, profile, command: command(profile), env: testGitEnv(), cwd, which: () => null, ...(id === "codex" ? { signal: deadline.signal } : {}), onGone: (done) => gone.push(done) });
      }));
      // The missing report, rather than real elapsed time, is what this test exercises.
      await Promise.race([codexOpened, checking.then(() => { throw new Error("The login probes ended before the silent conversation opened"); })]);
      deadline.abort();
      const [claude, codex] = await checking;
      expect(fakes.opens().length).toBe(2);
      expect(claude!.status).toBe("logged-out");
      // A tool that never says is Couldn't check, never Ready.
      expect(codex!.status).toBe("unknown");
      expect(codex!.detail).toContain("did not say whether it is logged in");
      expect(fakes.prompts()).toEqual([]);
    } finally {
      deadline.abort(); await checking?.catch(() => {}); await Promise.allSettled(gone); starting.mockRestore();
    }
  });
});
