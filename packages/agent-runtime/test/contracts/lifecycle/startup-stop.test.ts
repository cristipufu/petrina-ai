import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../../../src/acp-run.js";
import { ENGINE_PROFILES } from "../../../src/tools.js";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { tempDir, removeDir, waitFor } from "@petrina/test-support/fixtures";
import { nativeSession } from "../../fixtures/native-session.js";

describe("Stopping during startup", () => {
  for (const probe of [true, false]) it(probe ? "lets a tool check report while its stubborn agent stops" : "waits for a task's stubborn agent to stop before releasing its copy", async () => {
    const root = tempDir("petrina-startup-stop-"), lease = await createProcessLease();
    const peer = nativeSession(root), actor = join(root, "leased-peer.ts");
    writeFileSync(actor, lease.program(`await import(${JSON.stringify(peer.command[1])}); await new Promise(() => undefined);`));
    const controller = new AbortController();
    let child: ChildProcess | undefined, closed: Promise<void> | undefined, gone: Promise<void> | undefined;
    const alive = () => !!child && child.exitCode === null && child.signalCode === null;
    const opening = AgentRun.start({
      profile: ENGINE_PROFILES.find(profile => profile.toolId === "claude-code")!, cwd: root,
      command: [process.execPath, actor, ...peer.command.slice(2), "--hang", "--stubborn"], signal: controller.signal, probe, browser: false,
      callbacks: { onActivity: () => {}, onPlanStep: () => {}, onPermission: async () => "deny" },
      onProcess(process) { child = process; closed = new Promise(resolve => process.once("close", () => resolve())); },
      ...(probe ? { onGone: (stopped: Promise<void>) => { gone = stopped; } } : {}),
    }).then(() => "Opened unexpectedly", (error: Error) => error.message);
    try {
      // The real peer has installed its TERM handler and received the startup request before abort.
      await waitFor(async () => {
        if (peer.requests().some(request => request.method === "session/new")) return true;
        const ended = await Promise.race([opening.then(value => ({ value })), Promise.resolve(undefined)]);
        if (ended) throw new Error(`The native startup ended before its held request: ${ended.value}`);
        return false;
      }, "the stubborn native peer's held startup request");
      controller.abort();
      expect(await opening).toBe("Stopped before the agent started");
      // Probe owners follow onGone; a task must retain its copy until the child really ends.
      expect(alive()).toBe(probe);
      if (gone) await gone;
      await waitFor(() => !alive(), "the stopped agent to be gone");
    } finally {
      controller.abort();
      await opening;
      await lease.close();
      await closed;
      removeDir(root);
    }
  });
});
