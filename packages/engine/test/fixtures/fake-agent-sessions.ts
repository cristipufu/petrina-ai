import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { ADAPTERS, ModelAtCapacity, limitFromFailure, limitFromReport, reportOf, reroutedTo, settingsOf, type UsageInfo } from "@petrina/agent-runtime";
import { commandOf, describeTool, fileOf, isPlumbing, kindOf } from "@petrina/agent-runtime/native-tool-activity";
import { AgentMessages, TurnText } from "@petrina/agent-runtime/agent-messages";
import { messageClock } from "@petrina/agent-runtime/message-clock";
import { CODEX_MODEL_CAPACITY, type SessionNotice } from "@petrina/agent-runtime/provider-interruptions";
import { ToolInvocations } from "@petrina/agent-runtime/tool-invocations";
import { ReopenFailed, type AgentInputReceipt, type AgentSession, type AgentSessionOptions, type PermissionInfo, type RetryCause, type SessionSettings, type StartAgentSession, type TurnNotes, type TurnResult } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { git } from "@petrina/test-support/commands";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import type { EngineOptions } from "../engine.js";
import type { AgentScript, NativeStep, Scenario } from "../fake-agent.js";
import { nativeAgentProcess } from "../native-agent.js";
import { recordPrompt } from "../prompt-records.js";
import { answersTo, findingIds, promptSection as section } from "../scripted-findings.js";
import { privateAgentToolProbe } from "../scripted-probes.js";
import { FAKE_AGENT, type Fakes } from "../support.js";
import {
  block,
  checkFinderPayload,
  defaultConfigOptions as defaultOptions,
  designReviewerPayload,
  DISPUTE_REASON,
  guideKeeperPayload,
  NOTES,
  objectionIds,
  plannerPayload,
  roleOf,
  SCREEN_REASON,
  SECURITY_FINDING,
  slug,
  verifierVerdictsPayload,
  type FakeConfigOption as ConfigOption,
} from "./fake-agent-scenarios.js";

export { attachReviewWorktree, prepareReviewRepository } from "./review-repository-seed.js";

interface Conversation {
  maintenance?: boolean;
  captures?: string;
  cwd: string;
  role: string;
  turns: number;
  restarts: number;
  history: acp.SessionNotification["update"][];
  notices?: { method: string; params: Record<string, unknown> }[];
  terminal?: number;
  model?: string;
  failing?: boolean;
  effort?: string;
  options: ConfigOption[];
}

interface Reply {
  meta?: Record<string, unknown>;
  text: string;
  stop?: "cancelled";
  silent?: boolean;
  models?: { model: string; input: number; cached: number; write: number; output: number }[];
  native?: boolean;
}

const run = (cwd: string, ...args: string[]) => git(cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args);

const usageUpdate = (status: string, kind: string, utilization?: number, resetsAt?: number, overage?: boolean, paidStatus?: string): acp.SessionNotification["update"] =>
  ({
    sessionUpdate: "usage_update",
    used: 100,
    size: 1000,
    _meta: {
      "_claude/rateLimit": {
        status,
        rateLimitType: kind,
        ...(utilization !== undefined ? { utilization } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(overage ? { isUsingOverage: true } : {}),
        ...(paidStatus ? { overageStatus: paidStatus } : {}),
      },
    },
  }) as acp.SessionNotification["update"];

function providerError(error: unknown): unknown {
  if (!(error instanceof Error) || error.message !== "Internal error") return error;
  const data = (error as Error & { data?: unknown }).data;
  const detail = data && typeof data === "object" ? (data as { message?: unknown }).message : undefined;
  if (typeof detail === "string" && detail.trim()) error.message = detail;
  return error;
}

function internalError(data: unknown, message = "Internal error"): Error & { code: number; data?: unknown } {
  return Object.assign(new Error(message), { code: -32603, data });
}

function requestError(code: number, message: string, data?: unknown): Error & { code: number; data?: unknown } {
  return Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });
}

async function waitForFile(path: string, signal: AbortSignal): Promise<void> {
  while (!existsSync(path)) {
    if (signal.aborted) throw new Error("The agent stopped (exit signal)");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

async function waitWhileFile(path: string, signal: AbortSignal): Promise<void> {
  while (existsSync(path)) {
    if (signal.aborted) throw new Error("The agent stopped (exit signal)");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

export interface FakeSessionOptions {
  recordTool?: boolean;
  scriptPath?: string;
  flags?: (toolId: string) => readonly string[];
}

/** Return the process-like handle for a session or native AgentRun. */
export function sessionProcess(agent: AgentSession): ChildProcess {
  if ("exitCode" in agent) return agent as unknown as ChildProcess;
  return nativeAgentProcess(agent);
}

/** Engine options that run the fake agent in-process with a private tool probe. */
export function fakeEngineSettings(fakes: Fakes, options: FakeSessionOptions = {}): Partial<EngineOptions> {
  return {
    agentCommand: (profile) => [
      process.execPath,
      FAKE_AGENT,
      fakes.dir,
      ...(options.scriptPath ? [`--script=${options.scriptPath}`] : []),
      ...(options.recordTool ? [`--record-tool=${profile.toolId}`] : []),
    ],
    toolPath: () => process.execPath,
    toolProbe: privateAgentToolProbe(),
    startAgentSession: fakeAgentSessions(fakes, options),
  };
}

/** In-process `StartAgentSession` implementation matching `fake-agent.ts` and `AgentRun`. */
export function fakeAgentSessions(fakes: Fakes, options: FakeSessionOptions = {}): StartAgentSession {
  const dir = fakes.dir;
  const sessions = new Map<string, Conversation>();
  const cancels = new Map<string, () => void>();
  const undisputed = new Map<string, string>();

  const readScenario = (): Scenario =>
    existsSync(join(dir, "scenario.json")) ? (JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario) : {};

  const readScript = (): AgentScript =>
    options.scriptPath && existsSync(options.scriptPath) ? (JSON.parse(readFileSync(options.scriptPath, "utf8")) as AgentScript) : {};

  const saveScript = (script: AgentScript) => {
    if (options.scriptPath) writeFixtureJson(options.scriptPath, script, 2);
  };

  const mark = (name: string) => writeFileSync(join(dir, name), String(Date.now()));
  const marked = (name: string) => existsSync(join(dir, name));

  const conversationFile = (sessionId: string) => join(dir, "conversations", `${sessionId}.json`);
  const keep = (sessionId: string) => {
    const file = conversationFile(sessionId);
    mkdirSync(dirname(file), { recursive: true });
    writeFixtureJson(file, sessions.get(sessionId));
  };

  const capacityProgress = (sessionId: string): { used: number; armed?: boolean } => {
    const path = join(dir, `capacity-${sessionId}.json`);
    if (!existsSync(path)) return { used: 0 };
    return JSON.parse(readFileSync(path, "utf8")) as { used: number; armed?: boolean };
  };

  const outOfUsage = (limit: NonNullable<Scenario["limited"]>[number]): number | undefined => {
    const file = join(dir, `limit-${limit.model}`);
    if (!existsSync(file)) writeFileSync(file, String(Date.now() + (limit.resetsInMs ?? 3_600_000)));
    const until = Number(readFileSync(file, "utf8"));
    return Date.now() < until ? until : undefined;
  };

  const recordOpen = (sessionId: string, how: "new" | "resume" | "load", toolId: string) => {
    mkdirSync(dir, { recursive: true });
    const autoMode = (ADAPTERS[toolId]?.sessionMeta as { autoMode?: unknown } | undefined)?.autoMode === true;
    appendFileSync(
      join(dir, "opens.jsonl"),
      `${JSON.stringify({ session: sessionId, how, tool: options.recordTool ? toolId : "", background: true, logins: true, quiet: true, ...(autoMode ? { autoMode: true } : {}) })}\n`,
    );
  };

  return async (launch: AgentSessionOptions): Promise<AgentSession> => {
    let resolveGone!: () => void;
    const gone = new Promise<void>((resolve) => {
      resolveGone = resolve;
    });
    launch.onGone?.(gone);

    if (launch.signal.aborted) {
      resolveGone();
      throw new Error("Stopped before the agent started");
    }

    const adapter = ADAPTERS[launch.profile.toolId]!;
    const toolFlags = options.flags?.(launch.profile.toolId) ?? [];
    if (toolFlags.includes("--wont-start")) {
      resolveGone();
      throw new Error(`${adapter.name} exited with code 3`);
    }
    const plan = readScenario();
    let sessionId: string;
    let reopened: "resume" | "load" | undefined;
    let session: Conversation;

    if (launch.reopen === undefined) {
      if (toolFlags.includes("--logged-out")) {
        resolveGone();
        throw requestError(-32000, "Authentication required");
      }
      if (toolFlags.includes("--hang")) {
        await new Promise<never>((_, reject) => {
          const limit = launch.startTimeoutMs ?? 30_000;
          const duration = limit === 60_000 ? "a minute" : `${Math.max(1, Math.round(limit / 1000))} seconds`;
          const timer = setTimeout(() => {
            resolveGone();
            reject(new Error(`${adapter.name} did not start within ${duration}. Try again; if it keeps happening, check that ${adapter.name} starts in a terminal.`));
          }, limit);
          launch.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolveGone();
            reject(new Error("Stopped before the agent started"));
          }, { once: true });
        });
      }
      const holdOpen = toolFlags.find((arg) => arg.startsWith("--hold-open="))?.slice("--hold-open=".length);
      if (holdOpen) {
        try {
          writeFileSync(`${holdOpen}.reached`, "");
          await waitWhileFile(holdOpen, launch.signal);
        } catch (error) {
          resolveGone();
          throw error;
        }
      }
      sessionId = crypto.randomUUID();
      session = {
        cwd: launch.cwd,
        role: "",
        model: "default",
        effort: "high",
        turns: 0,
        restarts: 0,
        history: [],
        options: defaultOptions(plan),
      };
      sessions.set(sessionId, session);
      keep(sessionId);
      recordOpen(sessionId, "new", launch.profile.toolId);
    } else {
      if (plan.reopen === "stall") {
        const limit = launch.reopenTimeoutMs ?? 30_000;
        const duration = limit === 60_000 ? "a minute" : `${Math.max(1, Math.round(limit / 1000))} seconds`;
        resolveGone();
        throw new ReopenFailed(`${adapter.name} did not reopen the conversation within ${duration}`);
      }
      const how = plan.reopen === "resume" ? "resume" : plan.reopen === "load" ? "load" : undefined;
      if (!how) {
        resolveGone();
        throw new ReopenFailed(`${adapter.name} cannot reopen conversations`);
      }
      const file = conversationFile(launch.reopen);
      const found = existsSync(file) ? (sessions.get(launch.reopen) ?? (JSON.parse(readFileSync(file, "utf8")) as Conversation)) : undefined;
      if (!found) {
        sessions.delete(launch.reopen);
        resolveGone();
        throw new ReopenFailed(`${adapter.name} could not reopen the conversation`);
      }
      sessionId = launch.reopen;
      reopened = how;
      found.cwd = launch.cwd;
      sessions.set(sessionId, found);
      session = found;
      recordOpen(sessionId, how, launch.profile.toolId);
    }

    let sessionOptions = session.options.map((entry) => ({ ...entry, options: [...entry.options] }));
    const setConfig = (configId: string | undefined, value: string | undefined): boolean => {
      if (!configId || !value) return false;
      const option = session.options.find((entry) => entry.id === configId);
      if (!option || !option.options.some((entry) => entry.value === value)) return false;
      if (option.currentValue === value) return true;
      if (configId === "model") session.model = String(value);
      if (["effort", "reasoning_effort", "thinking_level"].includes(configId)) session.effort = String(value);
      appendFileSync(join(dir, "config.jsonl"), `${JSON.stringify({ session: sessionId, configId, value })}\n`);
      option.currentValue = value;
      keep(sessionId);
      if (!plan.maintenance?.unconfirmed) {
        sessionOptions = session.options.map((entry) => ({ ...entry, options: [...entry.options] }));
      } else {
        sessionOptions = sessionOptions.map((entry) => (entry.id === configId ? { ...entry, currentValue: "" } : entry));
      }
      return true;
    };

    try {
      setConfig(adapter.options.model, launch.profile.modelId);
      setConfig(adapter.options.effort, launch.profile.effort);
      if (adapter.sessionMeta === undefined && adapter.options.mode !== undefined) {
        setConfig(adapter.options.mode, adapter.mode);
      }
      const optionIds = { model: adapter.options.model, effort: adapter.options.effort };
      const initialSettings = settingsOf(sessionOptions as never, optionIds);
      adapter.verifySessionSettings?.(launch.profile, initialSettings);

      return new InProcessFakeSession(
        launch,
        sessionId,
        reopened,
        session,
        initialSettings,
        resolveGone,
        {
          dir,
          readScenario,
          readScript,
          saveScript,
          mark,
          marked,
          keep: () => keep(sessionId),
          capacityProgress: () => capacityProgress(sessionId),
          outOfUsage,
          cancels,
          undisputed,
          toolFlags,
        },
      );
    } catch (error) {
      resolveGone();
      if (launch.reopen !== undefined && !(error instanceof ReopenFailed) && !launch.signal.aborted) {
        throw new ReopenFailed(`${adapter.name} could not reopen the conversation`);
      }
      throw providerError(error);
    }
  };
}

interface Helpers {
  dir: string;
  readScenario: () => Scenario;
  readScript: () => AgentScript;
  saveScript: (script: AgentScript) => void;
  mark: (name: string) => void;
  marked: (name: string) => boolean;
  keep: () => void;
  capacityProgress: () => { used: number; armed?: boolean };
  outOfUsage: (limit: NonNullable<Scenario["limited"]>[number]) => number | undefined;
  cancels: Map<string, () => void>;
  undisputed: Map<string, string>;
  toolFlags: readonly string[];
}

class InProcessFakeSession implements AgentSession {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  onPromptStarted?: () => void;
  private readonly stopped = new AbortController();
  private pending?: Promise<TurnResult>;
  private notes?: TurnNotes;
  private currentSettings: SessionSettings;
  private readonly messages: AgentMessages;
  private readonly onSignalAbort = () => this.close();

  get liveInput(): boolean {
    const live = ADAPTERS[this.launch.profile.toolId]?.liveInput;
    const plan = this.h.readScenario();
    const init = { protocolVersion: 1, ...(plan.live ? { _meta: { steering: { supported: true } } } : {}) };
    if (!live?.supported(init)) return false;
    if (live.probe) return plan.liveProbe !== "null";
    return true;
  }

  constructor(
    private readonly launch: AgentSessionOptions,
    readonly sessionId: string,
    readonly reopened: "resume" | "load" | undefined,
    private readonly session: Conversation,
    initialSettings: SessionSettings,
    private readonly resolveGone: () => void,
    private readonly h: Helpers,
  ) {
    this.currentSettings = initialSettings;
    this.messages = new AgentMessages(messageClock, launch.callbacks.onMessage);
    launch.signal.addEventListener("abort", this.onSignalAbort, { once: true });
    if (launch.signal.aborted) this.close();
  }

  get settings(): SessionSettings {
    return { ...this.currentSettings };
  }

  get prompting(): boolean {
    return this.pending !== undefined;
  }

  get lastTurn(): TurnNotes | undefined {
    return this.notes ? structuredClone(this.notes) : undefined;
  }

  async prompt(text: string): Promise<TurnResult> {
    if (this.stopped.signal.aborted) throw new Error("The agent stopped (exit signal)");
    if (this.h.toolFlags.includes("--not-logged-in") || this.h.toolFlags.includes("--logged-out")) {
      throw providerError(requestError(-32000, "Authentication required"));
    }
    const adapter = ADAPTERS[this.launch.profile.toolId]!;
    const optionIds = { model: adapter.options.model, effort: adapter.options.effort };
    const messages = this.messages;
    messages.boundary();
    const turnText = new TurnText();
    let latestUsage: UsageInfo | undefined;
    let retrying: RetryCause | undefined;
    const turnChanged: { model?: string; effort?: string } = {};
    let rerouted = false;
    const helpers = new Set<string>();
    let modelSeen: string | undefined;
    let nextSettings: SessionSettings | undefined;
    const tools = new ToolInvocations(
      (event) => {
        if (event.isNew) messages.activity();
        this.launch.callbacks.onToolActivity?.(event);
      },
      { activity: { commandOf, describeTool, isPlumbing, kindOf, fileOf }, now: Date.now, id: () => crypto.randomUUID() },
    );
    tools.startTurn();
    this.notes = undefined;

    const buildNotes = (): TurnNotes => ({
      changed: { ...turnChanged },
      rerouted,
      helpers: helpers.size,
      ...(modelSeen ? { modelSeen } : {}),
    });

    let toolsEnded = false;
    const endTools = () => {
      if (!toolsEnded) {
        toolsEnded = true;
        tools.endTurn();
      }
    };

    const retryOver = () => {
      if (retrying === undefined) return;
      retrying = undefined;
      this.launch.callbacks.onRetrying?.(undefined);
    };

    const sendUpdate = async (update: acp.SessionNotification["update"]): Promise<void> => {
      this.session.history.push(update);
      this.h.keep();
      if (this.stopped.signal.aborted) return;

      const noticeRead = adapter.interruptions?.notice?.({ kind: "update", sessionId: this.sessionId, update });
      if (noticeRead) {
        if ("stopped" in noticeRead) retryOver();
        else if (retrying !== noticeRead.retrying) {
          retrying = noticeRead.retrying;
          this.launch.callbacks.onRetrying?.({
            toolId: this.launch.profile.toolId,
            profileId: this.launch.profile.id,
            sessionId: this.sessionId,
            cause: noticeRead.retrying,
            ...(noticeRead.retryAfterMs !== undefined ? { retryAfterMs: noticeRead.retryAfterMs } : {}),
          });
        }
      } else {
        const kind = update.sessionUpdate;
        const hasText =
          (kind === "agent_message_chunk" || kind === "agent_thought_chunk") &&
          update.content?.type === "text" &&
          typeof update.content.text === "string" &&
          update.content.text.length > 0;
        if (hasText || kind === "tool_call") retryOver();
      }

      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content.type === "text") {
            const source = "messageId" in update && typeof update.messageId === "string" ? update.messageId : undefined;
            const fresh = messages.push(update.content.text, source);
            turnText.push(update.content.text, fresh);
          }
          break;
        case "agent_thought_chunk":
          messages.activity();
          if (update.content.type === "text" && /rerouted/i.test(update.content.text)) {
            const model = reroutedTo(update.content.text);
            if (model) {
              turnChanged.model = model;
              rerouted = true;
            }
          }
          break;
        case "notice":
          if (/rerouted/i.test((update as { title: string }).title)) {
            const model = reroutedTo((update as { description?: string; title: string }).description ?? (update as { title: string }).title);
            if (model) {
              turnChanged.model = model;
              rerouted = true;
            }
          }
          break;
        case "config_option_update": {
          const next = settingsOf(update.configOptions as never, optionIds);
          if (next.model && next.model !== this.currentSettings.model) turnChanged.model = next.modelName ?? next.model;
          if (next.effort && next.effort !== this.currentSettings.effort) turnChanged.effort = next.effort;
          nextSettings = next;
          break;
        }
        case "usage_update": {
          const meta = update._meta ?? {};
          const native = adapter.parseUsageUpdate?.(meta);
          const reports = native?.reports ?? [];
          for (const info of reports) (this.launch.callbacks as { onUsage?: (info: UsageInfo) => void }).onUsage?.(info);
          const windows = reports.filter((info) => !info.claudeOverage);
          if (windows.length) latestUsage = windows.find((info) => info.status === "rejected" && !info.overage) ?? windows[0];
          if (reports.some((info) => info.claudeOverage === "unavailable") && latestUsage?.overage) {
            latestUsage = { ...latestUsage, overage: false };
          }
          if (typeof native?.model === "string") modelSeen = native.model;
          break;
        }
        case "tool_call": {
          const input = update.rawInput as { receiverThreadIds?: unknown } | undefined;
          if (update.title === "spawnAgent" || Array.isArray(input?.receiverThreadIds)) helpers.add(update.toolCallId);
          tools.update(update as never, true);
          if (!isPlumbing(update as never)) {
            messages.activity();
            this.launch.callbacks.onActivity(describeTool(update as never));
          }
          break;
        }
        case "tool_call_update": {
          const known = tools.known(update.toolCallId) ?? {};
          const merged = { ...known, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null && value !== undefined)) };
          tools.update(update as never, false);
          if ([update.title, update.kind, update.rawInput, update.locations, update._meta].some((value) => value !== null && value !== undefined) && !isPlumbing(merged as never)) {
            messages.activity();
            this.launch.callbacks.onActivity(describeTool(merged as never));
          }
          break;
        }
        case "plan": {
          messages.activity();
          const current = update.entries.find((entry) => entry.status === "in_progress");
          if (current) this.launch.callbacks.onPlanStep(current.content);
          break;
        }
        default:
          break;
      }
    };

    const sendNotice = async (method: string, params: Record<string, unknown>): Promise<void> => {
      const fullParams = { sessionId: this.sessionId, ...params };
      this.session.notices = [...(this.session.notices ?? []), { method, params: fullParams }];
      this.h.keep();
      if (this.stopped.signal.aborted) return;
      const notice: SessionNotice = { kind: "extension", method, params: fullParams };
      const read = adapter.interruptions?.notice?.(notice);
      if (read) {
        if ("stopped" in read) retryOver();
        else if (retrying !== read.retrying) {
          retrying = read.retrying;
          this.launch.callbacks.onRetrying?.({
            toolId: this.launch.profile.toolId,
            profileId: this.launch.profile.id,
            sessionId: this.sessionId,
            cause: read.retrying,
            ...(read.retryAfterMs !== undefined ? { retryAfterMs: read.retryAfterMs } : {}),
          });
        }
      }
    };

    const askPermission = async (title: string, command?: string): Promise<boolean> => {
      if (this.stopped.signal.aborted) return false;
      const info: PermissionInfo = {
        title,
        kind: "execute",
        ...(command ? { command } : {}),
        paths: [],
      };
      const decision = await this.launch.callbacks.onPermission(info);
      return decision === "allow";
    };

    const rejected = (source: "report" | "refusal" = "report") => {
      const info = latestUsage;
      return info?.status === "rejected" && !info.overage && (info.resetsAt === undefined || info.resetsAt > Date.now())
        ? Object.assign(limitFromReport(this.launch.profile, info, Date.now(), source), { said: turnText.text })
        : undefined;
    };

    const capacityOf = (source: unknown): ModelAtCapacity | undefined => {
      const read = adapter.interruptions?.capacity;
      if (!read || rejected()) return undefined;
      const found = read(source, turnText.ending);
      if (!found) return undefined;
      const out = new ModelAtCapacity(this.launch.profile.toolId, this.launch.profile.modelId ?? this.launch.profile.model, this.launch.profile.id, this.sessionId);
      if (found.retryAfterMs !== undefined) out.retryAfterMs = found.retryAfterMs;
      if (turnText.text) out.said = turnText.text;
      if (messages.streamed) out.streamed = true;
      return out;
    };

    const limitOf = (error: unknown, explicitOnly = false) => {
      const failure = limitFromFailure(this.launch.profile, error, turnText.ending, Date.now());
      if (explicitOnly && !failure) return undefined;
      const limited = failure?.independent ? failure : rejected(failure ? "refusal" : "report") ?? failure;
      if (limited) {
        limited.said ??= turnText.text;
        if (messages.streamed) limited.streamed = true;
      }
      return limited;
    };

    const work = (async (): Promise<TurnResult> => {
      this.session.history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
      this.onPromptStarted?.();
      let completed = false;
      try {
        const reply = await this.answer(text, sendUpdate, sendNotice, askPermission);
        if (this.stopped.signal.aborted) throw new Error("The agent stopped (exit signal)");
        if (reply.text) {
          await sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.text } });
        }
        endTools();
        const plan = this.h.readScenario();
        const meta =
          reply.meta ??
          (this.session.turns === 1
            ? plan.nativeRetry?.find((entry) => entry.role === this.session.role && (!entry.model || entry.model === this.session.model))?.meta
            : undefined);
        const response: Record<string, unknown> = {
          stopReason: reply.stop ?? ("end_turn" as const),
          ...(meta
            ? { _meta: meta }
            : reply.native
              ? {
                  _meta: {
                    jetbrains: {
                      air: {
                        version: 1,
                        sessionFailure: { id: "capacity", revision: 1, category: "service", severity: "error", title: CODEX_MODEL_CAPACITY, actions: ["retry"] },
                      },
                    },
                  },
                }
              : {}),
        };
        if (response.stopReason !== "end_turn" && response.stopReason !== "cancelled") {
          const out = rejected();
          if (out) {
            if (messages.streamed) out.streamed = true;
            throw out;
          }
        }
        const report = reportOf(response, this.launch.profile.toolId);
        const full = capacityOf(response);
        if (full) throw full;
        const failure = response.stopReason !== "cancelled" ? adapter.interruptions?.failure?.(response) : undefined;
        if (failure) throw limitOf(failure, true) ?? failure;
        completed = response.stopReason !== "cancelled";
        return {
          stopReason: response.stopReason as TurnResult["stopReason"],
          text: turnText.text,
          ...(messages.streamed ? { streamed: true } : {}),
          ...(report ? { report } : {}),
          ...buildNotes(),
        };
      } catch (error) {
        endTools();
        throw capacityOf(error) ?? limitOf(error) ?? providerError(error);
      } finally {
        endTools();
        messages.boundary(!completed);
        this.notes = buildNotes();
        if (retrying !== undefined) {
          retrying = undefined;
          this.launch.callbacks.onRetrying?.(undefined);
        }
        if (nextSettings) this.currentSettings = nextSettings;
      }
    })();

    this.pending = work;
    try {
      return await work;
    } finally {
      this.pending = undefined;
    }
  }

  private async answer(
    text: string,
    send: (update: acp.SessionNotification["update"]) => Promise<void>,
    sendNotice: (method: string, params: Record<string, unknown>) => Promise<void>,
    askPermission: (title: string, command?: string) => Promise<boolean>,
  ): Promise<Reply> {
    const session = this.session;
    const sessionId = this.sessionId;
    const dir = this.h.dir;
    session.turns += 1;
    if (roleOf(text)) session.role = roleOf(text);
    const captures =
      /Browser output belongs only in (.+), outside product files\./.exec(text)?.[1] ??
      /Browser capture folder for this turn: (.+)\. Earlier pages/.exec(text)?.[1];
    if (captures) session.captures = captures;
    const restarted = text.includes("Petrina restarted");
    if (restarted) session.restarts += 1;
    this.h.keep();
    await recordPrompt(dir, { role: session.role, session: sessionId, text });
    if (session.role === "builder" && text.startsWith("The selected model was at capacity.") && existsSync(join(session.cwd, "capacity-draft.txt"))) {
      await Bun.sleep(80);
    }
    const say = (line: string) => send({ sessionUpdate: "plan", entries: [{ content: line, status: "in_progress", priority: "medium" }] });
    const plan = this.h.readScenario();
    const learned =
      plan.learnings === "tester"
        ? session.role === "tester"
          ? ["Check the welcome page from the guest view."]
          : []
        : plan.learnings
          ? session.role === "builder"
            ? ["Run the tests with bun test: they take a second.", "Greetings live at the repository root."]
            : session.role === "code reviewer"
              ? [plan.reviewTodo ? "Check the greeting from the guest view." : "Greetings live at the repository root!"]
              : []
          : [];

    if (plan.failure?.role === session.role) {
      throw internalError({ message: plan.failure.message, http_status: plan.failure.httpStatus });
    }

    const done = (value: unknown, prose?: string): Reply => {
      const ids = plan.affectedProducts;
      if (ids && value && typeof value === "object") {
        const report = value as { findings?: Record<string, unknown>[]; checks?: Record<string, unknown>[] };
        if (report.findings) {
          report.findings = report.findings.map((finding) => ({ ...finding, productIds: ids }));
          if (plan.unassignedFinding && report.findings.some((finding) => finding.severity === "important")) {
            report.findings.push({ text: "The shared ownership needs a coordinator decision.", severity: "important" });
          }
        }
        if (report.checks && session.role === "tester") {
          report.checks = report.checks.map((entry) => ({
            ...entry,
            productIds: entry.productIds ?? ids,
            ...(typeof entry.pass === "boolean" ? { result: entry.pass ? "pass" : "fail", pass: undefined } : {}),
          }));
        }
      }
      let result = learned.length && value && typeof value === "object" && !("needsInput" in value) ? { ...value, learnings: learned } : value;
      if (plan.sourcePointers && Object.hasOwn(plan.sourcePointers, session.role) && result && typeof result === "object" && !("needsInput" in result)) {
        result = { ...result, sourcePointers: plan.sourcePointers[session.role] };
      }
      return { text: block(result, prose) };
    };

    if (text.includes("Which older reports are the same bug")) {
      const keys = [...text.matchAll(/^- Report \[([^\]]+)\]/gm)].map((match) => match[1]!);
      if (plan.followUpMatch === "same") return done({ groups: [{ keys }], uncertain: [] });
      if (plan.followUpMatch === "unsure") return done({ groups: [], uncertain: keys });
      return { text: "could not tell" };
    }

    const runOut = async (limit: NonNullable<Scenario["limited"]>[number], until: number): Promise<never> => {
      if (session.turns === 1) {
        writeFileSync(join(session.cwd, "notes.txt"), "A first draft\n");
        await send({
          sessionUpdate: "tool_call",
          toolCallId: `edit-${session.turns}`,
          title: "Edit notes.txt",
          kind: "edit",
          status: "completed",
          locations: [{ path: join(session.cwd, "notes.txt") }],
        });
        await send({ sessionUpdate: "plan", entries: [{ content: "Drafting the greeting", status: "in_progress", priority: "medium" }] });
      }
      if (limit.model.startsWith("gpt")) {
        const at = new Date(until);
        await send({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `You've hit your usage limit. Try again at ${at.getHours() % 12 || 12}:${String(at.getMinutes()).padStart(2, "0")} ${at.getHours() < 12 ? "AM" : "PM"}.`,
          },
        });
        throw internalError({ codexErrorInfo: "usageLimitExceeded", category: "quota_exhausted" }, "Internal error");
      }
      if (limit.model.startsWith("grok")) {
        throw internalError({ message: "API error (status 402 Payment Required): Grok Build usage balance exhausted", http_status: 402 });
      }
      await send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I drafted notes.txt and started on the greeting file before running out." },
      });
      if (limit.spendCap) {
        await send({
          sessionUpdate: "usage_update",
          used: 100,
          size: 1000,
          _meta: {
            "_claude/model": "claude-opus-5-5",
            "_claude/rateLimit": {
              status: "allowed",
              rateLimitType: "five_hour",
              utilization: 0.4,
              overageStatus: "rejected",
              overageResetsAt: Math.ceil(until / 1000),
            },
          },
        } as acp.SessionNotification["update"]);
        throw internalError({ errorKind: "billing_error" }, "Internal error");
      } else {
        await send(usageUpdate("rejected", limit.type ?? "five_hour", 1, Math.ceil(until / 1000)));
      }
      if (limit.refusal === "unrecognized") throw new Error("Claude usage limit reached");
      throw internalError(
        limit.refusal === "synthetic" ? {} : { errorKind: limit.refusal === "billing" ? "billing_error" : limit.refusal === "hold" ? "account_on_hold" : "rate_limit" },
        `You've hit your ${limit.type === "seven_day_opus" ? "Opus" : "usage"} limit`,
      );
    };

    const nativeSteps = async (steps: readonly NativeStep[]): Promise<void> => {
      const name = (file: string) => file.replaceAll("{session}", sessionId);
      for (const step of steps) {
        if ("update" in step) await send(step.update);
        else if ("notice" in step) await sendNotice(step.notice.method, step.notice.params);
        else if ("wait" in step) await waitForFile(join(dir, name(step.wait)), this.stopped.signal);
        else if ("mark" in step) this.h.mark(name(step.mark));
        else if ("permission" in step) await askPermission(step.permission);
        else throw requestError(step.fail.code, step.fail.message, step.fail.data);
      }
    };

    for (const report of plan.usage ?? []) {
      if (report.model === session.model) {
        await send(usageUpdate(report.status, report.type ?? "seven_day", report.utilization, report.resetsAt, report.overage, report.paidStatus));
      }
    }

    if (session.role === "tester") {
      for (const entry of plan.testerFiles ?? []) {
        if (entry.model && entry.model !== session.model) continue;
        writeFileSync(join(entry.dir, entry.file), entry.text);
        if (entry.commit) {
          await gitOps.commitChanges(entry.dir, "Tester commits during acceptance");
        }
      }
    }

    const limit = (plan.limited ?? []).find(
      (entry) =>
        entry.model === session.model &&
        (!entry.role || entry.role === session.role) &&
        (!entry.onScreen || text.includes("You may now use the screen for")),
    );
    const until = limit && this.h.outOfUsage(limit);
    if (limit && until && !limit.afterRelease) await runOut(limit, until);

    const retry =
      session.turns === 1 ? (plan.nativeRetry ?? []).find((entry) => entry.role === session.role && (!entry.model || entry.model === session.model)) : undefined;
    if (retry) await nativeSteps(retry.steps);

    const progress = this.h.capacityProgress();
    const capacity = (plan.capacity ?? []).find(
      (entry) =>
        entry.model === session.model &&
        (!entry.role || entry.role === session.role) &&
        !(entry.onScreen && !progress.armed && !text.includes("You may now use the screen for")) &&
        progress.used < (entry.times ?? 1),
    );
    if (capacity) {
      if (capacity.waitFor) await waitForFile(join(dir, capacity.waitFor), this.stopped.signal);
      writeFixtureJson(join(dir, `capacity-${sessionId}.json`), { used: progress.used + 1, armed: true });
      if (text.includes('Set "complete" to true only')) session.maintenance = true;
      if (capacity.partial) writeFileSync(join(session.cwd, "capacity-draft.txt"), "A greeting draft\n");
      const draft = capacity.partial ? "I drafted the greeting before the model filled up.\n\n" : "";
      this.h.keep();
      if (capacity.shape) {
        if (draft) await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: draft.trim() } });
        if (capacity.shape === "claude") {
          throw internalError({ errorKind: "overloaded" }, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
        }
        if (capacity.shape === "claude-server") {
          throw internalError({ errorKind: "server_error" }, "API Error: 500 Internal server error");
        }
        if (capacity.shape === "grok") {
          throw requestError(-32603, "Model is temporarily overloaded. Try again in a moment.");
        }
        throw internalError({ message: "The service is busy. Please try again later.", http_status: 503 });
      }
      if (capacity.thrown) {
        throw internalError(
          {
            message: CODEX_MODEL_CAPACITY,
            codexErrorInfo: "serverOverloaded",
            codex_error_info: "server_overloaded",
            ...(capacity.retryAfterMs ? { retryAfterMs: capacity.retryAfterMs } : {}),
          },
          "Internal error",
        );
      }
      if (capacity.native) return { text: draft, native: true };
      return { text: `${draft}${CODEX_MODEL_CAPACITY}` };
    }

    if (text.startsWith("The selected model was at capacity.") && !plan.screen) {
      const first = session.history.find((entry) => entry.sessionUpdate === "user_message_chunk" && entry.content.type === "text");
      if (first?.sessionUpdate === "user_message_chunk" && first.content.type === "text" && !first.content.text.startsWith("The selected model was at capacity.")) {
        text = `${first.content.text}\n\n${text}`;
      }
    }

    if (plan.controlled && session.turns === 1) {
      await say(`${session.role} is working`);
      if (plan.cancelHeld) {
        const cancelled = new Promise<boolean>((resolve) => this.h.cancels.set(sessionId, () => resolve(true)));
        const released = waitForFile(join(dir, `release-${sessionId}`), this.stopped.signal).then(() => false);
        const stopped = await Promise.race([cancelled, released]);
        this.h.cancels.delete(sessionId);
        if (stopped) return { text: "", stop: "cancelled" };
      } else {
        await waitForFile(join(dir, `release-${sessionId}`), this.stopped.signal);
      }
    }

    if (plan.livePermission && session.turns === 1) {
      await askPermission("Check the guest view");
    }

    if (limit?.afterRelease && until) await runOut(limit, until);

    if (plan.maintenance && (session.maintenance || text.includes('Set "complete" to true only'))) {
      session.maintenance = true;
      const behavior = plan.maintenance;
      if (behavior.change || behavior.readOnlyWrite) writeFileSync(join(session.cwd, "maintenance.txt"), "Confirmed maintenance change\n");
      if (behavior.commit) {
        await gitOps.commitChanges(session.cwd, "Maintenance agent commit");
      }
      if (session.turns === 1 && (behavior.mismatchReply || behavior.question)) {
        if (behavior.mismatchReply) {
          const id = behavior.mismatchSetting === "model" ? "model" : "reasoning_effort";
          session.options.find((option) => option.id === id)!.currentValue = id === "model" ? "gpt-6-astra" : "high";
          await send({ sessionUpdate: "config_option_update", configOptions: session.options });
        }
        if (behavior.mismatchReply === "screen") return done({ needsScreen: { reason: "Inspect the bounded maintenance area" } });
        if (behavior.mismatchReply === "invalid") return { text: "Investigation still in progress." };
        if (behavior.mismatchReply === "validation") return done({ summary: "Investigation needs a complete result.", notes: [] });
        if (behavior.mismatchReply === "cancelled") return { text: "Investigation interrupted.", stop: "cancelled" };
        return done({ needsInput: { question: "Should I investigate the guest view?", options: ["Yes", "No"] } });
      }
      if (behavior.withdraw) {
        try {
          unlinkSync(join(session.cwd, "maintenance.txt"));
        } catch {}
      }
      if (behavior.mismatch) {
        session.options.find((option) => option.id === "reasoning_effort")!.currentValue = "high";
        await send({ sessionUpdate: "config_option_update", configOptions: session.options });
      }
      const findings = behavior.change ? "Investigated and repaired a confirmed maintenance issue." : "Investigated the selected area; no actionable defect was confirmed.";
      const answers = [...text.matchAll(/^- \[([^\]]+)\] (?:important|nit)/gm)].map((match) => ({ id: match[1], fixed: true, text: "Repaired the confirmed cause." }));
      return done({
        summary: findings,
        notes: ["The available evidence did not justify a product change."],
        complete: !behavior.incomplete,
        changes: behavior.change ? ["Removed confirmed unused code."] : [],
        answers,
        title: "Perform focused product maintenance",
      });
    }

    if (plan.screenRoles?.includes(session.role) && (!plan.screenModels || plan.screenModels.includes(session.model ?? ""))) {
      if (text.includes("You may now use the screen for")) {
        this.h.mark(`on-screen-${sessionId}`);
        if (plan.screenRoleHold) await waitForFile(join(dir, `screen-release-${sessionId}`), this.stopped.signal);
        const first = session.history.find((update) => update.sessionUpdate === "user_message_chunk");
        if (first?.sessionUpdate === "user_message_chunk" && first.content.type === "text") text = `${first.content.text}\n${text}`;
      } else if (roleOf(text)) {
        await say("Finished the background checks");
        return done({ needsScreen: { reason: SCREEN_REASON } });
      }
      if (text.includes("handed it back")) {
        const first = session.history.find((update) => update.sessionUpdate === "user_message_chunk");
        if (first?.sessionUpdate === "user_message_chunk" && first.content.type === "text") text = `${first.content.text}\n${text}`;
      }
    }

    if (plan.reviewConfirmation?.role === session.role) {
      const original = session.history.find((entry) => entry.sessionUpdate === "user_message_chunk" && entry.content.type === "text");
      const opening = original?.sessionUpdate === "user_message_chunk" && original.content.type === "text" ? original.content.text : text;
      const earlier = section(opening, "Findings so far (confirm or dispute by id)") ?? "";
      if (earlier.includes("(fixed)")) {
        const correction = text.includes("Your result block could not be used");
        const ids = findingIds(opening, "Findings so far (confirm or dispute by id)");
        if (plan.reviewConfirmation.duplicate) {
          return done({
            verdict: "fail",
            confirms: [],
            disputes: [],
            findings: [{ text: "The GREETING is missing on the welcome page!", severity: "important", ...(correction ? { evidence: plan.reopenedEvidence } : {}) }],
          });
        }
        const confirms = !correction
          ? ids
          : plan.reviewConfirmation.correction === "omit"
            ? []
            : ids.map((id) => ({
                id,
                evidence: plan.reopenedEvidence ?? "On current code, the guest welcome page still omits the greeting; the signed-in control shows it.",
              }));
        return done({ verdict: confirms.length ? "fail" : "pass", findings: [], confirms, disputes: [] });
      }
    }
    const earlierAttempt = text.includes("in an earlier attempt at this step");
    const handedBack = text.includes("handed it back");
    const terminal = `Terminal turns: ${session.terminal ?? 0}.`;
    const hang = (marker: string): Promise<Reply> => {
      this.h.mark(marker);
      return new Promise((resolve) => this.h.cancels.set(sessionId, () => resolve({ text: "", stop: "cancelled" })));
    };

    const held = async (role: string) => {
      const hold = this.h.readScript().hold;
      if (!hold || (hold.role ?? "builder") !== role || (hold.title && !text.includes(hold.title)) || !existsSync(hold.file)) return;
      writeFileSync(`${hold.file}.reached`, "");
      await waitWhileFile(hold.file, this.stopped.signal);
    };

    switch (session.role) {
      case "planner":
        await say("Sizing the work");
        return done(plannerPayload(plan, text));

      case "architect": {
        const revised =
          plan.reviseBrief &&
          session.history.some((entry) => entry.sessionUpdate === "user_message_chunk" && entry.content.type === "text" && entry.content.text.includes("## Objections so far"));
        const brief = {
          summary: "A greeting file.",
          forUsers: ["People see a greeting"],
          areas: [revised ? "Greeting, visible to everyone after the review" : "Greeting"],
          acceptance: ["A greeting file exists"],
          risks: [],
        };
        if (handedBack) return done({ ...brief, answers: [] }, terminal);
        if (text.includes("Your result block could not be used")) {
          return done({ ...brief, answers: objectionIds(text).map((id) => ({ id, status: "accepted", byCall: false, answer: "Added it to the brief." })) });
        }
        const call = section(text, "The coordinator's call (final, exact words)");
        const settled = section(text, "Objections answered after the call (answer every one again by id)");
        if (plan.architect === "writes") {
          writeFileSync(
            join(session.cwd, "architecture.txt"),
            call === undefined ? "Before the design review" : settled === undefined ? "After the coordinator's call" : "After the design check",
          );
        }
        if (call !== undefined && settled !== undefined) {
          const ids = objectionIds(settled);
          const answers = ids.map((id, index) =>
            index === 0
              ? { id, status: "accepted", byCall: false, answer: "Kept it in the brief after your note." }
              : { id, status: "accepted", byCall: true, answer: "Added it to the brief, as the call says." },
          );
          const messages = section(text, "Messages from the coordinator, in order") ?? "";
          const latest = [...messages.matchAll(/^\d+\. (.+)$/gm)].at(-1)?.[1] ?? section(text, NOTES)?.split("\n").at(-1) ?? "none";
          return done({ ...brief, answers }, `Revising: ${ids.join(", ")}. Latest note: - ${latest}`);
        }
        if (call !== undefined) {
          await say("Reading your call");
          const hold = this.h.toolFlags.find((arg) => arg.startsWith("--hold="))?.slice("--hold=".length);
          if (hold && existsSync(hold)) await waitWhileFile(hold, this.stopped.signal);
          const open = objectionIds(section(text, "Objections still open (answer every one by id)") ?? "");
          const answers = open.slice(0, open.length > 1 ? -1 : undefined).map((id, index) =>
            index === 0
              ? { id, status: "rejected", byCall: true, answer: "Removed it from the brief, as the call says." }
              : { id, status: "accepted", byCall: false, answer: "Added it to the brief." },
          );
          return done({ ...brief, answers }, `Call: ${call}. Final: ${text.includes("The call is final") ? "yes" : "no"}. Open: ${open.join(", ")}.`);
        }
        if (plan.architect !== "plain" && !text.includes("The coordinator answered")) {
          return done({ needsInput: { question: "Should the greeting be formal?", options: ["Formal", "Casual"] } });
        }
        return done({ ...brief, answers: [] });
      }

      case "check finder": {
        const checks = checkFinderPayload(plan, this.h.readScript().checks, process.execPath);
        return checks.broken ? { text: checks.text } : done(checks.payload);
      }

      case "design reviewer": {
        const review = designReviewerPayload(plan, text);
        return review.silent ? { ...done(review.payload), silent: true } : done(review.payload);
      }

      case "builder": {
        if (plan.builder === "fail-once") {
          if (roleOf(text) && !this.h.marked("builder-failed")) {
            session.failing = true;
            this.h.keep();
            this.h.mark("builder-failed");
          }
          if (session.failing) return { text: "Something went wrong, so there is no result this time." };
        }
        if (plan.mentionCapacity && session.turns === 1 && roleOf(text)) {
          writeFileSync(join(session.cwd, "greeting.txt"), "Hello\n");
          return done(
            { summary: "Added a greeting.", changes: ["People see a greeting"], tests: "1 passed" },
            `A note along the way said “${CODEX_MODEL_CAPACITY}” The work is finished.`,
          );
        }
        if (plan.screen) {
          if (text.includes("You may now use the screen for")) {
            this.h.mark(`on-screen-${sessionId}`);
            if (plan.screen === "hold") await waitForFile(join(dir, `screen-release-${sessionId}`), this.stopped.signal);
            writeFileSync(join(session.cwd, "greeting.txt"), "Hello\n");
            return done({ summary: "Added a quick note window and checked it on screen.", changes: ["A quick note window"], tests: "Clicked through it on screen" });
          }
          if (roleOf(text)) {
            writeFileSync(join(session.cwd, "notes.txt"), "A first draft\n");
            await say("Checking the window offscreen");
            if (plan.screenLate) await waitForFile(join(dir, `screen-ask-${sessionId}`), this.stopped.signal);
            return done({ needsScreen: { reason: SCREEN_REASON } }, "Everything else is done in the background.");
          }
          return done({ summary: "Took your message into account.", changes: [], tests: "1 passed" });
        }
        if (handedBack) {
          writeFileSync(join(session.cwd, "greeting.txt"), "Hello\n");
          return done({ summary: "Finished the greeting after the hand back.", changes: ["People see a greeting"], tests: "1 passed", answers: answersTo(text) }, terminal);
        }
        if (plan.builder === "restart" && !earlierAttempt && !restarted) {
          if (roleOf(text)) return done({ needsInput: { question: "Which colour should the greeting be?", options: ["Blue", "Green"] } });
          if (text.includes("The coordinator answered")) return hang("builder-answered");
          return hang("builder-interrupted");
        }
        if (plan.builder === "todo") {
          let calls = 0;
          const tool = (id: string, update: Record<string, unknown>) =>
            send({ sessionUpdate: "tool_call", toolCallId: `${id}-${session.turns}-${calls++}`, status: "completed", ...update } as acp.SessionNotification["update"]);
          if (restarted) {
            this.h.mark("builder-back");
            await waitForFile(join(dir, "go-todo"), this.stopped.signal);
            await say("Finishing the greeting");
            this.h.mark("builder-renamed");
            await waitForFile(join(dir, "go-finish"), this.stopped.signal);
          } else if (!this.h.marked("builder-todo")) {
            await send({
              sessionUpdate: "plan",
              entries: [
                { content: "- **Drafting** the `greeting` file", status: "in_progress", priority: "high" },
                { content: "Checking the greeting", status: "in_progress", priority: "medium" },
                { content: "Writing it up", status: "pending", priority: "low" },
              ],
            });
            if (plan.activity === "grok") {
              const call = (name: string, kind: string, rawInput: unknown) =>
                tool(name, { title: name, rawInput, _meta: { "x.ai/tool": { version: 1, name, kind, namespace: "grok_build" } } });
              await call("grep", "search", { pattern: "greeting", glob: "*.txt" });
              await call("read_file", "read", { target_file: join(session.cwd, "notes.txt") });
              await call("run_terminal_command", "execute", { command: "bun test" });
              await call("todo_write", "plan", { todos: [] });
              await call("run_terminal_command", "execute", { command: "ls -la" });
            } else {
              await tool("edit", { title: "Edit notes.txt", kind: "edit", locations: [{ path: join(session.cwd, "notes.txt") }] });
              await tool("read", { title: "ls", kind: "execute", rawInput: { command: "ls -la" } });
            }
            await send({
              sessionUpdate: "plan",
              entries: [
                { content: "Drafting the greeting file", status: "completed", priority: "high" },
                { content: "Checking the greeting", status: "completed", priority: "medium" },
              ],
            });
            return hang("builder-todo");
          }
          writeFileSync(join(session.cwd, "greeting.txt"), "Hello\n");
          return done({ summary: "Added a greeting.", changes: ["People see a greeting"], tests: "1 passed", answers: answersTo(text, plan.answer) });
        }
        if (plan.builder === "work" && !earlierAttempt && session.restarts < (plan.restarts ?? 1)) {
          if (roleOf(text)) {
            writeFileSync(join(session.cwd, "notes.txt"), "A first draft\n");
            await send({
              sessionUpdate: "tool_call",
              toolCallId: `edit-${session.turns}`,
              title: "Edit notes.txt",
              kind: "edit",
              status: "completed",
              locations: [{ path: join(session.cwd, "notes.txt") }],
            });
            await say("Drafting the greeting");
            return hang("builder-working");
          }
          return hang(session.restarts ? `builder-restart-${session.restarts}` : "builder-heard");
        }
        await say("Writing the greeting");
        const setup = this.h.readScript();
        if (setup.installs) {
          mkdirSync(join(session.cwd, "node_modules", "left-pad"), { recursive: true });
          writeFileSync(join(session.cwd, "node_modules", "left-pad", "index.js"), "module.exports = (text) => text;\n");
          mkdirSync(join(session.cwd, "target", "debug"), { recursive: true });
          writeFileSync(join(session.cwd, "target", "debug", "greeting.bin"), "build output\n");
          if (!existsSync(join(session.cwd, "node_modules", ".cache"))) {
            fixtureFiles.directoryLink(setup.installs.cache, join(session.cwd, "node_modules", ".cache"));
          }
        }
        let allowed = true;
        if (!plan.builder) {
          allowed = await askPermission("npm install left-pad", "npm install left-pad");
        }
        writeFileSync(join(session.cwd, "greeting.txt"), allowed ? "Hello (with left-pad)\n" : "Hello\n");
        if (plan.fixes === "change" && text.includes("You are fixing the review findings")) {
          writeFileSync(join(session.cwd, "welcome.txt"), `Hello ${Date.now()}\n`);
        }
        if (plan.leak && !text.includes("You are fixing the review findings")) {
          writeFileSync(join(session.cwd, "greeting.txt"), "Hello from internal-db-07\n");
        }
        if (plan.mergesMain && !text.includes("You are fixing the review findings")) {
          await git(session.cwd, "add", "-A");
          await git(session.cwd, "-c", "user.email=fake@example.com", "-c", "user.name=Fake", "commit", "-q", "-m", "Builder's own commit");
          await git(session.cwd, "-c", "user.email=fake@example.com", "-c", "user.name=Fake", "merge", "-q", "--no-edit", "main");
        }
        const initialScript = this.h.readScript();
        const taskTitle = text.match(/^# (?:The )?[Tt]ask: (.+)$/m)?.[1];
        if (initialScript.ownFiles && taskTitle) {
          writeFileSync(join(session.cwd, `${taskTitle.toLowerCase().replace(/\W+/g, "-")}.txt`), `${taskTitle}\n`);
        }
        await held("builder");
        const script = this.h.readScript();
        const gitlink = script.gitlink;
        if (gitlink && (await run(session.cwd, "rev-parse", `HEAD:${gitlink.path}`)) !== gitlink.sha) {
          await run(session.cwd, "update-index", "--cacheinfo", `160000,${gitlink.sha},${gitlink.path}`);
          await run(session.cwd, "add", "greeting.txt");
          await run(session.cwd, "commit", "--quiet", "-m", "Bring the submodule up to date");
        }
        const title = script.title ?? plan.title;
        const description = script.description ?? (text.includes('"description"') ? "Adds a greeting file.\n\nTested with the greeting test." : undefined);
        return done({
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          summary: "Added a greeting.",
          changes: ["People see a greeting"],
          tests: "1 passed",
          answers: answersTo(text, plan.answer),
        });
      }

      case "code reviewer": {
        await held("code reviewer");
        if (plan.reviewer === "confirm-dismissed") {
          const original = session.history.find((entry) => entry.sessionUpdate === "user_message_chunk" && entry.content.type === "text");
          const opening = original?.sessionUpdate === "user_message_chunk" && original.content.type === "text" ? original.content.text : text;
          const ids = session.model === "opus" ? [] : findingIds(opening, "Findings so far (confirm or dispute by id)");
          const confirms = text.startsWith("Your result block could not be used") ? ids.map((id) => ({ id, evidence: plan.reopenedEvidence })) : ids;
          return done({ verdict: ids.length ? "fail" : "pass", findings: [], confirms, disputes: [] });
        }
        if (plan.reviewer === "confirm") {
          return done({
            verdict: text.includes("This is review round") ? "pass" : "fail",
            findings: [],
            confirms: text.includes("This is review round") ? [] : findingIds(text, "Findings so far (confirm or dispute by id)"),
            disputes: [],
          });
        }
        if (handedBack) return done({ verdict: "pass", findings: [], confirms: [], disputes: [] }, terminal);
        if (
          plan.reviewer === "question" &&
          session.model === "opus" &&
          (session.turns === 1 || (text.includes("You may now use the screen for") && !text.includes("The coordinator answered")))
        ) {
          return done({ needsInput: { question: "Should the window keep its size?", options: ["Yes", "No"] } });
        }
        if (plan.reviewer === "work" && session.model === "opus" && !this.h.marked("reviewer-worked")) {
          this.h.mark("reviewer-worked");
          await say("Reading the change");
          return hang("reviewer-working");
        }
        if (plan.reviewer === "move-branch" && session.model === "opus" && !this.h.marked("branch-moved")) {
          this.h.mark("branch-moved");
          const branch = /on branch (\S+?)\./.exec(text)?.[1];
          if (branch) await run(session.cwd, "update-ref", `refs/heads/${branch}`, "HEAD~1");
        }
        if (plan.reviewer === "confirm-fixed" && text.includes("This is review round")) {
          return done({
            verdict: "fail",
            findings: [],
            confirms: findingIds(text, "Findings so far (confirm or dispute by id)").map((id) => ({
              id,
              evidence: plan.reopenedEvidence ?? "On current code, the guest welcome page still omits the greeting; the signed-in control shows it.",
            })),
            disputes: [],
          });
        }
        if (plan.reviewer === "confirm-fixed-one-tool" && text.includes("This is review round")) {
          return done({
            verdict: session.model === "opus" ? "fail" : "pass",
            findings: [],
            confirms:
              session.model === "opus"
                ? findingIds(text, "Findings so far (confirm or dispute by id)").map((id) => ({
                    id,
                    evidence: plan.reopenedEvidence ?? "On current code, the guest welcome page still omits the greeting; the signed-in control shows it.",
                  }))
                : [],
            disputes: [],
          });
        }
        if (
          (plan.reviewer === "important" || plan.reviewer === "important-twice" || plan.reviewer === "confirm-fixed" || plan.reviewer === "confirm-fixed-one-tool") &&
          !text.includes("This is review round") &&
          !(plan.fixes === "change" && existsSync(join(session.cwd, "welcome.txt")))
        ) {
          const opus = session.model === (plan.importantBy ?? "opus");
          if ((plan.reviewer === "important" || plan.reviewer === "confirm-fixed-one-tool") && !opus) {
            return done({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit" }], confirms: [], disputes: [] });
          }
          return done({
            verdict: "fail",
            findings: [
              {
                text: opus ? "The greeting is missing on the welcome page." : "The GREETING is missing on the welcome page!",
                where: "greeting.txt",
                severity: "important",
                evidence: "Opened the welcome page",
              },
            ],
            confirms: [],
            disputes: [],
          });
        }
        return done({
          verdict: "pass",
          findings: [
            {
              text: "Consider a friendlier greeting.",
              severity: "nit",
              evidence: "On the current welcome page the greeting is still terse; a warmer greeting would be friendlier.",
            },
          ],
          confirms: [],
          disputes: [],
        });
      }

      case "security reviewer":
        return done({ verdict: "pass", findings: [], confirms: [], disputes: [] });

      case "guide keeper": {
        const guide = guideKeeperPayload(plan);
        return guide.broken ? { text: guide.text } : done(guide.payload);
      }

      case "release manager": {
        if (plan.releaseManager === "hang" && !this.h.marked("release-manager-started")) return hang("release-manager-started");
        await say("Writing the release notes");
        const script = this.h.readScript();
        script.releaseManagerPrompts = [...(script.releaseManagerPrompts ?? []), text];
        if (script.releaseManagerCommits) {
          delete script.releaseManagerCommits;
          writeFileSync(join(session.cwd, "notes-draft.md"), "Not for the release\n");
          await gitOps.commitChanges(session.cwd, "A draft of the notes");
        }
        this.h.saveScript(script);
        await held("release manager");
        const current = this.h.readScript();
        if (current.releaseManagerWrite) writeFileSync(join(session.cwd, current.releaseManagerWrite), "Notes scratch\n");
        if (current.releaseManagerScreen && roleOf(text)) return done({ needsScreen: { reason: "Look at the released app on screen" } });
        const titles = [...text.matchAll(/^### (.+)$/gm)].map((match) => match[1]!);
        return done({
          summary: current.releaseSummary ?? `Wrote the notes on ${titles.length} change${titles.length === 1 ? "" : "s"}.`,
          notes: current.releaseNotes ?? `## What's new\n${titles.map((title) => `- ${title}`).join("\n")}`,
        });
      }

      case "verifier": {
        const correction = plan.partialVerification && session.turns > 1 ? plan.correctPartialVerification : undefined;
        if (plan.partialVerification && session.turns > 1 && !correction) {
          if (plan.limitAfterPartial) await runOut({ model: session.model!, spendCap: true }, Date.now() + 3_600_000);
          this.h.mark("partial-verification");
          return new Promise<Reply>((resolve) => this.h.cancels.set(sessionId, () => resolve({ text: "", stop: "cancelled" })));
        }
        if (correction) {
          const opening = session.history.flatMap((update) => (update.sessionUpdate === "user_message_chunk" && update.content.type === "text" ? [update.content.text] : []))[0]!;
          return done({
            verdicts: findingIds(opening, "Important findings to check (a verdict on every one, by id)").map((id, index) => {
              const verdict = index === 0 ? correction : "not-a-bug";
              return { id, verdict, reason: `After checking every finding, this one ${verdict === "real" ? "is a real problem" : "is not a bug"}.` };
            }),
          });
        }
        let notABug = plan.verifier === "not-a-bug";
        if (plan.verifier === "split") {
          try {
            writeFileSync(join(dir, "first-vote"), sessionId, { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            notABug = true;
          }
        }
        if (plan.verifier === "hold") {
          this.h.mark("verifier-voting");
          await waitForFile(join(dir, "release-vote"), this.stopped.signal);
        }
        return done(verifierVerdictsPayload(plan, text, session.model, notABug));
      }

      case "quality partner":
      case "tester":
        if (plan.tester === "no-evidence") return done({ summary: "It looks fine.", checks: [{ text: "A greeting file exists", result: "pass" }] });
        if (plan.tester === "omit-once" && !this.h.marked("tester-omitted")) {
          this.h.mark("tester-omitted");
          return done({ summary: "It looks fine.", checks: [] });
        }
        if (handedBack) return done({ summary: "Tried it after the hand back.", checks: [] }, terminal);
        if (plan.tester === "writes") {
          const final = this.h.marked("tester-passed-once");
          writeFileSync(join(session.cwd, "tester-edit.txt"), final ? "After the review\n" : "Before the review\n");
          if (final) {
            await gitOps.commitChanges(session.cwd, "Tester commits after the review");
          }
        }
        if (plan.tester === "work" && !this.h.marked("tester-worked")) {
          this.h.mark("tester-worked");
          await say("Trying it out");
          return hang("tester-working");
        }
        if (plan.testerRuns?.length) {
          const unused = plan.testerRuns.findIndex((_, index) => !this.h.marked(`tester-run-${index}`));
          const index = unused < 0 ? plan.testerRuns.length - 1 : unused;
          this.h.mark(`tester-run-${index}`);
          return done({ summary: "Tried every acceptance item.", checks: plan.testerRuns[index]!.map((check) => ({ ...check })) });
        }
        if (plan.testerChecks) {
          const checks = plan.testerChecksFixed && existsSync(join(session.cwd, "welcome.txt")) ? plan.testerChecksFixed : plan.testerChecks;
          return done({
            summary: "Tried every acceptance item.",
            checks: checks.map((entry) => ({ ...entry })),
            ...(plan.testerProofAnswers ? { proofAnswers: plan.testerProofAnswers } : {}),
          });
        }
        if (plan.tester === "blocked") {
          return done({
            summary: "I could not open the live session because its account limit is exhausted.",
            checks: [{ text: "A greeting file exists", result: "blocked", reason: "The Claude Code weekly limit prevents opening a live session." }],
          });
        }
        if (plan.tester === "always-fail") {
          return done({
            summary: "The greeting still does not appear.",
            checks: [{ text: "A greeting file exists", pass: false, evidence: "The scripted guest welcome page has no greeting; expected the greeting to be visible." }],
            ...(plan.testerProofAnswers ? { proofAnswers: plan.testerProofAnswers } : {}),
          });
        }
        if (plan.tester === "fail-once" && this.h.marked("tester-passed-once") && !this.h.marked("tester-failed-once")) {
          this.h.mark("tester-failed-once");
          return done({
            summary: "Tried it: the greeting is missing on the welcome page.",
            checks: [{ text: "A greeting file exists", pass: false, evidence: "The scripted guest welcome page has no greeting; expected the greeting to be visible." }],
          });
        }
        this.h.mark("tester-passed-once");
        return done({
          summary: "Tried it: it works.",
          checks: [{ text: "A greeting file exists", pass: true, evidence: "The scripted greeting check returned the expected result." }],
          ...(plan.testerProofAnswers ? { proofAnswers: plan.testerProofAnswers } : {}),
        });

      default: {
        if (plan.addedReviewer === "pass" && session.role === "security specialist") {
          return done({ verdict: "pass", findings: [], confirms: [], disputes: [] });
        }
        const blocks = { verdict: "fail", findings: [{ text: SECURITY_FINDING, where: "greeting.txt:1", severity: "important", evidence: "Nothing limits it." }], confirms: [] };
        const disputed = this.h.undisputed.get(sessionId);
        if (disputed && text.includes("Your result block could not be used")) {
          this.h.undisputed.delete(sessionId);
          return done({ ...blocks, disputes: disputed === "a-finding-that-is-not-listed" ? [] : [{ id: disputed, reason: DISPUTE_REASON }] });
        }
        if (text.includes('"verdict": "pass"')) {
          if (text.includes(SECURITY_FINDING)) return done({ verdict: "pass", findings: [], confirms: [], disputes: [] });
          const suggestion = /^- \[([^\]]+)\] nit \(open\): Consider a friendlier greeting\./m.exec(text)?.[1];
          const disputedId = suggestion ?? "a-finding-that-is-not-listed";
          this.h.undisputed.set(sessionId, disputedId);
          return done({ ...blocks, disputes: [disputedId] });
        }
        if (plan.notes === "work" && session.role !== "researcher" && session.restarts < 1) {
          if (roleOf(text)) writeFileSync(join(session.cwd, `${slug(session.role)}.txt`), "A first draft\n");
          await say("Drafting");
          return hang(`working-${slug(session.role)}`);
        }
        if (text.includes("[roles]") && session.role !== "researcher" && roleOf(text)) {
          const name = slug(session.role);
          const heldFile = join(dir, `hold-${name}`);
          if (existsSync(heldFile)) {
            this.h.mark(`working-${name}`);
            await waitWhileFile(heldFile, this.stopped.signal);
          }
          const readOnly = text.includes("you are read-only") || text.includes("You are read-only");
          writeFileSync(join(session.cwd, `${name}.txt`), `Written while ${readOnly ? "read-only" : "changing the product"}\n`);
          if (readOnly) {
            await gitOps.commitChanges(session.cwd, `${session.role} commits anyway`);
          }
        }
        const report = plan.reports?.[session.role];
        if (report) return done({ summary: report.summary, notes: report.notes }, report.prose);
        return done({ summary: `Notes from the ${session.role}.`, notes: [`A note from the ${session.role}`] });
      }
    }
  }

  async guide(text: string, messageId: string): Promise<AgentInputReceipt> {
    const live = ADAPTERS[this.launch.profile.toolId]?.liveInput;
    if (!live || !this.liveInput || !this.prompting) return "unsupported";
    const request = live.request(this.sessionId, text, messageId);
    const plan = this.h.readScenario();
    try {
      let response: unknown;
      if (request.method === "_session/steering") {
        const params = request.params as { sessionId: string; prompt: { text: string }[]; _meta?: unknown };
        appendFileSync(join(this.h.dir, "live.jsonl"), `${JSON.stringify({ ...params, text: params.prompt.map((part) => part.text).join("\n") })}\n`);
        if (plan.liveAckHeld) await waitForFile(join(this.h.dir, `ack-${params.sessionId}`), this.stopped.signal);
        if (plan.live === "refused") throw requestError(-32600, "Live guidance refused");
        response = plan.live === "null" ? null : { outcome: plan.live ?? "failed" };
      } else if (request.method === "_x.ai/interject") {
        const params = request.params as { sessionId: string; text: string; interjectionId?: string };
        if (plan.liveProbe === "null") response = null;
        else {
          appendFileSync(join(this.h.dir, "live.jsonl"), `${JSON.stringify(params)}\n`);
          response = { status: "queued" };
        }
      } else {
        return "unsupported";
      }
      return live.receipt(response);
    } catch (error) {
      const code = (error as { code?: number } | null)?.code;
      return code !== undefined && [-32600, -32601, -32602].includes(code) ? "rejected" : "unknown";
    }
  }

  async cancel(): Promise<void> {
    appendFileSync(join(this.h.dir, "cancelled.jsonl"), `${JSON.stringify({ sessionId: this.sessionId })}\n`);
    this.h.cancels.get(this.sessionId)?.();
    this.h.cancels.delete(this.sessionId);
  }

  flushMessages(interrupted = true): void {
    this.messages.boundary(interrupted);
  }

  close(): void {
    this.flushMessages();
    this.h.cancels.get(this.sessionId)?.();
    this.h.cancels.delete(this.sessionId);
    this.exitCode = 0;
    this.stopped.abort();
    this.resolveGone();
  }

  async stop(): Promise<boolean> {
    this.flushMessages();
    this.close();
    this.launch.signal.removeEventListener("abort", this.onSignalAbort);
    await this.pending?.catch(() => undefined);
    return true;
  }
}
