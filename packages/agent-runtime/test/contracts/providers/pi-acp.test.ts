import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { AgentRun } from "../../../src/acp-run.js";
import { piSpawnPlan } from "../../../src/pi-acp-protocol.js";
import { checkAgentTool } from "../../../src/probe.js";
import { ADAPTERS, ENGINE_PROFILES } from "../../../src/tools.js";

const root = tempDir("petrina-pi-acp-");
afterAll(() => removeDir(root));

const translatorScript = join(root, "run-pi-acp.ts");
writeFileSync(
  translatorScript,
  `import { runPiAcp } from ${JSON.stringify(join(import.meta.dir, "../../../src/pi-acp.ts"))};\nawait runPiAcp(process.argv.slice(2));\n`,
  "utf8",
);

const fakePiImpl = join(root, "fake-pi.ts");
writeFileSync(
  fakePiImpl,
  `import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const cwd = process.cwd();
const logPath = join(cwd, ".fake-pi-calls.json");
const prevCalls = existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : [];
prevCalls.push(args);
writeFileSync(logPath, JSON.stringify(prevCalls));

if (process.env.FAKE_PI_AUTH_ERROR === "1") {
  process.stderr.write("No API key configured. Run pi to authenticate.\\n");
  process.exit(1);
}

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const sessionsPath = join(cwd, ".fake-pi-sessions.json");
const sessions: Record<string, { turns: number; file: string }> = existsSync(sessionsPath)
  ? JSON.parse(readFileSync(sessionsPath, "utf8"))
  : {};

const requestedSession = flag("--session");
let sessionId: string;
let sessionFile: string;
if (!requestedSession) {
  const idx = Object.keys(sessions).length + 1;
  sessionId = "00000000-0000-4000-8000-" + String(idx).padStart(12, "0");
  sessionFile = join(cwd, "pi-session-" + idx + ".jsonl");
  sessions[sessionId] = { turns: 0, file: sessionFile };
  writeFileSync(sessionsPath, JSON.stringify(sessions));
} else {
  const match = Object.entries(sessions).find(([id, data]) => id === requestedSession || data.file === requestedSession);
  if (match) {
    sessionId = match[0];
    sessionFile = match[1].file;
  } else {
    sessionId = "00000000-0000-4000-8000-ffffffffffff";
    sessionFile = join(cwd, "pi-session-missing.jsonl");
  }
}

let currentModel = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" };
let thinkingLevel = "medium";
let pendingSteerResolver: ((text: string) => void) | undefined;
let pendingAbortResolver: (() => void) | undefined;

function writeJson(payload: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const cmd = JSON.parse(line) as Record<string, unknown>;
  const id = cmd.id;
  const type = String(cmd.type ?? "");

  if (type === "get_available_models") {
    const models = process.env.FAKE_PI_NO_MODELS === "1"
      ? []
      : [
          { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          { provider: "openai", id: "gpt-5", name: "GPT-5" },
        ];
    writeJson({ type: "response", id, command: type, success: true, data: { models } });
    return;
  }

  if (type === "get_state") {
    writeJson({
      type: "response",
      id,
      command: type,
      success: true,
      data: { sessionId, sessionFile, thinkingLevel, model: currentModel },
    });
    return;
  }

  if (type === "set_model") {
    const provider = String(cmd.provider ?? "anthropic");
    const modelId = String(cmd.modelId ?? "claude-sonnet-4-5");
    currentModel = {
      provider,
      id: modelId,
      name: modelId === "gpt-5" ? "GPT-5" : "Claude Sonnet 4.5",
    };
    writeJson({ type: "response", id, command: type, success: true, data: currentModel });
    return;
  }

  if (type === "set_thinking_level") {
    thinkingLevel = String(cmd.level ?? "high");
    writeJson({ type: "response", id, command: type, success: true, data: { level: thinkingLevel } });
    return;
  }

  if (type === "steer") {
    const steeredText = String(cmd.message ?? "");
    writeJson({ type: "response", id, command: type, success: true });
    pendingSteerResolver?.(steeredText);
    pendingSteerResolver = undefined;
    return;
  }

  if (type === "abort") {
    writeJson({ type: "response", id, command: type, success: true });
    pendingAbortResolver?.();
    pendingAbortResolver = undefined;
    return;
  }

  if (type === "prompt") {
    const message = String(cmd.message ?? "");
    writeJson({ type: "response", id, command: type, success: true });

    void (async () => {
      if (message.includes("[wait-abort]")) {
        writeJson({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "Working until cancelled..." },
        });
        await new Promise<void>((resolve) => {
          pendingAbortResolver = resolve;
        });
        writeJson({
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
        });
        return;
      }

      let steeredNote = "";
      if (message.includes("[wait-steer]")) {
        writeJson({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "Waiting for guidance..." },
        });
        steeredNote = await new Promise<string>((resolve) => {
          pendingSteerResolver = resolve;
        });
      }

      const entry = sessions[sessionId] ?? { turns: 0, file: sessionFile };
      const turnCount = entry.turns + 1;
      sessions[sessionId] = { turns: turnCount, file: sessionFile };
      writeFileSync(sessionsPath, JSON.stringify(sessions));

      writeJson({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "Inspecting repository..." },
      });
      writeJson({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: join(cwd, "README.md") },
      });
      writeJson({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
      });
      const reply = "Turn " + turnCount + " on " + currentModel.provider + "/" + currentModel.id + " (" + thinkingLevel + ")" + (steeredNote ? " [steered: " + steeredNote + "]" : "") + " complete.";
      writeJson({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: reply },
      });
      const assistantMessage = {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: reply }],
        usage: { input: 120, cacheRead: 400, cacheWrite: 0, output: 30, totalTokens: 550 },
      };
      writeJson({ type: "message_end", message: assistantMessage });
      writeJson({ type: "agent_end", messages: [assistantMessage] });
    })();
  }
});
rl.on("close", () => process.exit(0));
`,
  "utf8",
);

const fakePiBin = join(root, process.platform === "win32" ? "pi.cmd" : "pi");
if (process.platform === "win32") {
  writeFileSync(fakePiBin, `@echo off\r\n"${process.execPath}" "${fakePiImpl}" %*\r\n`, "utf8");
} else {
  writeFileSync(fakePiBin, `#!/bin/sh\nexec "${process.execPath}" "${fakePiImpl}" "$@"\n`, "utf8");
  chmodSync(fakePiBin, 0o755);
}

const profile = ENGINE_PROFILES.find((p) => p.id === "pi-gpt5-high")!;
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };

describe("embedded __internal-pi-acp translator", () => {
  it("launches native executables directly and wraps Windows .cmd shims through ComSpec", () => {
    expect(piSpawnPlan("/usr/local/bin/pi", ["--mode", "rpc"], {}, "darwin")).toEqual({
      command: "/usr/local/bin/pi",
      args: ["--mode", "rpc"],
    });
    expect(piSpawnPlan("C:\\Program Files\\Pi\\pi.exe", ["--mode", "rpc"], {}, "win32")).toEqual({
      command: "C:\\Program Files\\Pi\\pi.exe",
      args: ["--mode", "rpc"],
    });
    const cmdPlan = piSpawnPlan(
      "C:\\Users\\Runner\\AppData\\Roaming\\npm\\pi.cmd",
      ["--mode", "rpc"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    );
    expect(cmdPlan.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(cmdPlan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(cmdPlan.args[3]).toContain("pi.cmd");
    expect(cmdPlan.windowsVerbatimArguments).toBe(true);
  });

  it("checks readiness, configures model and thinking, delivers live steering, cancels turns, and resumes conversations", async () => {
    const cwd = join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const command = [process.execPath, translatorScript];
    const baseEnv = { ...process.env, PI_EXECUTABLE: fakePiBin };

    const loggedOutEmptyModels = await checkAgentTool({
      adapter: ADAPTERS.pi!,
      profile,
      cwd,
      command,
      env: { ...baseEnv, FAKE_PI_NO_MODELS: "1" },
      which: () => fakePiBin,
    });
    expect(loggedOutEmptyModels.status).toBe("logged-out");

    const loggedOutStderr = await checkAgentTool({
      adapter: ADAPTERS.pi!,
      profile,
      cwd,
      command,
      env: { ...baseEnv, FAKE_PI_AUTH_ERROR: "1" },
      which: () => fakePiBin,
    });
    expect(loggedOutStderr.status).toBe("logged-out");

    const ready = await checkAgentTool({
      adapter: ADAPTERS.pi!,
      profile,
      cwd,
      command,
      env: baseEnv,
      which: () => fakePiBin,
    });
    expect(ready.status).toBe("ready");

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
      },
    });
    try {
      expect(run.liveInput).toBe(true);
      expect(run.settings).toEqual({
        model: "openai/gpt-5",
        modelName: "GPT-5",
        effort: "high",
      });

      let steerPromise: Promise<string> | undefined;
      run.onPromptStarted = () => {
        steerPromise = run.guide("Focus on README.md", "msg-1");
      };
      const first = await run.prompt("Summarize the repository [wait-steer]");
      expect(await steerPromise).toBe("current-turn");
      expect(first.text).toContain("Turn 1 on openai/gpt-5 (high) [steered: Focus on README.md] complete.");
      expect(first.report).toEqual({
        main: { total: 550, input: 120, cacheRead: 400, cacheWrite: 0, output: 30 },
      });
      expect(activities.some((line) => line.includes("README.md"))).toBe(true);

      let cancelTriggered = false;
      run.onPromptStarted = () => {
        cancelTriggered = true;
        setTimeout(() => {
          void run.cancel();
        }, 50);
      };
      const cancelled = await run.prompt("Long turn [wait-abort]");
      expect(cancelTriggered).toBe(true);
      expect(cancelled.stopReason).toBe("cancelled");

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
      expect(second.text).toContain("Turn 2 on openai/gpt-5 (high) complete.");
      expect(second.report).toEqual({
        main: { total: 550, input: 120, cacheRead: 400, cacheWrite: 0, output: 30 },
      });

      const recordedCalls = JSON.parse(readFileSync(join(cwd, ".fake-pi-calls.json"), "utf8")) as string[][];
      expect(recordedCalls.some((args) => args.includes("--mode") && args.includes("rpc"))).toBe(true);
      expect(recordedCalls.some((args) => args.includes("--session") && args.includes(sessionId))).toBe(true);
      expect(existsSync(join(cwd, ".fake-pi-sessions.json"))).toBe(true);
    } finally {
      await run.stop();
    }
  }, 25_000 * SLOW);
});
