import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { ownSession } from "@petrina/platform/process-environment";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { readProcessList } from "@petrina/platform/process-tree";
import { resolveInstalledClaudeCli } from "@petrina/agent-runtime/claude-acp";
import { resolveInstalledCodexCli } from "@petrina/agent-runtime/codex-acp";
import { backgroundCommand } from "@petrina/agent-runtime/codex-background";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

const root = tempDir("petrina-managed-launch-");
afterAll(() => removeDir(root));
const wrapper = join(import.meta.dir, "../../../src/codex-background.ts");

for (const target of [undefined, "/custom/codex"]) it(`keeps the real Codex target across repeated preparation (${target ?? "bundled"})`, () => {
  const env: NodeJS.ProcessEnv = target ? { CODEX_PATH: target } : {};
  ADAPTERS.codex!.prepareEnv!(env);
  const first = { ...env };
  ADAPTERS.codex!.prepareEnv!(env);
  expect(env).toEqual(first);
  expect(env.PETRINA_CODEX_EXECUTABLE).toBe(target);
  expect(env.CODEX_PATH).not.toBe(env.PETRINA_CODEX_EXECUTABLE);
});

it("respects the user's native plan-tool setting, including its disabled default", () => {
  for (const enabled of [undefined, false, true]) {
    const config = { ...(enabled !== undefined ? { "tools.update_plan.enabled": enabled } : {}), "unrelated.setting": "preserved" };
    const env = { CODEX_CONFIG: JSON.stringify(config) };
    ADAPTERS.codex!.prepareEnv!(env);
    const prepared = JSON.parse(env.CODEX_CONFIG);
    expect(prepared["tools.update_plan.enabled"]).toBe(enabled);
    expect(prepared["unrelated.setting"]).toBe("preserved");
  }
});

for (const id of ["claude-code", "codex", "grok", "antigravity"]) {
  it(`${id}: restores inherited managed settings before a nested launch, including another clone`, () => {
    for (const target of [undefined, "/custom/codex"]) {
      const parent: NodeJS.ProcessEnv = {
        CODEX_PATH: "/another-clone/codex-background.ts", PETRINA_CODEX_WRAPPER: "/another-clone/codex-background.ts",
        ...(target ? { PETRINA_CODEX_EXECUTABLE: target } : {}),
        CLAUDECODE: "1", CLAUDE_EFFORT: "low", CODEX_THREAD_ID: "parent", GROK_SESSION_ID: "parent",
        GH_TOKEN: "login", GROK_HOME: "/personal/grok", CLAUDE_CODE_USE_BEDROCK: "1",
      };
      const before = { ...parent };
      const env = ownSession(parent);
      ADAPTERS[id]!.prepareEnv?.(env);
      expect(parent).toEqual(before);
      for (const key of ["CLAUDECODE", "CLAUDE_EFFORT", "CODEX_THREAD_ID", "GROK_SESSION_ID"]) expect(env[key]).toBeUndefined();
      expect(env).toMatchObject({ GH_TOKEN: "login", GROK_HOME: "/personal/grok", CLAUDE_CODE_USE_BEDROCK: "1" });
      expect(ownSession(env).CODEX_PATH).toBe(target);
      expect(ownSession(env).PETRINA_CODEX_EXECUTABLE).toBeUndefined();
    }
    const changed = ownSession({ CODEX_PATH: "/new/codex", PETRINA_CODEX_WRAPPER: wrapper, PETRINA_CODEX_EXECUTABLE: "/old/codex" });
    expect(changed.CODEX_PATH).toBe("/new/codex");
  });
}

it("refuses a self-referencing Codex command and resolves installed agent CLIs strictly from PATH", async () => {
  await expectRejection(backgroundCommand(wrapper), "launcher points back to itself");
  expect(await backgroundCommand(process.execPath)).toEqual([process.execPath]);

  const binDir = join(root, "private-bin");
  const emptyBinDir = join(root, "empty-bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(emptyBinDir, { recursive: true });
  const ext = process.platform === "win32" ? ".cmd" : "";
  const fakeCodex = join(binDir, `codex${ext}`);
  const fakeClaude = join(binDir, `claude${ext}`);
  for (const bin of [fakeCodex, fakeClaude]) {
    writeFileSync(bin, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
    if (process.platform !== "win32") chmodSync(bin, 0o755);
  }

  expect(await backgroundCommand(undefined, binDir)).toEqual([fakeCodex]);
  await expectRejection(backgroundCommand(undefined, emptyBinDir), "no `codex` on PATH");

  expect(resolveInstalledCodexCli({ PATH: binDir })).toBe(fakeCodex);
  expect(() => resolveInstalledCodexCli({ PATH: emptyBinDir })).toThrow("no `codex` on PATH");

  expect(resolveInstalledClaudeCli({ PATH: binDir })).toBe(fakeClaude);
  expect(resolveInstalledClaudeCli({ PATH: emptyBinDir, CLAUDE_CODE_EXECUTABLE: fakeClaude })).toBe(fakeClaude);
  expect(() => resolveInstalledClaudeCli({ PATH: emptyBinDir })).toThrow("no `claude` on PATH");
});

for (const toolId of ["claude-code", "codex", "grok", "antigravity"]) it(`${toolId}: the actual connector receives an independent environment`, async () => {
  const cwd = join(root, toolId);
  mkdirSync(cwd);
  const file = join(cwd, "received.json"), command = join(cwd, "capture.ts");
  await Bun.write(command, `await Bun.write(${JSON.stringify(file)}, JSON.stringify(process.env)); await import(${JSON.stringify(join(import.meta.dir, "../../fixtures/session-agent.ts"))});`);
  const env = { PATH: process.env.PATH, CODEX_PATH: "/other-clone/codex-background.ts", PETRINA_CODEX_WRAPPER: "/other-clone/codex-background.ts", PETRINA_CODEX_EXECUTABLE: "/custom/codex", CLAUDECODE: "1", CODEX_THREAD_ID: "outer", GROK_SESSION_ID: "outer", GROK_MEMORY: "1", PETRINA_LIFECYCLE_REPLACEMENT: "1", PETRINA_RECONNECT_PORT: "4317" };
  const options = { profile: { id: "fixture", toolId, model: "Opus", modelId: "opus", effort: "high" as const }, cwd, browser: false,
    env, command: [process.execPath, command, cwd], signal: new AbortController().signal,
    callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const },
  };
  let run: AgentRun | undefined;
  try {
    run = await AgentRun.start(options);
    const session = run.sessionId;
    await run.stop();
    run = await AgentRun.start({ ...options, reopen: session });
    expect(run.reopened).toBe("resume");
    const received = await Bun.file(file).json();
    for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "GROK_SESSION_ID", "PETRINA_LIFECYCLE_REPLACEMENT", "PETRINA_RECONNECT_PORT"]) expect(received[key]).toBeUndefined();
    expect(ownSession(received).CODEX_PATH).toBe("/custom/codex");
    if (toolId === "codex") expect(JSON.parse(received.CODEX_CONFIG)["tools.update_plan.enabled"]).toBeUndefined();
    expect(received.GROK_MEMORY).toBe(toolId === "grok" ? "0" : "1");
    expect(env.GROK_MEMORY).toBe("1");
    expect(env.CODEX_PATH).toBe("/other-clone/codex-background.ts");
  } finally { await run?.stop(); }
}, 20_000 * SLOW);

it.skipIf(process.platform === "win32")("retains the startup error and reports incomplete cleanup when process scanning cannot start, for every provider", async () => {
  const saved = process.env.PATH;
  process.env.PATH = join(root, "no-programs");
  try {
    expect(await readProcessList(100)).toBeUndefined();
    for (const toolId of ["claude-code", "codex", "grok", "antigravity"]) {
      let incomplete = 0;
      let failure: unknown;
      try {
        await AgentRun.start({ profile: { id: "fails", toolId, model: "test", effort: "high" }, cwd: root, browser: false,
          env: {}, command: [process.execPath, "-e", "import {createInterface} from 'node:readline'; createInterface({input:process.stdin}).on('line', line => { const r=JSON.parse(line); console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:'Fixture initialization refused'}})); }); setInterval(()=>{},1000);"], signal: new AbortController().signal,
          callbacks: { onActivity() {}, onPlanStep() {}, async onPermission() { return "deny"; }, onCleanupIncomplete() { incomplete++; } },
        });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("Fixture initialization refused");
      expect(String(failure)).not.toMatch(/posix_spawn 'ps'|spawn ps|ENOENT|EPERM/);
      expect(incomplete).toBe(1);
    }
  } finally { if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved; }
}, 20_000 * SLOW);
