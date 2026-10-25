import type { ToolInvocation, ToolInvocationStatus } from "@petrina/core";
import type { ToolActivityEvent } from "@petrina/orchestrator";
import type { ToolActivity, createToolActivity } from "./tool-activity.js";

export interface InvocationEffects { now: () => number; id: () => string; activity: Pick<ReturnType<typeof createToolActivity>, "commandOf" | "describeTool" | "fileOf" | "isPlumbing" | "kindOf"> }

export const MAX_TOOL_INVOCATIONS = 100;
export const MAX_TOOL_COMMAND = 4096;
const MAX_PATH = 512;
const MAX_PATHS = 8;

type Update = ToolActivity & { toolCallId: string; status?: string | null };
type Entry = { call: ToolActivity; invocation?: ToolInvocation };
const terminal = (status?: string | null) => status === "completed" || status === "failed";
const reportedStatus = (value?: string | null): ToolInvocationStatus | undefined =>
  ["pending", "in_progress", "completed", "failed"].includes(value ?? "") ? value as ToolInvocationStatus : undefined;

// Retain only fields used for descriptions/diagnostics, never outputs, patches or arbitrary payloads.
const INPUT_FIELDS = ["command", "cmd", "CommandLine", "description", "toolAction", "toolSummary", "target_file", "file_path", "path", "filePath", "tool_name", "name", "ToolName", "url", "element", "arguments", "args", "parameters", "Arguments"];
function boundedInput(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return undefined;
  const fields: [string, unknown][] = [];
  for (const key of INPUT_FIELDS) {
    const item = (value as Record<string, unknown>)[key];
    if (["arguments", "args", "parameters", "Arguments"].includes(key)) {
      const nested = boundedInput(item, depth + 1);
      if (nested) fields.push([key, nested]);
    } else if (["command", "cmd", "CommandLine"].includes(key)) {
      const command = typeof item === "string" ? item : Array.isArray(item) ? item.filter(part => typeof part === "string").join(" ") : undefined;
      if (command !== undefined) fields.push([key, command.slice(0, MAX_TOOL_COMMAND)]);
    } else if (typeof item === "string") fields.push([key, item.slice(0, MAX_PATH)]);
  }
  return Object.fromEntries(fields);
}

function mergeCall(previous: ToolActivity, update: ToolActivity): ToolActivity {
  const call = { ...previous };
  if (update.title != null) call.title = update.title.slice(0, 240);
  if (update.kind != null) call.kind = update.kind.slice(0, 80);
  if (update.locations != null) call.locations = update.locations.slice(0, MAX_PATHS).map(location => ({ path: location.path.slice(0, MAX_PATH) }));
  if (update.rawInput != null) {
    const input = boundedInput(update.rawInput);
    call.rawInput = input && typeof input === "object" && !Array.isArray(input)
      ? { ...(previous.rawInput && typeof previous.rawInput === "object" ? previous.rawInput : {}), ...input } : input;
  }
  if (update._meta != null) {
    const meta = update._meta;
    const small = (value: unknown) => value && typeof value === "object" ? Object.fromEntries(["name", "kind", "tool"].flatMap(key => {
      const item = (value as Record<string, unknown>)[key];
      return typeof item === "string" ? [[key, item.slice(0, 240)]] : [];
    })) : undefined;
    call._meta = { ...previous._meta, ...(small(meta["x.ai/tool"]) ? { "x.ai/tool": small(meta["x.ai/tool"]) } : {}), ...(small(meta.mcp) ? { mcp: small(meta.mcp) } : {}) };
  }
  return call;
}

/** One turn's bounded metadata cache. Updates never invent an invocation. */
export class ToolInvocations {
  private entries = new Map<string, Entry>();
  private latest?: string;
  private turnId: string;
  constructor(private readonly publish: (event: ToolActivityEvent) => void, private readonly effects: InvocationEffects) { this.turnId = effects.id(); }

  startTurn(): void { this.entries.clear(); this.latest = undefined; this.turnId = this.effects.id(); }
  known(id: string): ToolActivity | undefined { return this.entries.get(id)?.call; }

  update(update: Update, start: boolean): void {
    let entry = this.entries.get(update.toolCallId);
    if (!entry && !start) return;
    if (!entry) {
      if (this.entries.size >= MAX_TOOL_INVOCATIONS) this.entries.delete(this.entries.keys().next().value!);
      entry = { call: {} };
      this.entries.set(update.toolCallId, entry);
    }
    entry.call = mergeCall(entry.call, update);
    const { commandOf, describeTool, fileOf, isPlumbing, kindOf } = this.effects.activity;
    if (isPlumbing(entry.call)) return;
    const previous = entry.invocation;
    const at = this.effects.now();
    const status = reportedStatus(update.status) ?? previous?.status;
    const command = commandOf(entry.call.rawInput)?.slice(0, MAX_TOOL_COMMAND);
    const paths = entry.call.locations?.map(location => location.path) ?? (fileOf(entry.call) ? [fileOf(entry.call)!.slice(0, MAX_PATH)] : undefined);
    const shortened = (update.title?.length ?? 0) > 240 || (update.kind?.length ?? 0) > 80 || update.toolCallId.length > 200 || (commandOf(update.rawInput)?.length ?? 0) > MAX_TOOL_COMMAND || (update.locations?.length ?? 0) > MAX_PATHS || update.locations?.some(location => location.path.length > MAX_PATH) || (fileOf(update)?.length ?? 0) > MAX_PATH;
    const invocation: ToolInvocation = {
      ...previous, id: previous?.id ?? this.effects.id(), turnId: this.turnId, toolCallId: update.toolCallId.slice(0, 200),
      description: describeTool(entry.call), kind: kindOf(entry.call), startedAt: previous?.startedAt ?? at, updatedAt: at,
      ...(entry.call.title ? { title: entry.call.title } : {}), ...(status ? { status } : {}),
      ...(terminal(status) ? { endedAt: previous?.endedAt ?? at } : {}),
      ...(command !== undefined ? { command } : {}), ...(paths ? { paths } : {}),
      ...(shortened ? { metadataShortened: true } : {}),
    };
    if (previous && JSON.stringify({ ...previous, updatedAt: 0 }) === JSON.stringify({ ...invocation, updatedAt: 0 })) return;
    entry.invocation = invocation;
    if (!previous) this.latest = update.toolCallId;
    this.publish({ turnId: this.turnId, invocation, isNew: !previous, ...this.summary() });
  }

  private summary(): Pick<ToolActivityEvent, "runningTool" | "lastActivity"> {
    const invocation = [...this.entries.values()].reverse().find(entry => entry.invocation && !terminal(entry.invocation.status) && !entry.invocation.turnEndedAt)?.invocation;
    return {
      lastActivity: this.latest ? this.entries.get(this.latest)?.invocation?.description : undefined,
      runningTool: invocation ? { id: invocation.id, description: invocation.description, startedAt: invocation.startedAt, ...(invocation.status ? { status: invocation.status } : {}) } : undefined,
    };
  }

  endTurn(): void {
    const at = this.effects.now();
    for (const entry of this.entries.values()) {
      if (entry.invocation && !terminal(entry.invocation.status)) entry.invocation.turnEndedAt = at;
    }
    this.publish({ turnId: this.turnId, ...this.summary(), turnEndedAt: at });
    this.entries.clear();
    this.latest = undefined;
  }
}
