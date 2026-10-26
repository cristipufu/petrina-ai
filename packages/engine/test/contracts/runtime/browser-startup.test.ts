import { completeAll } from "@petrina/core";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { directDrivers, removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { afterEach } from "bun:test";
import { engineProcessCases } from "../../support.js";
import { afterAll, expect, it } from "bun:test";
import * as processes from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "../../engine.js";
import * as browserRecovery from "@petrina/agent-runtime/browser";
import { CLEANUP_NOTE, recoverBrowserTemps } from "@petrina/agent-runtime/browser";
import { browserProcesses } from "@petrina/platform/browser-processes";
import { connectionPath } from "../../../src/instance.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { Fakes, FAKE_AGENT, makeProduct, removeDir, tempDir, testBrowserRoot, waitFor } from "../../support.js";
import { expectRejection } from "@petrina/test-support/rejections";

const cases = engineProcessCases();
const inProcessClosers = new Set<() => Promise<void>>(), retainedRecoveries = new Set<string>();
afterEach(() => completeAll([...inProcessClosers].map(close => close()).concat(cases.close())).then(() => undefined));
const root = tempDir("petrina-browser-startup-");
registerFixtureRoot(root);
const browsers = testBrowserRoot();
registerFixtureRoot(browsers);
afterAll(() => { removeDir(root); if (!cases.retained.size && !retainedRecoveries.size) removeDir(browsers); });
const notePattern = (fields: string) => new RegExp(`^${`${CLEANUP_NOTE} ${fields}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("elapsed=\\?", "elapsed=\\d+ms")}\n?$`);

const BROWSER_RECOVERY_FAILURE = fileURLToPath(new URL("../../fixtures/browser-startup-failure.ts", import.meta.url));

const RECOVERY_HOLD_WAIT_MS = 5_000;

for (const result of [{ kind: "fulfilled" }, { kind: "rejected", error: new Error("Startup recovery failed after its hold") }, { kind: "rejected", error: undefined }] as const) it(`joins held startup recovery before shutdown and root disposal (${result.kind === "fulfilled" ? "success" : result.error === undefined ? "undefined" : "Error"})`, async () => {
  const work = tempDir("petrina-startup-shutdown-"), owner = directDrivers(work);
  const release = Promise.withResolvers<void>();
  let commandRoot: string | undefined, commands: ReturnType<typeof cases.open> | undefined;
  let startup: Promise<void> | undefined, receipt: Promise<{ value: void } | { error: unknown }> | undefined;
  let command: ReturnType<ReturnType<typeof cases.open>["command"]> | undefined, finishing: Promise<void> | undefined;
  let started = false, recovered = false;
  const finish = (): Promise<void> => {
    // Publish the release even when Bun ended the case without unwinding its body.
    release.resolve();
    if (finishing) return finishing;
    let done!: () => void, failed!: (error: unknown) => void;
    finishing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    void (async () => {
      const settled = await Promise.allSettled([owner.close(), commands?.close()]);
      const errors = settled.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Startup shutdown owners could not confirm cleanup; roots retained");
      // Both original results were observed when published; canonical close confirms native cleanup.
      if (commandRoot && !commands) removeFixtureRoot(commandRoot);
    })().then(done, failed);
    void finishing.then(() => inProcessClosers.delete(finish), () => { inProcessClosers.delete(finish); retainedRecoveries.add(work); });
    return finishing;
  };
  inProcessClosers.add(finish);
  await setupWithCleanup(async () => {
    commandRoot = tempDir("petrina-startup-shutdown-boundary-");
    const ownedCommands = cases.open(commandRoot); commands = ownedCommands;
    const engine = owner.open(join(work, "data"), { agentCommand: () => undefined, browserRecovery: async () => {
      started = true;
      try {
        await release.promise;
        if (result.kind === "rejected") throw result.error;
        writeFixtureJson(join(work, "recovery-finished.json"), { finished: true });
      } finally { recovered = true; }
    } });
    startup = engine.waitUntilReady();
    receipt = startup.then(value => ({ value }), (error: unknown) => ({ error }));
    expect(started).toBe(true);
    const shutdown = engine.shutdown(), closing = owner.close();
    let shutdownSettled = false, rootSettled = false;
    let recoveredAtShutdown: boolean | undefined, recoveredAtClose: boolean | undefined;
    void shutdown.then(() => { shutdownSettled = true; recoveredAtShutdown = recovered; }, () => { shutdownSettled = true; recoveredAtShutdown = recovered; });
    void closing.then(() => { rootSettled = true; recoveredAtClose = recovered; }, () => { rootSettled = true; recoveredAtClose = recovered; });
    const shutdownAgain = engine.shutdown();
    // This independently owned actual command fully exits and drains; no continuation budget stands in for it.
    command = ownedCommands.command(commandRoot, ["-e", 'console.log("startup boundary");']);
    expect(await command.completion).toMatchObject({ code: 0, stdout: "startup boundary\n", stderr: "" });
    expect(shutdownSettled).toBe(false);
    expect(rootSettled).toBe(false);
    expect(recovered).toBe(false);
    expect(existsSync(work)).toBe(true);
    expect(engine.store.database.query("SELECT 1 AS live").get()).toEqual({ live: 1 });
    release.resolve();
    const ready = await receipt;
    if (result.kind === "rejected") {
      expect("error" in ready).toBe(true);
      if (!("error" in ready)) throw new Error("The original startup rejection became a ready result");
      expect(ready.error).toBe(result.error);
    } else expect("value" in ready).toBe(true);
    await completeAll([shutdown, shutdownAgain, closing]);
    expect(shutdownAgain).toBe(shutdown);
    expect(recoveredAtShutdown).toBe(true);
    expect(recoveredAtClose).toBe(true);
    expect(engine.stopped).toBe(true);
    expect(() => engine.store.database.query("SELECT 1").get()).toThrow();
    expect(existsSync(work)).toBe(false);
  }, finish);
  await finish();
});

async function withPendingBrowserRecovery(
  check: (fixture: { engine: Engine; fakes: Fakes; work: string; registry: string; stale: string; startup: Promise<void>; ready: () => boolean; release: () => void }) => Promise<void>,
  options: { atHold?: (markReached: () => void) => void; observeMs?: number; bypassHold?: boolean } = {},
) {
  const work = tempDir("petrina-browser-startup-pending-"), owner = directDrivers(work);
  const releaseRecovery = Promise.withResolvers<void>();
  let stale: string | undefined, startup: Promise<void> | undefined;
  let ready = false, settled = false;
  let failure: { error: unknown } | undefined, closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // A failed or timed-out test must release recovery before joining shutdown.
    releaseRecovery.resolve();
    if (closing) return closing;
    let done!: () => void, failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    void (async () => {
      await owner.close();
      if (startup) await waitFor(() => settled, "browser startup recovery to settle after releasing its test hold", RECOVERY_HOLD_WAIT_MS,
        { during: startup.then(() => undefined, () => undefined) });
      if (stale) removeFixtureRoot(stale);
    })().then(done, failed);
    void closing.then(() => inProcessClosers.delete(close), () => { inProcessClosers.delete(close); retainedRecoveries.add(work); });
    return closing;
  };
  inProcessClosers.add(close);
  const run = await setupWithCleanup(() => owner.prepare(async () => {
    const data = join(work, "data"), registry = join(data, "browser-temp");
    const currentStale = mkdtempSync(join(browsers, "petrina-browser-")); stale = currentStale;
    const fakes = new Fakes(join(work, "fake"));
    mkdirSync(registry, { recursive: true });
    writeFixtureJson(join(registry, "stale.json"), stale);
    // Hold the promise the kernel awaits, rather than a process scan whose own
    // deadline can finish recovery while product setup is still running.
    let recovered = false;
    const recover = browserRecovery.recoverBrowserTemps;
    let heldArgs: Parameters<typeof recover> | undefined;
    const scopedRecovery = async (...args: Parameters<typeof recover>) => {
      if (args[0] !== registry || args[1] !== browsers) throw new Error("Unexpected browser recovery owner");
      heldArgs = args;
      await owner.prepare(() => recover(args[0], args[1], undefined, { ...browserProcesses, readFolder: async () => ({ pids: [], states: new Map() }) }));
      if (options.atHold) options.atHold(() => { recovered = true; });
      else recovered = true;
      await releaseRecovery.promise;
    };
    // The actual generation is registered before any asynchronous startup can settle.
    const engine = owner.open(data, { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir], browser: true, browserTempRoot: browsers, ...(options.bypassHold ? {} : { browserRecovery: scopedRecovery }) });
    const starting = engine.waitUntilReady(); startup = starting;
    void starting.then(() => { ready = true; settled = true; }, error => { failure = { error }; settled = true; });
    // In bypass mode the kernel's default native recovery is the operation under test.
    if (options.bypassHold) void owner.prepare(() => starting).catch(() => undefined);
    return { current: engine, fakes, registry, stale: currentStale, startup: starting, recovered: () => recovered, heldArgs: () => heldArgs };
  }), close);
  await setupWithCleanup(async () => {
    // Bound observation only. The hold itself never expires during slow setup.
    await waitFor(() => {
      if (failure) throw failure.error;
      if (run.recovered()) return true;
      if (ready) throw new Error("Browser startup finished without reaching its recovery hold");
      return false;
    }, "browser startup recovery to reach its held point", options.observeMs ?? RECOVERY_HOLD_WAIT_MS);
    const heldArgs = run.heldArgs(), registry = run.registry;
    expect(heldArgs).toEqual([registry, browsers]);
    await owner.run(run.current, () => check({ engine: run.current, fakes: run.fakes, work, registry: run.registry, stale: run.stale, startup: run.startup, ready: () => ready, release: releaseRecovery.resolve }));
  }, close);
  await close();
}

it("does not schedule queued work after shutdown while browser recovery is pending", async () => {
  await withPendingBrowserRecovery(async ({ engine, fakes, work, registry, stale, startup, ready, release }) => {
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(registry)).toBe(false);
    const productId = await engine.addProduct(await makeProduct(work));
    expect(ready()).toBe(false);
    const taskId = engine.addTask({ productId, title: "A queued task", description: "[no-check]" });
    const task = engine.task(taskId)!;
    task.state = "waiting";
    task.screen = { reason: "Check the window", at: Date.now(), roleId: "builder", profileId: "sol-high" };
    engine.setScreenUse("off");
    expect(engine.s.inbox.filter(item => item.taskId === taskId && item.kind === "screen")).toEqual([expect.objectContaining({ blocking: false })]);
    engine.allowScreen(taskId);
    expect(engine.s.inbox.some(item => item.taskId === taskId && item.kind === "screen")).toBe(false);
    expect(engine.store.load()!.tasks.find(task => task.id === taskId)!.screen?.allowed).toBe(true);
    delete task.screen.allowed;
    engine.setTaskScreen(taskId, true);
    expect(engine.store.load()!.tasks.find(task => task.id === taskId)!.screenAllowed).toBe(true);
    engine.setTaskScreen(taskId, false);
    expect(engine.s.inbox.filter(item => item.taskId === taskId && item.kind === "screen")).toEqual([expect.objectContaining({ blocking: false })]);
    expect(engine.store.load()!.tasks.find(task => task.id === taskId)!.screenAllowed).toBeUndefined();
    engine.setScreenUse("on");
    expect(engine.s.inbox.some(item => item.taskId === taskId && item.kind === "screen")).toBe(false);
    expect(engine.store.load()!.pool.screen?.mode).toBe("on");
    expect(ready()).toBe(false);
    expect(engine.drivers.size).toBe(0);
    expect(fakes.opens()).toEqual([]);
    const shutdown = engine.shutdown();
    expect(ready()).toBe(false);
    release();
    await startup;
    await shutdown;
    expect(ready()).toBe(true);
    expect(engine.stopped).toBe(true);
    expect(engine.drivers.size).toBe(0);
    expect(fakes.opens()).toEqual([]);
    expect(existsSync(registry)).toBe(false);
  });
});

it("lets later recovery finish while the owned startup call remains held, before teardown", async () => {
  const originalRecovery = browserRecovery.recoverBrowserTemps, originalScan = processes.execFile;
  await withPendingBrowserRecovery(async ({ registry, ready }) => {
    expect(ready()).toBe(false);
    expect(browserRecovery.recoverBrowserTemps).toBe(originalRecovery);
    expect(processes.execFile).toBe(originalScan);
    await recoverBrowserTemps(registry, browsers);
    expect(ready()).toBe(false);
  });
});

for (const mode of ["not observed", "failed", "bypassed"] as const) it(`restores startup recovery stand-ins when the hold is ${mode}, then permits another recovery`, async () => {
  const originalRecovery = browserRecovery.recoverBrowserTemps, originalScan = processes.execFile;
  const error = new Error("Startup recovery failed before the held point");
  let checked = false;
  const work = tempDir("petrina-browser-startup-failure-");
  registerFixtureRoot(work);
  const registry = join(work, "registry");
  const stale = mkdtempSync(join(browsers, "petrina-browser-"));
  mkdirSync(registry);
  writeFileSync(join(registry, "stale.json"), JSON.stringify(stale));
  try {
    await expectRejection(withPendingBrowserRecovery(async () => { checked = true; }, {
      atHold: () => {
        if (mode === "failed") throw error;
        // Omit the notification. The clock and observation deadline keep running
        // independently of whether startup ever reaches this callback.
      },
      observeMs: mode === "not observed" ? 200 : undefined,
      bypassHold: mode === "bypassed",
    }), mode === "failed" ? error : mode === "bypassed"
      ? "Browser startup finished without reaching its recovery hold"
      : "Timed out waiting for browser startup recovery to reach its held point");
    expect(checked).toBe(false);
    expect(browserRecovery.recoverBrowserTemps).toBe(originalRecovery);
    expect(processes.execFile).toBe(originalScan);
    // A later recovery must use the real implementation and complete its own cleanup.
    await recoverBrowserTemps(registry, browsers);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(registry)).toBe(false);
  } finally { removeDir(stale); removeDir(work); }
});

for (const replacement of [false, true]) it(`does not advertise a ready engine or discard browser ownership when startup recovery fails${replacement ? " during replacement" : ""}`, async () => {
  const work = tempDir("petrina-browser-launch-recovery-fails-");
  let lifecycle: LifecycleStore | undefined;
  const closeLifecycle = () => { const current = lifecycle; current?.close(); if (lifecycle === current) lifecycle = undefined; };
  return cases.use(work, async owners => {
  const home = join(work, "home");
  const registry = join(home, "browser-temp");
  const session = mkdtempSync(join(browsers, "petrina-browser-"));
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, "interrupted.json"), JSON.stringify(session));
  lifecycle = replacement ? new LifecycleStore(home) : undefined;
  lifecycle?.begin("restart", { requestId: "browser-recovery" }, "paused");
  lifecycle?.finish("starting");
  const engine = await owners.app(home, [BROWSER_RECOVERY_FAILURE, home, browsers, ...(replacement ? ["--replacement"] : [])]);
  const proc = engine.proc;

  const cleanup = async () => {
    const failures: unknown[] = [];
    try { if (proc.exitCode === null) await engine.kill(); else await engine.exited(10_000); }
    catch (error) { failures.push(error); }
    try { closeLifecycle(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Startup recovery fixture cleanup could not be confirmed");
    removeDir(session);
  };
  const result = await setupWithCleanup(async () => {
    const hello = engine.hello as { type: string; message?: string };
    expect(hello.type).toBe("error");
    expect(hello.message).toContain(process.platform === "win32" ? "The headless browser did not stop." : "Petrina could not confirm that a background browser from an earlier session stopped. Petrina could not read the list of running programs.");
    expect(hello.message).not.toContain(CLEANUP_NOTE);
    expect(existsSync(connectionPath(home))).toBe(false);
    expect(readdirSync(registry)).toEqual(["interrupted.json"]);
    expect(existsSync(session)).toBe(true);
    expect(await engine.exited(10_000)).toBe(1);
    if (process.platform !== "win32") {
      // The engine's own saved log keeps the attempt's private note, whole, on one line.
      const notes = readFileSync(join(home, "engine.log"), "utf8").split("\n").filter((line) => line.includes(CLEANUP_NOTE));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(notePattern("stage=startup-recovery elapsed=? helper=not-tracked early=not-taken tree=not-taken folder1=unavailable folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=0 shown=0 omitted=0"));
    }
    if (lifecycle) expect(lifecycle.receipt("browser-recovery")).toEqual(expect.objectContaining({ outcome: "failed", operation: expect.objectContaining({ phase: "failed" }) }));
    await recoverBrowserTemps(registry, browsers);
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(session)).toBe(false);

  }, cleanup);
  await cleanup();
  return result;
  }, { stopPeers: () => closeLifecycle() });
});
