import { expectRejection } from "./rejections.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import * as processes from "node:child_process";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import * as os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Engine } from "./engine.js";
import * as browserRecovery from "../src/browser.js";
import { AgentBrowser, browserTempRoot, recoverBrowserTemps } from "../src/browser.js";
import { connectionPath } from "../src/instance.js";
import { LifecycleStore } from "../src/lifecycle.js";
import { parseDescendants, readProcessList } from "../src/process-tree.js";
import { engineEnv, Fakes, firstLine, HARNESS, makeProduct, removeDir, SLOW, tempDir, testBrowserRoot, waitFor } from "./support.js";

const root = tempDir("petrina-browser-");
// Sessions start in this file's own short browser folder, never the user's standard one.
const browsers = testBrowserRoot();
afterAll(() => { removeDir(root); removeDir(browsers); });
const startBrowser = (parent: string, env: NodeJS.ProcessEnv = process.env, onLog?: (text: string) => void) => AgentBrowser.start(parent, env, onLog, browsers);

export async function connectBrowser(browser: AgentBrowser) {
  if (!("url" in browser.mcp) || !("headers" in browser.mcp)) throw new Error("Expected an HTTP browser");
  const client = new Client({ name: "browser check", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(browser.mcp.url), { requestInit: { headers: Object.fromEntries(browser.mcp.headers.map((header) => [header.name, header.value])) } }));
  return client;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function commandLines(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axww", "-o", "pid=,command="], { timeout: 4_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

function namesSession(command: string, directory: string): boolean {
  return command.includes(`${directory}/`) || command.includes(`${directory} `) || command.endsWith(directory);
}

async function sessionCommands(directory: string): Promise<string[]> {
  return (await commandLines()).split("\n").filter((line) => namesSession(line, directory));
}

/** Browser processes this controller still owns: its descendants, and any command that names its folder. */
async function ownedBrowsers(controller: number, directory: string): Promise<number[]> {
  const list = await readProcessList(4_000);
  if (list === undefined) throw new Error("Could not list processes");
  const marked: number[] = [];
  for (const line of (await commandLines()).split("\n")) {
    const match = /^(\d+)\s+(.*)$/.exec(line.trim());
    if (match && Number(match[1]) !== controller && namesSession(match[2]!, directory)) marked.push(Number(match[1]));
  }
  return [...new Set([...parseDescendants(list, [controller]), ...marked])];
}

/** Stop if a spawned process has not reported an id, instead of using a missing one. */
function requiredPid(pid: number | undefined, who: string): number {
  if (pid === undefined) throw new Error(`${who} has no process id`);
  return pid;
}

/** Open a real headless page, then run one shutdown and require every browser process it started to be gone. */
async function expectBrowserStops(port: number, stop: (browser: AgentBrowser) => Promise<void>): Promise<void> {
  const browser = await startBrowser(root);
  const child = (browser as unknown as { child: ChildProcess }).child;
  const controller = requiredPid(child.pid, "The browser controller");
  let client: Client | undefined;
  let owned: number[] = [];
  try {
    client = await connectBrowser(browser);
    const opened = await client.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${port}` } });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    await waitFor(async () => (await sessionCommands(browser.directory)).some((line) => line.includes("--headless")), "the headless browser to open the page", 45_000);
    owned = await ownedBrowsers(controller, browser.directory);
    expect(owned.length).toBeGreaterThan(0);
    await client.close();
    client = undefined;
    // Closing the tool connection must not be what stops the browser. Shutdown has to.
    expect(owned.some(processAlive)).toBe(true);
    await stop(browser);
    expect(await sessionCommands(browser.directory)).toEqual([]);
    for (const pid of [controller, ...owned]) expect(processAlive(pid)).toBe(false);
  } finally {
    await client?.close().catch(() => undefined);
    if (processAlive(controller)) {
      try { process.kill(controller, "SIGCONT"); } catch { /* Not stopped. */ }
      try { process.kill(controller, "SIGKILL"); } catch { /* Already gone. */ }
    }
    for (const pid of owned) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Not a process group leader. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    await browser.close().catch(() => undefined);
  }
}

it("the browser server exposes page tools, confines output and stops cleanly even without opening a page", async () => {
  const browser = await startBrowser(root);
  let client: Client | undefined;
  try {
    client = await connectBrowser(browser);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_take_screenshot");
    expect(names).not.toContain("browser_run_code");
    expect(names).not.toContain("browser_run_code_unsafe");
    for (const name of ["browser_click", "browser_type", "browser_console_messages", "browser_evaluate"]) expect(names).toContain(name);
    for (const name of ["browser_run_code", "browser_run_code_unsafe", "browser_future_code_runner"]) {
      const result = await client.callTool({ name, arguments: { code: `async (page) => page.screenshot({ path: ${JSON.stringify(join(root, "escape.png"))} })` } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Use the supplied browser's page tools");
    }
    expect(existsSync(join(root, "escape.png"))).toBe(false);
    await client.close();
    client = await connectBrowser(browser);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("browser_take_screenshot");
    expect((await client.callTool({ name: "browser_take_screenshot", arguments: { filename: "../escape.png" } })).isError).toBe(true);
    expect(existsSync(join(root, "escape.png"))).toBe(false);
  } finally { await client?.close(); await browser.close(); }
  expect(existsSync(browser.directory)).toBe(false);
  await expectRejection(fetch("url" in browser.mcp ? browser.mcp.url : ""));
});

it("restart reaps registered interrupted browser output and ignores outside paths", async () => {
  const registry = join(root, "registry");
  mkdirSync(registry);
  const interrupted = mkdtempSync(join(browsers, "petrina-browser-"));
  writeFileSync(join(interrupted, "leftover.png"), "leftover");
  const product = join(root, "product-kept"); mkdirSync(product);
  writeFileSync(join(product, "keep.txt"), "product work");
  writeFileSync(join(registry, "interrupted.json"), JSON.stringify(interrupted));
  writeFileSync(join(registry, "outside.json"), JSON.stringify(product));
  await recoverBrowserTemps(registry, browsers);
  expect(existsSync(interrupted)).toBe(false);
  expect(existsSync(registry)).toBe(false);
  expect(existsSync(join(product, "keep.txt"))).toBe(true);
});

it("starts cleanly when no interrupted browser registry exists", async () => {
  const missing = join(root, "empty-browser-registry");
  await recoverBrowserTemps(missing, browsers);
  expect(existsSync(missing)).toBe(false);
});

for (const stillRunning of [false, true]) it(`checks final browser termination after the first cleanup wait (${stillRunning ? "still running" : "stopped"})`, async () => {
  const registry = join(root, `late-browser-stop-${stillRunning}`);
  const directory = mkdtempSync(join(browsers, "petrina-browser-"));
  mkdirSync(registry);
  writeFileSync(join(registry, "owned.json"), JSON.stringify(directory));
  const pid = 1_234_567_890;
  let scans = 0;
  const originalRead = processes.execFile, originalKill = process.kill;
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps") return Reflect.apply(originalRead, processes, args);
    scans += 1;
    const output = scans === 1 ? `${pid} browser ${directory}\n` : "";
    const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
    queueMicrotask(() => callback(null, output, ""));
    return new processes.ChildProcess();
  }) as typeof processes.execFile);
  const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
    if (Math.abs(target) !== pid) return originalKill(target, signal);
    // The first one-second wait expires. The next OS observation confirms it is gone.
    if (signal === 0 && scans >= 2 && !stillRunning) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    return true;
  });
  try {
    if (stillRunning) await expectRejection(recoverBrowserTemps(registry, browsers), "The headless browser did not stop");
    else await recoverBrowserTemps(registry, browsers);
    expect(scans).toBe(3);
    expect(existsSync(directory)).toBe(stillRunning);
    expect(existsSync(registry)).toBe(stillRunning);
  } finally { kill.mockRestore(); scan.mockRestore(); removeDir(directory); removeDir(registry); }
});

it.skipIf(process.platform !== "darwin")("keeps the standard home browser folder and recovers it canonically when the home path is a symlink", async () => {
  const home = join(root, "real-home"), link = join(root, "home-link"), registry = join(root, "linked-home-registry");
  mkdirSync(home); symlinkSync(home, link); mkdirSync(registry);
  const mockedHome = spyOn(os, "homedir").mockReturnValue(link);
  try {
    // Without a fixture's folder, sessions use the standard short folder in the home.
    expect(browserTempRoot()).toBe(join(link, ".petrina", "b"));
    const browser = await AgentBrowser.start(registry, process.env);
    expect(dirname(browser.directory)).toBe(realpathSync(join(home, ".petrina", "b")));
    const child = (browser as unknown as { child: ChildProcess }).child;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL"); await exited;
    expect(existsSync(browser.directory)).toBe(true);
    await recoverBrowserTemps(registry);
    expect(existsSync(browser.directory)).toBe(false);
    expect(existsSync(registry)).toBe(false);
  } finally { mockedHome.mockRestore(); }
});

it("discards a legacy directory and invalid browser registrations without following outside folders", async () => {
  const registry = join(root, "legacy-registry");
  const legacy = join(registry, "interrupted");
  const outside = join(root, "legacy-outside-kept");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(legacy, "old.png"), "old browser output");
  writeFileSync(join(outside, "keep.txt"), "product work");
  symlinkSync(outside, join(registry, "outside-link"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(registry, "partial.json"), "{unfinished");
  writeFileSync(join(registry, "outside.json"), JSON.stringify(outside));
  await recoverBrowserTemps(registry, browsers);
  expect(existsSync(registry)).toBe(false);
  expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("product work");
});

it("keeps a folder registered under another name for the browser root, removing only its marker", async () => {
  // Sessions register their canonical folder. Another spelling of the same root (a link here, a
  // Windows short name such as RUNNER~1) names a folder outside it, so recovery reaps nothing there.
  const own = testBrowserRoot(), alias = join(root, "browser-root-alias"), registry = join(root, "alias-registry");
  const session = join(own, "petrina-browser-aliased");
  mkdirSync(session); mkdirSync(registry);
  symlinkSync(own, alias, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(registry, "aliased.json"), JSON.stringify(join(alias, "petrina-browser-aliased")));
  try {
    await recoverBrowserTemps(registry, own);
    expect(existsSync(session)).toBe(true);
    expect(existsSync(registry)).toBe(false);
  } finally { removeDir(alias); removeDir(own); }
});

const RECOVERY_HOLD_WAIT_MS = 5_000;

/** Own the stand-ins and teardown even when the held point is never observed. */
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
  const recovery = spyOn(browserRecovery, "recoverBrowserTemps").mockImplementation(async (...args) => {
    if (args[0] !== registry || args[1] !== browsers) return recover(...args);
    // Only this engine's startup call owns the hold. Later calls must remain usable
    // even if Bun stops the test during setup and never runs its finally block.
    recovery.mockRestore();
    heldArgs = args;
    try { await recover(...args); }
    finally { scan.mockRestore(); }
    if (options.atHold) options.atHold(() => { recovered = true; });
    else recovered = true;
    await releaseRecovery.promise;
  });
  const originalExecFile = processes.execFile;
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps") return Reflect.apply(originalExecFile, processes, args);
    const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
    queueMicrotask(() => callback(null, "", ""));
    return new processes.ChildProcess();
  }) as typeof processes.execFile);
  let engine: Engine | undefined;
  let startup: Promise<void> | undefined;
  let ready = false, settled = false;
  let failure: { error: unknown } | undefined;
  try {
    // A control models an engine that no longer calls the held export at startup.
    if (options.bypassHold) recovery.mockRestore();
    engine = new Engine(data, { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], browser: true, browserTempRoot: browsers });
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
        recovery.mockRestore();
        scan.mockRestore();
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
    const productId = await engine.addProduct(makeProduct(work));
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
  const fake = join(work, "fake");
  const bin = join(work, "bin");
  const registry = join(home, "browser-temp");
  const session = mkdtempSync(join(browsers, "petrina-browser-"));
  mkdirSync(registry, { recursive: true });
  mkdirSync(bin);
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(registry, "interrupted.json"), JSON.stringify(session));
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const lifecycle = replacement ? new LifecycleStore(home) : undefined;
  lifecycle?.begin("restart", { requestId: "browser-recovery" }, "paused");
  lifecycle?.finish("starting");
  const proc = Bun.spawn([process.execPath, HARNESS, home, fake, `--browser-root=${browsers}`], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...engineEnv(home), PATH: `${bin}:${process.env.PATH ?? ""}`, ...(replacement ? { PETRINA_LIFECYCLE_REPLACEMENT: "1" } : {}) } });
  try {
    const hello = JSON.parse(await firstLine(proc.stdout)) as { type: string; message?: string };
    expect(hello.type).toBe("error");
    expect(hello.message).toContain("The headless browser did not stop.");
    expect(existsSync(connectionPath(home))).toBe(false);
    expect(readdirSync(registry)).toEqual(["interrupted.json"]);
    expect(existsSync(session)).toBe(true);
    expect(await proc.exited).toBe(1);
    if (lifecycle) expect(lifecycle.receipt("browser-recovery")).toEqual(expect.objectContaining({ outcome: "failed", operation: expect.objectContaining({ phase: "failed" }) }));
    await recoverBrowserTemps(registry, browsers);
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(session)).toBe(false);
  } finally {
    proc.kill("SIGKILL");
    lifecycle?.close();
    removeDir(session);
    removeDir(work);
  }
});

it("cleans output after the browser server is killed unexpectedly", async () => {
  const browser = await startBrowser(root);
  const child = (browser as unknown as { child: ChildProcess }).child;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  if (process.platform === "win32") {
    await expectRejection(browser.close(), "The headless browser did not stop.");
    expect(existsSync(browser.directory)).toBe(true);
    removeDir(browser.directory);
    return;
  }
  await browser.close();
  expect(existsSync(browser.directory)).toBe(false);
});

it.skipIf(process.platform === "win32")("stops the browser after a page is open, and when its controller never answers", async () => {
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>Shutdown check</title><p>Open</p>", { headers: { "content-type": "text/html" } }) });
  // A process outside this session. Cleanup must not take it with the browser.
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const port = page.port;
    if (port === undefined) throw new Error("The local page has no port");
    const sentinelPid = requiredPid(sentinel.pid, "The unrelated process");
    await expectBrowserStops(port, async (browser) => { await browser.close(); });
    await expectBrowserStops(port, async (browser) => {
      const child = (browser as unknown as { child: ChildProcess }).child;
      process.kill(requiredPid(child.pid, "The browser controller"), "SIGSTOP");
      await browser.close();
    });
    expect(processAlive(sentinelPid)).toBe(true);
  } finally {
    try { sentinel.kill("SIGKILL"); } catch { /* Already gone. */ }
    page.stop(true);
  }
}, 90_000 * SLOW);

it.skipIf(process.platform === "win32")("stops an opened browser when its controller exits before or during close", async () => {
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>Controller exit</title><p>Open</p>", { headers: { "content-type": "text/html" } }) });
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const port = page.port;
    if (port === undefined) throw new Error("The local page has no port");
    for (const duringClose of [false, true]) {
      await expectBrowserStops(port, async (browser) => {
        const child = (browser as unknown as { child: ChildProcess }).child;
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        // Hold graceful shutdown so the second case cannot accidentally pass by
        // closing Chromium before we simulate a controller failure.
        process.kill(requiredPid(child.pid, "The browser controller"), "SIGSTOP");
        const closing = duringClose ? browser.close() : undefined;
        child.kill("SIGKILL");
        await exited;
        await (closing ?? browser.close());
      });
      expect(processAlive(requiredPid(sentinel.pid, "The unrelated process"))).toBe(true);
    }
  } finally {
    try { sentinel.kill("SIGKILL"); } catch { /* Already gone. */ }
    page.stop(true);
  }
}, 90_000 * SLOW);

it.skipIf(process.platform === "win32")("keeps browser ownership when a dead controller cannot be inspected, then retries cleanup", async () => {
  // Isolate the unavailable ps in one owner process, without changing this test
  // worker's process lookup or another session's cleanup.
  const directory = mkdtempSync(join(root, "unavailable-scan-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "ps"), 0o755);
  const pids = join(directory, "owned.json");
  const script = join(directory, "owner.ts");
  writeFileSync(script, `import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { AgentBrowser } from ${JSON.stringify(join(import.meta.dir, "../src/browser.ts"))};
import { descendantsKnown } from ${JSON.stringify(join(import.meta.dir, "../src/process-tree.ts"))};
import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))};
const registry = ${JSON.stringify(join(directory, "registry"))};
const browser = await AgentBrowser.start(registry, process.env, undefined, ${JSON.stringify(browsers)});
const child = (browser as any).child;
const client = new Client({ name: "cleanup check", version: "1" });
const savedPath = process.env.PATH;
let result;
try {
  const endpoint = browser.mcp as any;
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: Object.fromEntries(endpoint.headers.map((header: any) => [header.name, header.value])) } }));
  const opened = await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } });
  if (opened.isError) throw new Error(JSON.stringify(opened));
  const owned = await descendantsKnown([child.pid]);
  if (!owned?.length) throw new Error("The opened browser has no recorded children");
  writeFileSync(${JSON.stringify(pids)}, JSON.stringify(owned));
  await client.close();
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  process.env.PATH = ${JSON.stringify(bin)};
  let error;
  try { await browser.close(); } catch (failure) { error = (failure as Error).message; }
  result = { error, keptDirectory: existsSync(browser.directory), registrations: readdirSync(registry).length };
} finally {
  process.env.PATH = savedPath;
  await client.close().catch(() => undefined);
  await browser.close();
}
console.log(JSON.stringify({ ...result, removedAfterRetry: !existsSync(browser.directory), registrationsAfterRetry: readdirSync(registry).length }));
`);
  const worker = Bun.spawn([process.execPath, script], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  try {
    const [code, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ error: "The headless browser did not stop.", keptDirectory: true, registrations: 1, removedAfterRetry: true, registrationsAfterRetry: 0 });
    expect((JSON.parse(readFileSync(pids, "utf8")) as number[]).filter(processAlive)).toEqual([]);
  } finally {
    worker.kill();
    for (const pid of existsSync(pids) ? JSON.parse(readFileSync(pids, "utf8")) as number[] : []) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Not a process group leader. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
}, 45_000 * SLOW);

it("stops unused endpoints and endpoints receiving their first connection", async () => {
  for (const connect of [false, true]) {
    const browser = await startBrowser(root);
    const connecting = connect ? connectBrowser(browser).then((client) => client.close(), () => undefined) : undefined;
    try {
      await browser.close();
      await connecting;
      expect(existsSync(browser.directory)).toBe(false);
      await expectRejection(fetch("url" in browser.mcp ? browser.mcp.url : ""));
    } finally { await browser.close(); }
  }
});

it("waits for a cleanly exited unused helper's final stdout acknowledgement before cleanup", async () => {
  const browser = await startBrowser(root);
  const child = browser["child"];
  const stdout = child.stdout!, readers = stdout.listeners("data"), chunks: Buffer[] = [];
  for (const reader of readers) stdout.removeListener("data", reader);
  let released = false;
  const deliver = (chunk: Buffer) => { for (const reader of readers) reader.call(stdout, chunk); };
  const hold = (chunk: Buffer) => { if (released) deliver(chunk); else chunks.push(chunk); };
  stdout.on("data", hold);
  try {
    const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.stdin!.end(); await exit;
    expect(child.exitCode).toBe(0);
    expect(browser["lifecycle"].closedUnused).toBe(false);
    const scan = spyOn(processes, "execFile");
    try {
      const closing = browser.close();
      released = true; for (const chunk of chunks.splice(0)) deliver(chunk);
      await closing;
      expect(browser["lifecycle"].closedUnused).toBe(true);
      expect(existsSync(browser.directory)).toBe(false);
      expect(scan.mock.calls.filter(args => args[0] === "ps" || args[0] === "taskkill")).toHaveLength(0);
    } finally { scan.mockRestore(); }
  } finally {
    released = true; for (const chunk of chunks.splice(0)) deliver(chunk);
    stdout.removeListener("data", hold); for (const reader of readers) stdout.on("data", reader);
    await browser.close();
  }
});

it("closes an acknowledged unused helper without scanning processes", async () => {
  const browser = await startBrowser(root);
  const scan = spyOn(processes, "execFile");
  try {
    expect(browser.directory.startsWith(browsers + sep)).toBe(true);
    if (process.platform === "darwin") expect(Buffer.byteLength(join(browser.directory, "SingletonSocket"))).toBeLessThan(104);
    await browser.close();
    expect(scan.mock.calls.filter(([program]) => program === "ps")).toHaveLength(0);
    expect(existsSync(browser.directory)).toBe(false);
  } finally { scan.mockRestore(); await browser.close(); }
});

it("ignores inherited debug and remote-browser settings before launch, without opening a browser", async () => {
  // Intercept the actual Playwright launcher inside the helper. Even a regression that
  // asks for a visible browser cannot start one in this test.
  const hook = `data:text/javascript;base64,${Buffer.from(`const cp = require("node:child_process");
const fs = require("node:fs");
// The launch probe needs no downloaded browser or host libraries. Only the
// bundled-browser availability checks are stand-ins; launch arguments stay real.
const access = fs.accessSync;
fs.accessSync = (path, ...args) => String(path).includes("ms-playwright") ? undefined : access(path, ...args);
const stat = fs.promises.stat;
fs.promises.stat = (path, ...args) => String(path).includes("ms-playwright") && String(path).endsWith("DEPENDENCIES_VALIDATED") ? Promise.resolve({ mtime: new Date() }) : stat(path, ...args);
cp.spawn = (program, args) => {
  console.error("INSPECTED_BROWSER_LAUNCH " + JSON.stringify({ program, args }));
  throw new Error("Browser launch inspected without starting it");
};
require("node:module").syncBuiltinESMExports();
console.error("BROWSER_LAUNCH_GUARD_READY");`).toString("base64")}`;
  let remoteRequests = 0;
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    remoteRequests += 1;
    return Response.json({ value: { error: "session not created", message: "No remote browser exists here" } }, { status: 500 });
  } });
  try {
    for (const controls of [
      { PWDEBUG: "1", npm_config_pwdebug: "1", npm_package_config_pwdebug: "1" },
      { SELENIUM_REMOTE_URL: `http://127.0.0.1:${remote.port}`, SELENIUM_REMOTE_CAPABILITIES: '{"browserName":"chrome"}', PLAYWRIGHT_MCP_CDP_ENDPOINT: `http://127.0.0.1:${remote.port}` },
    ]) {
      let output = "";
      const inherited: NodeJS.ProcessEnv = { ...process.env, ...controls, BUN_OPTIONS: `--preload=${hook}` };
      const browser = await startBrowser(root, inherited, (text) => { output += text; });
      let client: Client | undefined;
      let navigating: Promise<unknown> | undefined;
      try {
        await waitFor(() => output.includes("BROWSER_LAUNCH_GUARD_READY"), "the browser launch guard to be ready", 5000);
        client = await connectBrowser(browser);
        navigating = client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } }).catch(() => undefined);
        await waitFor(() => /INSPECTED_BROWSER_LAUNCH (\{.*\})/.test(output) || remoteRequests > 0, "the intercepted browser launch", 5000);
        expect(remoteRequests).toBe(0);
        const launch = /INSPECTED_BROWSER_LAUNCH (\{.*\})/.exec(output)?.[1];
        expect(launch).toBeDefined();
        const { program, args } = JSON.parse(launch!) as { program: string; args: string[] };
        expect(args).toContain("--headless");
        expect(program).toMatch(/(?:chromium|chrome-headless-shell)/i);
        expect(args.find((arg) => arg.startsWith("--user-data-dir="))).toStartWith(`--user-data-dir=${browser.directory}${sep}`);
        for (const [key, value] of Object.entries(controls)) expect(inherited[key]).toBe(value);
      } finally { await client?.close(); await browser.close(); await navigating; }
      expect(existsSync(browser.directory)).toBe(false);
    }
  } finally { remote.stop(true); }
});

for (const opened of [false, true]) it.skipIf(opened && !process.env.PETRINA_BROWSER_CHECK)(`refuses named and automatic captures in a redirected capture folder ${opened ? "after opening a headless page" : "before opening a page"}`, async () => {
  const product = join(root, `redirected-product-${opened}`);
  mkdirSync(product);
  writeFileSync(join(product, "keep.txt"), "Product files stay unchanged");
  const browser = await startBrowser(root);
  const parked = `${browser.directory}-original`;
  let client: Client | undefined;
  try {
    client = await connectBrowser(browser);
    if (opened) {
      expect((await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } })).isError).not.toBe(true);
      const { default: sharp } = await import("sharp");
      for (const type of [undefined, "png", "jpeg", "webp"] as const) {
        const before = new Set(readdirSync(browser.directory));
        expect((await client.callTool({ name: "browser_take_screenshot", arguments: type ? { type } : {} })).isError).not.toBe(true);
        const files = readdirSync(browser.directory).filter((file) => !before.has(file));
        expect(files).toHaveLength(1);
        expect((await sharp(readFileSync(join(browser.directory, files[0]!))).metadata()).format).toBe(type ?? "png");
      }
    }
    renameSync(browser.directory, parked);
    symlinkSync(product, browser.directory, "dir");
    for (const args of [{ filename: "named.png" }, {}, { type: "png" }, { type: "jpeg" }, { type: "webp" }]) {
      const result = await client.callTool({ name: "browser_take_screenshot", arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("capture folder");
      expect(readdirSync(product)).toEqual(["keep.txt"]);
    }
    for (const name of ["browser_snapshot", "browser_console_messages"]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("capture folder");
    }
  } finally {
    await client?.close();
    await browser.close();
    removeDir(parked);
  }
  expect(existsSync(browser.directory)).toBe(false);
  expect(existsSync(parked)).toBe(false);
  expect(readdirSync(product)).toEqual(["keep.txt"]);
  expect(readFileSync(join(product, "keep.txt"), "utf8")).toBe("Product files stay unchanged");
}, 60_000 * SLOW);

it.skipIf(!process.env.PETRINA_BROWSER_CHECK)("startup recovery retains a browser registration when process scanning fails, then reaps only that browser", async () => {
  const work = tempDir("petrina-browser-recovery-retry-");
  const registry = join(work, "registry");
  const bin = join(work, "bin");
  const recoveryScript = join(import.meta.dir, ".browser-recovery-retry.ts");
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>Recovery retry</title><p>Open</p>", { headers: { "content-type": "text/html" } }) });
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const sentinelPid = requiredPid(sentinel.pid, "The unrelated process");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(recoveryScript, `import { existsSync, readdirSync } from "node:fs";
import { recoverBrowserTemps } from "../src/browser.js";
const [registry, browsers] = process.argv.slice(2) as [string, string];
try {
  await recoverBrowserTemps(registry, browsers);
  console.log(JSON.stringify({ failed: false }));
} catch (error) {
  console.log(JSON.stringify({ failed: true, message: (error as Error).message, folder: readdirSync(registry).length, marker: existsSync(registry) }));
}
`);
  const browser = await startBrowser(registry);
  const child = (browser as unknown as { child: ChildProcess }).child;
  const controller = requiredPid(child.pid, "The browser controller");
  let client: Client | undefined;
  let owned: number[] = [];
  try {
    client = await connectBrowser(browser);
    const opened = await client.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${page.port}` } });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    await waitFor(async () => (await sessionCommands(browser.directory)).some((line) => line.includes("--headless")), "the headless browser to open the recovery page", 45_000);
    owned = await ownedBrowsers(controller, browser.directory);
    expect(owned.length).toBeGreaterThan(0);
    await client.close();
    client = undefined;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;

    const failed = Bun.spawnSync([process.execPath, recoveryScript, registry, browsers], { cwd: import.meta.dir, env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe" });
    expect(failed.exitCode, failed.stderr.toString()).toBe(0);
    expect(JSON.parse(failed.stdout.toString())).toMatchObject({ failed: true, message: "The headless browser did not stop." });
    expect(readdirSync(registry)).toHaveLength(1);
    expect(existsSync(browser.directory)).toBe(true);
    expect(owned.some(processAlive)).toBe(true);

    await recoverBrowserTemps(registry, browsers);
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(browser.directory)).toBe(false);
    for (const pid of owned) expect(processAlive(pid)).toBe(false);
    expect(processAlive(sentinelPid)).toBe(true);
  } finally {
    await client?.close().catch(() => undefined);
    try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
    for (const pid of owned) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Not a process group leader. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    try { sentinel.kill("SIGKILL"); } catch { /* Already gone. */ }
    page.stop(true);
    rmSync(recoveryScript, { force: true });
    removeDir(work);
  }
}, 90_000 * SLOW);

it.skipIf(!process.env.PETRINA_BROWSER_CHECK)("real bundled Chromium: named and unnamed captures, output links, isolated storage and cleanup", async () => {
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/download/")) {
      const name = decodeURIComponent(url.pathname.slice("/download/".length));
      return new Response(Buffer.from(`download:${name}`), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` } });
    }
    return new Response('<label>Name<input aria-label="Name"></label><button onclick="document.body.dataset.checked=1;console.log(\'clicked\')">Check</button><a id="ordinary" href="/download/ordinary.bin" download="ordinary.bin">Ordinary</a><a id="linked" href="/download/shortcut-download.png" download="shortcut-download.png">Linked</a><a id="shared" href="/download/hardlink-download.png" download="hardlink-download.png">Shared</a>', { headers: { "content-type": "text/html" } });
  } });
  const first = await startBrowser(root);
  const second = await startBrowser(root);
  const clients: Client[] = [];
  try {
    // Two simultaneous first connections must initialize the first agent's browser once.
    clients.push(...await Promise.all([connectBrowser(first), connectBrowser(first), connectBrowser(second)]));
    for (const client of [clients[0]!, clients[2]!]) expect((await client.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${page.port}` } })).isError).not.toBe(true);
    await clients[0]!.callTool({ name: "browser_evaluate", arguments: { function: '() => { localStorage.setItem("private", "first"); document.cookie="private=first"; }' } });
    const shared = JSON.stringify(await clients[1]!.callTool({ name: "browser_evaluate", arguments: { function: '() => localStorage.getItem("private")' } }));
    expect(shared).toContain("first");
    const empty = JSON.stringify(await clients[2]!.callTool({ name: "browser_evaluate", arguments: { function: '() => ({cookie:document.cookie,value:localStorage.getItem("private")})' } }));
    expect(empty).not.toContain("private=first");
    expect(empty).toContain("null");
    for (const args of [{ filename: "named.png" }, {}]) {
      expect((await clients[0]!.callTool({ name: "browser_take_screenshot", arguments: args })).isError).not.toBe(true);
    }
    expect(readdirSync(first.directory).filter((name) => name.endsWith(".png")).length).toBe(2);
    const outside = join(root, "product"); mkdirSync(outside);
    symlinkSync(outside, join(first.directory, "linked"));
    for (const filename of [join(outside, "bad.png"), "linked/bad.png"]) expect((await clients[0]!.callTool({ name: "browser_take_screenshot", arguments: { filename } })).isError).toBe(true);
    const unsafe = await clients[0]!.callTool({ name: "browser_run_code_unsafe", arguments: { code: `async (page) => page.screenshot({ path: ${JSON.stringify(join(outside, "bad.png"))} })` } });
    expect(unsafe.isError).toBe(true);
    expect(JSON.stringify(unsafe)).toContain("Use the supplied browser's page tools");
    expect(readdirSync(outside)).toEqual([]);
    const original = readFileSync(join(first.directory, "named.png"));
    const productImage = join(outside, "existing.png");
    writeFileSync(productImage, original);
    linkSync(productImage, join(first.directory, "shared.png"));
    symlinkSync("shared.png", join(first.directory, "shortcut.png"));
    symlinkSync("shortcut.png", join(first.directory, "shortcut-chain.png"));
    symlinkSync(join(outside, "missing.png"), join(first.directory, "dangling.png"));
    for (const filename of ["shared.png", "shortcut.png", "shortcut-chain.png", "dangling.png"]) {
      expect((await clients[0]!.callTool({ name: "browser_take_screenshot", arguments: { filename } })).isError).toBe(true);
      expect(readFileSync(productImage)).toEqual(original);
      expect(existsSync(join(outside, "missing.png"))).toBe(false);
    }
    // A page download uses the browser's own filename. An ordinary one stays in
    // the capture folder. The same shortcut a named screenshot refuses must not
    // be followed when the page saves a file.
    expect((await clients[0]!.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${page.port}` } })).isError).not.toBe(true);
    expect((await clients[0]!.callTool({ name: "browser_click", arguments: { target: "#ordinary" } })).isError).not.toBe(true);
    await waitFor(() => {
      const saved = join(first.directory, "ordinary.bin");
      return existsSync(saved) && readFileSync(saved).equals(Buffer.from("download:ordinary.bin"));
    }, "the ordinary download to stay in the capture folder");
    const victim = join(outside, "victim.png");
    writeFileSync(victim, original);
    symlinkSync(victim, join(first.directory, "shortcut-download.png"));
    linkSync(victim, join(first.directory, "hardlink-download.png"));
    for (const target of ["#linked", "#shared"]) {
      expect((await clients[0]!.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${page.port}` } })).isError).not.toBe(true);
      await clients[0]!.callTool({ name: "browser_click", arguments: { target } });
      const started = Date.now();
      do {
        expect(readFileSync(victim)).toEqual(original);
        await Bun.sleep(50);
      } while (Date.now() - started < 1000);
    }
    expect(lstatSync(join(first.directory, "shortcut-download.png")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(first.directory, "hardlink-download.png")).nlink).toBeGreaterThan(1);
    expect(readFileSync(victim)).toEqual(original);
    expect(readFileSync(productImage)).toEqual(original);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all([first.close(), second.close()]);
    page.stop(true);
  }
  expect(existsSync(first.directory)).toBe(false);
  expect(existsSync(second.directory)).toBe(false);
}, 60_000 * SLOW);
