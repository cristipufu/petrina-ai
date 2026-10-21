// Where agents' temporary browser folders live. Real agents keep the user's standard folder; test
// fixtures use their own short folders, and scripted agents that never open a page get no browser.
import { expect, it, spyOn } from "bun:test";
import { execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as files from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { BUILT_IN_ROLES } from "@petrina/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import sharp from "sharp";
import { AgentRun } from "../src/acp-run.js";
import { AgentBrowser, browserTempRoot } from "../src/browser.js";
import { preserveCaptures } from "../src/captures.js";
import { Engine } from "../src/engine.js";
import { mayAskScreen } from "../src/prompts.js";
import { opensBrowser } from "../src/turn.js";
import { finish, makeWorld, removeDir, SLOW, taskOf, tempDir, testBrowserRoot } from "./support.js";

const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };

/**
 * Refuse every write under the standard browser folder in this process, the way a coding tool's
 * sandbox does, and record each attempt. Browser startup and recovery run in this process.
 */
function refuseStandardFolder() {
  const standard = resolve(browserTempRoot());
  const attempts: string[] = [];
  const refused = (path: unknown) => {
    const text = typeof path === "string" ? resolve(path) : path instanceof URL ? resolve(path.pathname) : "";
    if (text !== standard && !text.startsWith(standard + sep)) return undefined;
    attempts.push(text);
    return Object.assign(new Error(`EPERM: operation not permitted, '${text}'`), { code: "EPERM", path: text });
  };
  const spies = [
    ...(["mkdir", "mkdtemp", "writeFile", "rm"] as const).map((name) => {
      const original = files[name] as (...args: unknown[]) => Promise<unknown>;
      return spyOn(files, name).mockImplementation((async (...args: unknown[]) => {
        const error = refused(args[0]);
        if (error) throw error;
        return original(...args);
      }) as never);
    }),
    ...(["mkdirSync", "mkdtempSync", "writeFileSync", "rmSync"] as const).map((name) => {
      const original = fs[name] as (...args: unknown[]) => unknown;
      return spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
        const error = refused(args[0]);
        if (error) throw error;
        return original(...args);
      }) as never);
    }),
  ];
  return { attempts, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

async function connect(browser: AgentBrowser): Promise<Client> {
  if (!("url" in browser.mcp) || !("headers" in browser.mcp)) throw new Error("Expected an HTTP browser");
  const client = new Client({ name: "fixture browser check", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(browser.mcp.url), { requestInit: { headers: Object.fromEntries(browser.mcp.headers.map((header) => [header.name, header.value])) } }));
  return client;
}

/** Process command lines that still name a folder, from a full process list. */
function processesNaming(folder: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axww", "-o", "pid=,command="], { timeout: 4_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout.split("\n").filter((line) => line.includes(`${folder}/`) || line.includes(`${folder} `) || line.endsWith(folder)));
    });
  });
}

/** A helper that stopped without closing leaves its folder and registration, like an engine crash. */
async function crash(browser: AgentBrowser): Promise<void> {
  const child = (browser as unknown as { child: ChildProcess }).child;
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  child.kill("SIGKILL");
  await closed;
}

it("gives real agents a browser in the standard folder, and scripted agents one only when their test asks", () => {
  expect(browserTempRoot()).toBe(process.platform === "darwin" ? join(homedir(), ".petrina", "b") : join(tmpdir(), "petrina-browsers"));
  const fake = () => ["fake-agent"];
  for (const role of BUILT_IN_ROLES) {
    expect(opensBrowser(role, {})).toBe(mayAskScreen(role));
    expect(opensBrowser(role, { agentCommand: fake })).toBe(false);
    expect(opensBrowser(role, { agentCommand: fake, browser: true })).toBe(mayAskScreen(role));
    expect(opensBrowser(role, { browser: false })).toBe(false);
  }
  expect(BUILT_IN_ROLES.some((role) => mayAskScreen(role))).toBe(true);
});

it("finishes a scripted workflow unrelated to browsing while the standard browser folder refuses writes", async () => {
  const refusal = refuseStandardFolder();
  const started = spyOn(AgentBrowser, "start");
  const world = makeWorld("browser-free-workflow");
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
    started.mockRestore();
    refusal.restore();
    removeDir(world.dir);
  }
}, 120_000 * SLOW);

it.skipIf(process.platform === "win32")("opens a real headless page and saves a capture in a fixture's own folder, new and resumed, while the standard folder refuses writes", async () => {
  const refusal = refuseStandardFolder();
  const browsers = testBrowserRoot();
  const work = tempDir("petrina-browser-fixture-");
  const registry = join(work, "registry"), storage = join(work, "captures");
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>Fixture page</title><h1>Checked</h1>", { headers: { "content-type": "text/html" } }) });
  const options = {
    profile: { id: "fixture", toolId: "claude-code", model: "test", effort: "high" as const }, cwd: work, callbacks, signal: new AbortController().signal,
    browserRoot: registry, browserTempRoot: browsers, command: [process.execPath, join(import.meta.dir, "browser-agent.ts")], env: { ...process.env, FAKE_REOPEN: "resume" },
  };
  const runs: AgentRun[] = [];
  const directories: string[] = [];
  try {
    for (const reopen of [undefined, "fixture-session"]) {
      const run = await AgentRun.start({ ...options, ...(reopen ? { reopen } : {}) });
      runs.push(run);
      expect(run.reopened).toBe(reopen ? "resume" : undefined);
      const directory = run.browser!.directory;
      directories.push(directory);
      expect(dirname(directory)).toBe(browsers);
      if (process.platform === "darwin") expect(Buffer.byteLength(join(directory, "SingletonSocket"))).toBeLessThan(104);
      const client = await connect(run.browser!);
      try {
        const opened = await client.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${page.port}` } });
        expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
        expect(JSON.stringify(await client.callTool({ name: "browser_evaluate", arguments: { function: "() => document.title" } }))).toContain("Fixture page");
        expect((await client.callTool({ name: "browser_take_screenshot", arguments: { filename: "page.png" } })).isError).not.toBe(true);
      } finally { await client.close(); }
      const saved = await preserveCaptures(directory, storage, [{ path: "page.png", caption: "The fixture page" }]);
      expect(saved).toEqual([{ id: expect.any(String), caption: "The fixture page" }]);
      expect((await sharp(readFileSync(join(storage, `${saved[0]!.id}.png`))).metadata()).format).toBe("png");
      expect(await run.stop()).toBe(true);
      expect(existsSync(directory)).toBe(false);
      expect(await processesNaming(directory)).toEqual([]);
    }
    expect(new Set(directories).size).toBe(2);
    expect(readdirSync(storage)).toHaveLength(2);
    expect(readdirSync(registry)).toEqual([]);
    expect(readdirSync(browsers)).toEqual([]);
    expect(await processesNaming(browsers)).toEqual([]);
    expect(refusal.attempts).toEqual([]);
  } finally {
    for (const run of runs) await run.stop();
    page.stop(true);
    refusal.restore();
    removeDir(work);
    removeDir(browsers);
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
      if (process.platform === "win32") await expect(browser.close()).rejects.toThrow("The headless browser did not stop.");
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
