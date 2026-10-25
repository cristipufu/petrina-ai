import { expectRejection } from "@petrina/test-support/rejections";
import { expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as files from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { AgentBrowser, browserTempRoot, CLEANUP_NOTE } from "@petrina/agent-runtime/browser";
import { browserProcesses } from "@petrina/platform/browser-processes";
import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";
import { refuseFolder } from "@petrina/test-support/refuse-folder";
import { Engine } from "../../engine.js";
import { finish, makeWorld, removeDir, SLOW, taskOf, tempDir, testBrowserRoot, waitFor } from "../../support.js";

async function crash(browser: AgentBrowser): Promise<void> {
  const child = (browser as unknown as { child: ChildProcess }).child;
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  child.kill("SIGKILL");
  await closed;
}

it("finishes a scripted workflow unrelated to browsing while the standard browser folder refuses writes", async () => {
  const refusal = refuseFolder(browserTempRoot());
  const started = spyOn(AgentBrowser, "start");
  try {
  const world = await makeWorld("browser-free-workflow");
  const engine = world.start();
  try {
    // The refusal reaches browser startup: the standard folder cannot hold a session here.
    const control = await AgentBrowser.start(undefined, process.env).then(async (browser) => { await browser.close(); return "started"; }, (error: Error) => error.message);
    expect(control).toContain("EPERM");
    expect(refusal.attempts.length).toBeGreaterThan(0);
    refusal.attempts.length = 0;
    started.mockClear();
    const productId = await engine.addProduct(world.clone);
    const id = engine.addTask({ productId, title: "Greet the guest", description: "[no-check]" });
    const task = taskOf(await finish(engine, id), id);
    expect(task.error).toBeUndefined();
    expect(task.state).toBe("pr-open");
    // Roles that may check pages ran, without a browser helper.
    const roles = new Set(task.steps?.map((step) => step.roleId));
    expect(roles.has("builder")).toBe(true);
    expect(roles.has("code-reviewer")).toBe(true);
    expect(started).not.toHaveBeenCalled();
    expect(refusal.attempts).toEqual([]);
    expect(existsSync(join(world.data, "browser-temp"))).toBe(false);
  } finally {
    await engine.shutdown();
    removeDir(world.dir);
  }
  } finally { started.mockRestore(); refusal.restore(); }
}, 120_000 * SLOW);

it.skipIf(process.platform === "win32")("saves a failed browser cleanup's private note in the task's own log and only the shared warning on the task", async () => {
  const world = await makeWorld("browser-cleanup-note", { browser: true });
  // The first agent's helper dies before its conversation opens, and this engine cannot read the folder scans.
  const opened: AgentBrowser[] = [];
  let unavailable = true;
  const start = AgentBrowser.start;
  const started = spyOn(AgentBrowser, "start").mockImplementation(async (...args) => {
    const browser = await start.call(AgentBrowser, args[0], args[1], args[2], args[3], { ...browserProcesses, readFolder: directory => unavailable ? Promise.resolve(undefined) : browserProcesses.readFolder(directory) });
    if (!opened.length) await crash(browser);
    opened.push(browser);
    return browser;
  });
  const engine = world.start();
  try {
    const productId = await engine.addProduct(world.clone);
    const id = engine.addTask({ productId, title: "Greet the guest", description: "[no-check]" });
    const log = join(world.data, "logs", `${id}.log`);
    const notes = await waitFor(() => {
      const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.includes(CLEANUP_NOTE)) : [];
      return lines.length ? lines : undefined;
    }, "the failed cleanup's note in the task's saved log", 60_000);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(new RegExp(`^${CLEANUP_NOTE} stage=exited-before-close elapsed=\\d+ms helper=signal-SIGKILL,closed,unused early=not-taken tree=not-taken folder1=unavailable folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=0 shown=0 omitted=0$`));
    await waitFor(() => engine.task(id)?.timeline.some((entry) => entry.text === CLEANUP_INCOMPLETE), "the shared cleanup warning on the task");
    expect(engine.task(id)!.timeline.some((entry) => entry.text.includes(CLEANUP_NOTE))).toBe(false);
    expect(existsSync(opened[0]!.directory)).toBe(true);
  } finally {
    unavailable = false;
    await engine.shutdown();
    started.mockRestore();
    for (const browser of opened) await browser.close().catch(() => undefined);
    removeDir(world.dir);
    removeDir(world.browsers!);
  }
}, 90_000 * SLOW);

it("keeps parallel fixtures' browser folders apart and recovers only an engine's own leftovers at startup", async () => {
  const first = testBrowserRoot(), second = testBrowserRoot();
  const work = tempDir("petrina-browser-recovery-root-");
  const data = join(work, "data"), registry = join(data, "browser-temp");
  const outside = join(work, "product");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "product work");
  const browsers: AgentBrowser[] = [];
  let engine: Engine | undefined;
  try {
    expect(first).not.toBe(second);
    // Fixture folders are spelled as browser startup and recovery canonicalize them, even where the
    // temporary folder has another name for itself (a Windows short name such as RUNNER~1).
    expect(await Promise.all([first, second].map((root) => files.realpath(root)))).toEqual([first, second]);
    // Two fixtures start at once, each in its own folder. Both registered with this engine, then it stopped abruptly.
    browsers.push(...await Promise.all([first, second].map((root) => AgentBrowser.start(registry, process.env, undefined, root))));
    expect(browsers.map((browser) => dirname(browser.directory))).toEqual([first, second]);
    for (const browser of browsers) await crash(browser);
    writeFileSync(join(registry, "outside.json"), JSON.stringify(outside));
    expect(readdirSync(registry)).toHaveLength(3);
    // Startup recovery uses the engine's configured folder: it reaps that leftover only.
    engine = new Engine(data, { agentCommand: () => ["fake-agent"], browser: true, browserTempRoot: first });
    await engine.waitUntilReady();
    expect(existsSync(browsers[0]!.directory)).toBe(false);
    expect(existsSync(browsers[1]!.directory)).toBe(true);
    expect(existsSync(registry)).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("product work");
    await engine.shutdown();
    // An engine with the standard folder never reaps another fixture's folder either.
    mkdirSync(registry);
    writeFileSync(join(registry, "other.json"), JSON.stringify(browsers[1]!.directory));
    engine = new Engine(data, { agentCommand: () => ["fake-agent"] });
    await engine.waitUntilReady();
    expect(existsSync(browsers[1]!.directory)).toBe(true);
    expect(existsSync(registry)).toBe(false);
    // Windows cannot verify browser children after a forced helper exit, so it
    // reports incomplete cleanup and leaves the folder for the fixture's final cleanup.
    for (const browser of browsers) {
      if (process.platform === "win32") await expectRejection(browser.close(), "The headless browser did not stop.");
      else await browser.close();
    }
    expect(readdirSync(first)).toEqual([]);
    if (process.platform === "win32") expect(existsSync(browsers[1]!.directory)).toBe(true);
    else expect(readdirSync(second)).toEqual([]);
  } finally {
    await engine?.shutdown();
    for (const browser of browsers) await browser.close().catch(() => undefined);
    removeDir(work);
    removeDir(first);
    removeDir(second);
  }
}, 60_000 * SLOW);
