import { expect, it } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { AgentRun } from "../../../src/acp-run.js";
import { browserTempRoot } from "../../../src/browser.js";
import { preserveCaptures } from "../../../src/captures.js";
import { connectBrowser as connect } from "../../fixtures/browser-client.js";
import { browserProcesses } from "@petrina/platform/browser-processes";
import { expectRejection } from "@petrina/test-support/rejections";
import { refuseFolder } from "@petrina/test-support/refuse-folder";
import { tempDir, testBrowserRoot, removeDir } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
const BROWSER_AGENT = fileURLToPath(new URL("../../fixtures/browser-agent.ts", import.meta.url));
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };
async function processesNaming(folder: string): Promise<string[]> {
  const listed = await browserProcesses.readFolder(folder);
  if (!listed?.commands) throw new Error("The native folder observation is unavailable");
  return [...listed.commands];
}

it("opens a real headless page and saves a capture in a fixture's own folder, new and resumed, while the standard folder refuses writes", async () => {
  const refusal = refuseFolder(browserTempRoot());
  try {
  const browsers = testBrowserRoot();
  const work = tempDir("petrina-browser-fixture-");
  const registry = join(work, "registry"), storage = join(work, "captures");
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>Fixture page</title><h1>Checked</h1>", { headers: { "content-type": "text/html" } }) });
  const options = {
    profile: { id: "fixture", toolId: "claude-code", model: "test", effort: "high" as const }, cwd: work, callbacks, signal: new AbortController().signal,
    browserRoot: registry, browserTempRoot: browsers, command: [process.execPath, BROWSER_AGENT], env: { ...process.env, FAKE_REOPEN: "resume" },
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
      const endpoint = run.browser!.mcp;
      if (!("url" in endpoint)) throw new Error("The browser fixture needs its HTTP endpoint");
      expect(await run.stop()).toBe(true);
      await expectRejection(fetch(endpoint.url));
      expect(existsSync(directory)).toBe(false);
      if (browserProcesses.groups) expect(await processesNaming(directory)).toEqual([]);
    }
    expect(new Set(directories).size).toBe(2);
    expect(readdirSync(storage)).toHaveLength(2);
    expect(readdirSync(registry)).toEqual([]);
    expect(readdirSync(browsers)).toEqual([]);
    if (browserProcesses.groups) expect(await processesNaming(browsers)).toEqual([]);
    expect(refusal.attempts).toEqual([]);
  } finally {
    for (const run of runs) await run.stop();
    page.stop(true);
    removeDir(work);
    removeDir(browsers);
  }
  } finally { refusal.restore(); }
}, 90_000 * SLOW);
