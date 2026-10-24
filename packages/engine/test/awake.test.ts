import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { IdleSleepAssertion } from "../src/awake.js";
import { Engine } from "./engine.js";
import { removeDir, tempDir } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("the macOS idle sleep assertion", () => {
  it("holds idle and AC system sleep without a display assertion, is tied to this engine, and stops after work drains", async () => {
    const commands: { command: string; args: readonly string[]; stops: number }[] = [];
    const assertion = new IdleSleepAssertion({
      platform: "darwin",
      pid: 456,
      spawn: (command, args) => {
        const child = { command, args, stops: 0 };
        commands.push(child);
        return { stop: () => { child.stops += 1; } };
      },
    });

    assertion.setActive(true);
    assertion.setActive(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: "/usr/bin/caffeinate", args: ["-i", "-s", "-w", "456"] });
    assertion.setActive(false);
    assertion.setActive(false);
    expect(commands[0]!.stops).toBe(1);
    assertion.setActive(true);
    expect(commands).toHaveLength(2);
    const stopped = assertion.shutdown();
    expect(commands[1]!.stops).toBe(1);
    await stopped;
  });

  it("does nothing on other platforms and treats a missing caffeinate as a best-effort failure", () => {
    let spawned = 0;
    const otherPlatform = new IdleSleepAssertion({ platform: "linux", spawn: () => { spawned += 1; return { stop() {} }; } });
    otherPlatform.setActive(true);
    otherPlatform.setActive(false);
    expect(spawned).toBe(0);

    let attempts = 0;
    const missing = new IdleSleepAssertion({ platform: "darwin", spawn: () => { attempts += 1; throw new Error("not installed"); } });
    expect(() => missing.setActive(true)).not.toThrow();
    missing.setActive(true);
    expect(attempts).toBe(1);
    missing.setActive(false);
    missing.setActive(true);
    expect(attempts).toBe(2);
  });

  it("holds through paused work and settling cleanup, releases when drained, and releases immediately on shutdown", async () => {
    const root = tempDir("petrina-awake-");
    roots.push(root);
    const changes: boolean[] = [];
    const engine = new Engine(join(root, "data"), { awakeObserver: (active) => changes.push(active) });
    try {
      engine.drivers.set("task", new AbortController());
      engine.syncIdleSleep();
      expect(changes).toEqual([true]);
      engine.setPoolPaused(true);
      expect(changes.at(-1)).toBe(true);

      // The driver has let go of its agent, but still owns asynchronous result and file handling.
      engine.drivers.delete("task");
      engine.settling.set("task", Promise.resolve());
      engine.syncIdleSleep();
      engine.cleanupJobs.add("task");
      engine.settling.delete("task");
      engine.syncIdleSleep();
      expect(changes.at(-1)).toBe(true);
      engine.cleanupJobs.delete("task");
      engine.syncIdleSleep();
      expect(changes.at(-1)).toBe(false);

      engine.setPoolPaused(false);
      engine.drivers.set("task", new AbortController());
      engine.syncIdleSleep();
      expect(changes.at(-1)).toBe(true);
      const stopping = engine.shutdown();
      expect(changes.at(-1)).toBe(false);
      expect(changes).toEqual([true, false, true, false]);
      await stopping;
    } finally {
      await engine.shutdown();
    }
  });
});
