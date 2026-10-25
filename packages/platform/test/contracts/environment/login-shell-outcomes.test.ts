import { describe, expect, it } from "bun:test";
import { getEventListeners } from "node:events";
import { rejectionOf } from "@petrina/test-support/rejections";
import { loginShellPath, LoginShellCleanupError, type LoginShellProcess } from "../../../src/login-shell.js";
import type { ProcessDeadline } from "../../../src/process-capabilities.js";

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function fixture({ missingExit = false, brokenOutput = false, cancellation }: { missingExit?: boolean; brokenOutput?: boolean; cancellation?: "pending" | "rejected" } = {}) {
  const completion = Promise.withResolvers<number>(), signals: string[] = [];
  const timers = new Map<number, { ms: number; expire: () => void }>();
  let id = 0;
  const arm: ProcessDeadline = (expire, ms) => { const key = ++id; timers.set(key, { ms, expire }); return () => { timers.delete(key); }; };
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    if (brokenOutput) controller.error(new Error("owned output failed"));
    else { controller.enqueue(new TextEncoder().encode("__petrina_env__\nPATH=/private/bin\n__petrina_env__\n")); if (!cancellation) controller.close(); }
  }, cancel() {
    if (cancellation === "rejected") throw new Error("underlying output cancellation failed");
    if (cancellation === "pending") return new Promise<void>(() => {});
  } });
  const child: LoginShellProcess = { stdout: stream, exited: completion.promise, exitCode: undefined, signalCode: undefined,
    kill(signal) { signals.push(signal); if (!missingExit) completion.resolve(0); },
  };
  return { child, arm, signals, stream, timers,
    async expire(ms: number) {
      const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms);
      if (!entry) throw new Error(`No ${ms}ms deadline is armed`);
      timers.delete(entry[0]); entry[1].expire(); await flush();
    },
  };
}

describe.skipIf(process.platform === "win32")("login-shell cleanup outcomes", () => {
  it("does not turn unavailable process completion into a successful PATH", async () => {
    const f = fixture({ missingExit: true }), lifetime = new AbortController();
    const stopped = rejectionOf(loginShellPath({}, 4_000, { start: () => f.child, arm: f.arm, signal: lifetime.signal }));
    await flush(); await f.expire(100); await f.expire(400);
    const error = await stopped;
    expect(error).toBeInstanceOf(LoginShellCleanupError);
    expect((error as LoginShellCleanupError).cleanup).toBe("unconfirmed");
    expect((error as LoginShellCleanupError).processStopped).toBe(false);
    expect((error as LoginShellCleanupError).outputClosed).toBe(true);
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(f.stream.locked).toBe(false);
    expect(f.timers.size).toBe(0);
    expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(0);
  });

  it("keeps an errored output unavailable after confirming its child stopped", async () => {
    const f = fixture({ brokenOutput: true });
    expect(await loginShellPath({}, 4_000, { start: () => f.child, arm: f.arm })).toBeUndefined();
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.stream.locked).toBe(false);
    expect(f.timers.size).toBe(0);
  });

  for (const cancellation of ["pending", "rejected"] as const) it(`does not confuse ${cancellation} underlying output cancellation with an already-errored reader`, async () => {
    const f = fixture({ cancellation });
    const stopped = rejectionOf(loginShellPath({}, 4_000, { start: () => f.child, arm: f.arm }));
    await f.expire(4_000);
    if (cancellation === "pending") await f.expire(500);
    const error = await stopped;
    expect(error).toBeInstanceOf(LoginShellCleanupError);
    expect((error as LoginShellCleanupError).processStopped).toBe(true);
    expect((error as LoginShellCleanupError).outputClosed).toBe(false);
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.stream.locked).toBe(false);
    expect(f.timers.size).toBe(0);
  });

  it("keeps startup failure unavailable without leaving a read deadline or abort listener", async () => {
    const f = fixture(), lifetime = new AbortController();
    expect(await loginShellPath({}, 4_000, { arm: f.arm, signal: lifetime.signal, start() { throw new Error("owned helper could not start"); } })).toBeUndefined();
    expect(f.signals).toEqual([]);
    expect(f.timers.size).toBe(0);
    expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(0);
  });
});
