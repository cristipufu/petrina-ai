import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../../../src/acp-run.js";
import { ENGINE_PROFILES } from "../../../src/tools.js";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { nativeSession } from "../../fixtures/native-session.js";

describe("An agent session", () => {
it("reads 'not confirmed' when the tool acknowledges a setting without saying what it ended up on", async () => {
    const cwd = tempDir("petrina-run-");
    const profile = ENGINE_PROFILES.find((entry) => entry.id === "opus-high")!;
    const callbacks = { onActivity: () => undefined, onPlanStep: () => undefined, onPermission: async () => "deny" as const };
    const start = (bareConfigAck: boolean) => {
      const directory = join(cwd, bareConfigAck ? "bare" : "echoed"); mkdirSync(directory);
      const peer = nativeSession(directory, { bareConfigAck, config: [
        { id: "model", name: "Model", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "opus", name: "Opus 5.5" }] },
        { id: "effort", name: "Effort", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
        { id: "mode", name: "Mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "auto", name: "Auto" }] },
      ] });
      return AgentRun.start({ profile, cwd: directory, callbacks, signal: new AbortController().signal, command: peer.command, env: process.env, browser: false });
    };
    let bare: AgentRun | undefined, echoed: AgentRun | undefined;
    try {
      bare = await start(true);
      echoed = await start(false);
      // Petrina asked for opus at high and the tool only said "ok": neither is taken as confirmed.
      expect(bare.settings).toEqual({});
      expect(echoed.settings).toEqual({ model: "opus", modelName: "Opus 5.5", effort: "high" });
    } finally {
      // Wait for both stops: a stop pauses its agent while it lists the agent's programs.
      await Promise.all([bare?.stop(), echoed?.stop()]);
      removeDir(cwd);
    }
  });
});
