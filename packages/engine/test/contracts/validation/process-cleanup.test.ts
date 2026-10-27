import { childState } from "@petrina/platform/process-tree";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { currentSlow, waitFor } from "../../fixtures.js";


import { extraFixture } from "../../extra-fixtures.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());


describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
for (const observed of [false, true]) it(`stops the labelled workload but keeps capacity for a local child that outlives its client ${observed ? "after observing its identity" : "without observing its identity"}`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => { f.engine.setPoolPaused(false);
    const record = await f.submit("client-child", ["probe", "hold-child"]); await f.started(record);
    const started = JSON.parse(readFileSync(join(f.service, "started", record.id), "utf8"));
    try {
      // Establish product evidence while both client and helper are live; fixture knowledge alone is not ownership.
      if (observed) {
        const signal = process.kill;
        const blocked = spyOn(process, "kill");
    owner.onStop(() => blocked.mockRestore());
    blocked.mockImplementation(((pid: number, how?: NodeJS.Signals | number) => {
          if (pid === -started.pid && how === "SIGKILL") throw Object.assign(new Error("Controlled client stop refusal"), { code: "EPERM" });
          return signal(pid, how);
        }) as typeof process.kill);
        try {
          const current = f.engine.s.extraValidations![0]!;
          expect(await f.engine.extraValidations["container"]["stopClient"](current)).toBe(false);
          expect(current.cleanupDetail).toContain("verified local client");
        } finally { blocked.mockRestore(); }
      }
      process.kill(started.pid, "SIGKILL");
      await waitFor(() => f.engine.s.extraValidations?.[0]?.state === "held", "surviving owned local child");
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      expect(f.engine.checkQueue.running).toBe(1);
      if (observed) {
        expect(f.engine.extraValidations.blocker).toContain(`verified local helpers (${started.childPid})`);
        expect(f.engine.extraValidations.blocker).toContain("Stop those owned programs");
        expect(f.engine.extraValidations.blocker).not.toContain("restart this computer");
      } else {
        expect(f.engine.extraValidations.blocker).toContain("may be unrelated");
        expect(f.engine.extraValidations.blocker).toContain("Do not stop programs based on the saved number");
        expect(f.engine.extraValidations.blocker).not.toContain("Stop those owned programs");
      }
      const pending = f.engine.checkQueue.acquire(new AbortController().signal);
      process.kill(started.childPid, "SIGUSR1");
      await waitFor(async () => { await f.engine.extraValidations.retryCleanup(); return f.engine.extraValidations.get(record.requestId)?.outcome === "completed"; }, "local child cleanup confirmation");
      const release = await pending; release();
      expect(await childState(started.childPid)).toBe("ended");
      expect(existsSync(record.snapshot)).toBe(false);
    } finally { await owner.stop(f.engine); }

  });

  });
});

for (const stalled of [false, true]) it(`${stalled ? "holds boundedly unconfirmed removal" : "confirms removal in progress without a false held state"} before handing off capacity`, async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const record = await f.submit("removal-in-progress");
    f.engine.setPoolPaused(false); await f.started(record);
    writeFileSync(join(f.service, "removal-pending"), "service is removing the stopped container");
    const controller = new AbortController();
    owner.onStop(() => controller.abort());
    let admitted = false;
    const pending = f.engine.checkQueue.acquire(controller.signal).then(place => { admitted = true; return place; }, () => undefined);
    try {
      f.engine.cancel(f.task.id);
      await waitFor(() => existsSync(join(f.service, "removal-observed")), "the owned container to be listed during removal");
      expect(admitted).toBe(false); expect(f.engine.checkQueue.running).toBe(1);
      if (!stalled) expect(f.engine.s.extraValidations![0]!.state).toBe("stopping");
      if (stalled) {
        await waitFor(() => f.engine.s.extraValidations![0]?.state === "held", "bounded removal confirmation to stay held");
        expect(f.engine.extraValidations.blocker).toContain("still unconfirmed after its stop/removal request");
        expect(f.engine.extraValidations.blocker).not.toContain("Make the local container service available");
      }
      writeFileSync(join(f.service, "finish-removal"), "release removal");
      if (stalled) await f.engine.extraValidations.retryCleanup();
      await waitFor(() => f.engine.extraValidations.get(record.requestId)?.outcome === "completed", "normal product cleanup to release capacity");
      const place = await pending;
      expect((await f.finished(record)).result).toBe("stopped");
      expect(f.engine.events.log.collect({}, 0, 100).events.filter(event => event.kind === "extra.held")).toHaveLength(stalled ? 1 : 0);
      expect(existsSync(record.snapshot)).toBe(false);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      place!(); expect(f.engine.checkQueue.running).toBe(0);
    } finally {
      writeFileSync(join(f.service, "finish-removal"), "release removal"); controller.abort(); (await pending)?.();
      await f.engine.extraValidations.retryCleanup(); await owner.stop(f.engine);
    }

  });

  });
});

it("a time limit stops the workload before releasing the next place", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => { f.engine.setPoolPaused(false);
    const record = await f.submit("deadline"); await f.started(record);
    const next = f.engine.checkQueue.acquire(new AbortController().signal);
    const release = await next;
    expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    expect(existsSync(record.snapshot)).toBe(false);
    expect((await f.finished(record)).result).toBe("did not finish");
    release();

  }, { checkTimeoutMs: 1_000 * currentSlow() });

  });
});

it("cancels queued work without execution and running work with confirmed cleanup", async () => {
  return cases.use("petrina-extra-", async owner => {
    return await extraFixture(owner, async f => {
    const queued = await f.submit("queued-cancel");
    f.engine.cancel(f.task.id);
    expect((await f.finished(queued)).result).toBe("stopped");
    expect(existsSync(join(f.service, "started"))).toBe(false);
    const task = await f.add(); f.engine.setPoolPaused(false);
    const running = await f.submit("running-cancel", undefined, task.id); await f.started(running);
    f.engine.cancel(task.id); await f.finished(running);
    expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    expect(f.engine.checkQueue.running).toBe(0);

  });

  });
});
});
