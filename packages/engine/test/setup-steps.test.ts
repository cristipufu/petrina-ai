// Deliberate synchronous holds stay in this file's sequential tests, away from concurrent deadlines.
import { expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, type Started } from "./commands.js";
import { removeDir, tempDir, waitForFile } from "./fixtures.js";
import { rejectionOf } from "./rejections.js";
import { SetupSteps } from "./setup-steps.js";

it("receives a real completion and its complete output before the deadline while later setup steps are ready", async () => {
  const root = tempDir("petrina-setup-completion-");
  const ready = join(root, "ready"), release = join(root, "release"), proof = join(root, "finished");
  const lifetime = new AbortController(), setup = new SetupSteps();
  const limit = 3_000, count = 8;
  const started = performance.now();
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
  // The command finishes only after the third heavy step starts. Its own parent watch and deadline
  // also bound it if the test is interrupted before the command runner gets to cleanup.
  const script = `
    const { existsSync, writeFileSync } = require("node:fs");
    const parent = process.ppid;
    const watch = setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(98); } }, 100);
    const bound = setTimeout(() => process.exit(99), 20000);
    writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
    writeFileSync(${JSON.stringify(proof)}, JSON.stringify({ at: Date.now() }));
    console.log("finished in the setup chain"); console.error("complete error output");
    clearInterval(watch); clearTimeout(bound);
  `;
  const wallStarted = Date.now();
  const command = runCommand([process.execPath, "-e", script], {
    timeoutMs: limit, signal: lifetime.signal,
    start: (argv, options): Started => {
      const child = Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe", windowsHide: true });
      void child.exited.then(() => receipt("exit"));
      return {
        pid: child.pid, stdout: observe(child.stdout, "stdout"), stderr: observe(child.stderr, "stderr"), exited: child.exited,
        get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
        kill: (signal) => child.kill(signal),
      };
    },
  }).then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
  let chain: Promise<unknown> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  try {
    await waitForFile(ready);
    // Other real commands complete first and start the setup chain. All eight steps are ready
    // together; the watched command completes midway, while further steps remain in that chain.
    const warmups = await Promise.all([0, 1].map(() => runCommand([process.execPath, "-e", "console.log('setup ready')"], { signal: lifetime.signal })));
    expect(warmups.map((result) => result.code)).toEqual([0, 0]);
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
    await Promise.allSettled([command, ...(chain ? [chain] : [])]);
    removeDir(root);
  }
});

it("releases the next setup step after a failure without giving it the failed step's error", async () => {
  const setup = new SetupSteps(), failed = new Error("this setup failed");
  const first = rejectionOf(setup.run(() => { throw failed; }));
  const second = setup.run(() => "independent setup");
  expect(await first).toBe(failed);
  expect(await second).toBe("independent setup");
});

it("gives up a cancelled place without starting it or blocking later setup", async () => {
  const setup = new SetupSteps(), lifetime = new AbortController(), ended = new Error("the owner ended");
  let started = false;
  const first = setup.run(() => { lifetime.abort(ended); return "first"; });
  const cancelled = rejectionOf(setup.run(() => { started = true; }, lifetime.signal));
  const last = setup.run(() => "last");
  expect(await first).toBe("first");
  expect(await cancelled).toBe(ended);
  expect(started).toBe(false);
  expect(await last).toBe("last");
  expect(await rejectionOf(setup.run(() => { started = true; }, lifetime.signal))).toBe(ended);
  expect(started).toBe(false);
});

it("only schedules synchronous setup rather than waiting for a whole asynchronous test", async () => {
  const setup = new SetupSteps(), held = Promise.withResolvers<void>();
  const first = setup.run(() => held.promise);
  try { expect(await setup.run(() => "another test can start")).toBe("another test can start"); }
  finally { held.resolve(); await first; }
});
