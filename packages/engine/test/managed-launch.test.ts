import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { ADAPTERS } from "../src/tools.js";
import { ownSession } from "../src/env.js";
import { AgentRun } from "../src/acp-run.js";
import { readProcessList } from "../src/process-tree.js";
import { backgroundCommand } from "../src/codex-background.js";
import { Fakes, removeDir, SLOW, tempDir } from "./support.js";

const root = tempDir("petrina-managed-launch-");
afterAll(() => removeDir(root));
const wrapper = join(import.meta.dir, "../src/codex-background.ts");

for (const target of [undefined, "/custom/codex"]) it(`keeps the real Codex target across repeated preparation (${target ?? "bundled"})`, () => {
  const env: NodeJS.ProcessEnv = target ? { CODEX_PATH: target } : {};
  ADAPTERS.codex!.prepareEnv!(env);
  const first = { ...env };
  ADAPTERS.codex!.prepareEnv!(env);
  expect(env).toEqual(first);
  expect(env.PETRINA_CODEX_EXECUTABLE).toBe(target);
  expect(env.CODEX_PATH).not.toBe(env.PETRINA_CODEX_EXECUTABLE);
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

it("refuses a self-referencing Codex command without starting a recursive process", async () => {
  await expect(backgroundCommand(wrapper)).rejects.toThrow("launcher points back to itself");
  expect(await backgroundCommand(process.execPath)).toEqual([process.execPath]);
  expect((await backgroundCommand(undefined))[1]).toEndWith("codex.js");
});

for (const toolId of ["claude-code", "codex", "grok", "antigravity"]) it(`${toolId}: the actual connector receives an independent environment`, async () => {
  const cwd = join(root, toolId);
  const fakes = new Fakes(cwd); fakes.scenario({ reopen: "resume" });
  const file = join(cwd, "received.json"), command = join(cwd, "capture.ts");
  await Bun.write(command, `await Bun.write(${JSON.stringify(file)}, JSON.stringify(process.env)); await import(${JSON.stringify(join(import.meta.dir, "fake-agent.ts"))});`);
    const env = { PATH: process.env.PATH, CODEX_PATH: "/other-clone/codex-background.ts", PETRINA_CODEX_WRAPPER: "/other-clone/codex-background.ts", PETRINA_CODEX_EXECUTABLE: "/custom/codex", CLAUDECODE: "1", CODEX_THREAD_ID: "outer", GROK_SESSION_ID: "outer", GROK_MEMORY: "1" };
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
    for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "GROK_SESSION_ID"]) expect(received[key]).toBeUndefined();
    expect(ownSession(received).CODEX_PATH).toBe("/custom/codex");
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
