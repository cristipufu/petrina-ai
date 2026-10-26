import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { expectRejection } from "@petrina/test-support/rejections";
import { afterEach, afterAll, expect, it, spyOn } from "bun:test";
import { type ChildProcess } from "node:child_process";
import { existsSync, linkSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AgentBrowser, browserTempRoot, CLEANUP_NOTE, recoverBrowserTemps } from "../../../src/browser.js";
import { readProcessList, parseProcessState } from "@petrina/platform/process-tree";
import { browserProcesses } from "@petrina/platform/browser-processes";
import { defunctProcesses } from "@petrina/test-support/defunct-process";

const defuncts = defunctProcesses();
afterEach(() => defuncts.close());
afterAll(() => defuncts.close());
import { runCommand } from "@petrina/test-support/commands";
import { SLOW } from "@petrina/test-support/slow";
import { tempDir, removeDir, testBrowserRoot, waitFor } from "@petrina/test-support/fixtures";
import { root, browsers, startBrowser, pauseBrowser, forceBrowser, notesIn, notePattern, connectBrowser, processAlive, requiredPid, sessionCommands, ownedBrowsers, expectBrowserStops, answerEarlyList, watchBrowserProcessReads, overrideBrowserProcesses, orphan, stopOrphan } from "../../fixtures/browser-processes.js";

const BROWSER_SCAN_WORKER = fileURLToPath(new URL("../../fixtures/browser-scan-worker.ts", import.meta.url));

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
    forceBrowser(browser); await exited;
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

it("cleans output after the browser server is killed unexpectedly", async () => {
  const browser = await startBrowser(root);
  const child = (browser as unknown as { child: ChildProcess }).child;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  forceBrowser(browser);
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
  const sentinel = await orphan(process.execPath, "-e", "setInterval(() => {}, 1000)");
  try {
    const port = page.port;
    if (port === undefined) throw new Error("The local page has no port");
    const sentinelPid = sentinel;
    await expectBrowserStops(port, async (browser) => { await browser.close(); });
    await expectBrowserStops(port, async (browser) => {
      pauseBrowser(browser);
      await browser.close();
    });
    expect(processAlive(sentinelPid)).toBe(true);
  } finally {
    await stopOrphan(sentinel);
    page.stop(true);
  }
}, 90_000 * SLOW);

it.skipIf(process.platform === "win32")("stops an opened browser when its controller exits before or during close", async () => {
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>Controller exit</title><p>Open</p>", { headers: { "content-type": "text/html" } }) });
  const sentinel = await orphan(process.execPath, "-e", "setInterval(() => {}, 1000)");
  try {
    const port = page.port;
    if (port === undefined) throw new Error("The local page has no port");
    for (const duringClose of [false, true]) {
      await expectBrowserStops(port, async (browser) => {
        const child = (browser as unknown as { child: ChildProcess }).child;
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        // Hold graceful shutdown so the second case cannot accidentally pass by
        // closing Chromium before we simulate a controller failure.
        pauseBrowser(browser);
        const closing = duringClose ? browser.close() : undefined;
        forceBrowser(browser);
        await exited;
        await (closing ?? browser.close());
      });
      expect(processAlive(sentinel)).toBe(true);
    }
  } finally {
    await stopOrphan(sentinel);
    page.stop(true);
  }
}, 90_000 * SLOW);

it.skipIf(process.platform === "win32")("keeps browser ownership when a dead controller cannot be inspected, then retries cleanup", async () => {
  // Isolate an unavailable typed observation in its native owner process; no other
  // session's process lookup or cleanup changes.
  const directory = mkdtempSync(join(root, "unavailable-scan-"));
  const registry = join(directory, "registry"), pids = join(directory, "owned.json");
  const worker = runCommand([process.execPath, BROWSER_SCAN_WORKER, registry, browsers, pids], { cwd: import.meta.dir, timeoutMs: 45_000 * SLOW });
  try {
    const { code, stdout, stderr } = await worker;
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ error: "The headless browser did not stop.", keptDirectory: true, registrations: 1, removedAfterRetry: true, registrationsAfterRetry: 0 });
    expect((JSON.parse(readFileSync(pids, "utf8")) as number[]).filter(processAlive)).toEqual([]);
    // Without a log of its own, the failed attempt's note goes to standard error.
    const notes = stderr.split("\n").filter((line) => line.startsWith(CLEANUP_NOTE));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(notePattern("stage=exited-before-close elapsed=? helper=signal-SIGKILL,closed,used early=not-taken tree=not-taken folder1=unavailable folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=0 shown=0 omitted=0"));
  } finally {
    await worker.catch(() => undefined);
    await recoverBrowserTemps(registry, browsers);
  }
}, 45_000 * SLOW);

it.skipIf(process.platform === "win32")("keeps a killed helper's folder and registration while every folder scan is unavailable, then a later attempt stops the session's program", async () => {
  const registry = join(root, "killed-during-shutdown");
  const notes: string[] = [];
  const browser = await startBrowser(registry, process.env, notesIn(notes));
  const child = (browser as unknown as { child: ChildProcess }).child;
  let standIn: number | undefined, unrelated: number | undefined;
  let unavailable = false;
  const reads: string[] = [];
  const scan = overrideBrowserProcesses(browser, {
    readFolder: async directory => { if (!unavailable) return browserProcesses.readFolder(directory); reads.push("folder"); return undefined; },
    descendants: async roots => { if (!unavailable) return browserProcesses.descendants(roots); reads.push("helper"); return []; },
  });
  try {
    // Connecting marks the helper used without opening a page, so its shutdown needs process scans.
    await (await connectBrowser(browser)).close();
    standIn = await orphan(process.execPath, "-e", "setInterval(() => {}, 1000)", join(browser.directory, "stand-in"));
    unrelated = await orphan(process.execPath, "-e", "setInterval(() => {}, 1000)");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // Hold the helper so it cannot finish closing normally, then kill it during shutdown.
    pauseBrowser(browser);
    unavailable = true;
    const closing = browser.close();
    forceBrowser(browser);
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
    scan.restore();
    await stopOrphan(standIn);
    await stopOrphan(unrelated);
    await browser.close().catch(() => undefined);
  }
}, 30_000 * SLOW);

it.skipIf(process.platform === "win32")("records a helper that never answered and was force-stopped apart from the unreadable folder scans", async () => {
  const registry = join(root, "forced-without-scans");
  const notes: string[] = [];
  const browser = await startBrowser(registry, process.env, notesIn(notes));
  const helper = requiredPid((browser as unknown as { child: ChildProcess }).child.pid, "The browser controller");
  let unavailable = false;
  const scan = overrideBrowserProcesses(browser, {
    readFolder: async directory => unavailable ? undefined : browserProcesses.readFolder(directory),
    descendants: async roots => unavailable ? [] : browserProcesses.descendants(roots),
    descendantsKnown: async (roots, budget) => unavailable ? [] : browserProcesses.descendantsKnown(roots, budget),
  });
  try {
    await (await connectBrowser(browser)).close();
    pauseBrowser(browser);
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
    scan.restore();
    forceBrowser(browser);
    await browser.close().catch(() => undefined);
  }
}, 30_000 * SLOW);

it.skipIf(process.platform === "win32")("keeps what the helper's early list finds after the helper closed as targets of that stop", async () => {
  const notes: string[] = [];
  const browser = await startBrowser(root, process.env, notesIn(notes));
  const child = (browser as unknown as { child: ChildProcess }).child;
  let standIn: number | undefined;
  // A slow early list, as on a busy machine: it names the helper's child only after the helper has closed.
  const scan = answerEarlyList(browser, (done) => child.once("close", () => setTimeout(() => done([standIn!]), 50)));
  try {
    await (await connectBrowser(browser)).close();
    standIn = await orphan(process.execPath, "-e", "setInterval(() => {}, 1000)");
    await browser.close();
    expect(processAlive(standIn)).toBe(false);
    expect(existsSync(browser.directory)).toBe(false);
    expect(notes).toEqual([]);
  } finally {
    scan.restore();
    await stopOrphan(standIn);
    await browser.close().catch(() => undefined);
  }
}, 30_000 * SLOW);

it.skipIf(process.platform === "win32")("never signals process numbers from an earlier stop when cleanup is retried", async () => {
  const registry = join(root, "retry-forgets-numbers");
  const notes: string[] = [];
  const browser = await startBrowser(registry, process.env, notesIn(notes));
  // A process number the first stop found. The system keeps reporting it, as it would once the number is reused.
  const remembered = 1_234_567_891;
  let attempt = 1;
  const signals: string[] = [];
  const kill = overrideBrowserProcesses(browser, {
    exists: target => target === remembered ? (signals.push(`${attempt}:0`), true) : browserProcesses.exists(target),
    forceKill: pids => {
      for (const pid of pids) {
        if (pid === remembered) signals.push(`${attempt}:SIGKILL`);
        else browserProcesses.forceKill([pid]);
      }
    },
  });
  const scan = answerEarlyList(browser, (done) => queueMicrotask(() => done([remembered])));
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
    scan.restore();
    kill.restore();
    await browser.close().catch(() => undefined);
  }
}, 30_000 * SLOW);

it.skipIf(process.platform === "win32")("describes a finished but unreleased process as finished and keeps cleanup incomplete until it is released", async () => defuncts.use(async defunct => {
  const registry = join(root, "finished-unreleased");
  const notes: string[] = [];
  let browser: AgentBrowser | undefined, scan: { restore(): void } | undefined;
  const cleanup = async () => {
    const errors: unknown[] = [];
    try { scan?.restore(); } catch (error) { errors.push(error); }
    try { await defunct.release(); } catch (error) { errors.push(error); }
    try { await browser?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Finished-browser observation cleanup failed");
  };
  await setupWithCleanup(async () => {
    browser = await startBrowser(registry, process.env, notesIn(notes));
    await waitFor(async () => { const list = await readProcessList(4_000); return list !== undefined && parseProcessState(list, defunct.pid) === "finished"; }, "the stand-in to finish without being released", 10_000);
    // The helper's early list names it; the folder scans and its final state stay live.
    scan = answerEarlyList(browser, (done) => queueMicrotask(() => done([defunct.pid])));
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
  }, cleanup);
  await cleanup();
}), 30_000 * SLOW);

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
    const scan = watchBrowserProcessReads(browser);
    try {
      const closing = browser.close();
      released = true; for (const chunk of chunks.splice(0)) deliver(chunk);
      await closing;
      expect(browser["lifecycle"].closedUnused).toBe(true);
      expect(existsSync(browser.directory)).toBe(false);
      expect(scan.calls).toHaveLength(0);
    } finally { scan.restore(); }
  } finally {
    released = true; for (const chunk of chunks.splice(0)) deliver(chunk);
    stdout.removeListener("data", hold); for (const reader of readers) stdout.on("data", reader);
    await browser.close();
  }
});

it("closes an acknowledged unused helper without scanning processes", async () => {
  const browser = await startBrowser(root);
  const scan = watchBrowserProcessReads(browser);
  try {
    expect(browser.directory.startsWith(browsers + sep)).toBe(true);
    if (process.platform === "darwin") expect(Buffer.byteLength(join(browser.directory, "SingletonSocket"))).toBeLessThan(104);
    await browser.close();
    expect(scan.calls).toHaveLength(0);
    expect(existsSync(browser.directory)).toBe(false);
  } finally { scan.restore(); await browser.close(); }
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
  const recoveryScript = fileURLToPath(new URL("../../fixtures/browser-recovery-failure.ts", import.meta.url));
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>Recovery retry</title><p>Open</p>", { headers: { "content-type": "text/html" } }) });
  const sentinel = await orphan(process.execPath, "-e", "setInterval(() => {}, 1000)");
  const sentinelPid = sentinel;
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
    forceBrowser(browser);
    await exited;

    const failed = await runCommand([process.execPath, recoveryScript, registry, browsers], { cwd: import.meta.dir });
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
    const current = await browserProcesses.readFolder(browser.directory);
    if (current) browserProcesses.forceKill(current.pids);
    await recoverBrowserTemps(registry, browsers).catch(() => undefined);
    await stopOrphan(sentinel);
    page.stop(true);
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
