import { describe, expect, it } from "bun:test";
import { loginShellPath } from "../../../src/login-shell.js";
import { preparedLoginShell } from "../../fixtures/login-shell.js";

describe.skipIf(process.platform === "win32")("login-shell helper ownership", () => {
  it("returns a complete PATH only after its own prepared helper has stopped", async () => {
    const f = await preparedLoginShell("success");
    try {
      expect(await loginShellPath(f.env, 4_000, { start: f.start })).toBe("/private/bin:/usr/bin");
      expect(f.handle.exitCode != null || f.handle.signalCode != null).toBe(true);
    } finally { await f.close(); }
  });

  it("stops a helper whose output closes before it exits", async () => {
    const f = await preparedLoginShell("closed-output");
    try {
      expect(await loginShellPath(f.env, 4_000, { start: f.start })).toBe("/private/bin:/usr/bin");
      expect(f.handle.exitCode != null || f.handle.signalCode != null).toBe(true);
      expect(f.signals[0]).toBe("SIGTERM");
    } finally { await f.close(); }
  });

  it("escalates a read-timed-out TERM-resistant helper and confirms its exit", async () => {
    const f = await preparedLoginShell("stubborn");
    try {
      const started = performance.now();
      expect(await loginShellPath(f.env, 30, { start: f.start })).toBeUndefined();
      expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(f.handle.exitCode != null || f.handle.signalCode != null).toBe(true);
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally { await f.close(); }
  });

  it("bounds and disposes output held open by another leased actor after its own helper exits", async () => {
    const f = await preparedLoginShell("held-output");
    try {
      const started = performance.now();
      expect(await loginShellPath(f.env, 30, { start: f.start })).toBeUndefined();
      expect(f.handle.exitCode).toBe(0);
      expect(f.hasHeldOutput).toBe(true);
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally { await f.close(); }
  });

  for (const synchronous of [false, true]) it(`cleans a prepared owned helper when aborted ${synchronous ? "inside its starter" : "during its read"}`, async () => {
    const f = await preparedLoginShell("waiting"), lifetime = new AbortController();
    try {
      const start = () => {
        const handle = f.start();
        if (synchronous) lifetime.abort();
        else queueMicrotask(() => lifetime.abort());
        return handle;
      };
      expect(await loginShellPath(f.env, 4_000, { start, signal: lifetime.signal })).toBeUndefined();
      expect(f.handle.exitCode != null || f.handle.signalCode != null).toBe(true);
      expect(f.signals[0]).toBe("SIGTERM");
    } finally { await f.close(); }
  });

  it("does not start a helper for an already cancelled request", async () => {
    const lifetime = new AbortController(); lifetime.abort();
    let starts = 0;
    expect(await loginShellPath({}, 4_000, { signal: lifetime.signal, start() { starts++; throw new Error("Must not start"); } })).toBeUndefined();
    expect(starts).toBe(0);
  });
});
