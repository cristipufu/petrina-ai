// ACP session protocol helpers, settings parsing, stream framing and client update handlers.
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { type AgentProfile, type TurnReport } from "@petrina/core";
import type { AgentSessionCallbacks, NativeRetryReport, PermissionInfo, RetryCause, SessionSettings } from "@petrina/orchestrator";
import { genericTurnReport } from "./turn-report.js";
import { ADAPTERS } from "./tool-catalog.js";
import type { UsageInfo } from "./usage.js";
import type { SessionNotice } from "./provider-interruptions.js";
import { AgentMessages, TurnText } from "./agent-messages.js";
import { browserTarget, commandOf, describeTool, fileOf, isPlumbing, kindOf, type ToolActivity } from "./native-tool-activity.js";
import type { ToolAdapter } from "./tool-adapter.js";
import { ToolInvocations } from "./tool-invocations.js";

export interface RunCallbacks extends AgentSessionCallbacks {
  onLog?(text: string): void;
  /** The tool said how much of a usage limit is used (every report, whether or not it is close). */
  onUsage?(info: UsageInfo): void;
  /** A complete native account response, including changed quota groups after a subscription change. */
  onAccountUsage?(reports: readonly UsageInfo[]): void;
  /** What the tool says it is logged in with, when it says: "none" means not logged in. */
  onAuthStatus?(kind: string): void;
}

/** The notification Claude Code's and Codex's connectors send, unasked, with the login they run on. */
export const AUTH_STATUS_UPDATE = "_auth/status_update";

export type ConfigOption = {
  id: string;
  currentValue?: unknown;
  options?: ({ value?: string; name?: string; options?: { value?: string; name?: string }[] } | undefined)[];
};

/** Every choice of a select option, groups flattened. */
export function choices(option: ConfigOption | undefined): { value: string; name?: string }[] {
  const flat: { value: string; name?: string }[] = [];
  for (const entry of option?.options ?? []) {
    if (!entry) continue;
    if (Array.isArray(entry.options)) {
      for (const inner of entry.options) {
        if (typeof inner.value === "string") flat.push({ value: inner.value, ...(inner.name ? { name: inner.name } : {}) });
      }
    }
    if (typeof entry.value === "string") flat.push({ value: entry.value, ...(entry.name ? { name: entry.name } : {}) });
  }
  return flat;
}

/** The option without its current value: what it is set to is not confirmed. */
export const unconfirmed = ({ currentValue: _value, ...option }: ConfigOption): ConfigOption => option;

/** Read what the session is set to from the tool's config options, never guessing. */
export function settingsOf(options: readonly ConfigOption[], ids: { model: string; effort: string }): SessionSettings {
  const model = options.find((entry) => entry.id === ids.model);
  const effort = options.find((entry) => entry.id === ids.effort);
  const modelValue = typeof model?.currentValue === "string" && model.currentValue ? model.currentValue : undefined;
  const name = modelValue ? choices(model).find((entry) => entry.value === modelValue)?.name : undefined;
  const effortValue = typeof effort?.currentValue === "string" && effort.currentValue ? effort.currentValue : undefined;
  return { ...(modelValue ? { model: modelValue } : {}), ...(name ? { modelName: name } : {}), ...(effortValue ? { effort: effortValue } : {}) };
}

/** Native composition selects each provider's parser; generic ACP counts stay pure. */
export function reportOf(response: unknown, toolId?: string): TurnReport | undefined {
  const adapter = toolId ? ADAPTERS[toolId] : undefined;
  return adapter?.parseTurnReport ? adapter.parseTurnReport(response) : genericTurnReport(response);
}

/** "Model rerouted from X to Y (reason)" or "Switched from X to Y (reason)": the model Codex moved to. */
export function reroutedTo(text: string): string | undefined {
  const match = /(?:rerouted|switched)\s+from\s+\S+\s+to\s+(\S+)/i.exec(text);
  const model = match?.[1]?.replace(/[.,;:)]+$/, "");
  return model && model.length <= 120 ? model : undefined;
}

/** How long Petrina waits for a tool to reopen a conversation before it starts a fresh one. */
export const REOPEN_TIMEOUT_MS = 60_000;
/** How long a tool gets to start a fresh conversation: handshake, new session and its settings. */
export const START_TIMEOUT_MS = 2 * 60_000;
/** How long a tool that gave up starting gets to stop by itself before it is forced to. */
export const FORCE_AFTER_MS = 2_000;

export const duration = (ms: number): string => (ms === 60_000 ? "a minute" : `${Math.max(1, Math.round(ms / 1000))} seconds`);

/** ACP's generic wrapper can carry the useful provider diagnostic in data.message. Keep its code and data. */
export function providerError(error: unknown): unknown {
  if (!(error instanceof Error) || error.message !== "Internal error") return error;
  const data = (error as Error & { data?: unknown }).data;
  const detail = data && typeof data === "object" ? (data as { message?: unknown }).message : undefined;
  if (typeof detail === "string" && detail.trim()) error.message = detail;
  return error;
}

export interface RunState {
  response: TurnText;
  messages: AgentMessages;
  lastActivity: string;
  activeToolCall?: string;
  tools?: ToolInvocations;
  quiet: boolean;
  settings: SessionSettings;
  latest?: UsageInfo;
  /** Native account command output is never an agent message or part of the task conversation. */
  accountText?: string;
  /** The conversation this run owns, once it is open. Another session's notices are not this participant's. */
  sessionId?: string;
  /** The tool is retrying the current turn by itself, and why. Cleared by fresh model output, a new tool call or the turn's end. */
  retrying?: RetryCause;
  /** The current turn's prompt request, until its answer arrives. */
  promptId?: acp.JsonRpcId;
  turn?: { changed: { model?: string; effort?: string }; rerouted: boolean; helpers: Set<string>; modelSeen?: string; next?: SessionSettings };
}

export function createAcpConnection(params: {
  child: ChildProcess;
  adapter: ToolAdapter;
  profile: AgentProfile;
  state: RunState;
  callbacks: RunCallbacks;
  onSessionOptions: (options: ConfigOption[]) => void;
  readSettings: (options: readonly ConfigOption[]) => void;
}): acp.ClientSideConnection {
  const { child, adapter, profile, state, callbacks, onSessionOptions, readSettings } = params;
  const noteReroute = (text: string) => {
    const model = state.turn && reroutedTo(text);
    if (model && state.turn) {
      state.turn.changed.model = model;
      state.turn.rerouted = true;
    }
  };
  // Native retries are read in the order the tool sent its messages. The ACP library hands each message to its
  // handler without waiting for the previous one, and an extension route (Grok's retry state) passes more
  // handlers than a session update: read there, a notice could land after the work or the answer that followed it.
  const retryReport = (cause: RetryCause, sessionId: string, retryAfterMs?: number): NativeRetryReport =>
    ({ toolId: profile.toolId, profileId: profile.id, sessionId, cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  const retryOver = () => {
    if (state.retrying === undefined) return;
    delete state.retrying;
    callbacks.onRetrying?.(undefined);
  };
  /** One incoming message, as it arrives. Only this run's own conversation, during a turn whose answer has not come. */
  const arrived = (message: acp.AnyMessage) => {
    if (!("method" in message)) {
      // The turn's own answer: later notices belong to no turn.
      if ("id" in message && message.id === state.promptId) delete state.promptId;
      return;
    }
    if ("id" in message || !state.turn || state.quiet || state.promptId === undefined || state.sessionId === undefined) return;
    const msgParams = message.params as { sessionId?: unknown; update?: unknown } | undefined;
    if (msgParams?.sessionId !== state.sessionId) return;
    const update = message.method === acp.methods.client.session.update ? msgParams.update as {
      sessionUpdate?: unknown;
      content?: {
      type?: unknown;
      text?: unknown
    }
    } | undefined : undefined;
    const notice: SessionNotice = update ? {
      kind: "update",
      sessionId: state.sessionId,
      update
    } : {
      kind: "extension",
      method: message.method,
      params: msgParams
    };
    const read = adapter.interruptions?.notice?.(notice);
    if (read) {
      if ("stopped" in read) return retryOver();
      if (state.retrying === read.retrying) return;
      state.retrying = read.retrying;
      callbacks.onRetrying?.(retryReport(read.retrying, state.sessionId, read.retryAfterMs));
      return;
    }
    // Fresh model output or a new tool call: useful work is under way again. An update to an earlier call is not.
    const kind = update?.sessionUpdate;
    const text = (kind === "agent_message_chunk" || kind === "agent_thought_chunk") && update?.content?.type === "text" && typeof update.content.text === "string" && update.content.text.length > 0;
    if (text || kind === "tool_call") retryOver();
  };
  const tools = state.tools = new ToolInvocations((event) => {
    if (event.isNew) state.messages.activity();
    callbacks.onToolActivity?.(event);
  }, { activity: { commandOf, describeTool, isPlumbing, kindOf, fileOf }, now: Date.now, id: () => crypto.randomUUID() });
  const publishTool = (call: ToolActivity, isNew = false) => {
    if (isPlumbing(call)) return;
    const line = describeTool(call);
    if (!isNew && line === state.lastActivity) return;
    state.messages.activity();
    state.lastActivity = line;
    callbacks.onActivity(line);
  };
  const raw = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
  const outgoing = raw.writable.getWriter();
  const stream: acp.Stream = {
    readable: raw.readable.pipeThrough(new TransformStream<acp.AnyMessage, acp.AnyMessage>({
      transform(message, controller) {
        try { arrived(message); } catch (error) { callbacks.onLog?.(`Could not read a retry notice: ${error instanceof Error ? error.message : String(error)}`); }
        controller.enqueue(message);
      },
    })),
    writable: new WritableStream<acp.AnyMessage>({
      write(message) {
        // The turn's own request, so its answer can be told from a live-input reply. An account read is not a turn.
        if ("method" in message && "id" in message && message.method === acp.methods.agent.session.prompt && state.turn && state.accountText === undefined) state.promptId = message.id;
        return outgoing.write(message);
      },
      close: () => outgoing.close(),
      abort: (reason) => outgoing.abort(reason),
    }),
  };

  return new acp.ClientSideConnection(
    () => ({
      async requestPermission(reqParams) {
        if (state.quiet) return { outcome: { outcome: "cancelled" } };
        const call = reqParams.toolCall;
        const known = tools.known(call.toolCallId) ?? {};
        const merged = { ...known, ...call };
        const info: PermissionInfo = {
          title: describeTool(merged),
          kind: kindOf(merged),
          ...(commandOf(merged.rawInput) ? { command: commandOf(merged.rawInput)! } : {}),
          paths: (merged.locations ?? []).map((location) => location.path),
          ...(browserTarget(merged) ? { target: browserTarget(merged)! } : {}),
        };
        const decision = await callbacks.onPermission(info);
        // One-time answers only: a tool's "always" options write settings into the working copy
        // or switch modes, so Petrina never picks them.
        const order = decision === "allow" ? ["allow_once"] : ["reject_once", "reject_always"];
        const option = order.map((kind) => reqParams.options.find((entry) => entry.kind === kind)).find((entry) => entry !== undefined);
        if (!option) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      },
      async sessionUpdate(updateParams) {
        if (state.accountText !== undefined) {
          if (updateParams.update.sessionUpdate === "agent_message_chunk" && updateParams.update.content.type === "text") {
            state.accountText = `${state.accountText}${updateParams.update.content.text}`.slice(0, 32_000);
          }
          return;
        }
        if (state.quiet) return;
        const update = updateParams.update;
        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            state.activeToolCall = undefined;
            if (update.content.type === "text") {
              const source = "messageId" in update && typeof update.messageId === "string" ? update.messageId : undefined;
              const fresh = state.messages.push(update.content.text, source);
              state.response.push(update.content.text, fresh);
            }
            break;
          case "agent_thought_chunk":
            state.activeToolCall = undefined;
            state.messages.activity();
            if (update.content.type === "text" && /rerouted/i.test(update.content.text)) noteReroute(update.content.text);
            break;
          case "notice":
            if (/rerouted/i.test(update.title)) noteReroute(update.description ?? update.title);
            break;
          case "config_option_update": {
            const nextOptions = update.configOptions as ConfigOption[];
            onSessionOptions(nextOptions);
            readSettings(nextOptions);
            break;
          }
          case "usage_update": {
            const meta = update._meta ?? {};
            const native = adapter.parseUsageUpdate?.(meta);
            const reports = native?.reports ?? [];
            for (const info of reports) callbacks.onUsage?.(info);
            const windows = reports.filter((info) => !info.claudeOverage);
            if (windows.length) state.latest = windows.find((info) => info.status === "rejected" && !info.overage) ?? windows[0];
            if (reports.some((info) => info.claudeOverage === "unavailable") && state.latest?.overage) state.latest = { ...state.latest, overage: false };
            const seen = native?.model;
            if (state.turn && typeof seen === "string") state.turn.modelSeen = seen;
            break;
          }
          case "tool_call": {
            if (!state.turn) break;
            // A Codex agent starting a helper agent shows up as a tool call named spawnAgent.
            const input = update.rawInput as { receiverThreadIds?: unknown } | undefined;
            if (state.turn && (update.title === "spawnAgent" || Array.isArray(input?.receiverThreadIds))) state.turn.helpers.add(update.toolCallId);
            tools.update(update, true);
            if (isPlumbing(update)) break;
            state.activeToolCall = update.toolCallId;
            state.messages.activity();
            publishTool(update, true);
            break;
          }
          case "tool_call_update": {
            if (!state.turn) break;
            const known = tools.known(update.toolCallId) ?? {};
            const merged = { ...known, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null && value !== undefined)) };
            tools.update(update, false);
            if (state.activeToolCall === update.toolCallId && [
              update.title,
              update.kind,
              update.rawInput,
              update.locations,
              update._meta
            ].some((value) => value !== null && value !== undefined)) publishTool(merged);
            break;
          }
          case "plan": {
            state.activeToolCall = undefined;
            state.messages.activity();
            const current = update.entries.find((entry) => entry.status === "in_progress");
            if (current) callbacks.onPlanStep(current.content);
            break;
          }
          default:
            break;
        }
      },
      async extNotification(method, extParams) {
        if (method !== AUTH_STATUS_UPDATE && method !== AUTH_STATUS_UPDATE.slice(1)) return;
        const kind = (extParams as { authStatus?: { kind?: unknown } }).authStatus?.kind;
        if (typeof kind === "string") callbacks.onAuthStatus?.(kind);
      },
    }),
    stream,
  );
}
