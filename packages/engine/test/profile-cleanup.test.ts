import { expect, it, spyOn } from "bun:test";
import { ProfileChoiceReader } from "../src/profile-choices.js";
import { AgentRun } from "../src/acp-run.js";
import type { Kernel } from "../src/kernel.js";
import { demoProfileChoices } from "@petrina/core";
import { removeDir, tempDir } from "./support.js";

it("waits for a failed startup's process cleanup before opening another configuration probe", async () => {
  const root = tempDir("profile-cleanup-");
  let release!: () => void;
  const gone = new Promise<void>(resolve => { release = resolve; });
  const start = spyOn(AgentRun, "start");
  start.mockImplementationOnce(async options => { options.onGone?.(gone); throw new Error("Could not open"); });
  start.mockImplementationOnce(async options => {
    options.onGone?.(Promise.resolve());
    return { profileChoices: async () => demoProfileChoices("codex"), stop: async () => true } as unknown as AgentRun;
  });
  const reader = new ProfileChoiceReader({ dataDir: root, s: { profiles: [] }, options: {}, stopped: false } as unknown as Kernel);
  try {
    await expect(reader.read("codex")).rejects.toThrow("Could not open");
    const next = reader.read("codex");
    await new Promise(resolve => setImmediate(resolve));
    expect(start).toHaveBeenCalledTimes(1);
    release();
    expect((await next).toolId).toBe("codex");
    expect(start).toHaveBeenCalledTimes(2);
  } finally { release(); await reader.stop(); start.mockRestore(); removeDir(root); }
});
