import { afterAll, expect } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectBrowser } from "./browser-client.js";
export { connectBrowser } from "./browser-client.js";

import { AgentBrowser, CLEANUP_NOTE, cleanupNote } from "../../src/browser.js";
import type { ObservedProcess } from "@petrina/platform/process-tree";
import { browserProcesses, type BrowserProcessControl } from "@petrina/platform/browser-processes";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { runCommand } from "@petrina/test-support/commands";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir, removeDir, testBrowserRoot, waitFor } from "@petrina/test-support/fixtures";

export const root = tempDir("petrina-browser-");

export const browsers = testBrowserRoot();

afterAll(() => { removeDir(root); removeDir(browsers); });

const controls = new WeakMap<AgentBrowser, BrowserProcessControl>();
export async function startBrowser(parent: string, env: NodeJS.ProcessEnv = process.env, onLog?: (text: string) => void, supplied: Partial<BrowserProcessControl> = {}): Promise<AgentBrowser> {
  const effects = { ...browserProcesses, ...supplied };
  const browser = await AgentBrowser.start(parent, env, onLog, browsers, effects);
  controls.set(browser, effects);
  return browser;
}

/** Per-owner observations; unrelated browsers and the test worker keep their native boundary. */
export function overrideBrowserProcesses(browser: AgentBrowser, supplied: Partial<BrowserProcessControl>): { restore(): void } {
  const target = controls.get(browser);
  if (!target) throw new Error("This browser has no owned fixture controls");
  const original = { ...target };
  Object.assign(target, supplied);
  return { restore() { Object.assign(target, original); } };
}

export const notesIn = (notes: string[]) => (text: string) => { if (text.trim().startsWith(CLEANUP_NOTE)) notes.push(text.trim()); };

export const notePattern = (fields: string) => new RegExp(`^${`${CLEANUP_NOTE} ${fields}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("elapsed=\\?", "elapsed=\\d+ms")}\\n?$`);

export function processAlive(pid: number): boolean { return browserProcesses.exists(pid); }

export async function sessionCommands(directory: string): Promise<string[]> {
  const snapshot = await browserProcesses.readFolder(directory);
  if (!snapshot?.commands) throw new Error("Could not read the owned browser process list");
  return [...snapshot.commands];
}

/** Browser children captured while the exact controller still owns their relationship. */
export async function ownedBrowsers(controller: number, directory: string): Promise<number[]> {
  const [tree, marked] = await Promise.all([browserProcesses.descendants([controller]), browserProcesses.readFolder(directory)]);
  if (tree === undefined || marked === undefined) throw new Error("Could not list browser processes");
  return [...new Set([...tree, ...marked.pids.filter(pid => pid !== controller)])];
}

export function requiredPid(pid: number | undefined, who: string): number {
  if (pid === undefined) throw new Error(`${who} has no process id`);
  return pid;
}

async function observeTracked(stage: string, started: number, controller: number, owned: readonly number[], directory: string): Promise<string> {
  const snapshot = await browserProcesses.readFolder(directory);
  const named = new Set(snapshot?.pids ?? []);
  const state = (pid: number): ObservedProcess["state"] => {
    if (!processAlive(pid)) return "absent";
    const listed = snapshot?.states.get(pid) ?? "unknown";
    return listed === "absent" ? "unknown" : listed;
  };
  const processes = [...new Set([...owned, ...named])].map(pid => ({ pid, state: state(pid), sources: [...(owned.includes(pid) ? ["tracked"] : []), ...(named.has(pid) ? ["folder"] : [])] }));
  return cleanupNote("Browser shutdown test observation:", [["stage", stage], ["elapsed", `${Date.now() - started}ms`], ["controller", state(controller)], ["list", snapshot === undefined ? "unavailable" : "readable"], ["folder", snapshot === undefined ? "unavailable" : named.size]], processes);
}

export async function expectBrowserStops(port: number, stop: (browser: AgentBrowser) => Promise<void>): Promise<void> {
  const started = Date.now();
  const browser = await startBrowser(root);
  const child = (browser as unknown as { child: ChildProcess }).child;
  const controller = requiredPid(child.pid, "The browser controller");
  let client: Client | undefined;
  let owned: number[] = [];
  let stage = "opening";
  let stopped = false;
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
    stopped = true;
  } catch (error) {
    // Record this test's own observations before its cleanup and retry below. The original error stays the failure.
    await observeTracked(stage, started, controller, owned, browser.directory).then((note) => console.error(note), () => undefined);
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
    if (!stopped) {
      // A failed setup, stop or assertion retains independent cleanup. Use the current helper
      // handle and fresh folder ownership, never an earlier process number as signal authority.
      resumeBrowser(browser);
      forceBrowser(browser);
      const current = await browserProcesses.readFolder(browser.directory);
      if (current) browserProcesses.forceKill(current.pids);
    }

    await browser.close().catch(() => undefined);
  }
}

const orphanLeases = new Map<number, { lease: ProcessLease; root: string }>();
/** A reparented actor whose lifetime remains bound to this case's private loopback lease. */
export async function orphan(...args: string[]): Promise<number> {
  if (args[0] !== process.execPath || args[1] !== "-e") throw new Error("The owned browser actor requires the portable runtime");
  const ownedRoot = tempDir("petrina-browser-orphan-"), ready = join(ownedRoot, "ready"), lease = await createProcessLease();
  const actor = join(ownedRoot, "actor.ts");
  writeFileSync(actor, lease.program(`const { writeFileSync, renameSync } = require("node:fs"); writeFileSync(${JSON.stringify(ready)} + ".tmp", String(process.pid)); renameSync(${JSON.stringify(ready)} + ".tmp", ${JSON.stringify(ready)}); ${args[2]}; await new Promise(() => undefined);`));
  const argv = [process.execPath, actor, ...args.slice(3)];
  try {
    const launched = await runCommand([process.execPath, "-e", `const child = Bun.spawn(${JSON.stringify(argv)}, { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); console.log(child.pid); process.exit(0);`]);
    const pid = requiredPid(Number(launched.stdout.trim()) || undefined, "The stand-in program");
    await waitFor(() => existsSync(ready) && Number(readFileSync(ready, "utf8")) === pid, "the reparented leased browser actor to be ready");
    orphanLeases.set(pid, { lease, root: ownedRoot });
    return pid;
  } catch (error) { await lease.close(); removeDir(ownedRoot); throw error; }
}

export async function stopOrphan(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const owner = orphanLeases.get(pid);
  if (!owner) throw new Error("No independent fixture lease owns that process");
  orphanLeases.delete(pid);
  await owner.lease.close();
  await waitFor(() => !processAlive(pid), "the fixture lease to stop its own actor");
  removeDir(owner.root);
}

export function answerEarlyList(browser: AgentBrowser, answer: (done: (pids: number[] | undefined) => void) => void) {
  let answered = false;
  return overrideBrowserProcesses(browser, { descendants(roots) {
    if (answered) return browserProcesses.descendants(roots);
    answered = true;
    return new Promise(resolve => answer(resolve));
  } });
}

/** Observe this browser's typed process boundary without replacing another owner's OS APIs. */
export function watchBrowserProcessReads(browser: AgentBrowser) {
  const calls: string[] = [];
  const scan = overrideBrowserProcesses(browser, {
    readFolder(directory) { calls.push("folder"); return browserProcesses.readFolder(directory); },
    descendants(roots) { calls.push("descendants"); return browserProcesses.descendants(roots); },
    descendantsKnown(roots, budget) { calls.push("descendants-known"); return browserProcesses.descendantsKnown(roots, budget); },
    ...(browserProcesses.stopTree ? { stopTree(pid: number, ms: number) { calls.push("stop-tree"); return browserProcesses.stopTree!(pid, ms); } } : {}),
  });
  return { calls, restore: () => scan.restore() };
}

/** POSIX suspension is confined to a current child handle; callers never signal a saved process number. */
export function pauseBrowser(browser: AgentBrowser): void {
  if (!browserProcesses.groups) throw new Error("The native browser suspension control requires POSIX process groups");
  const child = browser["child"];
  if (child.exitCode !== null || child.signalCode !== null) throw new Error("The owned browser helper already ended");
  child.kill("SIGSTOP");
}

export function forceBrowser(browser: AgentBrowser): void {
  const child = browser["child"];
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
}

export function resumeBrowser(browser: AgentBrowser): void {
  if (!browserProcesses.groups) return;
  const child = browser["child"];
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGCONT"); } catch { /* Already ended. */ }
}
