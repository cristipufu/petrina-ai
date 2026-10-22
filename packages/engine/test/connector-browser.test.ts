import { rejectionOf } from "./rejections.js";
import { afterAll, expect, it } from "bun:test";
import { existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentRun, ReopenFailed } from "../src/acp-run.js";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { descendantsKnown } from "../src/process-tree.js";
import { BACKGROUND_FEATURES, backgroundConfig } from "../src/codex-background.js";
import { removeDir, SLOW, tempDir, testBrowserRoot } from "./support.js";
import { claudeSandbox } from "../src/sandbox.js";

const root = tempDir("petrina-connector-browser-");
const browsers = testBrowserRoot();
afterAll(() => { removeDir(root); removeDir(browsers); });
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };
for (const toolId of ["claude-code", "codex"]) {
  for (const how of ["new", "resume", "load", "failed-reopen"] as const) {
    it(`${toolId}: the browser reaches ${how} with personal browser controls off`, async () => {
      const signal = new AbortController();
      const cwd = mkdtempSync(join(root, "case-"));
      const registry = join(cwd, "registry");
      const settings = JSON.stringify({ enabledPlugins: { "personal-browser@test": true, "desktop-control@test": true }, sandbox: { filesystem: { allowWrite: [join(cwd, "allowed-by-user")] } } });
      mkdirSync(join(cwd, ".claude"));
      writeFileSync(join(cwd, ".claude", "settings.json"), settings);
      const options = {
        profile: { id: "test", toolId, model: "test", effort: "high" as const }, cwd, browserRoot: registry, browserTempRoot: browsers,
        sandbox: claudeSandbox(),
        callbacks, signal: signal.signal, command: [process.execPath, join(import.meta.dir, "browser-agent.ts")],
        env: { ...process.env, FAKE_REOPEN: how === "failed-reopen" ? "fail" : how, CODEX_CONFIG: JSON.stringify({ "features.computer_use": true, "features.plugins": true, "features.browser_use": true }) },
      };
      let run: AgentRun;
      if (how === "failed-reopen") {
        expect(await rejectionOf(AgentRun.start({ ...options, reopen: "old" }))).toBeInstanceOf(ReopenFailed);
        expect(readdirSync(registry)).toEqual([]);
        run = await AgentRun.start(options);
      } else run = await AgentRun.start({ ...options, ...(how === "new" ? {} : { reopen: "old" }) });
      const directory = run.browser!.directory;
      // New, reopened and replacement conversations all use the configured browser folder.
      expect(dirname(directory)).toBe(browsers);
      try {
        const result = JSON.parse((await run.prompt("Describe supplied browser tools")).text);
        expect(result.tools).toContain("browser_navigate");
        expect(result.tools).toContain("browser_take_screenshot");
        expect(result.tools).not.toContain("browser_run_code_unsafe");
        expect(result.params.mcpServers).toHaveLength(1);
        if (toolId === "claude-code") {
          const controls = result.params._meta.claudeCode.options;
          expect(controls.extraArgs).toEqual({ "no-chrome": null });
          expect(controls.settingSources).toBeUndefined();
          expect(controls.sandbox).toEqual(claudeSandbox());
          expect(controls.settings.enabledPlugins["personal-browser@test"]).toBe(false);
          expect(controls.settings.enabledPlugins["desktop-control@test"]).toBe(false);
          expect(controls.settings.syncClaudeAiPlugins).toBe(false);
          expect(controls.plugins).toEqual([]);
          expect(controls.strictMcpConfig).toBe(true);
          expect(controls.tools).not.toContain("Computer");
        } else {
          for (const feature of BACKGROUND_FEATURES) expect(result.codex[`features.${feature}`]).toBe(false);
          expect(result.codexPath).toEndWith("codex-background.ts");
        }
      } finally { await run.stop(); }
      expect(existsSync(directory)).toBe(false);
      expect(readFileSync(join(cwd, ".claude", "settings.json"), "utf8")).toBe(settings);
    }, 30_000 * SLOW);
  }
}

it("Codex disables inherited desktop connections from effective and project settings, keeping only explicit session servers", () => {
  const inherited = { mcp_servers: { "claude-in-chrome": { enabled: true, tool_timeout_sec: null }, "personal.desktop": { enabled: true } }, features: { computer_use: true, plugins: true } };
  const before = JSON.stringify(inherited);
  const result = backgroundConfig({ mcp_servers: { supplied: { url: "http://127.0.0.1/" } } }, inherited, [{ config: { mcp_servers: { screen: { enabled: true } } } }]);
  const servers = result.mcp_servers as Record<string, { enabled: boolean }>;
  expect(servers["claude-in-chrome"]!.enabled).toBe(false);
  expect(servers["personal.desktop"]!.enabled).toBe(false);
  expect(servers.screen!.enabled).toBe(false);
  expect(servers.supplied!.enabled).toBe(true);
  for (const feature of BACKGROUND_FEATURES) expect(result[`features.${feature}`]).toBe(false);
  expect(JSON.stringify(inherited)).toBe(before);
  expect(JSON.stringify(result)).not.toContain("null");
});

it("an aborted session stops its browser and removes its temporary folder", async () => {
  const controller = new AbortController();
  const cwd = mkdtempSync(join(root, "abort-"));
  const registry = join(cwd, "registry");
  const run = await AgentRun.start({ profile: { id: "abort", toolId: "claude-code", model: "test", effort: "high" }, cwd, browserRoot: registry, browserTempRoot: browsers, callbacks, signal: controller.signal, command: [process.execPath, join(import.meta.dir, "browser-agent.ts")] });
  const directory = run.browser!.directory;
  controller.abort();
  await run.stop();
  expect(existsSync(directory)).toBe(false);
  expect(readdirSync(registry)).toEqual([]);
}, 30_000 * SLOW);

for (const how of ["stop", "abort"] as const) it.skipIf(process.platform === "win32")(`${how} cleans an opened session browser after its controller has exited`, async () => {
  const signal = new AbortController();
  const cwd = mkdtempSync(join(root, `${how}-page-`));
  const registry = join(cwd, "registry");
  let incomplete = 0;
  const run = await AgentRun.start({ profile: { id: how, toolId: "claude-code", model: "test", effort: "high" }, cwd, browserRoot: registry, browserTempRoot: browsers, callbacks: { ...callbacks, onCleanupIncomplete: () => { incomplete += 1; } }, signal: signal.signal, command: [process.execPath, join(import.meta.dir, "browser-agent.ts")] });
  const browser = run.browser!;
  const child = (browser as unknown as { child: ChildProcess }).child;
  const endpoint = browser.mcp;
  if (!("url" in endpoint) || !("headers" in endpoint) || child.pid === undefined) throw new Error("Expected an owned HTTP browser");
  const client = new Client({ name: "session page check", version: "1" });
  let owned: number[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: Object.fromEntries(endpoint.headers.map((header) => [header.name, header.value])) } }));
    expect((await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } })).isError).not.toBe(true);
    owned = await descendantsKnown([child.pid]) ?? [];
    expect(owned.length).toBeGreaterThan(0);
    await client.close();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    if (how === "abort") signal.abort();
    expect(await run.stop()).toBe(true);
    expect(owned.filter(alive)).toEqual([]);
    expect(incomplete).toBe(0);
    expect(existsSync(browser.directory)).toBe(false);
    expect(readdirSync(registry)).toEqual([]);
  } finally {
    await client.close().catch(() => undefined);
    await run.stop();
    for (const pid of owned) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Not a process group leader. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
}, 45_000 * SLOW);

it("stops detached programs even when a conversation has no browser", async () => {
  const root = tempDir("petrina-text-agent-cleanup-");
  const pidFile = join(root, "child.pid");
  const wrapper = join(root, "agent.ts");
  writeFileSync(wrapper, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); child.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
await import(${JSON.stringify(join(import.meta.dir, "fake-agent.ts"))});`);
  let run: AgentRun | undefined;
  let pid: number | undefined;
  try {
    run = await AgentRun.start({ profile: { id: "text-only", toolId: "codex", model: "sol", effort: "high" }, cwd: root, browser: false, command: [process.execPath, wrapper], signal: new AbortController().signal, callbacks: { onActivity() {}, onPlanStep() {}, async onPermission() { return "deny"; } } });
    pid = Number(readFileSync(pidFile, "utf8"));
    process.kill(pid, 0);
    await run.stop();
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    await run?.stop();
    pid ??= existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : undefined;
    if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    removeDir(root);
  }
});
