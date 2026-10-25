import { afterAll, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Engine } from "../../engine.js";
import { removeDir, tempDir } from "../../fixtures.js";
import { SLOW } from "@petrina/test-support/slow";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

for (const kind of ["background", "copy", "nested"] as const) it(`shutdown waits for owned ${kind} file handling before its caller removes the fixture`, async () => {
  const root = tempDir("shutdown-ownership-"); roots.push(root);
  const engine = new Engine(join(root, "data"));
  const first = gate(), next = gate(), enteredNext = gate();
  let stopping: Promise<void> | undefined, settled = false;
  try {
    await engine.waitUntilReady();
    await Promise.all([...engine.backgroundWork]);
    const file = join(root, "finished.txt");
    const work = first.promise.then(async () => {
      if (kind === "nested") {
        engine.trackWork(next.promise.then(() => { writeFileSync(file, "finished"); }));
        enteredNext.release();
      } else writeFileSync(file, "finished");
    });
    if (kind === "copy") {
      const owned = work.finally(() => engine.copyCleanups.delete("owned"));
      engine.copyCleanups.set("owned", owned);
    } else engine.trackWork(work);
    const stop = engine.shutdown(), repeated = engine.shutdown();
    stopping = stop.then(() => { settled = true; });
    // Deliver the native event-loop boundary; the held work, not a duration, controls completion.
    await setImmediate();
    expect(settled).toBe(false);
    first.release();
    if (kind === "nested") {
      await enteredNext.promise;
      await setImmediate();
      expect(settled).toBe(false);
      next.release();
    }
    await Promise.all([stop, repeated]); await stopping;
    expect(repeated).toBe(stop);
    expect(readFileSync(file, "utf8")).toBe("finished");
    expect(engine.backgroundWork.size).toBe(0);
    expect(engine.copyCleanups.size).toBe(0);
  } finally { first.release(); next.release(); await stopping; await engine.shutdown(); }
}, 30_000 * SLOW);

it("keeps a background failure available to its caller and still waits for a separate cleanup owner", async () => {
  const root = tempDir("shutdown-failed-owner-"); roots.push(root);
  const engine = new Engine(join(root, "data")), failed = gate(), held = gate();
  let stopping: Promise<void> | undefined, settled = false;
  try {
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    const failure = new Error("The owned cleanup failed");
    const result = engine.trackWork(failed.promise.then(() => { throw failure; })).catch(error => error);
    engine.trackWork(held.promise.then(() => { writeFileSync(join(root, "finished.txt"), "finished"); }));
    stopping = engine.shutdown().then(() => { settled = true; });
    failed.release(); expect(await result).toBe(failure);
    await setImmediate(); expect(settled).toBe(false);
    held.release(); await stopping;
    expect(readFileSync(join(root, "finished.txt"), "utf8")).toBe("finished");
    expect(engine.backgroundWork.size).toBe(0);
  } finally { failed.release(); held.release(); await stopping; await engine.shutdown(); }
}, 30_000 * SLOW);
