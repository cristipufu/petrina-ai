import { afterAll, expect, it } from "bun:test";
import { getEventListeners } from "node:events";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { AgentRun } from "../src/acp-run.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { removeDir, tempDir } from "./support.js";

const root = tempDir("petrina-agent-lifetime-");
afterAll(() => removeDir(root));
const profile = ENGINE_PROFILES.find(profile => profile.id === "sol-high")!;
const command = [process.execPath, join(import.meta.dir, "fake-agent.ts")];
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };

it("releases stopped and failed runs from a shared task cancellation signal", async () => {
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort").length;
  for (let n = 0; n < 3; n++) {
    const run = await AgentRun.start({ profile, cwd: root, command, callbacks, signal: controller.signal, probe: true });
    await run.stop();
    expect(getEventListeners(controller.signal, "abort").length).toBe(before);
  }
  await expect(AgentRun.start({ profile, cwd: root, command: [...command, "--logged-out"], callbacks, signal: controller.signal, probe: true })).rejects.toThrow();
  expect(getEventListeners(controller.signal, "abort").length).toBe(before);
});

it("does not retain completed turns on the live agent's process", async () => {
  let child: ChildProcess | undefined;
  const run = await AgentRun.start({ profile, cwd: root, command, callbacks, signal: new AbortController().signal, browser: false, onProcess: process => { child = process; } });
  try {
    const before = child!.listenerCount("exit");
    for (let n = 0; n < 3; n++) {
      await run.prompt("You are the Researcher in Petrina. Hand back notes.");
      expect(child!.listenerCount("exit")).toBe(before);
    }
  } finally { await run.stop(); }
});
