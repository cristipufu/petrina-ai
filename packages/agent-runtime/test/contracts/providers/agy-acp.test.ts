import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { removeTreeWithRetries } from "@petrina/test-support/fixture-roots";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { AgentRun } from "../../../src/acp-run.js";
import { agySpawnPlan, stageMcpPluginDir } from "../../../src/agy-acp-protocol.js";
import { checkAgentTool } from "../../../src/probe.js";
import { ADAPTERS, ENGINE_PROFILES } from "../../../src/tools.js";

const root = tempDir("petrina-agy-acp-");
afterAll(() => removeDir(root));

const translatorScript = join(root, "run-agy-acp.ts");
writeFileSync(
  translatorScript,
  `import { runAgyAcp } from ${JSON.stringify(join(import.meta.dir, "../../../src/agy-acp.ts"))};\nawait runAgyAcp(process.argv.slice(2));\n`,
  "utf8",
);

const fakeAgyImpl = join(root, "fake-agy.ts");
writeFileSync(
  fakeAgyImpl,
  `import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const cwd = process.cwd();
const logPath = join(cwd, ".fake-agy-calls.json");
const prevCalls = existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : [];
prevCalls.push(args);
writeFileSync(logPath, JSON.stringify(prevCalls));

if (process.env.FAKE_AGY_AUTH_ERROR === "1") {
  process.stderr.write("Authentication required: run agy to sign in.\\n");
  process.exit(1);
}

if (args.includes("--print") && args.includes("/usage")) {
  process.stdout.write([
    "Model\\tQuota\\tRemaining\\tResets",
    "Gemini Models\\tWeekly Limit Remaining\\t40%\\t2099-01-01T00:00:00Z",
    "Gemini Models\\t5-Hour Limit Remaining\\t80%\\t2099-01-01T05:00:00Z",
    "Gemini 4 Argon\\tWeekly Limit Remaining\\t60%\\t2099-01-01T00:00:00Z",
  ].join("\\n") + "\\n");
  process.exit(0);
}

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const sessionsPath = join(cwd, ".fake-agy-sessions.json");
const sessions: Record<string, number> = existsSync(sessionsPath) ? JSON.parse(readFileSync(sessionsPath, "utf8")) : {};
const requestedConv = flag("--conversation");
let conversationId: string;
if (!requestedConv) {
  conversationId = "agy-conv-" + (Object.keys(sessions).length + 1);
  sessions[conversationId] = 0;
  writeFileSync(sessionsPath, JSON.stringify(sessions));
} else if (Object.hasOwn(sessions, requestedConv)) {
  conversationId = requestedConv;
} else {
  conversationId = "agy-conv-fallback";
}

const model = flag("--model") ?? "gemini-3.8-flash";
process.stdout.write(JSON.stringify({
  event: "init",
  conversation_id: conversationId,
  model,
  tools: ["read_file", "run_command"],
}) + "\\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const turnCount = (sessions[conversationId] ?? 0) + 1;
  sessions[conversationId] = turnCount;
  writeFileSync(sessionsPath, JSON.stringify(sessions));
  process.stdout.write(JSON.stringify({
    event: "step_update",
    step_update: { step_index: 1, step_type: "thinking", state: "GENERATING", thinking_delta: "Inspecting repository..." },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 2,
      step_type: "tool",
      state: "GENERATING",
      tool_info: { name: "read_file", parameters: { Path: join(cwd, "README.md") } },
    },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 2,
      step_type: "tool",
      state: "DONE",
      tool_info: { name: "read_file", parameters: { Path: join(cwd, "README.md") }, result: "ok" },
      usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 400, total_tokens: 530 },
    },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    event: "step_update",
    step_update: { step_index: 3, step_type: "agent_response", state: "GENERATING", text_delta: "Turn " + turnCount + " complete." },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    event: "result",
    result: {
      conversation_id: conversationId,
      status: "DONE",
      finished_reason: "stop",
      response: "Turn " + turnCount + " complete.",
      usage: {
        input_tokens: 100 * turnCount,
        output_tokens: 20 * turnCount,
        thinking_tokens: 10 * turnCount,
        cache_read_tokens: 400 * turnCount,
        total_tokens: 530 * turnCount,
      },
    },
  }) + "\\n");
});
rl.on("close", () => process.exit(0));
`,
  "utf8",
);

const fakeAgyBin = join(root, process.platform === "win32" ? "agy.cmd" : "agy");
if (process.platform === "win32") {
  writeFileSync(fakeAgyBin, `@echo off\r\n"${process.execPath}" "${fakeAgyImpl}" %*\r\n`, "utf8");
} else {
  writeFileSync(
    fakeAgyBin,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeAgyImpl}" "$@"\n`,
    "utf8",
  );
  chmodSync(fakeAgyBin, 0o755);
}

const profile = ENGINE_PROFILES.find((p) => p.id === "flash-medium")!;
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };

describe("embedded __internal-agy-acp translator", () => {
  it("launches native executables directly and wraps Windows .cmd shims through ComSpec", () => {
    expect(agySpawnPlan("/usr/local/bin/agy", ["--print", "/usage"], {}, "darwin")).toEqual({
      command: "/usr/local/bin/agy",
      args: ["--print", "/usage"],
    });
    expect(agySpawnPlan("C:\\Program Files\\Antigravity\\agy.exe", ["--print", "/usage"], {}, "win32")).toEqual({
      command: "C:\\Program Files\\Antigravity\\agy.exe",
      args: ["--print", "/usage"],
    });
    const cmdPlan = agySpawnPlan(
      "C:\\Users\\Runner\\AppData\\Roaming\\npm\\agy.cmd",
      ["--input-format", "stream-json"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    );
    expect(cmdPlan.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(cmdPlan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(cmdPlan.args[3]).toContain("agy.cmd");
    expect(cmdPlan.windowsVerbatimArguments).toBe(true);
  });

  it("stages Streamable HTTP and stdio MCP servers into an isolated .agents/plugins directory", async () => {
    const dir = await stageMcpPluginDir([
      {
        type: "http",
        name: "petrina-browser-1",
        url: "http://127.0.0.1:45123/mcp",
        headers: [{ name: "Authorization", value: "Bearer secret-token" }],
      },
      {
        name: "petrina",
        command: "petrina",
        args: ["mcp"],
        env: [{ name: "PETRINA_HOME", value: "/tmp/petrina" }],
      },
    ]);
    expect(dir).toBeDefined();
    try {
      const mcpConfig = JSON.parse(
        readFileSync(join(dir!, ".agents", "plugins", "petrina", "mcp_config.json"), "utf8"),
      );
      expect(mcpConfig).toEqual({
        mcpServers: {
          "petrina-browser-1": {
            type: "http",
            url: "http://127.0.0.1:45123/mcp",
            headers: { Authorization: "Bearer secret-token" },
          },
          petrina: {
            command: "petrina",
            args: ["mcp"],
            env: { PETRINA_HOME: "/tmp/petrina" },
          },
        },
      });
    } finally {
      if (dir) removeTreeWithRetries(dir);
    }
  });

  it("checks readiness, streams turns, reports TSV quotas, and resumes conversations counting per-turn token deltas", async () => {
    const cwd = join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const command = [process.execPath, translatorScript];
    const baseEnv = { ...process.env, AGY_EXECUTABLE: fakeAgyBin };

    const loggedOut = await checkAgentTool({
      adapter: ADAPTERS.antigravity!,
      profile,
      cwd,
      command,
      env: { ...baseEnv, FAKE_AGY_AUTH_ERROR: "1" },
      which: () => fakeAgyBin,
    });
    expect(loggedOut.status).toBe("logged-out");

    const ready = await checkAgentTool({
      adapter: ADAPTERS.antigravity!,
      profile,
      cwd,
      command,
      env: baseEnv,
      which: () => fakeAgyBin,
    });
    expect(ready.status).toBe("ready");

    const accountSnapshots: unknown[][] = [];
    const activities: string[] = [];
    let run = await AgentRun.start({
      profile,
      cwd,
      command,
      env: baseEnv,
      signal: new AbortController().signal,
      browser: false,
      callbacks: {
        ...callbacks,
        onActivity: (line) => activities.push(line),
        onAccountUsage: (reports) => accountSnapshots.push([...reports]),
      },
    });
    try {
      expect(run.settings).toEqual({
        model: "gemini-3.8-flash",
        modelName: "Gemini 3.8 Flash",
        effort: "medium",
      });
      expect(accountSnapshots.length).toBeGreaterThanOrEqual(1);
      expect(accountSnapshots[0]).toHaveLength(3);

      const first = await run.prompt("Summarize the repository");
      expect(first.text).toContain("Turn 1 complete.");
      expect(first.report).toEqual({
        main: { total: 530, input: 100, cacheRead: 400, output: 30, reasoning: 10 },
      });
      expect(activities.some((line) => line.includes("README.md"))).toBe(true);

      const sessionId = run.sessionId;
      await run.stop();

      run = await AgentRun.start({
        profile,
        cwd,
        command,
        env: baseEnv,
        reopen: sessionId,
        signal: new AbortController().signal,
        browser: false,
        callbacks,
      });
      expect(run.reopened).toBe("resume");
      const second = await run.prompt("Continue from turn 1");
      expect(second.text).toContain("Turn 2 complete.");
      expect(second.report).toEqual({
        main: { total: 530, input: 100, cacheRead: 400, output: 30, reasoning: 10 },
      });

      const recordedCalls = JSON.parse(readFileSync(join(cwd, ".fake-agy-calls.json"), "utf8")) as string[][];
      expect(recordedCalls.some((args) => args.includes("--dangerously-skip-permissions"))).toBe(true);
      expect(recordedCalls.some((args) => args.includes("--conversation") && args.includes(sessionId))).toBe(true);
      expect(existsSync(join(cwd, ".fake-agy-sessions.json"))).toBe(true);
    } finally {
      await run.stop();
    }
  }, 25_000 * SLOW);
});
