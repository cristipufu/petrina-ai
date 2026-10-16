// One agent session over ACP: start the tool's adapter, open a session in the task's
// worktree, pin model, effort and mode, then send turns and report what happens.

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@petrina/core";
import { adapterEntry, ADAPTERS } from "./tools.js";

export interface PermissionInfo {
  title: string;
  kind: string;
  /** The command, when the agent wants to run one. */
  command?: string;
  /** Paths the tool call touches. */
  paths: string[];
}

export interface RunCallbacks {
  /** A plain-language line about what the agent is doing. */
  onActivity(text: string): void;
  /** The step of its own plan the agent is on. */
  onPlanStep(text: string): void;
  onPermission(info: PermissionInfo): Promise<"allow" | "deny">;
  onLog?(text: string): void;
}

export interface TurnResult {
  stopReason: string;
  text: string;
  tokens?: number;
}

const humanizeCommand = (command: string): string => {
  const c = command.toLowerCase();
  if (/\b(vitest|jest|pytest|cargo test|go test|bun test|npm test|bun run test|npm run test|playwright)\b/.test(c)) return "Running the tests";
  if (/\b(tsc|typecheck|cargo check|cargo build|vite build|bun run build|npm run build)\b/.test(c)) return "Checking that it builds";
  if (/\b(npm (install|i)|bun (add|install)|pnpm (add|install)|yarn add|pip install|cargo add)\b/.test(c)) return "Installing packages";
  if (/\bgit (push)\b/.test(c)) return "Pushing to GitHub";
  if (/\bgh (pr|release)\b/.test(c)) return "Talking to GitHub";
  if (/\bgit\b/.test(c)) return "Looking at the history";
  if (/\b(rg|grep|find|ls|cat|sed -n|head|tail)\b/.test(c)) return "Reading the code";
  return "Running a command";
};

const baseName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

function describeTool(update: { title?: string | null; kind?: string | null; locations?: { path: string }[] | null; rawInput?: unknown }): string {
  const kind = update.kind ?? "other";
  const command = commandOf(update.rawInput);
  const file = update.locations?.[0]?.path;
  switch (kind) {
    case "read":
      return file ? `Reading ${baseName(file)}` : "Reading the code";
    case "search":
      return "Searching the code";
    case "edit":
      return file ? `Editing ${baseName(file)}` : "Editing files";
    case "delete":
      return file ? `Removing ${baseName(file)}` : "Removing files";
    case "move":
      return "Moving files";
    case "execute":
      return command ? humanizeCommand(command) : "Running a command";
    case "think":
      return "Thinking it through";
    case "fetch":
      return "Looking something up";
    default:
      return update.title ? update.title.slice(0, 80) : "Working";
  }
}

function commandOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const input = rawInput as { command?: unknown; cmd?: unknown };
  const value = input.command ?? input.cmd;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((part) => typeof part === "string").join(" ");
  return undefined;
}

export class AgentRun {
  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: acp.ClientSideConnection,
    private readonly sessionId: string,
    private readonly state: { text: string; lastActivity: string },
  ) {}

  static async start(options: { profile: AgentProfile; cwd: string; readOnly: boolean; callbacks: RunCallbacks; signal: AbortSignal; command?: readonly string[]; env?: NodeJS.ProcessEnv }): Promise<AgentRun> {
    const { profile, cwd, readOnly, callbacks, signal } = options;
    const adapter = ADAPTERS[profile.toolId];
    if (!adapter) throw new Error(`No adapter for tool ${profile.toolId}`);

    const [program, ...args] = options.command ?? ["node", adapterEntry(adapter)];
    const child = spawn(program!, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env });
    child.stderr?.on("data", (chunk: Buffer) => callbacks.onLog?.(chunk.toString()));
    const killed = new Promise<never>((_, reject) => {
      child.once("exit", (code) => reject(new Error(`${adapter.name} stopped (exit ${code ?? "signal"})`)));
      child.once("error", (error) => reject(error));
    });
    killed.catch(() => undefined);
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });

    const state = { text: "", lastActivity: "" };
    const titles = new Map<string, { title?: string | null; kind?: string | null; locations?: { path: string }[] | null; rawInput?: unknown }>();
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);

    const connection = new acp.ClientSideConnection(
      () => ({
        async requestPermission(params) {
          const call = params.toolCall;
          const known = titles.get(call.toolCallId) ?? {};
          const merged = { ...known, ...call };
          const info: PermissionInfo = {
            title: describeTool(merged),
            kind: merged.kind ?? "other",
            ...(commandOf(merged.rawInput) ? { command: commandOf(merged.rawInput)! } : {}),
            paths: (merged.locations ?? []).map((location) => location.path),
          };
          const decision = await callbacks.onPermission(info);
          const wanted = decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
          const option = params.options.find((entry) => wanted.includes(entry.kind)) ?? params.options.find((entry) => (decision === "allow" ? entry.kind.startsWith("allow") : entry.kind.startsWith("reject")));
          if (!option) return { outcome: { outcome: "cancelled" } };
          return { outcome: { outcome: "selected", optionId: option.optionId } };
        },
        async sessionUpdate(params) {
          const update = params.update;
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              if (update.content.type === "text") state.text += update.content.text;
              break;
            case "tool_call": {
              titles.set(update.toolCallId, update);
              const line = describeTool(update);
              if (line !== state.lastActivity) {
                state.lastActivity = line;
                callbacks.onActivity(line);
              }
              break;
            }
            case "tool_call_update": {
              const known = titles.get(update.toolCallId) ?? {};
              titles.set(update.toolCallId, { ...known, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null && value !== undefined)) });
              break;
            }
            case "plan": {
              const current = update.entries.find((entry) => entry.status === "in_progress");
              if (current) callbacks.onPlanStep(current.content);
              break;
            }
            default:
              break;
          }
        },
      }),
      stream,
    );

    const ready = (async () => {
      await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      const session = await connection.newSession({ cwd, mcpServers: [] });
      const options = (session as { configOptions?: { id: string; options?: { value: string }[] }[] }).configOptions ?? [];
      const set = async (configId: string, value: string | undefined) => {
        if (!value) return;
        const option = options.find((entry) => entry.id === configId);
        if (!option || !option.options?.some((entry) => entry.value === value)) return;
        await connection.setSessionConfigOption({ sessionId: session.sessionId, configId, value });
      };
      await set(adapter.options.model, profile.modelId);
      await set(adapter.options.effort, profile.effort);
      await set(adapter.options.mode, readOnly ? adapter.modes.readOnly : adapter.modes.edit);
      return session.sessionId;
    })();

    const sessionId = await Promise.race([ready, killed]);
    return new AgentRun(child, connection, sessionId, state);
  }

  /** Send one turn and wait for it to end. Returns everything the agent said in it. */
  async prompt(text: string): Promise<TurnResult> {
    this.state.text = "";
    const exited = new Promise<never>((_, reject) => this.child.once("exit", (code) => reject(new Error(`The agent stopped (exit ${code ?? "signal"})`))));
    exited.catch(() => undefined);
    const response = await Promise.race([this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }), exited]);
    const usage = (response as { usage?: { totalTokens?: number } }).usage;
    return { stopReason: response.stopReason, text: this.state.text, ...(usage?.totalTokens ? { tokens: usage.totalTokens } : {}) };
  }

  /** Stop the current turn (the interrupt button). */
  async cancel(): Promise<void> {
    await this.connection.cancel({ sessionId: this.sessionId }).catch(() => undefined);
  }

  close(): void {
    if (this.child.exitCode === null) this.child.kill();
  }
}
