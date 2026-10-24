import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";
import { currentSlow, waitFor } from "./fixtures.js";
import * as processTree from "@petrina/platform/process-tree";
import { ExtraContainer } from "../src/extra-container.js";
import { ExtraFixtures } from "./extra-fixtures.js";

const owned = new ExtraFixtures();
const fixture = (...args: Parameters<ExtraFixtures["fixture"]>) => owned.fixture(...args);
afterAll(() => owned.close());

describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
  for (const identity of ["saved number", "verified client", "surviving helper", "unknown command"] as const) it(`gives ${identity === "verified client" || identity === "surviving helper" ? `direct advice for a ${identity}` : `safe uncertainty for a ${identity}`}`, async () => {
    const verified = identity === "verified client" || identity === "surviving helper";
    const f = await fixture();
    const record = await f.submit("client-advice");
    const current = { ...record, clientPid: 712345 };
    const command = verified ? `docker run --name ${record.containerName} --label app.petrina.validation-run=${record.id} local:image` : "unrelated-program";
    const start = "Fri Oct 23 08:00:00 2026";
    const before = `712345 712345 S ${start} ${command}\n712346 712345 S ${start} helper\n`;
    const read = spyOn(processTree, "processList").mockResolvedValue(identity === "unknown command" ? "712345 712345 S\n" : before);
    let reads = 0;
    if (identity === "surviving helper") read.mockImplementation(async () => reads++ === 0 ? before : `712346 712345 S ${start} helper\n`);
    const kill = spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Cannot stop client"), { code: "EPERM" }); });
    try {
      expect(await f.engine.extraValidations["container"]["stopClient"](current)).toBe(false);
      expect(current.cleanupDetail).toContain(identity === "surviving helper" ? "verified local helpers" : verified ? "verified local client" : "may be unrelated");
      if (verified) expect(current.cleanupDetail).not.toContain("restart this computer");
      else { expect(kill).not.toHaveBeenCalled(); expect(current.cleanupDetail).toContain("Do not stop programs based on the saved number"); }
    } finally { read.mockRestore(); kill.mockRestore(); }
  });

  for (const identity of ["same helper", "changed start", "changed command", "new member", "missing start", "new observer"] as const) it(`revalidates an observed helper identity: ${identity}`, async () => {
    const f = await fixture(), record = await f.submit("observed-helper");
    const current = { ...record, clientPid: 712345 };
    const start = "Fri Oct 23 08:00:00 2026";
    const client = `712345 712345 S ${start} docker run --name ${record.containerName} --label app.petrina.validation-run=${record.id} local:image`;
    const read = spyOn(processTree, "processList").mockResolvedValue(`${client}\n712346 712345 S ${start} helper\n`);
    const kill = spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Cannot stop client"), { code: "EPERM" }); });
    try {
      const observer = f.engine.extraValidations["container"];
      expect(await observer["stopClient"](current)).toBe(false);
      expect(current.cleanupDetail).toContain("verified local client");
      read.mockResolvedValue(identity === "missing start" ? "712346 712345 S helper\n" : `${identity === "new member" ? 712347 : 712346} 712345 S ${identity === "changed start" ? "Fri Oct 23 08:00:01 2026" : start} ${identity === "changed command" ? "unrelated" : "helper"}\n`);
      kill.mockClear();
      expect(await (identity === "new observer" ? new ExtraContainer(f.engine) : observer)["stopClient"](current)).toBe(false);
      expect(kill).not.toHaveBeenCalled(); // A remembered identity authorizes advice, never a signal.
      expect(current.cleanupDetail).toContain(identity === "same helper" ? "verified local helpers (712346)" : "may be unrelated");
      if (identity === "same helper") expect(current.cleanupDetail).toContain("Stop those owned programs");
      else expect(current.cleanupDetail).toContain("Do not stop programs based on the saved number");
    } finally { read.mockRestore(); kill.mockRestore(); }
  });

  it("holds a client first identified by the final lookup even without a saved client number", async () => {
    const f = await fixture(), record = await f.submit("final-client-identity");
    const current = { ...record, clientPid: undefined };
    const identified = `712345 712345 S Fri Oct 23 08:00:00 2026 docker run --name ${record.containerName} --label app.petrina.validation-run=${record.id} local:image\n`;
    let reads = 0;
    const read = spyOn(processTree, "processList").mockImplementation(async () => reads++ === 0 ? "712345 712345 S\n" : identified);
    const kill = spyOn(process, "kill").mockImplementation(() => { throw new Error("Unexpected signal from an unidentified first lookup"); });
    try {
      expect(await f.engine.extraValidations["container"]["stopClient"](current)).toBe(false);
      expect(current.cleanupDetail).toContain("verified local client");
      expect(kill).not.toHaveBeenCalled();
    } finally { read.mockRestore(); kill.mockRestore(); }
  });

  for (const observed of [false, true]) it(`stops the labelled workload but keeps capacity for a local child that outlives its client ${observed ? "after observing its identity" : "without observing its identity"}`, async () => {
    const f = await fixture(); f.engine.setPoolPaused(false);
    const record = await f.submit("client-child", ["probe", "hold-child"]); await f.started(record);
    const started = JSON.parse(readFileSync(join(f.service, "started", record.id), "utf8"));
    try {
      // Establish product evidence while both client and helper are live; fixture knowledge alone is not ownership.
      if (observed) {
        const signal = process.kill;
        const blocked = spyOn(process, "kill").mockImplementation(((pid: number, how?: NodeJS.Signals | number) => {
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
      expect(existsSync(record.snapshot)).toBe(false);
    } finally { try { process.kill(started.childPid, "SIGKILL"); } catch { /* Already stopped. */ } }
  });

  for (const mode of ["slow removal", "short remaining window", "unresponsive"] as const) it(`confirms removal with an unchanged service-read allowance: ${mode}`, async () => {
    const f = await fixture({ containerCommandTimeoutMs: 4_000 });
    await f.engine.waitUntilReady();
    const record = await f.submit("confirmation-budget"), container = f.engine.extraValidations["container"];
    let now = Date.now(), reads = 0;
    const start = now, budgets: number[] = [];
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const sleep = spyOn(Bun, "sleep").mockImplementation(async ms => { now += ms instanceof Date ? ms.getTime() - now : ms; });
    const inspections = container as unknown as { labelled(record: ExtraValidation, timeout?: number): Promise<string[]> };
    const inspect = spyOn(inspections, "labelled").mockImplementation(async (_record, timeout = 4_000) => {
      budgets.push(timeout); reads++;
      const latency = mode === "unresponsive" ? 4_001 : mode === "short remaining window" && reads === 1 ? 3_900 : 100;
      await Bun.sleep(Math.min(latency, timeout));
      if (latency > timeout) throw new Error("Controlled container inspection timed out");
      return mode === "slow removal" && now - start < 1_500 || mode === "short remaining window" && reads === 1 ? [record.containerName] : [];
    });
    try {
      expect(await container["removed"](record)).toBe(mode !== "unresponsive");
      expect(budgets.every(budget => budget === 4_000)).toBe(true);
      expect(now - start).toBeLessThan(8_000);
      if (mode === "unresponsive") { expect(reads).toBe(1); expect(now - start).toBe(4_000); }
      else expect(now - start).toBeGreaterThan(1_000);
    } finally { inspect.mockRestore(); sleep.mockRestore(); clock.mockRestore(); await f.engine.shutdown(); }
  });

  for (const stalled of [false, true]) it(`${stalled ? "holds boundedly unconfirmed removal" : "confirms removal in progress without a false held state"} before handing off capacity`, async () => {
    const f = await fixture();
    const record = await f.submit("removal-in-progress");
    f.engine.setPoolPaused(false); await f.started(record);
    writeFileSync(join(f.service, "removal-pending"), "service is removing the stopped container");
    const controller = new AbortController();
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
      await f.engine.extraValidations.retryCleanup(); await f.engine.shutdown();
    }
  });

  it("a time limit stops the workload before releasing the next place", async () => {
    const f = await fixture({ checkTimeoutMs: 1_000 * currentSlow() }); f.engine.setPoolPaused(false);
    const record = await f.submit("deadline"); await f.started(record);
    const next = f.engine.checkQueue.acquire(new AbortController().signal);
    const release = await next;
    expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    expect(existsSync(record.snapshot)).toBe(false);
    expect((await f.finished(record)).result).toBe("did not finish");
    release();
  });

  it("cancels queued work without execution and running work with confirmed cleanup", async () => {
    const f = await fixture();
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
