// Pi (`pi --mode rpc`) JSONL protocol helpers, process lifecycle, and ACP session update translation.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createInterface } from "node:readline";
import { win32 } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { processHost } from "@petrina/platform/process-host";

export const PI_ACP_VERSION = "0.1.0";

const KNOWN_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export function resolveInstalledPiCli(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_EXECUTABLE?.trim();
  if (configured) return configured;
  const found = Bun.which("pi", { PATH: env.PATH ?? "" });
  if (!found) {
    throw new Error("Pi is not installed: no `pi` on PATH.");
  }
  return found;
}

export function isPiAuthErrorText(text: string): boolean {
  return /\b(?:no api key|missing api key|authentication required|not logged in|configure a provider|invalid api key)\b/i.test(
    text,
  );
}

const WIN_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export function piSpawnPlan(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(executable)) {
    return { command: executable, args: [...args] };
  }
  const doubleEscape = /[\\/]node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(executable);
  const escapedCommand = win32.normalize(executable).replace(WIN_CMD_META_CHARS, "^$1");
  const escapedArgs = args.map((arg) => {
    let quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
    quoted = quoted.replace(WIN_CMD_META_CHARS, "^$1");
    return doubleEscape ? quoted.replace(WIN_CMD_META_CHARS, "^$1") : quoted;
  });
  const shellCommand = [escapedCommand, ...escapedArgs].join(" ");
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

export function spawnPi(executable: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const plan = piSpawnPlan(executable, args, options.env ?? process.env);
  return spawn(plan.command, plan.args, {
    ...options,
    ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

export async function stopPiChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  try {
    child.stdin?.end();
  } catch {
    // Ignore closed stdin.
  }
  if (processHost.stopTree && child.pid) {
    const cleanExit = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    if (cleanExit) return;
    await processHost.stopTree(child.pid, 4_000);
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
  }, 800);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

export interface PiModelRecord {
  provider?: string;
  id?: string;
  name?: string;
}

export interface PiStateData {
  sessionId?: string;
  sessionFile?: string;
  thinkingLevel?: string;
  model?: PiModelRecord;
}

export interface PiUsageCounts {
  inputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface PiPendingTurn {
  resolve: (response: acp.PromptResponse) => void;
  reject: (error: unknown) => void;
  usage: PiUsageCounts;
  hasUsage: boolean;
  seenTools: Set<string>;
  emittedText: boolean;
  cancelled: boolean;
  abortTimer?: ReturnType<typeof setTimeout>;
}

export interface PiRpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface PiRpcEvent {
  type: string;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
  message?: Record<string, unknown>;
  messages?: Record<string, unknown>[];
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
}

export interface PiWorker {
  child: ChildProcess;
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<PiRpcResponse>;
  close(): Promise<void>;
}

export interface PiSessionState {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  options: acp.SessionConfigOption[];
  worker: PiWorker;
  turn?: PiPendingTurn;
}

export function formatPiModelValue(model: PiModelRecord): string | undefined {
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) return undefined;
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  return provider && !id.includes("/") ? `${provider}/${id}` : id;
}

export function splitPiModelValue(value: string): { provider?: string; modelId: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return { modelId: value };
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function extractPiModels(data: Record<string, unknown> | undefined): { value: string; name: string }[] {
  const rawList = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  const seen = new Set<string>();
  const models: { value: string; name: string }[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const record = item as PiModelRecord;
    const value = formatPiModelValue(record);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = typeof record.name === "string" && record.name.trim() ? record.name.trim() : (record.id ?? value);
    models.push({ value, name: label });
  }
  return models;
}

export function buildPiConfigOptions(
  availableModels: readonly { value: string; name: string }[],
  state: PiStateData,
): acp.SessionConfigOption[] {
  const models = [...availableModels];
  const stateModelValue = state.model ? formatPiModelValue(state.model) : undefined;
  if (stateModelValue && !models.some((entry) => entry.value === stateModelValue)) {
    const label =
      typeof state.model?.name === "string" && state.model.name.trim() ? state.model.name.trim() : stateModelValue;
    models.unshift({ value: stateModelValue, name: label });
  }
  const currentModel =
    stateModelValue && models.some((entry) => entry.value === stateModelValue)
      ? stateModelValue
      : (models[0]?.value ?? "anthropic/claude-sonnet-4-5");
  const currentThinking =
    typeof state.thinkingLevel === "string" && (KNOWN_EFFORTS as readonly string[]).includes(state.thinkingLevel)
      ? state.thinkingLevel
      : "high";
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: currentModel,
      options: models.map((entry) => ({ value: entry.value, name: entry.name })),
    },
    {
      type: "select",
      id: "thinking_level",
      name: "Thinking",
      currentValue: currentThinking,
      options: KNOWN_EFFORTS.map((value) => ({ value, name: value })),
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      currentValue: "auto",
      options: [{ value: "auto", name: "auto" }],
    },
  ];
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function accumulateAssistantUsage(turn: PiPendingTurn, message: Record<string, unknown> | undefined): void {
  if (!message || message.role !== "assistant") return;
  const raw = message.usage;
  if (!raw || typeof raw !== "object") return;
  const usage = raw as Record<string, unknown>;
  const input = safeCount(usage.input ?? usage.inputTokens);
  const cacheRead = safeCount(usage.cacheRead ?? usage.cachedReadTokens);
  const cacheWrite = safeCount(usage.cacheWrite ?? usage.cachedWriteTokens);
  const output = safeCount(usage.output ?? usage.outputTokens);
  const reportedTotal = safeCount(usage.totalTokens ?? usage.total);
  const total = reportedTotal > 0 ? reportedTotal : input + cacheRead + cacheWrite + output;
  if (total === 0 && input === 0 && output === 0) return;
  turn.usage.inputTokens += input;
  turn.usage.cachedReadTokens += cacheRead;
  turn.usage.cachedWriteTokens += cacheWrite;
  turn.usage.outputTokens += output;
  turn.usage.totalTokens += total;
  turn.hasUsage = true;
}

function classifyPiToolKind(toolName: string): acp.ToolKind {
  const normalized = toolName.trim().toLowerCase();
  if (["read", "read_file", "ls", "list_dir"].includes(normalized)) return "read";
  if (["write", "write_file", "edit", "edit_file"].includes(normalized)) return "edit";
  if (["grep", "find", "rg", "search"].includes(normalized)) return "search";
  if (["bash", "sh", "exec", "run_command"].includes(normalized)) return "execute";
  if (["fetch", "web_search", "curl"].includes(normalized)) return "fetch";
  return "other";
}

function extractPiLocations(args: Record<string, unknown> | undefined): { path: string }[] | undefined {
  if (!args) return undefined;
  const candidate = args.path ?? args.file_path ?? args.filePath ?? args.Path;
  return typeof candidate === "string" && candidate.trim() ? [{ path: candidate }] : undefined;
}

export async function handlePiEvent(
  client: acp.AgentContext,
  session: PiSessionState,
  event: PiRpcEvent,
): Promise<void> {
  const turn = session.turn;
  if (!turn) return;
  switch (event.type) {
    case "message_update": {
      const sub = event.assistantMessageEvent;
      if (!sub || typeof sub.delta !== "string" || sub.delta.length === 0) return;
      if (sub.type === "text_delta") {
        turn.emittedText = true;
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: sub.delta } },
        });
      } else if (sub.type === "thinking_delta") {
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: sub.delta } },
        });
      }
      return;
    }
    case "tool_execution_start": {
      const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : "pi-tool";
      const toolName = typeof event.toolName === "string" && event.toolName ? event.toolName : "tool";
      const locations = extractPiLocations(event.args);
      turn.seenTools.add(toolCallId);
      await client.notify(acp.methods.client.session.update, {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolName,
          kind: classifyPiToolKind(toolName),
          status: "in_progress",
          ...(event.args ? { rawInput: event.args } : {}),
          ...(locations ? { locations } : {}),
        },
      });
      return;
    }
    case "tool_execution_end": {
      const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : "pi-tool";
      const status: acp.ToolCallStatus = event.isError ? "failed" : "completed";
      if (!turn.seenTools.has(toolCallId)) {
        turn.seenTools.add(toolCallId);
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: typeof event.toolName === "string" && event.toolName ? event.toolName : "tool",
            status,
          },
        });
      } else {
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId, status },
        });
      }
      return;
    }
    case "message_end": {
      accumulateAssistantUsage(turn, event.message);
      return;
    }
    case "agent_end": {
      if (turn.abortTimer) clearTimeout(turn.abortTimer);
      delete session.turn;
      if (!turn.hasUsage && Array.isArray(event.messages)) {
        for (const msg of event.messages) accumulateAssistantUsage(turn, msg);
      }
      const lastAssistant = Array.isArray(event.messages)
        ? [...event.messages].reverse().find((msg) => msg?.role === "assistant")
        : undefined;
      if (!turn.emittedText && lastAssistant && Array.isArray(lastAssistant.content)) {
        const text = (lastAssistant.content as Record<string, unknown>[])
          .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
          .join("");
        if (text) {
          turn.emittedText = true;
          await client.notify(acp.methods.client.session.update, {
            sessionId: session.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        }
      }
      if (turn.cancelled || lastAssistant?.stopReason === "aborted") {
        turn.resolve({ stopReason: "cancelled", ...(turn.hasUsage ? { usage: turn.usage } : {}) });
        return;
      }
      const errorMessage = typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage.trim() : "";
      if (lastAssistant?.stopReason === "error" || (errorMessage && !turn.emittedText)) {
        const message = errorMessage || "Pi failed to complete the turn.";
        turn.reject(
          isPiAuthErrorText(message) ? acp.RequestError.authRequired() : acp.RequestError.internalError({ message }),
        );
        return;
      }
      turn.resolve({ stopReason: "end_turn", ...(turn.hasUsage ? { usage: turn.usage } : {}) });
      return;
    }
    default:
      return;
  }
}

export function startPiWorker(
  executable: string,
  cwd: string,
  sessionArg: string | undefined,
  onEvent: (event: PiRpcEvent) => Promise<void>,
  onExit: (error: unknown) => void,
): PiWorker {
  const args = ["--mode", "rpc", ...(sessionArg ? ["--session", sessionArg] : [])];
  const child = spawnPi(executable, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
    windowsHide: true,
  });
  let stderr = "";
  let seq = 0;
  let closed = false;
  let streamChain = Promise.resolve();
  const pending = new Map<
    string,
    { resolve: (res: PiRpcResponse) => void; reject: (err: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const failAll = (error: unknown) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    if (isPiAuthErrorText(stderr)) {
      const authErr = acp.RequestError.authRequired();
      failAll(authErr);
      onExit(authErr);
      void stopPiChild(child);
    }
  });

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (parsed.type === "response" && typeof parsed.id === "string") {
      const waiter = pending.get(parsed.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(parsed.id);
        const response = parsed as unknown as PiRpcResponse;
        if (response.success === false) {
          const message = response.error || stderr.trim() || `Pi rejected ${response.command ?? "request"}.`;
          waiter.reject(
            isPiAuthErrorText(message)
              ? acp.RequestError.authRequired()
              : acp.RequestError.internalError({ message }),
          );
        } else {
          waiter.resolve(response);
        }
      }
      return;
    }
    if (typeof parsed.type === "string") {
      streamChain = streamChain.then(() => onEvent(parsed as unknown as PiRpcEvent)).catch(() => undefined);
    }
  });

  const handleExit = (code: number | null) => {
    rl.close();
    if (closed) return;
    closed = true;
    const error = isPiAuthErrorText(stderr)
      ? acp.RequestError.authRequired()
      : acp.RequestError.internalError({
          message: stderr.trim() || `Pi exited unexpectedly (exit ${code ?? "signal"}).`,
        });
    failAll(error);
    onExit(error);
  };
  child.once("exit", handleExit);
  child.once("error", (err) => {
    rl.close();
    if (closed) return;
    closed = true;
    const error = acp.RequestError.internalError({ message: err.message });
    failAll(error);
    onExit(error);
  });

  return {
    child,
    request(command: Record<string, unknown>, timeoutMs = 20_000): Promise<PiRpcResponse> {
      if (closed || child.exitCode !== null || child.signalCode !== null) {
        return Promise.reject(
          isPiAuthErrorText(stderr)
            ? acp.RequestError.authRequired()
            : acp.RequestError.internalError({ message: stderr.trim() || "Pi RPC process is not running." }),
        );
      }
      const id = `pi-req-${++seq}`;
      return new Promise<PiRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(acp.RequestError.internalError({ message: `Pi RPC ${String(command.type ?? "")} timed out.` }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`, (err) => {
          if (err && pending.has(id)) {
            clearTimeout(timer);
            pending.delete(id);
            reject(acp.RequestError.internalError({ message: err.message }));
          }
        });
      });
    },
    async close(): Promise<void> {
      closed = true;
      rl.close();
      failAll(acp.RequestError.internalError({ message: "Pi session closed." }));
      await stopPiChild(child);
    },
  };
}
