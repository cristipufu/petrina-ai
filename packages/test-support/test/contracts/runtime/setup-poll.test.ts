// Deliberate synchronous holds verify the native completion/poll contract.
import { expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, type Started } from "../../../src/commands.js";
import { removeDir, tempDir, waitForFile } from "../../../src/fixtures.js";
import { createSetupSteps } from "../../../src/setup-steps.js";
import { createProcessLease } from "../../../src/process-lease.js";

it("receives a real completion and its complete output before the deadline while later setup steps are ready", async () => {
  const root = tempDir("petrina-setup-completion-");
  const ready = join(root, "ready"), release = join(root, "release"), proof = join(root, "finished");
  const lifetime = new AbortController(), setup = createSetupSteps(), lease = await createProcessLease();
  const limit = 3_000, count = 8;
  let started = 0;
  let completed = 0, received: { at: number; completed: number } | undefined;
  const receipts: Partial<Record<"exit" | "stdout" | "stderr", number>> = {};
  const ticks: { at: number; completed: number }[] = [];
  const receipt = (part: keyof typeof receipts) => {
    receipts[part] = performance.now() - started;
    if (Object.keys(receipts).length === 3) received = { at: Math.max(...Object.values(receipts)), completed };
  };
  const observe = (stream: ReadableStream<Uint8Array>, part: "stdout" | "stderr") => {
    const reader = stream.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) { receipt(part); controller.close(); }
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
  };
  // Prepare the real leased actor before measuring native completion/polling. Cold process
  // startup is a separate boundary; this command finishes only after the third heavy step starts.
  const script = lease.program(`
    const { existsSync, writeFileSync } = require("node:fs");
    writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
    writeFileSync(${JSON.stringify(proof)}, JSON.stringify({ at: Date.now() }));
    console.log("finished in the setup chain"); console.error("complete error output");
  `);
  const argv = [process.execPath, "-e", script];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let command: Promise<{ result: Awaited<ReturnType<typeof runCommand>> | undefined; error: unknown }> | undefined;
  let chain: Promise<unknown> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  try {
    const owned = child = Bun.spawn(argv, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
    await waitForFile(ready, { during: owned.exited });
    expect(owned.exitCode).toBeNull();
    const wallStarted = Date.now();
    started = performance.now();
    command = runCommand(argv, {
      timeoutMs: limit, signal: lifetime.signal,
      start: (): Started => {
        void owned.exited.then(() => receipt("exit"));
        return {
          pid: owned.pid, stdout: observe(owned.stdout, "stdout"), stderr: observe(owned.stderr, "stderr"), exited: owned.exited,
          get exitCode() { return owned.exitCode; }, get signalCode() { return owned.signalCode; },
          kill: (signal) => owned.kill(signal),
        };
      },
    }).then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
    // All eight setup steps are ready together; the watched command completes midway,
    // while further synchronous steps remain in the chain.
    timer = setInterval(() => ticks.push({ at: performance.now() - started, completed }), 20);
    const hold = new Int32Array(new SharedArrayBuffer(4));
    chain = Promise.all(Array.from({ length: count }, (_, index) => setup.run(() => {
      if (index === 2) writeFileSync(release, "");
      // A bounded, sleeping fault injection for synchronous storage waits; no CPU load.
      Atomics.wait(hold, 0, 0, 500);
      completed++;
    }, lifetime.signal)));
    const outcome = await command;
    await chain;
    console.log("Setup completion observation", JSON.stringify({ limit, receipts, received, ticksDuringChain: ticks.filter((tick) => tick.completed > 0 && tick.completed < count).length }));
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({ code: 0, stdout: "finished in the setup chain\n", stderr: "complete error output\n" });
    expect(received).toBeDefined();
    expect(received!.at).toBeLessThan(limit);
    expect(received!.completed).toBeGreaterThan(0);
    expect(received!.completed).toBeLessThan(count);
    expect(JSON.parse(readFileSync(proof, "utf8")).at - wallStarted).toBeLessThan(limit);
    expect(ticks.some((tick) => tick.completed > 0 && tick.completed < count && tick.at < limit)).toBe(true);
    expect(existsSync(release)).toBe(true);
  } finally {
    lifetime.abort();
    if (timer) clearInterval(timer);
    await lease.close();
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled([...(child ? [child.exited] : []), ...(command ? [command] : []), ...(chain ? [chain] : [])]);
    removeDir(root);
  }
});
