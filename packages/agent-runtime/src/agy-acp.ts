#!/usr/bin/env bun
// Embedded Antigravity (`agy`) ACP protocol translator. Translates ACP JSON-RPC stdio
// directly to the coordinator's installed `agy` CLI (`--input-format stream-json
// --output-format stream-json`), sharing `~/.gemini/antigravity-cli` login and sessions.

import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  AGY_ACP_VERSION,
  agyEnv,
  buildConfigOptions,
  formatSessionUsageSection,
  handleStepUpdate,
  isAuthErrorText,
  optionValue,
  recordTurnTokens,
  resolveInstalledAgyCli,
  spawnAgy,
  stageMcpPluginDir,
  stopChild,
  type ActiveWorker,
  type AgyFrame,
  type AgyInitFrame,
  type AgySessionState,
  type PendingTurn,
} from "./agy-acp-protocol.js";

export { AGY_ACP_VERSION, resolveInstalledAgyCli } from "./agy-acp-protocol.js";

async function probeConversationInit(
  executable: string,
  cwd: string,
  requestedConversationId?: string,
): Promise<{ conversationId: string; model?: string }> {
  const args = [
    ...(requestedConversationId ? ["--conversation", requestedConversationId] : []),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];
  const child = spawnAgy(executable, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: agyEnv(),
    windowsHide: true,
  });
  let stderr = "";
  const rl = createInterface({ input: child.stdout! });
  try {
    const init = await new Promise<AgyInitFrame>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
        if (isAuthErrorText(stderr)) fail(acp.RequestError.authRequired());
      });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed) as AgyFrame;
          if (parsed.event === "init" && typeof parsed.conversation_id === "string" && !settled) {
            settled = true;
            resolve(parsed);
          }
        } catch {
          // Ignore non-JSON preamble lines.
        }
      });
      child.once("error", (error) => fail(acp.RequestError.internalError({ message: error.message })));
      child.once("exit", (code) => {
        if (settled) return;
        if (isAuthErrorText(stderr)) {
          fail(acp.RequestError.authRequired());
          return;
        }
        fail(
          acp.RequestError.internalError({
            message: stderr.trim() || `Antigravity exited before starting a conversation (exit ${code ?? "signal"}).`,
          }),
        );
      });
    });
    const conversationId = init.conversation_id!;
    if (
      requestedConversationId &&
      (conversationId !== requestedConversationId ||
        stderr.includes(`conversation "${requestedConversationId}" not found`))
    ) {
      throw acp.RequestError.invalidParams(`Conversation ${requestedConversationId} was not found.`);
    }
    return { conversationId, ...(init.init?.model ? { model: init.init.model } : {}) };
  } finally {
    rl.close();
    await stopChild(child);
  }
}

async function runUsageCommand(executable: string, session: AgySessionState): Promise<string> {
  const child = spawnAgy(executable, ["--print", "/usage"], {
    cwd: session.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: agyEnv(),
    windowsHide: true,
  });
  session.usageChild = child;
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-32_000);
  });
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stopChild(child);
      reject(acp.RequestError.internalError({ message: "Antigravity `/usage` timed out." }));
    }, 18_000);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (session.usageChild === child) delete session.usageChild;
      fn();
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
      if (isAuthErrorText(stderr)) {
        void stopChild(child);
        finish(() => reject(acp.RequestError.authRequired()));
      }
    });
    child.once("error", (error) => {
      finish(() => reject(acp.RequestError.internalError({ message: error.message })));
    });
    child.once("exit", (code) => {
      finish(() => {
        if (isAuthErrorText(stderr)) {
          reject(acp.RequestError.authRequired());
          return;
        }
        if (code !== 0) {
          reject(
            acp.RequestError.internalError({
              message: stderr.trim() || `Antigravity \`/usage\` failed (exit ${code ?? "signal"}).`,
            }),
          );
          return;
        }
        const quotaBlock = stdout.trim();
        const sessionBlock = formatSessionUsageSection(session.tokens, session.hasTokens);
        resolve(quotaBlock ? `${quotaBlock}\n\n${sessionBlock}` : sessionBlock);
      });
    });
  });
}

async function ensureWorker(
  executable: string,
  client: acp.AgentContext,
  session: AgySessionState,
): Promise<ActiveWorker> {
  const model = optionValue(session.options, "model");
  const effort = optionValue(session.options, "thinking_level");
  const mode = optionValue(session.options, "mode");
  const configKey = JSON.stringify([model, effort, mode]);
  if (session.worker && session.worker.configKey === configKey && session.worker.child.exitCode === null) {
    return session.worker;
  }
  if (session.worker) {
    const previous = session.worker;
    delete session.worker;
    await stopChild(previous.child);
  }
  const args = [
    "--conversation",
    session.sessionId,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(mode === "yolo" ? ["--dangerously-skip-permissions"] : []),
    ...(session.mcpDir ? ["--add-dir", session.mcpDir] : []),
  ];
  const child = spawnAgy(executable, args, {
    cwd: session.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: agyEnv(),
    windowsHide: true,
  });
  let stderr = "";
  const rl = createInterface({ input: child.stdout! });
  let streamChain = Promise.resolve();
  let initResolved = false;
  let resolveInit!: () => void;
  let rejectInit!: (error: unknown) => void;
  const initReady = new Promise<void>((resolve, reject) => {
    resolveInit = resolve;
    rejectInit = reject;
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    if (isAuthErrorText(stderr)) {
      const authErr = acp.RequestError.authRequired();
      if (!initResolved) {
        initResolved = true;
        rejectInit(authErr);
      }
      const turn = session.turn;
      if (turn) {
        delete session.turn;
        turn.reject(authErr);
      }
      void stopChild(child);
    }
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: AgyFrame;
    try {
      parsed = JSON.parse(trimmed) as AgyFrame;
    } catch {
      return;
    }
    if (parsed.event === "init") {
      if (!initResolved) {
        initResolved = true;
        resolveInit();
      }
      return;
    }
    streamChain = streamChain
      .then(async () => {
        const turn = session.turn;
        if (!turn) return;
        if (parsed.event === "step_update" && parsed.step_update) {
          await handleStepUpdate(client, session, turn, parsed.step_update);
          return;
        }
        if (parsed.event === "result") {
          delete session.turn;
          const res = parsed.result ?? {};
          recordTurnTokens(session, turn, res.usage);
          if (!turn.emittedText && typeof res.response === "string" && res.response.length > 0) {
            await client.notify(acp.methods.client.session.update, {
              sessionId: session.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: res.response } },
            });
          }
          if (turn.cancelled || res.status === "CANCELED" || res.finished_reason === "interrupted") {
            turn.resolve({ stopReason: "cancelled" });
            return;
          }
          if (res.status === "ERROR" || res.finished_reason === "error") {
            turn.reject(
              acp.RequestError.internalError({
                message: res.error || stderr.trim() || "Antigravity failed to complete the turn.",
              }),
            );
            return;
          }
          turn.resolve({ stopReason: "end_turn" });
        }
      })
      .catch((error) => {
        const turn = session.turn;
        if (turn) {
          delete session.turn;
          turn.reject(error);
        }
      });
  });

  const handleExit = (code: number | null) => {
    rl.close();
    if (session.worker?.child === child) delete session.worker;
    if (!initResolved) {
      initResolved = true;
      rejectInit(
        isAuthErrorText(stderr)
          ? acp.RequestError.authRequired()
          : acp.RequestError.internalError({
              message: stderr.trim() || `Antigravity stopped while starting (exit ${code ?? "signal"}).`,
            }),
      );
    }
    const turn = session.turn;
    if (turn) {
      delete session.turn;
      if (turn.cancelled) {
        turn.resolve({ stopReason: "cancelled" });
      } else {
        turn.reject(
          isAuthErrorText(stderr)
            ? acp.RequestError.authRequired()
            : acp.RequestError.internalError({
                message: stderr.trim() || `Antigravity stopped mid-turn (exit ${code ?? "signal"}).`,
              }),
        );
      }
    }
  };
  child.once("exit", handleExit);
  child.once("error", (error) => {
    if (!initResolved) {
      initResolved = true;
      rejectInit(acp.RequestError.internalError({ message: error.message }));
    }
    handleExit(null);
  });

  await initReady;
  const worker: ActiveWorker = { child, configKey, stderrTail: () => stderr.trim() };
  session.worker = worker;
  return worker;
}

export async function runAgyAcp(rawArgs: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    console.log(`petrina-agy-acp ${AGY_ACP_VERSION}`);
    return;
  }
  const executable = resolveInstalledAgyCli(process.env);
  const sessions = new Map<string, AgySessionState>();
  let shuttingDown = false;

  const cleanupAll = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all(
      [...sessions.values()].map(async (entry) => {
        await stopChild(entry.usageChild);
        await stopChild(entry.worker?.child);
        if (entry.mcpDir) await rm(entry.mcpDir, { recursive: true, force: true }).catch(() => undefined);
      }),
    );
  };

  const getSession = (sessionId: string): AgySessionState => {
    const current = sessions.get(sessionId);
    if (!current) throw acp.RequestError.invalidParams(`Unknown Antigravity session: ${sessionId}`);
    return current;
  };

  acp
    .agent({ name: "petrina-agy-acp" })
    .onRequest("initialize", () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "petrina-agy-acp", version: AGY_ACP_VERSION },
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    }))
    .onRequest("session/new", async (ctx) => {
      const probed = await probeConversationInit(executable, ctx.params.cwd);
      const mcpDir = await stageMcpPluginDir(ctx.params.mcpServers ?? []);
      const options = buildConfigOptions(probed.model);
      sessions.set(probed.conversationId, {
        sessionId: probed.conversationId,
        cwd: ctx.params.cwd,
        ...(mcpDir ? { mcpDir } : {}),
        options,
        tokens: { total: 0, prompt: 0, completion: 0, thinking: 0, cached: 0 },
        hasTokens: false,
        resumedFromDisk: false,
      });
      return { sessionId: probed.conversationId, configOptions: options };
    })
    .onRequest("session/resume", async (ctx) => {
      const probed = await probeConversationInit(executable, ctx.params.cwd, ctx.params.sessionId);
      const existing = sessions.get(ctx.params.sessionId);
      if (existing) {
        await stopChild(existing.worker?.child);
        if (existing.mcpDir) await rm(existing.mcpDir, { recursive: true, force: true }).catch(() => undefined);
      }
      const mcpDir = await stageMcpPluginDir(ctx.params.mcpServers ?? []);
      const options = buildConfigOptions(probed.model);
      sessions.set(ctx.params.sessionId, {
        sessionId: ctx.params.sessionId,
        cwd: ctx.params.cwd,
        ...(mcpDir ? { mcpDir } : {}),
        options,
        tokens: { total: 0, prompt: 0, completion: 0, thinking: 0, cached: 0 },
        hasTokens: false,
        resumedFromDisk: true,
      });
      return { configOptions: options };
    })
    .onRequest("session/set_config_option", async (ctx) => {
      const current = getSession(ctx.params.sessionId);
      const option = current.options.find((entry) => entry.id === ctx.params.configId);
      if (
        option?.type !== "select" ||
        typeof ctx.params.value !== "string" ||
        !option.options.some((choice) => "value" in choice && choice.value === ctx.params.value)
      ) {
        throw acp.RequestError.invalidParams(`Unsupported Antigravity setting: ${ctx.params.configId}`);
      }
      if (option.currentValue !== ctx.params.value) {
        option.currentValue = ctx.params.value;
        if (current.worker && !current.turn) {
          const previous = current.worker;
          delete current.worker;
          await stopChild(previous.child);
        }
      }
      return { configOptions: current.options };
    })
    .onRequest("session/prompt", async (ctx) => {
      const current = getSession(ctx.params.sessionId);
      const text = ctx.params.prompt.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      if (text.trim() === "/usage") {
        const reportText = await runUsageCommand(executable, current);
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: current.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reportText } },
        });
        return { stopReason: "end_turn" };
      }
      if (current.turn) {
        throw acp.RequestError.invalidParams("Antigravity already has a turn in progress on this session.");
      }
      const worker = await ensureWorker(executable, ctx.client, current);
      return new Promise<acp.PromptResponse>((resolve, reject) => {
        const turn: PendingTurn = {
          resolve,
          reject,
          stepUsages: new Map(),
          seenTools: new Set(),
          seenThinkingDelta: new Set(),
          emittedText: false,
          cancelled: false,
        };
        current.turn = turn;
        const payload = `${JSON.stringify({ event: "user", message: { content: text } })}\n`;
        worker.child.stdin?.write(payload, (error) => {
          if (error && current.turn === turn) {
            delete current.turn;
            reject(acp.RequestError.internalError({ message: error.message }));
          }
        });
      });
    })
    .onNotification("session/cancel", async (ctx) => {
      const current = sessions.get(ctx.params.sessionId);
      if (!current) return;
      if (current.usageChild) await stopChild(current.usageChild);
      if (current.turn) current.turn.cancelled = true;
      if (current.worker) {
        const active = current.worker;
        delete current.worker;
        await stopChild(active.child);
      }
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
      ),
    );

  const exitCleanly = () => {
    void cleanupAll().finally(() => process.exit(0));
  };
  process.stdin.on("end", exitCleanly);
  process.once("SIGTERM", exitCleanly);
  process.once("SIGINT", exitCleanly);
}

if (import.meta.main) await runAgyAcp();
