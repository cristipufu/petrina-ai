import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { removeFixtureRoot } from "@petrina/test-support/fixture-roots";
import { browserProcesses } from "@petrina/platform/browser-processes";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as files from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { AgentBrowser, browserTempRoot, CLEANUP_NOTE } from "@petrina/agent-runtime/browser";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { WaitClock } from "@petrina/storage/worklog";
import { turnCleanupFixtures } from "../../fixtures/turn-cleanup.js";
import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";
import { refuseFolder } from "@petrina/test-support/refuse-folder";
import { finish, SLOW, taskOf, testBrowserRoot } from "../../support.js";

import { completeAll } from "@petrina/core";
import { nativeWorldFixtures } from "../../fixtures/native-worlds.js";
import { installPreparedProduct, acmeDemoProduct } from "../../fixtures/prepared-product.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());
const worlds = nativeWorldFixtures();
afterAll(worlds.close);
const cleanupFixtures = turnCleanupFixtures();
afterEach(() => cleanupFixtures.close());

async function crash(browser: AgentBrowser): Promise<void> {
  const child = (browser as unknown as { child: ChildProcess }).child;
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  child.kill("SIGKILL");
  await closed;
}

it("finishes a scripted workflow unrelated to browsing while the standard browser folder refuses writes", async () => {
  let currentRefusal: ReturnType<typeof refuseFolder> | undefined;
  let currentStarted: ReturnType<typeof spyOn<typeof AgentBrowser, "start">> | undefined;
  const cleanup = async () => {
    await completeAll([(async () => { currentStarted?.mockRestore(); })(), (async () => { currentRefusal?.restore(); })()]);
  };
  await setupWithCleanup(async () => {
  const refusal = currentRefusal = refuseFolder(browserTempRoot());
  const started = currentStarted = spyOn(AgentBrowser, "start");
  await worlds.world("browser-free-workflow", async fixture => {
  const world = fixture.world;
  return fixture.engine(async engine => {
  try {
    installSharedWorkflowFastPaths(engine, {
      skipUpToDate: true,
      skipPrepareChecks: true,
      skipReviewCopies: true,
      skipReviewInputDiffs: true,
      fastCheckCapture: true,
    });
    // The refusal reaches browser startup: the standard folder cannot hold a session here.
    const control = await AgentBrowser.start(undefined, process.env).then(async (browser) => { await browser.close(); return "started"; }, (error: Error) => error.message);
    expect(control).toContain("EPERM");
    expect(refusal.attempts.length).toBeGreaterThan(0);
    refusal.attempts.length = 0;
    started.mockClear();
    await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
    const productId = installPreparedProduct(engine, acmeDemoProduct(world.clone));
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
  }
  }, {
    runCheckCommand: async req => req.argv[0] === "git" && req.argv[1] === "--version" ? { code: 0, stdout: "git version 2.45.0\n" } : undefined,
  });
  }, {}, { stopPeers: cleanup });
  }, cleanup);
  await cleanup();
}, 120_000 * SLOW);

it("saves a failed browser cleanup's private note in the task's own log and only the shared warning on the task", async () => {
  // This host boundary receives a Runtime diagnostic. Actual native formatting, callback
  // delivery and retained browser ownership are paired in Runtime browser/cleanup-note.
  const f = await cleanupFixtures.fixture({ nativeOpening: true });
  try {
    const role = f.engine.role("tester", f.task)!, profile = f.engine.profile("opus-high")!;
    const note = `${CLEANUP_NOTE} stage=exited-before-close elapsed=1ms helper=signal-SIGKILL,closed,unused early=not-taken tree=not-taken folder1=unavailable folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=0 shown=0 omitted=0`;
    const failure = new Error("The controlled browser opening failed"), written: Promise<void>[] = [];
    const save = f.engine.agentLog.bind(f.engine), saved = spyOn(f.engine, "agentLog");
    f.restore(() => saved.mockRestore());
    saved.mockImplementation((id, text) => {
      const writing = f.owner.run(f.engine, () => save(id, text));
      void writing.catch(() => undefined); written.push(writing); return writing;
    });
    const start = spyOn(AgentRun, "start"); f.restore(() => start.mockRestore());
    start.mockImplementation(async options => {
      expect(options.command).toEqual([join(f.root, "unconfigured-agent-must-never-launch")]);
      options.callbacks.onLog?.(`\n${note}\n`);
      options.callbacks.onCleanupIncomplete?.();
      throw failure;
    });
    const opened = await f.observe(() => f.engine["turns"]["openAgentRun"](f.scope, role, profile, f.root, f.abort.signal,
      { roleId: role.id, profile, waits: new WaitClock(), journeyId: "browser-log-routing", agentSeat: role.id }, { main: true }));
    expect(opened.kind).toBe("error");
    if (opened.kind !== "error" || !(opened.error instanceof AggregateError)) throw new Error("The failed native opening lost its cleanup refusal");
    expect(opened.error.errors[0]).toBe(failure);
    const cleanup = opened.error.errors[1];
    expect((cleanup as Error).message).toBe("Agent cleanup was not confirmed");
    await completeAll(written);
    const notes = readFileSync(join(f.engine.dataDir, "logs", `${f.task.id}.log`), "utf8").split("\n").filter(line => line.includes(CLEANUP_NOTE));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe(note);
    expect(f.task.timeline.some(entry => entry.text === CLEANUP_INCOMPLETE)).toBe(true);
    expect(f.task.timeline.some(entry => entry.text.includes(CLEANUP_NOTE))).toBe(false);
    const shutdown = await f.engine.shutdown().then(() => ({ kind: "value" as const }), error => ({ kind: "error" as const, error }));
    expect(shutdown.kind).toBe("error");
    if (shutdown.kind !== "error") throw new Error("Native cleanup uncertainty became a successful Engine shutdown");
    expect(shutdown.error).toBe(cleanup);
    expect(f.storeClosed).toBe(true);
    const owned = await f.closeSubject();
    expect(owned.kind).toBe("error"); expect(existsSync(f.root)).toBe(true);
    f.acknowledgeRetained(owned, cleanup);
  } finally { await f.finish(); }
}, 90_000 * SLOW);

it("keeps parallel fixtures' browser folders apart and recovers only an engine's own leftovers at startup", async () => {
  return engineCases.use("petrina-browser-recovery-root-", async owner => {
  const first = testBrowserRoot(), second = testBrowserRoot();
  registerFixtureRoot(first); registerFixtureRoot(second);
  const work = owner.root;
  const data = join(work, "data"), registry = join(data, "browser-temp");
  const outside = join(work, "product");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "product work");
  const browsers: AgentBrowser[] = [];
  let started: Promise<unknown> = Promise.resolve();
  const stopBrowsers = owner.onStop(async () => {
    // Each successful start is captured independently, even when its peer rejects.
    await started;
    await completeAll(browsers.map(async browser => {
      try { await browser.close(); }
      catch (error) {
        // Windows deliberately reports uncertainty after this forced helper exit. Independent
        // cleanup needs actual closed output and a readable empty native session observation.
        const child = (browser as unknown as { child: ChildProcess }).child;
        if (process.platform !== "win32" || !(error instanceof Error) || error.message !== "The headless browser did not stop."
          || (child.exitCode === null && child.signalCode === null) || !child.stdout?.readableEnded || !child.stderr?.readableEnded) throw error;
        const observed = await browserProcesses.readFolder(browser.directory);
        if (!observed || observed.pids.length) throw new Error("The crashed browser's native cleanup remains uncertain", { cause: error });
        removeFixtureRoot(browser.directory);
      }
    }));
  });
  owner.afterBody(async () => {
    await stopBrowsers();
    await owner.stopAll();
    for (const folder of [first, second]) {
      if (readdirSync(folder).length) throw new Error("Browser output remains after fixture cleanup; folders retained");
      removeFixtureRoot(folder);
    }
  });

    expect(first).not.toBe(second);
    // Fixture folders are spelled as browser startup and recovery canonicalize them, even where the
    // temporary folder has another name for itself (a Windows short name such as RUNNER~1).
    expect(await Promise.all([first, second].map((root) => files.realpath(root)))).toEqual([first, second]);
    // Two fixtures start at once, each in its own folder. Both registered with this engine, then it stopped abruptly.
    const openings = [first, second].map(root => owner.prepare(async () => {
      owner.check();
      const browser = await AgentBrowser.start(registry, process.env, undefined, root);
      browsers[[first, second].indexOf(root)] = browser;
      owner.check();
      return browser;
    }));
    started = Promise.allSettled(openings);
    await completeAll(openings);
    expect(browsers.map((browser) => dirname(browser.directory))).toEqual([first, second]);
    for (const browser of browsers) await crash(browser);
    writeFileSync(join(registry, "outside.json"), JSON.stringify(outside));
    expect(readdirSync(registry)).toHaveLength(3);
    // Startup recovery uses the engine's configured folder: it reaps that leftover only.
    let engine = owner.open(data, { agentCommand: () => ["fake-agent"], toolProbe: privateAgentToolProbe(), browser: true, browserTempRoot: first });
    await engine.waitUntilReady();
    expect(existsSync(browsers[0]!.directory)).toBe(false);
    expect(existsSync(browsers[1]!.directory)).toBe(true);
    expect(existsSync(registry)).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("product work");
    await owner.stop(engine);
    // An engine with the standard folder never reaps another fixture's folder either.
    mkdirSync(registry);
    writeFileSync(join(registry, "other.json"), JSON.stringify(browsers[1]!.directory));
    engine = owner.open(data, { agentCommand: () => ["fake-agent"], toolProbe: privateAgentToolProbe() });
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
  });
}, 60_000 * SLOW);
