#!/usr/bin/env bun
// Embedded Pi (`pi --mode rpc`) ACP protocol translator. Translates ACP JSON-RPC stdio
// directly to the coordinator's installed `pi` CLI, sharing `~/.pi/agent` login, models and sessions.

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  buildPiConfigOptions,
  extractPiModels,
  handlePiEvent,
  PI_ACP_VERSION,
  resolveInstalledPiCli,
  splitPiModelValue,
  startPiWorker,
  type PiPendingTurn,
  type PiRpcEvent,
  type PiSessionState,
  type PiStateData,
} from "./pi-acp-protocol.js";

export { PI_ACP_VERSION, resolveInstalledPiCli } from "./pi-acp-protocol.js";

interface SteeringParams {
  sessionId: string;
  prompt?: { type?: string; text?: string }[];
}

function parseSteeringParams(value: unknown): SteeringParams {
  if (!value || typeof value !== "object") {
    throw acp.RequestError.invalidParams("Expected steering parameters.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || !record.sessionId) {
    throw acp.RequestError.invalidParams("Missing steering sessionId.");
  }
  return {
    sessionId: record.sessionId,
    ...(Array.isArray(record.prompt) ? { prompt: record.prompt as SteeringParams["prompt"] } : {}),
  };
}

export async function runPiAcp(rawArgs: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    console.log(`petrina-pi-acp ${PI_ACP_VERSION}`);
    return;
  }
  const executable = resolveInstalledPiCli(process.env);
  const sessions = new Map<string, PiSessionState>();
  const sessionFiles = new Map<string, string>();
  let shuttingDown = false;

  const cleanupAll = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all([...sessions.values()].map((entry) => entry.worker.close()));
    sessions.clear();
  };

  const getSession = (sessionId: string): PiSessionState => {
    const current = sessions.get(sessionId);
    if (!current) throw acp.RequestError.invalidParams(`Unknown Pi session: ${sessionId}`);
    return current;
  };

  const openPiSession = async (
    client: acp.AgentContext,
    cwd: string,
    requestedSessionId?: string,
  ): Promise<PiSessionState> => {
    let stateRef: PiSessionState | undefined;
    const sessionArg = requestedSessionId ? (sessionFiles.get(requestedSessionId) ?? requestedSessionId) : undefined;
    const worker = startPiWorker(
      executable,
      cwd,
      sessionArg,
      async (event: PiRpcEvent) => {
        if (stateRef) await handlePiEvent(client, stateRef, event);
      },
      (error: unknown) => {
        if (!stateRef) return;
        const turn = stateRef.turn;
        if (turn) {
          if (turn.abortTimer) clearTimeout(turn.abortTimer);
          delete stateRef.turn;
          if (turn.cancelled) {
            turn.resolve({ stopReason: "cancelled", ...(turn.hasUsage ? { usage: turn.usage } : {}) });
          } else {
            turn.reject(error);
          }
        }
      },
    );

    try {
      const [modelsRes, stateRes] = await Promise.all([
        worker.request({ type: "get_available_models" }),
        worker.request({ type: "get_state" }),
      ]);
      const availableModels = extractPiModels(modelsRes.data);
      if (availableModels.length === 0) {
        throw acp.RequestError.authRequired();
      }
      const stateData = (stateRes.data ?? {}) as PiStateData;
      const actualId =
        typeof stateData.sessionId === "string" && stateData.sessionId.trim()
          ? stateData.sessionId.trim()
          : (requestedSessionId ?? crypto.randomUUID());
      if (requestedSessionId && actualId !== requestedSessionId) {
        throw acp.RequestError.invalidParams(`Pi session ${requestedSessionId} was not found.`);
      }
      if (typeof stateData.sessionFile === "string" && stateData.sessionFile.trim()) {
        sessionFiles.set(actualId, stateData.sessionFile.trim());
      }
      const options = buildPiConfigOptions(availableModels, stateData);
      const created: PiSessionState = {
        sessionId: actualId,
        ...(typeof stateData.sessionFile === "string" ? { sessionFile: stateData.sessionFile } : {}),
        cwd,
        options,
        worker,
      };
      stateRef = created;
      return created;
    } catch (error) {
      await worker.close();
      throw error;
    }
  };

  acp
    .agent({ name: "petrina-pi-acp" })
    .onRequest("initialize", () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "petrina-pi-acp", version: PI_ACP_VERSION },
      agentCapabilities: { sessionCapabilities: { resume: {} } },
      _meta: { steering: { supported: true } },
    }))
    .onRequest("session/new", async (ctx) => {
      const created = await openPiSession(ctx.client, ctx.params.cwd);
      const existing = sessions.get(created.sessionId);
      if (existing) await existing.worker.close();
      sessions.set(created.sessionId, created);
      return { sessionId: created.sessionId, configOptions: created.options };
    })
    .onRequest("session/resume", async (ctx) => {
      const existing = sessions.get(ctx.params.sessionId);
      if (existing) {
        sessions.delete(ctx.params.sessionId);
        await existing.worker.close();
      }
      const resumed = await openPiSession(ctx.client, ctx.params.cwd, ctx.params.sessionId);
      sessions.set(resumed.sessionId, resumed);
      return { configOptions: resumed.options };
    })
    .onRequest("session/set_config_option", async (ctx) => {
      const current = getSession(ctx.params.sessionId);
      const option = current.options.find((entry) => entry.id === ctx.params.configId);
      if (
        option?.type !== "select" ||
        typeof ctx.params.value !== "string" ||
        !option.options.some((choice) => "value" in choice && choice.value === ctx.params.value)
      ) {
        throw acp.RequestError.invalidParams(`Unsupported Pi setting: ${ctx.params.configId}`);
      }
      if (option.currentValue !== ctx.params.value) {
        if (ctx.params.configId === "model") {
          const { provider, modelId } = splitPiModelValue(ctx.params.value);
          await current.worker.request({
            type: "set_model",
            ...(provider ? { provider } : {}),
            modelId,
          });
        } else if (ctx.params.configId === "thinking_level") {
          await current.worker.request({ type: "set_thinking_level", level: ctx.params.value });
        }
        option.currentValue = ctx.params.value;
      }
      return { configOptions: current.options };
    })
    .onRequest("session/prompt", async (ctx) => {
      const current = getSession(ctx.params.sessionId);
      if (current.turn) {
        throw acp.RequestError.invalidParams("Pi already has a turn in progress on this session.");
      }
      const text = ctx.params.prompt.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      return new Promise<acp.PromptResponse>((resolve, reject) => {
        const turn: PiPendingTurn = {
          resolve,
          reject,
          usage: {
            inputTokens: 0,
            cachedReadTokens: 0,
            cachedWriteTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
          hasUsage: false,
          seenTools: new Set(),
          emittedText: false,
          cancelled: false,
        };
        current.turn = turn;
        void current.worker.request({ type: "prompt", message: text }).catch((error) => {
          if (current.turn === turn) {
            if (turn.abortTimer) clearTimeout(turn.abortTimer);
            delete current.turn;
            reject(error);
          }
        });
      });
    })
    .onRequest("_session/steering", parseSteeringParams, async (ctx) => {
      const current = sessions.get(ctx.params.sessionId);
      if (!current || !current.turn) return { outcome: "rejected" };
      const text = (ctx.params.prompt ?? [])
        .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
        .join("\n")
        .trim();
      if (!text) return { outcome: "rejected" };
      try {
        await current.worker.request({ type: "steer", message: text }, 8_000);
        return { outcome: "injected" };
      } catch {
        return { outcome: "rejected" };
      }
    })
    .onNotification("session/cancel", async (ctx) => {
      const current = sessions.get(ctx.params.sessionId);
      if (!current || !current.turn) return;
      const turn = current.turn;
      turn.cancelled = true;
      turn.abortTimer = setTimeout(() => {
        if (current.turn === turn) {
          void current.worker.close();
        }
      }, 1_500);
      await current.worker.request({ type: "abort" }, 1_200).catch(async () => {
        if (current.turn === turn) {
          await current.worker.close();
        }
      });
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

if (import.meta.main) await runPiAcp();
