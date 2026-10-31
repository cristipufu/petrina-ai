// Antigravity (`agy`) NDJSON stream-json frame normalization, MCP plugin staging, and ACP session state helpers.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { processHost } from "@petrina/platform/process-host";

export const AGY_ACP_VERSION = "0.1.0";

const KNOWN_MODELS: readonly { value: string; name: string }[] = [
  { value: "gemini-4-argon", name: "Gemini 4 Argon" },
  { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
];

const KNOWN_EFFORTS = ["low", "medium", "high"] as const;
const KNOWN_MODES = ["default", "yolo"] as const;

export function resolveInstalledAgyCli(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ANTIGRAVITY_EXECUTABLE?.trim() || env.AGY_EXECUTABLE?.trim();
  if (configured) return configured;
  const found = Bun.which("agy", { PATH: env.PATH ?? "" });
  if (!found) {
    throw new Error("Antigravity is not installed: no `agy` on PATH.");
  }
  return found;
}

export interface RawAgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyInitFrame {
  event: "init";
  conversation_id?: string;
  init?: { model?: string; cwd?: string; permission_mode?: string };
}

export interface AgyStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  text?: string;
  thinking_delta?: string;
  thinking?: string;
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: string;
    error?: { type?: string; message?: string };
  };
  usage?: RawAgyUsage;
}

export interface AgyStepFrame {
  event: "step_update";
  step_update?: AgyStepUpdate;
}

export interface AgyResultFrame {
  event: "result";
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    usage?: RawAgyUsage;
    finished_reason?: string;
  };
}

export type AgyFrame = AgyInitFrame | AgyStepFrame | AgyResultFrame;

export interface NormalizedStepTokens {
  total: number;
  prompt: number;
  completion: number;
  thinking: number;
  cached: number;
}

export interface PendingTurn {
  resolve: (response: acp.PromptResponse) => void;
  reject: (error: unknown) => void;
  stepUsages: Map<number, NormalizedStepTokens>;
  seenTools: Set<string>;
  seenThinkingDelta: Set<number>;
  emittedText: boolean;
  cancelled: boolean;
}

export interface ActiveWorker {
  child: ChildProcess;
  configKey: string;
  stderrTail: () => string;
}

export interface AgySessionState {
  sessionId: string;
  cwd: string;
  mcpDir?: string;
  options: acp.SessionConfigOption[];
  tokens: NormalizedStepTokens;
  hasTokens: boolean;
  resumedFromDisk: boolean;
  lastResultTokens?: NormalizedStepTokens;
  worker?: ActiveWorker;
  turn?: PendingTurn;
  usageChild?: ChildProcess;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function normalizeUsage(raw: RawAgyUsage | undefined): NormalizedStepTokens {
  const input = safeCount(raw?.input_tokens);
  const completion = safeCount(raw?.output_tokens);
  const thinking = safeCount(raw?.thinking_tokens);
  const cached = safeCount(raw?.cache_read_tokens);
  const reportedTotal = safeCount(raw?.total_tokens);
  // In agy's internal Usage struct, input_tokens is uncached input and cache_read_tokens is cached input.
  // Keep prompt = uncached + cached so antigravityReading / antigravityTurnReport split input vs cacheRead cleanly.
  const prompt =
    cached > 0 && (input < cached || reportedTotal === 0 || reportedTotal === input + cached + completion + thinking)
      ? input + cached
      : input;
  return {
    total: prompt + completion + thinking,
    prompt,
    completion,
    thinking,
    cached: Math.min(cached, prompt),
  };
}

export function formatSessionUsageSection(tokens: NormalizedStepTokens, hasTokens: boolean): string {
  if (!hasTokens) {
    return "### Session Usage\n- **Session total:** data not available yet";
  }
  return `### Session Usage\n- **Session total:** ${tokens.total} tokens (prompt: ${tokens.prompt}, completion: ${tokens.completion}, thinking: ${tokens.thinking}, cached: ${tokens.cached})`;
}

export function agyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, BROWSER: "none" };
}

export function isAuthErrorText(text: string): boolean {
  return /Authentication required\b/i.test(text);
}

const WIN_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export function agySpawnPlan(
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

export function spawnAgy(executable: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const plan = agySpawnPlan(executable, args, options.env ?? process.env);
  return spawn(plan.command, plan.args, {
    ...options,
    ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

export async function stopChild(child: ChildProcess | undefined): Promise<void> {
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

export async function stageMcpPluginDir(mcpServers: readonly acp.McpServer[]): Promise<string | undefined> {
  if (!mcpServers.length) return undefined;
  const servers: Record<string, Record<string, unknown>> = {};
  for (const server of mcpServers) {
    if ("url" in server && typeof server.url === "string") {
      const headers =
        Array.isArray(server.headers) && server.headers.length
          ? Object.fromEntries(server.headers.map((entry) => [entry.name, entry.value]))
          : undefined;
      servers[server.name] = {
        type: "http",
        url: server.url,
        ...(headers ? { headers } : {}),
      };
    } else if ("command" in server && typeof server.command === "string") {
      const env =
        Array.isArray(server.env) && server.env.length
          ? Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]))
          : undefined;
      servers[server.name] = {
        command: server.command,
        args: server.args ?? [],
        ...(env ? { env } : {}),
      };
    }
  }
  if (!Object.keys(servers).length) return undefined;
  const root = await mkdtemp(join(tmpdir(), "petrina-agy-mcp-"));
  const pluginDir = join(root, ".agents", "plugins", "petrina");
  await mkdir(pluginDir, { recursive: true, mode: 0o700 });
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "petrina", version: AGY_ACP_VERSION }), {
    mode: 0o600,
  });
  await writeFile(join(pluginDir, "mcp_config.json"), JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return root;
}

export function buildConfigOptions(initialModel?: string): acp.SessionConfigOption[] {
  const models = [...KNOWN_MODELS];
  if (initialModel && !models.some((entry) => entry.value === initialModel)) {
    models.push({ value: initialModel, name: initialModel });
  }
  const currentModel = models.some((entry) => entry.value === initialModel) ? initialModel! : models[0]!.value;
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
      currentValue: "medium",
      options: KNOWN_EFFORTS.map((value) => ({ value, name: value })),
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      currentValue: "default",
      options: KNOWN_MODES.map((value) => ({ value, name: value })),
    },
  ];
}

export function optionValue(options: readonly acp.SessionConfigOption[], id: string): string | undefined {
  const found = options.find((entry) => entry.id === id);
  return found?.type === "select" && typeof found.currentValue === "string" ? found.currentValue : undefined;
}

export function recordTurnTokens(
  session: AgySessionState,
  turn: PendingTurn,
  resultUsage: RawAgyUsage | undefined,
): void {
  if (turn.stepUsages.size > 0) {
    for (const usage of turn.stepUsages.values()) {
      session.tokens.total += usage.total;
      session.tokens.prompt += usage.prompt;
      session.tokens.completion += usage.completion;
      session.tokens.thinking += usage.thinking;
      session.tokens.cached += usage.cached;
    }
    session.hasTokens = true;
    if (resultUsage) session.lastResultTokens = normalizeUsage(resultUsage);
    session.resumedFromDisk = false;
    return;
  }
  if (!resultUsage) return;
  const normalized = normalizeUsage(resultUsage);
  if (normalized.total === 0 && !session.hasTokens) return;
  if (!session.resumedFromDisk || session.lastResultTokens) {
    const base = session.lastResultTokens ?? { total: 0, prompt: 0, completion: 0, thinking: 0, cached: 0 };
    if (
      normalized.total >= base.total &&
      normalized.prompt >= base.prompt &&
      normalized.completion >= base.completion &&
      normalized.thinking >= base.thinking &&
      normalized.cached >= base.cached
    ) {
      session.tokens.total += normalized.total - base.total;
      session.tokens.prompt += normalized.prompt - base.prompt;
      session.tokens.completion += normalized.completion - base.completion;
      session.tokens.thinking += normalized.thinking - base.thinking;
      session.tokens.cached += normalized.cached - base.cached;
      session.hasTokens = true;
    }
  }
  session.lastResultTokens = normalized;
  session.resumedFromDisk = false;
}

function classifyToolKind(toolName: string): acp.ToolKind {
  const normalized = toolName.trim().toLowerCase();
  if (["view_file", "read_file", "list_dir", "read_resource", "list_resources"].includes(normalized)) return "read";
  if (
    [
      "write_to_file",
      "write_file",
      "replace_file_content",
      "multi_replace_file_content",
      "edit_file",
      "sed_file",
      "notebook_edit",
    ].includes(normalized)
  ) {
    return "edit";
  }
  if (normalized === "delete_knowledge") return "delete";
  if (["grep_search", "find_by_name"].includes(normalized)) return "search";
  if (["run_command", "send_command_input", "command_status", "notebook_execution", "run_workflow"].includes(normalized)) {
    return "execute";
  }
  if (["search_web", "read_url_content"].includes(normalized)) return "fetch";
  return "other";
}

function extractLocation(parameters: Record<string, unknown> | undefined): { path: string }[] | undefined {
  if (!parameters) return undefined;
  const candidate =
    parameters.Path ??
    parameters.TargetFile ??
    parameters.SearchPath ??
    parameters.DirectoryPath ??
    parameters.target_file ??
    parameters.file_path ??
    parameters.path ??
    parameters.filePath;
  return typeof candidate === "string" && candidate.trim() ? [{ path: candidate }] : undefined;
}

function extractBrowserMeta(
  toolName: string,
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const effective =
    toolName === "call_mcp_tool" && typeof parameters?.ToolName === "string" ? parameters.ToolName : toolName;
  const match = /(?:^|[_:.])browser_([a-z_]+)$/i.exec(effective.trim());
  return match ? { mcp: { tool: `browser_${match[1]!.toLowerCase()}` } } : undefined;
}

export async function handleStepUpdate(
  client: acp.AgentContext,
  session: AgySessionState,
  turn: PendingTurn,
  step: AgyStepUpdate,
): Promise<void> {
  const stepIndex = typeof step.step_index === "number" ? step.step_index : 0;
  if (step.usage) {
    const normalized = normalizeUsage(step.usage);
    if (normalized.total > 0) turn.stepUsages.set(stepIndex, normalized);
  }
  switch (step.step_type) {
    case "thinking": {
      if (typeof step.thinking_delta === "string" && step.thinking_delta.length > 0) {
        turn.seenThinkingDelta.add(stepIndex);
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.thinking_delta } },
        });
      } else if (
        step.state === "DONE" &&
        !turn.seenThinkingDelta.has(stepIndex) &&
        typeof step.thinking === "string" &&
        step.thinking.length > 0
      ) {
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.thinking } },
        });
      }
      break;
    }
    case "agent_response": {
      const delta = typeof step.text_delta === "string" && step.text_delta.length > 0 ? step.text_delta : undefined;
      if (delta) {
        turn.emittedText = true;
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: `agy-step-${stepIndex}`,
            content: { type: "text", text: delta },
          } as acp.SessionUpdate,
        });
      }
      break;
    }
    case "tool": {
      const toolCallId = `agy-tool-${stepIndex}`;
      const toolName = step.tool_info?.name ?? step.tool_name ?? "tool";
      const rawInput = step.tool_info?.parameters;
      const locations = extractLocation(rawInput);
      const browserMeta = extractBrowserMeta(toolName, rawInput);
      const status: acp.ToolCallStatus =
        step.state === "ERROR" ? "failed" : step.state === "DONE" ? "completed" : "in_progress";
      if (!turn.seenTools.has(toolCallId)) {
        turn.seenTools.add(toolCallId);
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName === "invoke_subagent" ? "spawnAgent" : toolName,
            kind: classifyToolKind(toolName),
            status,
            ...(rawInput ? { rawInput } : {}),
            ...(locations ? { locations } : {}),
            ...(browserMeta ? { _meta: browserMeta } : {}),
          },
        });
      } else {
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status,
            ...(rawInput ? { rawInput } : {}),
            ...(locations ? { locations } : {}),
          },
        });
      }
      break;
    }
    default:
      break;
  }
}
