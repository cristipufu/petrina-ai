import { afterAll, expect, it } from "bun:test";
import * as processes from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../../engine.js";
import * as browserRecovery from "@petrina/agent-runtime/browser";
import { CLEANUP_NOTE, recoverBrowserTemps } from "@petrina/agent-runtime/browser";
import { browserProcesses } from "@petrina/platform/browser-processes";
import { connectionPath } from "../../../src/instance.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { EngineProcess, Fakes, FAKE_AGENT, makeProduct, removeDir, tempDir, testBrowserRoot, waitFor } from "../../support.js";
import { expectRejection } from "@petrina/test-support/rejections";
const root = tempDir("petrina-browser-startup-");
const browsers = testBrowserRoot();
afterAll(() => { removeDir(root); removeDir(browsers); });
const notePattern = (fields: string) => new RegExp(`^${`${CLEANUP_NOTE} ${fields}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("elapsed=\\?", "elapsed=\\d+ms")}\n?$`);

const BROWSER_RECOVERY_FAILURE = fileURLToPath(new URL("../../fixtures/browser-startup-failure.ts", import.meta.url));

const RECOVERY_HOLD_WAIT_MS = 5_000;

async function withPendingBrowserRecovery(
  check: (fixture: { engine: Engine; fakes: Fakes; work: string; registry: string; stale: string; startup: Promise<void>; ready: () => boolean; release: () => void }) => Promise<void>,
  options: { atHold?: (markReached: () => void) => void; observeMs?: number; bypassHold?: boolean } = {},
) {
  const work = tempDir("petrina-browser-startup-pending-");
  const data = join(work, "data");
  const registry = join(data, "browser-temp");
  const stale = mkdtempSync(join(browsers, "petrina-browser-"));
  const fakes = new Fakes(join(work, "fake"));
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, "stale.json"), JSON.stringify(stale));
  // Hold the promise the kernel awaits, rather than a process scan whose own
  // deadline can finish recovery while product setup is still running.
  let recovered = false;
  const releaseRecovery = Promise.withResolvers<void>();
  const recover = browserRecovery.recoverBrowserTemps;
  let heldArgs: Parameters<typeof recover> | undefined;
  const scopedRecovery = async (...args: Parameters<typeof recover>) => {
    if (args[0] !== registry || args[1] !== browsers) throw new Error("Unexpected browser recovery owner");
    heldArgs = args;
    await recover(args[0], args[1], undefined, { ...browserProcesses, readFolder: async () => ({ pids: [], states: new Map() }) });
    if (options.atHold) options.atHold(() => { recovered = true; });
    else recovered = true;
    await releaseRecovery.promise;
  };
  let engine: Engine | undefined;
  let startup: Promise<void> | undefined;
  let ready = false, settled = false;
  let failure: { error: unknown } | undefined;
  try {
    // A control models an engine that no longer calls the held export at startup.
    engine = new Engine(data, { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir], browser: true, browserTempRoot: browsers, ...(options.bypassHold ? {} : { browserRecovery: scopedRecovery }) });
    startup = engine.waitUntilReady();
    void startup.then(() => { ready = true; settled = true; }, error => { failure = { error }; settled = true; });
    // Bound observation only. The hold itself never expires during slow setup.
    await waitFor(() => {
      if (failure) throw failure.error;
      if (recovered) return true;
      if (ready) throw new Error("Browser startup finished without reaching its recovery hold");
      return false;
    }, "browser startup recovery to reach its held point", options.observeMs ?? RECOVERY_HOLD_WAIT_MS);
    expect(heldArgs).toEqual([registry, browsers]);
    await check({ engine, fakes, work, registry, stale, startup, ready: () => ready, release: releaseRecovery.resolve });
  } finally {
    try { await engine?.shutdown(); }
    finally {
      releaseRecovery.resolve();
      try {
        if (startup) await waitFor(() => settled, "browser startup recovery to settle after releasing its test hold", RECOVERY_HOLD_WAIT_MS);
      } finally {
        removeDir(stale);
        removeDir(work);
      }
    }
  }
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
    await engine.shutdown();
    expect(ready()).toBe(false);
    release();
    await startup;
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
  const home = join(work, "home");
  const registry = join(home, "browser-temp");
  const session = mkdtempSync(join(browsers, "petrina-browser-"));
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, "interrupted.json"), JSON.stringify(session));
  const lifecycle = replacement ? new LifecycleStore(home) : undefined;
  lifecycle?.begin("restart", { requestId: "browser-recovery" }, "paused");
  lifecycle?.finish("starting");
  const engine = await EngineProcess.start(home, [BROWSER_RECOVERY_FAILURE, home, browsers, ...(replacement ? ["--replacement"] : [])]);
  const proc = engine.proc;
  try {
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
  } finally {
    if (proc.exitCode === null) await engine.kill();
    lifecycle?.close();
    removeDir(session);
    removeDir(work);
  }
});
