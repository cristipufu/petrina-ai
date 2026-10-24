import { TEST_RUNNER } from "@petrina/test-support/run";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import type { ObservedProcess } from "@petrina/platform/process-tree";
import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, expect, it, spyOn } from "bun:test";
import * as processes from "node:child_process";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import * as os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Engine } from "./engine.js";
import * as browserRecovery from "../src/browser.js";
import { AgentBrowser, browserTempRoot, CLEANUP_NOTE, cleanupNote, recoverBrowserTemps } from "../src/browser.js";
import { connectionPath } from "../src/instance.js";
import { LifecycleStore } from "../src/lifecycle.js";
import { parseDescendants, parseProcessState, processList, readProcessList } from "@petrina/platform/process-tree";
import { defunctProcess, engineEnv, Fakes, finishedHelper, firstLine, HARNESS, makeProduct, removeDir, runChecks, runCommand, SLOW, tempDir, testBrowserRoot, waitFor } from "./support.js";

const root = tempDir("petrina-browser-");
// Sessions start in this file's own short browser folder, never the user's standard one.
const browsers = testBrowserRoot();
afterAll(() => { removeDir(root); removeDir(browsers); });
const startBrowser = (parent: string, env: NodeJS.ProcessEnv = process.env, onLog?: (text: string) => void) => AgentBrowser.start(parent, env, onLog, browsers);
/** A browser log that keeps only failed cleanups' notes, without the helper's own output. */
const notesIn = (notes: string[]) => (text: string) => { if (text.trim().startsWith(CLEANUP_NOTE)) notes.push(text.trim()); };
/** A failed attempt's whole note line, as a pattern: these fields in order, with `elapsed=?` for any elapsed time. */
const notePattern = (fields: string) => new RegExp(`^${`${CLEANUP_NOTE} ${fields}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("elapsed=\\?", "elapsed=\\d+ms")}\\n?$`);

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

/**
 * What this test itself sees of the processes it tracked, in cleanup's bounded format: the controller, the
 * browser processes it found and any process still naming the session folder. Only a failed shutdown asks.
 */
async function observeTracked(stage: string, started: number, controller: number, owned: readonly number[], directory: string): Promise<string> {
  // Both reads settle by their own deadlines, so a lost process exit cannot turn the failure into a timeout.
  const [list, commands] = await Promise.all([readProcessList(4_000), processList(["-axww", "-o", "pid=,command="], 4_000, 32 * 1024 * 1024)]);
  const named = new Set<number>();
  for (const line of commands?.split("\n") ?? []) {
    const match = /^(\d+)\s+(.*)$/.exec(line.trim());
    if (match && namesSession(match[2]!, directory)) named.add(Number(match[1]));
  }
  const state = (pid: number): ObservedProcess["state"] => {
    if (!processAlive(pid)) return "absent";
    const listed = list === undefined ? "unknown" : parseProcessState(list, pid);
    return listed === "absent" ? "unknown" : listed;
  };
  const processes = [...new Set([...owned, ...named])].map((pid) => ({ pid, state: state(pid), sources: [...(owned.includes(pid) ? ["tracked"] : []), ...(named.has(pid) ? ["folder"] : [])] }));
  return cleanupNote("Browser shutdown test observation:", [["stage", stage], ["elapsed", `${Date.now() - started}ms`], ["controller", state(controller)], ["list", list === undefined ? "unavailable" : "readable"], ["folder", commands === undefined ? "unavailable" : named.size]], processes);
}

/** Open a real headless page, then run one shutdown and require every browser process it started to be gone. */
async function expectBrowserStops(port: number, stop: (browser: AgentBrowser) => Promise<void>): Promise<void> {
  const started = Date.now();
  const browser = await startBrowser(root);
  const child = (browser as unknown as { child: ChildProcess }).child;
  const controller = requiredPid(child.pid, "The browser controller");
  let client: Client | undefined;
  let owned: number[] = [];
  let stage = "opening";
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
    stage = "stopping";
    await stop(browser);
    stage = "checking";
    expect(await sessionCommands(browser.directory)).toEqual([]);
    for (const pid of [controller, ...owned]) expect(processAlive(pid)).toBe(false);
  } catch (error) {
    // Record this test's own observations before its cleanup and retry below. The original error stays the failure.
    await observeTracked(stage, started, controller, owned, browser.directory).then((note) => console.error(note), () => undefined);
    throw error;
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

// What the three folder scans show: the process naming the folder, still present without the name, nothing,
// or an unreadable list. Completion needs the latest readable scan to show the folder clear, and every target gone.
for (const { name, shown, ends, failure, changed } of [
  { name: "stopped", shown: ["listed", "", ""], ends: "after the first wait" },
  { name: "still running", shown: ["listed", "listed", "listed"], ends: "never", failure: { wording: "Some of its programs are still running.", note: "folder1=1 folder2=1 folder3=1 confirmed=no reasons=still-running processes=1 shown=1 omitted=0 owned=1234567890:running:folder" } },
  { name: "stops during the final wait after losing its folder name", shown: ["listed", "unmarked", "unmarked"], ends: "during the final wait", changed: true },
  { name: "still running after losing its folder name", shown: ["listed", "unmarked", "unmarked"], ends: "never", failure: { wording: "Some of its programs are still running.", note: "folder1=1 folder2=0 folder3=0 confirmed=yes reasons=still-running processes=1 shown=1 omitted=0 owned=1234567890:running:folder" }, changed: true },
  { name: "stopped, confirmed by the final scan after an unreadable one", shown: ["listed", undefined, ""], ends: "after the first wait" },
  { name: "stopped, with no readable scan after it", shown: ["listed", undefined, undefined], ends: "after the first wait", failure: { wording: "Petrina could not read the list of running programs.", note: "folder1=1 folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=1 shown=1 omitted=0 owned=1234567890:absent:folder" }, changed: true },
  // An earlier clear scan no longer counts once a later one finds a process.
  { name: "appeared after a clear scan, with no readable scan after it", shown: ["", "listed", undefined], ends: "once killed", failure: { wording: "Petrina could not read the list of running programs.", note: "folder1=0 folder2=1 folder3=unavailable confirmed=no reasons=list-unreadable processes=1 shown=1 omitted=0 owned=1234567890:absent:folder" }, changed: true },
]) it.skipIf(!!changed && process.platform === "win32")(`checks final browser termination after the first cleanup wait (${name})`, async () => {
  const registry = join(root, `late-browser-stop-${name.replace(/\W+/g, "-")}`);
  const directory = mkdtempSync(join(browsers, "petrina-browser-"));
  mkdirSync(registry);
  writeFileSync(join(registry, "owned.json"), JSON.stringify(directory));
  const pid = 1_234_567_890;
  const listed = `${pid} 1 S browser ${directory}\n`;
  let scans = 0, killed = false, finalChecks = 0, released = false;
  const notes: string[] = [];
  const originalRead = processes.execFile, originalKill = process.kill;
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps") return Reflect.apply(originalRead, processes, args);
    scans += 1;
    const output = shown[scans - 1] === "listed" ? listed : shown[scans - 1] === "unmarked" ? `${pid} 1 S browser\n` : shown[scans - 1];
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    queueMicrotask(() => output === undefined ? callback(new Error("The process list is unavailable"), "", "") : callback(null, output, ""));
    return finishedHelper();
  }) as typeof processes.execFile);
  const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
    if (Math.abs(target) !== pid) return originalKill(target, signal);
    if (signal === "SIGKILL") killed = true;
    // Release only when cleanup checks the tracked target again between its second and final scans.
    // A clear folder scan alone cannot trigger this release or prove the process gone.
    if (ends === "during the final wait" && signal === 0 && scans === 2) released ||= ++finalChecks > 1;
    // The first one-second wait expires. The next OS observation confirms it is gone.
    const gone = ends === "after the first wait" ? scans >= 2 : ends === "once killed" ? killed : released;
    if (signal === 0 && gone) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    return true;
  });
  try {
    const recovery = recoverBrowserTemps(registry, browsers, (note) => notes.push(note));
    if (failure) await expectRejection(recovery, process.platform === "win32" ? "The headless browser did not stop" : `Petrina could not confirm that a background browser from an earlier session stopped. ${failure.wording}`);
    else await recovery;
    expect(scans).toBe(3);
    expect(existsSync(directory)).toBe(!!failure);
    expect(existsSync(registry)).toBe(!!failure);
    if (process.platform !== "win32") {
      expect(notes).toHaveLength(failure ? 1 : 0);
      if (failure) expect(notes[0]).toMatch(notePattern(`stage=startup-recovery elapsed=? helper=not-tracked early=not-taken tree=not-taken ${failure.note}`));
    }
  } finally { kill.mockRestore(); scan.mockRestore(); removeDir(directory); removeDir(registry); }
});

it.skipIf(process.platform !== "darwin")("keeps the standard home browser folder and recovers it canonically when the home path is a symlink", async () => {
  const home = join(root, "real-home"), link = join(root, "home-link"), registry = join(root, "linked-home-registry");
  mkdirSync(home); fixtureFiles.directoryLink(home, link); mkdirSync(registry);
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
  fixtureFiles.directoryLink(outside, join(registry, "outside-link"));
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
  fixtureFiles.directoryLink(own, alias);
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
    return finishedHelper();
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
    expect(hello.message).toContain(process.platform === "win32" ? "The headless browser did not stop." : "Petrina could not confirm that a background browser from an earlier session stopped. Petrina could not read the list of running programs.");
    expect(hello.message).not.toContain(CLEANUP_NOTE);
    expect(existsSync(connectionPath(home))).toBe(false);
    expect(readdirSync(registry)).toEqual(["interrupted.json"]);
    expect(existsSync(session)).toBe(true);
    expect(await proc.exited).toBe(1);
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
import { descendantsKnown } from ${JSON.stringify(import.meta.resolve("@petrina/platform/process-tree"))};
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
    // Without a log of its own, the failed attempt's note goes to standard error.
    const notes = stderr.split("\n").filter((line) => line.startsWith(CLEANUP_NOTE));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(notePattern("stage=exited-before-close elapsed=? helper=signal-SIGKILL,closed,used early=not-taken tree=not-taken folder1=unavailable folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=0 shown=0 omitted=0"));
  } finally {
    worker.kill();
    for (const pid of existsSync(pids) ? JSON.parse(readFileSync(pids, "utf8")) as number[] : []) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Not a process group leader. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
}, 45_000 * SLOW);

/** A program whose launcher has already exited, as a browser's are once its helper dies: the system, not this test, collects it. */
async function orphan(...args: string[]): Promise<number> {
  const launcher = Bun.spawn(["sh", "-c", '"$@" </dev/null >/dev/null 2>&1 & echo $!', "sh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [text] = await Promise.all([new Response(launcher.stdout).text(), launcher.exited]);
  return requiredPid(Number(text.trim()) || undefined, "The stand-in program");
}

function stopOrphan(pid: number | undefined): void {
  if (pid !== undefined) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
}

it.skipIf(process.platform === "win32")("keeps a killed helper's folder and registration while every folder scan is unavailable, then a later attempt stops the session's program", async () => {
  const registry = join(root, "killed-during-shutdown");
  const notes: string[] = [];
  const browser = await startBrowser(registry, process.env, notesIn(notes));
  const child = (browser as unknown as { child: ChildProcess }).child;
  const helper = requiredPid(child.pid, "The browser controller");
  let standIn: number | undefined, unrelated: number | undefined;
  const originalRead = processes.execFile;
  let unavailable = false;
  const reads: string[] = [];
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps" || !unavailable) return Reflect.apply(originalRead, processes, args);
    const folder = (args[1] as string[]).includes("-axww");
    reads.push(folder ? "folder" : "helper");
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    // The helper's early process list is readable and empty; every folder scan fails.
    queueMicrotask(() => folder ? callback(new Error("The process list is unavailable"), "", "") : callback(null, "", ""));
    return finishedHelper();
  }) as typeof processes.execFile);
  try {
    // Connecting marks the helper used without opening a page, so its shutdown needs process scans.
    await (await connectBrowser(browser)).close();
    standIn = await orphan(process.execPath, "-e", "setInterval(() => {}, 1000)", join(browser.directory, "stand-in"));
    unrelated = await orphan(process.execPath, "-e", "setInterval(() => {}, 1000)");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // Hold the helper so it cannot finish closing normally, then kill it during shutdown.
    process.kill(helper, "SIGSTOP");
    unavailable = true;
    const closing = browser.close();
    child.kill("SIGKILL");
    await exited;
    await expectRejection(closing, "The headless browser did not stop.");
    expect(reads).toEqual(["helper", "folder", "folder", "folder"]);
    expect(existsSync(browser.directory)).toBe(true);
    expect(readdirSync(registry)).toHaveLength(1);
    expect(processAlive(standIn)).toBe(true);
    // One private line for the attempt: the helper's own end apart from the unreadable scans.
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(notePattern("stage=closed-within-wait elapsed=? helper=signal-SIGKILL,closed,used early=0 tree=not-taken folder1=unavailable folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=0 shown=0 omitted=0"));

    // Readable scans let a later attempt find the session's program afresh and stop only it.
    unavailable = false;
    await browser.close();
    expect(notes).toHaveLength(1);
    expect(processAlive(standIn)).toBe(false);
    expect(existsSync(browser.directory)).toBe(false);
    expect(readdirSync(registry)).toEqual([]);
    expect(processAlive(unrelated)).toBe(true);
  } finally {
    scan.mockRestore();
    stopOrphan(standIn);
    stopOrphan(unrelated);
    await browser.close().catch(() => undefined);
  }
}, 30_000 * SLOW);

it.skipIf(process.platform === "win32")("records a helper that never answered and was force-stopped apart from the unreadable folder scans", async () => {
  const registry = join(root, "forced-without-scans");
  const notes: string[] = [];
  const browser = await startBrowser(registry, process.env, notesIn(notes));
  const helper = requiredPid((browser as unknown as { child: ChildProcess }).child.pid, "The browser controller");
  const originalRead = processes.execFile;
  let unavailable = false;
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps" || !unavailable) return Reflect.apply(originalRead, processes, args);
    const folder = (args[1] as string[]).includes("-axww");
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    // Both of the helper's own lists are readable and empty; every folder scan fails.
    queueMicrotask(() => folder ? callback(new Error("The process list is unavailable"), "", "") : callback(null, "", ""));
    return finishedHelper();
  }) as typeof processes.execFile);
  try {
    await (await connectBrowser(browser)).close();
    process.kill(helper, "SIGSTOP");
    unavailable = true;
    await expectRejection(browser.close(), "The headless browser did not stop.");
    expect(processAlive(helper)).toBe(false);
    expect(existsSync(browser.directory)).toBe(true);
    expect(readdirSync(registry)).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(notePattern("stage=forced-after-wait elapsed=? helper=signal-SIGKILL,closed,used early=0 tree=0 folder1=unavailable folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=0 shown=0 omitted=0"));
    unavailable = false;
    await browser.close();
    expect(existsSync(browser.directory)).toBe(false);
    expect(readdirSync(registry)).toEqual([]);
  } finally {
    scan.mockRestore();
    try { process.kill(helper, "SIGKILL"); } catch { /* Already gone. */ }
    await browser.close().catch(() => undefined);
  }
}, 30_000 * SLOW);

/** Answer this test's next early helper list itself; every other process list stays live. */
function answerEarlyList(answer: (callback: (error: Error | null, stdout: string, stderr: string) => void) => void) {
  const originalRead = processes.execFile;
  let answered = false;
  return spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (answered || args[0] !== "ps" || !(args[1] as string[]).includes("-A")) return Reflect.apply(originalRead, processes, args);
    answered = true;
    answer(args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void);
    return finishedHelper();
  }) as typeof processes.execFile);
}

it.skipIf(process.platform === "win32")("keeps what the helper's early list finds after the helper closed as targets of that stop", async () => {
  const notes: string[] = [];
  const browser = await startBrowser(root, process.env, notesIn(notes));
  const child = (browser as unknown as { child: ChildProcess }).child;
  const helper = requiredPid(child.pid, "The browser controller");
  let standIn: number | undefined;
  // A slow early list, as on a busy machine: it names the helper's child only after the helper has closed.
  const scan = answerEarlyList((callback) => child.once("close", () => setTimeout(() => callback(null, `${standIn} ${helper} S\n`, ""), 50)));
  try {
    await (await connectBrowser(browser)).close();
    standIn = await orphan(process.execPath, "-e", "setInterval(() => {}, 1000)");
    await browser.close();
    expect(processAlive(standIn)).toBe(false);
    expect(existsSync(browser.directory)).toBe(false);
    expect(notes).toEqual([]);
  } finally {
    scan.mockRestore();
    stopOrphan(standIn);
    await browser.close().catch(() => undefined);
  }
}, 30_000 * SLOW);

it.skipIf(process.platform === "win32")("never signals process numbers from an earlier stop when cleanup is retried", async () => {
  const registry = join(root, "retry-forgets-numbers");
  const notes: string[] = [];
  const browser = await startBrowser(registry, process.env, notesIn(notes));
  const helper = requiredPid((browser as unknown as { child: ChildProcess }).child.pid, "The browser controller");
  // A process number the first stop found. The system keeps reporting it, as it would once the number is reused.
  const remembered = 1_234_567_891;
  let attempt = 1;
  const signals: string[] = [];
  const originalKill = process.kill;
  const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
    if (Math.abs(target) !== remembered) return originalKill(target, signal);
    signals.push(`${attempt}:${signal ?? "SIGTERM"}`);
    return true;
  });
  const scan = answerEarlyList((callback) => queueMicrotask(() => callback(null, `${remembered} ${helper} S\n`, "")));
  try {
    await (await connectBrowser(browser)).close();
    await expectRejection(browser.close(), "The headless browser did not stop.");
    expect(signals).toContain("1:SIGKILL");
    expect(existsSync(browser.directory)).toBe(true);
    expect(readdirSync(registry)).toHaveLength(1);
    expect(notes).toHaveLength(1);
    // The helper finished its own close; the process it listed is present but missing from the final complete list.
    expect(notes[0]).toMatch(notePattern(`stage=closed-within-wait elapsed=? helper=exit-0,closed,used early=1 tree=not-taken folder1=0 folder2=0 folder3=0 confirmed=yes reasons=state-unknown processes=1 shown=1 omitted=0 owned=${remembered}:unknown:early`));
    attempt = 2;
    await browser.close();
    expect(signals.filter((signal) => signal.startsWith("2:"))).toEqual([]);
    expect(existsSync(browser.directory)).toBe(false);
    expect(readdirSync(registry)).toEqual([]);
    expect(notes).toHaveLength(1);
  } finally {
    scan.mockRestore();
    kill.mockRestore();
    await browser.close().catch(() => undefined);
  }
}, 30_000 * SLOW);

it.skipIf(process.platform === "win32")("describes a finished but unreleased process as finished and keeps cleanup incomplete until it is released", async () => {
  const registry = join(root, "finished-unreleased");
  const notes: string[] = [];
  const browser = await startBrowser(registry, process.env, notesIn(notes));
  const helper = requiredPid((browser as unknown as { child: ChildProcess }).child.pid, "The browser controller");
  const defunct = await defunctProcess();
  let scan: { mockRestore(): void } | undefined;
  try {
    await waitFor(async () => { const list = await readProcessList(4_000); return list !== undefined && parseProcessState(list, defunct.pid) === "finished"; }, "the stand-in to finish without being released", 10_000);
    // The helper's early list names it; the folder scans and its final state stay live.
    scan = answerEarlyList((callback) => queueMicrotask(() => callback(null, `${defunct.pid} ${helper} Z\n`, "")));
    await (await connectBrowser(browser)).close();
    // Today's rule: a process the system still holds is not confirmed stopped.
    await expectRejection(browser.close(), "The headless browser did not stop.");
    expect(existsSync(browser.directory)).toBe(true);
    expect(readdirSync(registry)).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(notePattern(`stage=closed-within-wait elapsed=? helper=exit-0,closed,used early=1 tree=not-taken folder1=0 folder2=0 folder3=0 confirmed=yes reasons=finished-unreleased processes=1 shown=1 omitted=0 owned=${defunct.pid}:finished:early`));
    await defunct.release();
    await browser.close();
    expect(existsSync(browser.directory)).toBe(false);
    expect(readdirSync(registry)).toEqual([]);
  } finally {
    scan?.mockRestore();
    await defunct.release();
    await browser.close().catch(() => undefined);
  }
}, 30_000 * SLOW);

it("keeps a cleanup note to one bounded line of fixed words, counts and process numbers", () => {
  const states = ["absent", "running", "finished", "unknown"] as const;
  const processes = Array.from({ length: 40 }, (_, index) => ({ pid: 1_000 + index, state: states[index % 4]!, sources: ["early", "folder"] }));
  const note = cleanupNote(CLEANUP_NOTE, [["stage", "closed-within-wait"], ["helper", "/Users/someone/private folder\nhttps://example.test/?token=secret"]], processes);
  expect(note).toStartWith(`${CLEANUP_NOTE} stage=closed-within-wait helper=`);
  for (const text of ["\n", "/", "?", "=secret", " folder"]) expect(note.slice(CLEANUP_NOTE.length)).not.toContain(text);
  expect(note).toContain("processes=40 shown=16 omitted=24 owned=");
  const shown = note.split(" owned=")[1]!.split(",");
  // Processes still present come first: ten running, then the first six finished.
  expect(shown.map((entry) => entry.split(":")[1])).toEqual([...Array(10).fill("running"), ...Array(6).fill("finished")]);
  expect(shown[0]).toBe("1001:running:early+folder");
  // However long its entries, the line stays within 4 KiB and counts what it leaves out.
  const long = cleanupNote(CLEANUP_NOTE, [["stage", "startup-recovery"]], processes.map((entry) => ({ ...entry, sources: ["x".repeat(400)] })));
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(4096);
  const [, total, kept, omitted] = /processes=(\d+) shown=(\d+) omitted=(\d+)/.exec(long)!.map(Number);
  expect(total).toBe(40);
  expect(kept).toBeLessThan(16);
  expect(kept! + omitted!).toBe(40);
  expect(long.split(" owned=")[1]!.split(",")).toHaveLength(kept!);
});

it.skipIf(process.platform === "win32")("a failing test run leaves the whole note line in its saved check log", async () => {
  const work = tempDir("petrina-browser-note-log-");
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  // A controlled failing test file through the engine's own parallel runner, as the Tests check runs it, in this
  // test's private folders. The process list is unreadable there. No configured check or live log is involved.
  writeFileSync(join(work, "shutdown.test.ts"), `import { it } from "bun:test";
import { rmSync } from "node:fs";
import { AgentBrowser } from ${JSON.stringify(join(import.meta.dir, "../src/browser.ts"))};
it("stops a browser whose helper was killed", async () => {
  const browser = await AgentBrowser.start(undefined, process.env, undefined, ${JSON.stringify(browsers)});
  const child = (browser as any).child;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGKILL");
  await closed;
  try { await browser.close(); } finally { rmSync(browser.directory, { recursive: true, force: true }); }
});
`);
  try {
    const checks = join(work, "data", "checks", "task-1");
    const [run] = await runChecks(work, [{ name: "Tests", argv: [process.execPath, TEST_RUNNER, "./shutdown.test.ts"] }], { ...process.env, PATH: bin }, 60_000 * SLOW, undefined, checks);
    expect(run!.ok).toBe(false);
    expect(dirname(run!.logPath!)).toBe(checks);
    const log = readFileSync(run!.logPath!, "utf8");
    expect(log).toContain("PARALLEL");
    expect(log).toContain("(fail) stops a browser whose helper was killed");
    // The error stays plain; the note is its own whole line, printed once.
    expect(log).toContain("error: The headless browser did not stop.\n");
    const notes = log.split("\n").filter((line) => line.includes(CLEANUP_NOTE));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(notePattern("stage=exited-before-close elapsed=? helper=signal-SIGKILL,closed,unused early=not-taken tree=not-taken folder1=unavailable folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=0 shown=0 omitted=0"));
  } finally { removeDir(work); }
}, 60_000 * SLOW);

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
    fixtureFiles.directoryLink(product, browser.directory);
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

    const failed = await runCommand([process.execPath, recoveryScript, registry, browsers], { cwd: import.meta.dir, env: { ...process.env, PATH: bin } });
    expect(failed.code, failed.stderr).toBe(0);
    expect(JSON.parse(failed.stdout)).toMatchObject({ failed: true, message: process.platform === "win32" ? "The headless browser did not stop." : "Petrina could not confirm that a background browser from an earlier session stopped. Petrina could not read the list of running programs." });
    if (process.platform !== "win32") expect(failed.stderr.split("\n").filter((line) => line.startsWith(CLEANUP_NOTE))).toHaveLength(1);
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
    fixtureFiles.directoryLink(outside, join(first.directory, "linked"));
    for (const filename of [join(outside, "bad.png"), "linked/bad.png"]) expect((await clients[0]!.callTool({ name: "browser_take_screenshot", arguments: { filename } })).isError).toBe(true);
    const unsafe = await clients[0]!.callTool({ name: "browser_run_code_unsafe", arguments: { code: `async (page) => page.screenshot({ path: ${JSON.stringify(join(outside, "bad.png"))} })` } });
    expect(unsafe.isError).toBe(true);
    expect(JSON.stringify(unsafe)).toContain("Use the supplied browser's page tools");
    expect(readdirSync(outside)).toEqual([]);
    const original = readFileSync(join(first.directory, "named.png"));
    const productImage = join(outside, "existing.png");
    writeFileSync(productImage, original);
    linkSync(productImage, join(first.directory, "shared.png"));
    fixtureFiles.fileLink("shared.png", join(first.directory, "shortcut.png"));
    fixtureFiles.fileLink("shortcut.png", join(first.directory, "shortcut-chain.png"));
    fixtureFiles.fileLink(join(outside, "missing.png"), join(first.directory, "dangling.png"));
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
    fixtureFiles.fileLink(victim, join(first.directory, "shortcut-download.png"));
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
