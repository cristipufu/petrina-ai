import { describe, expect, it } from "bun:test";
import { IdleSleepHold, idleSleepEffects } from "../../../src/idle-sleep-policy.js";

describe("the macOS idle sleep assertion", () => {
  it("holds idle and AC system sleep without a display assertion, is tied to this engine, and stops after work drains", async () => {
    const commands: { command: string; args: readonly string[]; stops: number }[] = [];
    const assertion = new IdleSleepHold(idleSleepEffects({
      platform: () => "darwin",
      pid: () => 456,
      spawn: (command, args) => {
        const child = { command, args, stops: 0 };
        commands.push(child);
        return { stop: () => { child.stops += 1; } };
      },
    }));

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
    const otherPlatform = new IdleSleepHold(idleSleepEffects({ platform: () => "linux", pid: () => 456, spawn: () => { spawned += 1; return { stop() {} }; } }));
    otherPlatform.setActive(true);
    otherPlatform.setActive(false);
    expect(spawned).toBe(0);

    let attempts = 0;
    const missing = new IdleSleepHold(idleSleepEffects({ platform: () => "darwin", pid: () => 456, spawn: () => { attempts += 1; throw new Error("not installed"); } }));
    expect(() => missing.setActive(true)).not.toThrow();
    missing.setActive(true);
    expect(attempts).toBe(1);
    missing.setActive(false);
    missing.setActive(true);
    expect(attempts).toBe(2);
  });

});
