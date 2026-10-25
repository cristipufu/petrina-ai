import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";

import { git, waitFor } from "../../fixtures.js";

import { executionFor } from "@petrina/orchestrator";


import { ExtraFixtures } from "../../extra-fixtures.js";

const owned = new ExtraFixtures();
const {  } = owned;
const fixture = (...args: Parameters<ExtraFixtures["fixture"]>) => owned.fixture(...args);
afterAll(() => owned.close());


describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
for (const checkRuns of [1, 2]) it(`reserves the final place atomically and keeps FIFO between product and extra runs (limit ${checkRuns})`, async () => {
    const f = await fixture({ checkRuns });
    const { engine } = f;
    engine.setPoolPaused(false);
    const acquire = () => engine["checks"]["turnToRun"](executionFor(f.task), new AbortController().signal);
    const occupying = [];
    for (let i = 0; i < checkRuns; i++) occupying.push(await acquire());
    const extra = await f.submit("race");
    expect(engine.checkQueue.running).toBe(checkRuns);
    expect(engine.checkQueue.waiting).toBe(1);
    occupying.pop()!();
    // New product arrival is in the same JS turn as release, before the extra continuation resumes.
    const product = acquire();
    await f.started(extra);
    expect(engine.checkQueue.running).toBe(checkRuns);
    expect(engine.checkQueue.waiting).toBe(1);
    expect(extra.state).toBe("queued"); // the immediate reply is truthful and immutable
    f.release(extra);
    const releaseProduct = await product;
    expect((await f.finished(extra)).result).toBe("passed");
    releaseProduct();
    for (const release of occupying) release();
    expect(engine.checkQueue.running).toBe(0);
    // Reverse arrival order: the product waiter cannot be overtaken by an extra run.
    const held = [];
    for (let i = 0; i < checkRuns; i++) held.push(await acquire());
    const older = acquire();
    const next = await f.submit("reverse", ["probe", "pass"]);
    held.pop()!();
    const releaseOlder = await older;
    expect(existsSync(join(f.service, "started", next.id))).toBe(false);
    releaseOlder(); await f.finished(next);
    for (const release of held) release();
  });

for (const checkRuns of [1, 2]) it(`admits two extra requests in order without starvation or double execution (limit ${checkRuns})`, async () => {
    const f = await fixture({ checkRuns });
    const secondTask = await f.add();
    const first = await f.submit("first");
    const second = await f.submit("second", ["probe", "hold"], secondTask.id);
    expect([first.queuePosition, second.queuePosition]).toEqual([1, 2]);
    expect(f.engine.checkQueue.running).toBe(0);
    f.engine.setPoolPaused(false);
    await f.started(first);
    if (checkRuns === 1) expect(existsSync(join(f.service, "started", second.id))).toBe(false);
    else await f.started(second);
    f.release(first); await f.finished(first); await f.started(second);
    f.release(second); await f.finished(second);
    expect(readdirSync(join(f.service, "started")).length).toBe(2);
    expect(f.engine.checkQueue.running).toBe(0);
  });

it("caller cancellation ends only its wait; retries return the same saved run and original log", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const waiting = f.coordination.call("validation.run", { ...f.request("lost-reply"), wait: true, timeoutMs: 60_000 }, controller.signal);
    await waitFor(() => f.engine.s.extraValidations?.length === 1, "durable queued request");
    controller.abort();
    const first = (await waiting).validation as ExtraValidation;
    expect(first.state).toBe("queued");
    const other = await f.coordination.call("pool.inspect", {});
    expect(other.outcome).toBe("completed");
    f.engine.setPoolPaused(false); await f.started(first);
    const retry = await f.coordination.call("validation.run", { ...f.request("lost-reply"), timeoutMs: 0 });
    expect((retry.validation as ExtraValidation).id).toBe(first.id);
    const runningCaller = new AbortController();
    const runningWait = f.coordination.call("validation.run", { ...f.request("lost-reply"), wait: true }, runningCaller.signal);
    await f.coordination.call("pool.inspect", {});
    runningCaller.abort();
    expect(((await runningWait).validation as ExtraValidation).state).toBe("running");
    expect((await f.coordination.call("validation.run", { ...f.request("lost-reply"), reason: "Changed reason" })).outcome).toBe("conflict");
    f.release(first);
    const record = await f.finished(first);
    const final = await f.coordination.call("validation.run", f.request("lost-reply"));
    expect(final.validation).toEqual(record);
    expect(readdirSync(join(f.service, "started"))).toEqual([first.id]);
    const log = await f.coordination.call("validation.log", { requestId: "lost-reply" });
    expect(log.completeness).toBe("complete");
    expect(log.text).toContain("Original complete diagnostic");
    writeFileSync(record.run!.logPath!, "replacement");
    expect((await f.coordination.call("validation.log", { requestId: "lost-reply" })).completeness).toBe("missing-file");
  });

it("holds capacity after the client dies while its container remains, survives cancellation and refuses removal until confirmed", async () => {
    const f = await fixture();
    f.engine.setPoolPaused(false);
    const record = await f.submit("held"); await f.started(record);
    expect(await git(record.snapshot, "rev-parse", "HEAD")).toBe(record.commit);
    expect(await git(record.snapshot, "rev-parse", "HEAD^{tree}")).toBe(record.tree);
    expect(readFileSync(join(record.snapshot, ".git", "config"), "utf8")).not.toContain("alternates");
    expect(existsSync(join(record.snapshot, ".git", "objects", "info", "alternates"))).toBe(false);
    writeFileSync(join(f.service, "cleanup-off"), "unavailable");
    const running = f.engine.s.extraValidations![0]!;
    process.kill(running.clientPid!, "SIGKILL");
    await waitFor(() => running.state === "held", "unconfirmed workload to hold its place");
    f.engine.cancel(f.task.id);
    expect(f.engine.checkQueue.running).toBe(1);
    expect(existsSync(record.snapshot)).toBe(true);
    expect(() => f.engine.removeProduct(f.productId)).toThrow("still needs this product for cleanup");
    const status = await f.coordination.call("engine.status", {});
    expect(status.checkBlockers).toEqual([f.engine.extraValidations.blocker]);
    const controller = new AbortController();
    const pending = f.engine.checkQueue.acquire(controller.signal);
    expect(f.engine.checkQueue.waiting).toBe(1);
    rmSync(join(f.service, "cleanup-off"));
    await f.engine.extraValidations.retryCleanup();
    const release = await pending; release();
    expect((await f.finished(record)).result).toBe("did not finish");
    expect((await f.coordination.call("validation.log", { requestId: record.requestId })).commandOutcome).toBe("unfinished");
    expect(existsSync(record.snapshot)).toBe(false);
    expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    expect(f.engine.extraValidations.outstanding(f.productId)).toBeUndefined();
    f.engine.removeProduct(f.productId);
    expect(f.engine.s.products).toEqual([]);
  });

it("keeps the remaining cleanup blocker on waiting checks after one of two held runs finishes", async () => {
    const f = await fixture({ checkRuns: 3 });
    f.engine.schedule = () => { f.engine.extraValidations.pump(); f.engine.checkQueue.pump(); };
    const first = await f.submit("first-held");
    const second = (await f.coordination.call("validation.run", { ...f.request("second-held", undefined, (await f.add()).id), name: "Second required suite" })).validation as ExtraValidation;
    f.engine.setPoolPaused(false);
    const productTask = await f.add(); productTask.state = "running";
    const controller = new AbortController();
    let productRun: Promise<unknown> | undefined;
    let confirmSecond = false;
    const container = f.engine.extraValidations["container"];
    const cleanup = container.cleanup.bind(container);
    container.cleanup = record => record.id === second.id && !confirmSecond ? Promise.resolve(false) : cleanup(record);
    try {
      await f.started(first); await f.started(second);
      writeFileSync(join(f.service, "cleanup-off"), "unavailable");
      for (const record of f.engine.s.extraValidations!) process.kill(record.clientPid!, "SIGKILL");
      await waitFor(() => f.engine.s.extraValidations!.every(record => record.state === "held") && f.engine.extraValidations.active === 0, "both runs to hold cleanup");
      productRun = f.engine["checks"].runProductChecks(executionFor(productTask), [{ name: "Ordinary check", argv: [process.execPath, "-e", "process.exit(0)"] }], controller.signal).then(failures => ({ failures }), error => ({ error }));
      await waitFor(() => f.engine.checkQueue.waiting === 1, "the product check to wait on cleanup");
      expect(productTask.statusLine).toBe(f.engine.extraValidations.blocker!);
      rmSync(join(f.service, "cleanup-off"));
      await f.engine.extraValidations.retryCleanup();
      expect(f.engine.s.extraValidations!.map(record => record.id)).toEqual([second.id]);
      expect(f.engine.checkQueue.running).toBe(1);
      expect(productTask.statusLine).toBe(f.engine.extraValidations.blocker!);
      expect(productTask.statusLine).toContain("Second required suite");
      expect(productTask.journey!.at(-1)!.productChecks![0]!.result).toBe("pending");
      f.engine.setPoolPaused(true);
      expect(productTask.statusLine).toBe("Waiting for the pool to resume");
      confirmSecond = true;
      await f.engine.extraValidations.retryCleanup();
      expect(productTask.statusLine).toBe("Waiting for the pool to resume");
      expect(f.engine.checkQueue.running).toBe(0);
      f.engine.setPoolPaused(false);
      expect(await productRun).toEqual({ failures: 0 });
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    } finally {
      confirmSecond = true; controller.abort();
      rmSync(join(f.service, "cleanup-off"), { force: true });
      await f.engine.extraValidations.retryCleanup(); await productRun;
      await f.engine.shutdown();
    }
  });
});
