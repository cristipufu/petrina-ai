import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtraValidation } from "@petrina/core";
import { Engine, writeFixtureEngineOptions } from "./engine.js";
import { waitFor } from "./fixtures.js";
import { Coordination } from "../src/coordination.js";
import { executionFor } from "../src/repository-context.js";
import { ExtraFixtures } from "./extra-fixtures.js";
import { FileFaults } from "./file-faults.js";

const owned = new ExtraFixtures();
const { engines } = owned;
const fixture = (...args: Parameters<ExtraFixtures["fixture"]>) => owned.fixture(...args);
afterAll(() => owned.close());

describe.skipIf(process.platform === "win32")("required extra validation shares the host check queue", () => {
  it("restarts a queued request once, preserves evidence binding and excludes working edits", async () => {
    const f = await fixture();
    writeFileSync(join(executionFor(f.task).work.worktree!, "working-only"), "not committed");
    const queued = await f.submit("restart-queued", ["probe", "pass"]);
    expect(queued.workingEdits).toBe(true);
    expect(queued.versionNote).toContain("working edits are not included");
    await f.engine.shutdown();
    const replacement = new Engine(f.data, f.settings); engines.push(replacement);
    const coordination = new Coordination(replacement); replacement.setPoolPaused(false);
    await waitFor(() => replacement.extraValidations.get(queued.requestId)?.outcome === "completed", "recovered queued validation");
    const result = (await coordination.call("validation.inspect", { requestId: queued.requestId })).validation as ExtraValidation;
    expect(result.commit).toBe(queued.commit); expect(result.tree).toBe(queued.tree);
    expect(result.container).toEqual(expect.objectContaining({ imageId: "sha256:" + "a".repeat(64), os: "linux", arch: "arm64" }));
    expect(readdirSync(join(f.service, "started"))).toEqual([queued.id]);
    expect(existsSync(queued.snapshot)).toBe(false);
  });

  for (const output of ["saved output", "no output", "no log file", "interrupted observation"] as const) it(`recovers an abruptly stopped engine with ${output} by label before any check starts, keeping its original incomplete log`, async () => {
    const f = await fixture();
    const record = await f.submit("crash-running", ["probe", output === "saved output" ? "hold" : "hold-silent"]);
    await f.engine.shutdown();
    const settings = join(f.root, "settings.json");
    writeFixtureEngineOptions(settings, f.settings);
    const folder = join(f.data, "checks", record.taskId);
    if (output === "no log file") {
      mkdirSync(join(f.data, "checks"), { recursive: true });
      writeFileSync(folder, "A file prevents creating the command log folder");
    }
    const crashed = Bun.spawn([process.execPath, join(import.meta.dir, "extra-crash-engine.ts"), f.data, settings], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let replacement: Engine | undefined;
    let cleanupOutcome: string | undefined;
    const interrupted = new Error("The diagnostic observer stopped before recovery started");
    try {
      await f.started(record);
      if (output === "interrupted observation") throw interrupted;
      // The service's start marker does not mean the engine has read stdout or written its log.
      // Crash only after observing the bytes we expect recovery to preserve; the silent control
      // proves a started workload can truthfully have an empty, incomplete diagnostic.
      const files = output === "no log file" ? [] : readdirSync(folder);
      expect(files).toHaveLength(output === "no log file" ? 0 : 1);
      const path = output === "no log file" ? undefined : join(folder, files[0]!);
      const diagnostic = `Original complete diagnostic for ${record.id}\n`;
      if (output === "saved output") await waitFor(() => readFileSync(path!, "utf8") === diagnostic, "the engine to save the original diagnostic before crashing");
      const original = path ? readFileSync(path, "utf8") : "";
      if (output === "no output") expect(original).toBe("");
      crashed.kill("SIGKILL"); await crashed.exited;
      expect(readdirSync(join(f.service, "containers"))).toEqual([record.containerName]);
      writeFileSync(join(f.service, "cleanup-off"), "service unavailable");
      replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.s.extraValidations![0]!.state).toBe("held");
      expect(replacement.checkQueue.running).toBe(1);
      const next = replacement.checkQueue.acquire(new AbortController().signal, true);
      expect(replacement.checkQueue.waiting).toBe(1);
      rmSync(join(f.service, "cleanup-off"));
      await replacement.extraValidations.retryCleanup();
      const release = await next;
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      expect(existsSync(record.snapshot)).toBe(false);
      release();
      const final = replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation;
      expect(final.result).toBe("stopped");
      expect(readdirSync(join(f.service, "started"))).toEqual([record.id]);
      const log = await new Coordination(replacement).call("validation.log", { requestId: record.requestId });
      expect(log.outcome).not.toBe("pending");
      expect(log.completeness).toBe(path ? "incomplete" : "excerpt-only");
      expect(log.commandOutcome).toBe("unfinished");
      expect(final.run!.logPath).toBe(path);
      expect(final.run!.logFileLength).toBe(path ? Buffer.byteLength(original) : undefined);
      expect(final.run!.logComplete).toBe(false);
      if (path) expect(readFileSync(path, "utf8")).toBe(original);
      if (output === "saved output") {
        expect(log.text).toBe(original);
      } else {
        if (path) expect(log.source).toBe("saved-result");
        expect(log.text).toContain("Petrina restarted before the command outcome was recorded");
      }
    } catch (error) {
      if (output !== "interrupted observation") throw error;
      expect(error).toBe(interrupted);
    } finally {
      crashed.kill("SIGKILL"); await crashed.exited;
      rmSync(join(f.service, "cleanup-off"), { force: true });
      // Recovery owns the detached client even when an earlier observation failed. Closed
      // admissions prevent a never-started request from beginning during emergency cleanup.
      if (!replacement) { replacement = new Engine(f.data, { ...f.settings, admissionsClosed: true }); engines.push(replacement); }
      try {
        await replacement.extraValidations.ready;
        await replacement.extraValidations.retryCleanup();
        cleanupOutcome = replacement.extraValidations.get(record.requestId)?.outcome;
      } finally { await replacement.shutdown(); }
    }
    expect(readdirSync(join(f.service, "containers"))).toEqual([]);
    expect(existsSync(record.snapshot)).toBe(false);
    expect(replacement.checkQueue.running).toBe(0);
    expect(readdirSync(join(f.service, "started"))).toEqual([record.id]);
    expect(cleanupOutcome).toBe("completed");
  });

  for (const phase of ["service inspection", "copying", "copying with held cleanup", "failed service inspection"] as const) it(`preserves never-started requests when force-stopped during ${phase}`, async () => {
    const f = await fixture();
    const record = await f.submit("force-stop-preparing", ["probe", "pass"]);
    const following = await f.submit("after-forced-stop", ["probe", "pass"], (await f.add()).id);
    const container = f.engine.extraValidations["container"];
    let entered!: () => void, releasePreparation!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { releasePreparation = resolve; });
    if (phase.includes("service inspection")) {
      const prepare = container.prepare.bind(container);
      container.prepare = async record => {
        entered(); await released;
        if (phase === "failed service inspection") throw new Error("Service inspection interrupted");
        return prepare(record);
      };
    } else {
      const snapshot = container.snapshot.bind(container);
      container.snapshot = async record => { await snapshot(record); entered(); await released; };
    }
    if (phase === "copying with held cleanup") container.cleanup = async () => false;
    let stopped: Promise<void> | undefined;
    try {
      f.engine.setPoolPaused(false); await preparing;
      f.engine.setPoolPaused(true);
      stopped = f.engine.shutdown();
      expect(f.engine.checkQueue.running).toBe(1);
      expect(f.engine.extraValidations.get(record.requestId)!.outcome).toBe("pending");
      releasePreparation(); await stopped;
      expect(f.engine.s.extraValidations!.map(entry => entry.state)).toEqual([phase === "copying with held cleanup" ? "held" : "queued", "queued"]);
      expect(f.engine.checkQueue.running).toBe(phase === "copying with held cleanup" ? 1 : 0);
      expect(existsSync(join(f.service, "started")) ? readdirSync(join(f.service, "started")) : []).toEqual([]);

      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.s.extraValidations!.map(entry => entry.state)).toEqual(["queued", "queued"]);
      expect(replacement.checkQueue.running).toBe(0);
      expect(existsSync(record.snapshot)).toBe(false);
      const retry = await new Coordination(replacement).call("validation.run", f.request(record.requestId, ["probe", "pass"]));
      const retried = retry.validation as ExtraValidation;
      expect(retry.outcome).toBe("pending");
      expect(retried).toEqual(expect.objectContaining({ id: record.id, state: "queued", commit: record.commit, tree: record.tree, queueOrder: record.queueOrder, queuedAt: record.queuedAt }));
      expect(retried.result).toBeUndefined();
      expect(retried.startedAt).toBeUndefined();
      expect(retried.endedAt).toBeUndefined();
      replacement.setPoolPaused(false);
      await waitFor(() => replacement.extraValidations.get(following.requestId)?.outcome === "completed", "both force-stopped requests to finish in order");
      expect((replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("passed");
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual([record.containerName, following.containerName]);
      expect(replacement.checkQueue.running).toBe(0);
      expect(readdirSync(join(f.service, "containers"))).toEqual([]);
      expect(existsSync(record.snapshot)).toBe(false);
      expect(existsSync(following.snapshot)).toBe(false);
    } finally { releasePreparation(); await (stopped ?? f.engine.shutdown()); }
  });

  for (const heldCopy of [false, true]) it(`returns interrupted preparation to its original place${heldCopy ? " after cleanup was held" : ""}`, async () => {
    const faults = new FileFaults();
    const f = await fixture({ files: faults.files });
    const record = await f.submit("crash-preparing", ["probe", "pass"]);
    const second = await f.add();
    const following = await f.submit("after-preparation", ["probe", "pass"], second.id);
    const current = f.engine.s.extraValidations![0]!;
    current.state = "preparing";
    mkdirSync(current.snapshot, { recursive: true }); writeFileSync(join(current.snapshot, "partial"), "incomplete copy");
    const allowRemoval = heldCopy ? faults.blockRemoval(current.snapshot) : () => {};
    try {
      f.engine.commitNow(); await f.engine.shutdown();
      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.s.extraValidations!.map(entry => entry.state)).toEqual([heldCopy ? "held" : "queued", "queued"]);
      replacement.setPoolPaused(false);
      if (heldCopy) {
        expect(replacement.checkQueue.waiting).toBe(1);
        expect(existsSync(join(f.service, "started", following.id))).toBe(false);
        allowRemoval();
        await replacement.extraValidations.retryCleanup();
      }
      await waitFor(() => replacement.extraValidations.get(following.requestId)?.outcome === "completed", "both never-started requests to finish once");
      expect(readdirSync(join(f.service, "started")).sort()).toEqual([record.id, following.id].sort());
      const calls = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(calls.map(args => args[args.indexOf("--name") + 1])).toEqual([record.containerName, following.containerName]);
    } finally { allowRemoval(); }
  });

  it("preserves an already completed outcome through held cleanup and restart, and drains only running work", async () => {
    const f = await fixture();
    const record = await f.submit("held-result");
    f.engine.setPoolPaused(false); await f.started(record);
    expect(f.engine.backgroundWork.size).toBeGreaterThan(0);
    writeFileSync(join(f.service, "cleanup-off"), "service unavailable");
    f.release(record);
    await waitFor(() => f.engine.s.extraValidations?.[0]?.state === "held", "held successful result");
    expect(f.engine.s.extraValidations![0]!.result).toBe("passed");
    await waitFor(() => f.engine.extraValidations.active === 0, "cleanup attempt to settle");
    await f.engine.shutdown();
    const replacement = new Engine(f.data, f.settings); engines.push(replacement);
    await replacement.extraValidations.ready;
    expect(replacement.s.extraValidations![0]!.result).toBe("passed");
    expect(replacement.extraValidations.blocker).toContain(record.containerName);
    expect(replacement.extraValidations.blocker).toContain("container service available");
    rmSync(join(f.service, "cleanup-off"));
    await replacement.extraValidations.retryCleanup();
    expect((replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("passed");
  });

  it("keeps paused and draining submissions queued without taking capacity; ordinary no-extra evidence is unchanged", async () => {
    const f = await fixture();
    const work = executionFor(f.task).work;
    const checks = JSON.stringify(work.checks);
    const eventsBefore = f.engine.events.log.collect({}, 0, 100).events.filter(event => event.kind.startsWith("check."));
    expect(f.engine.s.extraValidations).toBeUndefined();
    const queued = await f.submit("draining");
    expect(f.engine.checkQueue.running).toBe(0);
    f.engine.draining = true;
    f.engine.s.pool.paused = false; f.engine.schedule();
    expect(f.engine.checkQueue.running).toBe(0);
    expect(f.engine.s.extraValidations![0]!.state).toBe("queued");
    f.engine.draining = false; f.engine.schedule(); await f.started(queued);
    f.release(queued); await f.finished(queued);
    expect(JSON.stringify(work.checks)).toBe(checks);
    expect(f.engine.events.log.collect({}, 0, 100).events.filter(event => event.kind.startsWith("check."))).toEqual(eventsBefore);
    // No extra work: ordinary check execution and product removal continue under their old rules.
    const release = await f.engine["checks"]["turnToRun"](executionFor(f.task), new AbortController().signal);
    release();
    f.engine.cancel(f.task.id);
    f.engine.removeProduct(f.productId);
    expect(f.engine.s.products).toEqual([]);
  });

  it("cancelling during preparation keeps ownership and capacity until the admitted work settles", async () => {
    const f = await fixture();
    let entered!: () => void, releasePreparation!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { releasePreparation = resolve; });
    f.engine.extraValidations["container"].snapshot = async () => { entered(); await released; };
    const record = await f.submit("preparation-cancel");
    f.engine.setPoolPaused(false); await preparing;
    expect(f.engine.s.extraValidations![0]!.state).toBe("preparing");
    f.engine.cancel(f.task.id);
    expect(f.engine.extraValidations.get(record.requestId)!.outcome).toBe("pending");
    expect(f.engine.checkQueue.running).toBe(1);
    expect(() => f.engine.removeProduct(f.productId)).toThrow("still needs this product");
    const next = f.engine.checkQueue.acquire(new AbortController().signal);
    expect(f.engine.checkQueue.waiting).toBe(1);
    releasePreparation();
    const release = await next; release();
    expect((await f.finished(record)).result).toBe("stopped");
    expect(f.engine.events.log.collect({}, 0, 100).events.filter(event => event.kind === "extra.finished")).toHaveLength(1);
  });

  it("keeps a task cancellation final when Petrina also stops during preparation", async () => {
    const f = await fixture();
    let entered!: () => void, releasePreparation!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { releasePreparation = resolve; });
    f.engine.extraValidations["container"].snapshot = async () => { entered(); await released; };
    const record = await f.submit("cancel-before-shutdown");
    let stopped: Promise<void> | undefined;
    try {
      f.engine.setPoolPaused(false); await preparing;
      f.engine.cancel(f.task.id);
      stopped = f.engine.shutdown();
      releasePreparation(); await stopped;
      expect(f.engine.checkQueue.running).toBe(0);
      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.extraValidations.get(record.requestId)).toEqual(expect.objectContaining({ outcome: "completed",
        validation: expect.objectContaining({ id: record.id, result: "stopped", detail: "The task stopped before the container started." }) }));
      expect(replacement.s.extraValidations).toEqual([]);
      expect(readdirSync(join(f.service, "started"))).toEqual([]);
    } finally { releasePreparation(); await (stopped ?? f.engine.shutdown()); }
  });

  it("makes copy-cleanup failures visible across restart and retries them without leaking a hidden place", async () => {
    const faults = new FileFaults();
    const f = await fixture({ files: faults.files });
    const record = await f.submit("copy-cleanup");
    f.engine.setPoolPaused(false); await f.started(record);
    const allowRemoval = faults.blockRemoval(record.snapshot);
    try {
      f.release(record);
      await waitFor(() => f.engine.s.extraValidations?.[0]?.state === "held", "inaccessible copy to hold cleanup");
      expect(f.engine.s.extraValidations![0]!.result).toBe("passed");
      await f.engine.shutdown();
      const replacement = new Engine(f.data, f.settings); engines.push(replacement);
      await replacement.extraValidations.ready;
      expect(replacement.s.extraValidations![0]!.state).toBe("held");
      expect(replacement.extraValidations.blocker).toContain("copy");
      expect(replacement.checkQueue.running).toBe(1);
      allowRemoval();
      await replacement.extraValidations.retryCleanup();
      expect((replacement.extraValidations.get(record.requestId)!.validation as ExtraValidation).result).toBe("passed");
      expect(replacement.checkQueue.running).toBe(0);
    } finally { allowRemoval(); }
  });
});
