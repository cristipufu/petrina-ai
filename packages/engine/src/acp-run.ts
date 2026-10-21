// One agent session over ACP: start the tool's adapter, open a session in the task's
// worktree (or reopen an earlier one), pin model, effort and mode, then send turns and report
// what happens. It also reads back what the tool says the session runs on, and what each turn used.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { inFamily, type ProfileChoices, type AgentProfile, type TokenCounts, type TurnReport } from "@petrina/core";
import { type ClaudeSandbox, SandboxUnavailable, sandboxFailure } from "./sandbox.js";
import { adapterEntry, ADAPTERS } from "./tools.js";
import { AgentBrowser } from "./browser.js";
import { descendants, descendantsKnown } from "./process-tree.js";
import { codexCapacityFailure, codexModelAtCapacity, limitFromFailure, limitFromReport, ModelAtCapacity, type UsageInfo, type UsageLimited } from "./usage.js";
import { AgentMessages, type AgentMessage } from "./agent-messages.js";
import { browserTarget, commandOf, describeTool, isPlumbing, kindOf, type ToolActivity } from "./tool-activity.js";
import type { AccountReading } from "./tool-adapter.js";
import { ownSession } from "./env.js";
import { ToolInvocations, type ToolActivityEvent } from "./tool-invocations.js";

export interface PermissionInfo {
  title: string;
  kind: string;
  /** The command, when the agent wants to run one. */
  command?: string;
  /** Paths the tool call touches. */
  paths: string[];
  /** A plain description of a browser target, when the tool actually names it. */
  target?: string;
}

export interface RunCallbacks {
  /** A public progress message, updated in place as its text arrives. Never private reasoning. */
  onMessage?(message: AgentMessage): void;
  /** A plain-language line about what the agent is doing. */
  onActivity(text: string): void;
  /** Actual invocations and their streamed evidence, separate from public text. */
  onToolActivity?(event: ToolActivityEvent): void;
  /** The step of its own plan the agent is on. */
  onPlanStep(text: string): void;
  onPermission(info: PermissionInfo): Promise<"allow" | "deny">;
  onLog?(text: string): void;
  /** A bounded stop could not confirm that all programs started by this tool have exited. */
  onCleanupIncomplete?(): void;
  /** The tool said how much of a usage limit is used (every report, whether or not it is close). */
  onUsage?(info: UsageInfo): void;
  /** A complete native account response, including changed quota groups after a subscription change. */
  onAccountUsage?(reports: readonly UsageInfo[]): void;
  /** What the tool says it is logged in with, when it says: "none" means not logged in. */
  onAuthStatus?(kind: string): void;
}

/** The notification Claude Code's and Codex's connectors send, unasked, with the login they run on. */
const AUTH_STATUS_UPDATE = "_auth/status_update";

/** What the tool confirmed the session runs on. A missing value: not confirmed. */
export interface SessionSettings {
  model?: string;
  /** The tool's own name for the model, e.g. "Opus 5.5". */
  modelName?: string;
  effort?: string;
}

/** What the tool said during a turn about how it ran, kept even when the turn never finished. */
export interface TurnNotes {
  /** What the tool switched the model or effort to during the turn. */
  changed: { model?: string; effort?: string };
  /** Codex rerouted the turn to another model. */
  rerouted: boolean;
  /** Helper agents the agent started during the turn. */
  helpers: number;
  /** The model the tool said answered (Claude Code names it on its context updates). */
  modelSeen?: string;
}

export interface TurnResult extends TurnNotes {
  stopReason: string;
  text: string;
  /** Public messages have already reached the saved conversation through onMessage. */
  streamed?: boolean;
  /** What the tool reported about tokens. Missing: nothing reported. */
  report?: TurnReport;
}

type ConfigOption = { id: string; currentValue?: unknown; options?: ({ value?: string; name?: string; options?: { value?: string; name?: string }[] } | undefined)[] };

/** Every choice of a select option, groups flattened. */
function choices(option: ConfigOption | undefined): { value: string; name?: string }[] {
  const flat: { value: string; name?: string }[] = [];
  for (const entry of option?.options ?? []) {
    if (!entry) continue;
    if (Array.isArray(entry.options)) for (const inner of entry.options) if (typeof inner.value === "string") flat.push({ value: inner.value, ...(inner.name ? { name: inner.name } : {}) });
    if (typeof entry.value === "string") flat.push({ value: entry.value, ...(entry.name ? { name: entry.name } : {}) });
  }
  return flat;
}

/** The option without its current value: what it is set to is not confirmed. */
const unconfirmed = ({ currentValue: _value, ...option }: ConfigOption): ConfigOption => option;

/** Read what the session is set to from the tool's config options, never guessing. */
export function settingsOf(options: readonly ConfigOption[], ids: { model: string; effort: string }): SessionSettings {
  const model = options.find((entry) => entry.id === ids.model);
  const effort = options.find((entry) => entry.id === ids.effort);
  const modelValue = typeof model?.currentValue === "string" && model.currentValue ? model.currentValue : undefined;
  const name = modelValue ? choices(model).find((entry) => entry.value === modelValue)?.name : undefined;
  const effortValue = typeof effort?.currentValue === "string" && effort.currentValue ? effort.currentValue : undefined;
  return { ...(modelValue ? { model: modelValue } : {}), ...(name ? { modelName: name } : {}), ...(effortValue ? { effort: effortValue } : {}) };
}

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

function defined(counts: TokenCounts): TokenCounts {
  return Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== undefined)) as TokenCounts;
}

/**
 * The token figures a prompt response carries: ACP's `usage` (the main figure) and the
 * per-model rows both adapters attach under `_meta.quota.model_usage`. The dollar figure
 * Claude Code sends is never read.
 */
export function reportOf(response: unknown, toolId?: string): TurnReport | undefined {
  const adapter = toolId ? ADAPTERS[toolId] : undefined;
  if (adapter?.parseTurnReport) return adapter.parseTurnReport(response);
  if (!response || typeof response !== "object") return undefined;
  const { usage, _meta } = response as { usage?: Record<string, unknown> | null; _meta?: { quota?: { model_usage?: unknown } } | null };
  const report: { main?: TokenCounts; models?: { model: string; counts: TokenCounts }[] } = {};
  if (usage && typeof usage === "object") {
    report.main = defined({ input: count(usage.inputTokens), cacheRead: count(usage.cachedReadTokens), cacheWrite: count(usage.cachedWriteTokens), output: count(usage.outputTokens), reasoning: count(usage.thoughtTokens), total: count(usage.totalTokens) });
  }
  const rows = _meta?.quota?.model_usage;
  if (Array.isArray(rows)) {
    report.models = rows.flatMap((row) => {
      const { model, token_count: tokens } = (row ?? {}) as { model?: unknown; token_count?: Record<string, unknown> };
      if (typeof model !== "string" || !model.trim() || !tokens || typeof tokens !== "object") return [];
      const counts = defined({
        input: count(tokens.inputTokens),
        cacheRead: count(tokens.cachedInputTokens),
        cacheWrite: count(tokens.cachedWriteTokens ?? tokens.cacheWriteInputTokens),
        output: count(tokens.outputTokens),
        reasoning: count(tokens.reasoningOutputTokens),
        total: count(tokens.totalTokens),
      });
      return [{ model, counts }];
    });
  }
  return report.main || report.models?.length ? report : undefined;
}

/** "Model rerouted from X to Y (reason)" or "Switched from X to Y (reason)": the model Codex moved to. */
export function reroutedTo(text: string): string | undefined {
  const match = /(?:rerouted|switched)\s+from\s+\S+\s+to\s+(\S+)/i.exec(text);
  const model = match?.[1]?.replace(/[.,;:)]+$/, "");
  return model && model.length <= 120 ? model : undefined;
}

/** How long Petrina waits for a tool to reopen a conversation before it starts a fresh one. */
const REOPEN_TIMEOUT_MS = 60_000;
/** How long a tool gets to start a fresh conversation: handshake, new session and its settings. */
const START_TIMEOUT_MS = 2 * 60_000;

/** How long a tool that gave up starting gets to stop by itself before it is forced to. */
const FORCE_AFTER_MS = 2_000;

/** The tool could not reopen the conversation. The message says why, in plain words. */
export class ReopenFailed extends Error {}

const duration = (ms: number): string => (ms === 60_000 ? "a minute" : `${Math.max(1, Math.round(ms / 1000))} seconds`);

/** ACP's generic wrapper can carry the useful provider diagnostic in data.message. Keep its code and data. */
function providerError(error: unknown): unknown {
  if (!(error instanceof Error) || error.message !== "Internal error") return error;
  const data = (error as Error & { data?: unknown }).data;
  const detail = data && typeof data === "object" ? (data as { message?: unknown }).message : undefined;
  if (typeof detail === "string" && detail.trim()) error.message = detail;
  return error;
}

interface RunState {
  text: string;
  messages: AgentMessages;
  lastActivity: string;
  activeToolCall?: string;
  tools?: ToolInvocations;
  quiet: boolean;
  settings: SessionSettings;
  latest?: UsageInfo;
  /** Native account command output is never an agent message or part of the task conversation. */
  accountText?: string;
  turn?: { changed: { model?: string; effort?: string }; rerouted: boolean; helpers: Set<string>; modelSeen?: string; next?: SessionSettings };
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function send(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function exited(pids: readonly number[], ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (!pids.some(alive)) return true;
  return !pids.some(alive);
}

/**
 * Stop the tool and every program it started (a build, a test run, a server), which could otherwise keep
 * writing in the working copy after the tool is gone. They are found while the tool still runs, since they
 * lose their link to it once it exits. Resolves when they have all exited; forced after a few seconds.
 */
async function stopAll(child: ChildProcess, graceMs: number, collectPrograms: boolean): Promise<boolean> {
  if (child.pid === undefined) return true;
  if (process.platform === "win32") {
    if (!running(child)) return true;
    return new Promise<boolean>((resolve) => execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, (error) => resolve(!error)));
  }
  // Login probes never receive work. Stop their group at once, so a process lookup cannot hold
  // their forced stop past the tool check's deadline for starting the next probe.
  // launch.ts forces engine exit after seven seconds. Reserve its last second for confirming
  // the kill; process lookup and graceful stopping share the preceding six seconds.
  const forceBy = Date.now() + 6_000;
  const rescanBudget = collectPrograms ? 1_200 : 0;
  let complete = true;
  let pids = [child.pid];
  if (collectPrograms && running(child)) {
    // One read, long enough for a slow process list. A failed read is not an empty tree.
    const workers = await descendants([child.pid]);
    if (workers === undefined) complete = false;
    else pids.push(...workers);
  }
  send([-child.pid], "SIGTERM");
  send(pids, "SIGTERM");
  // A slow or failed first lookup must not let the grace wait consume the final lookup.
  const graceLeft = Math.max(0, forceBy - rescanBudget - Date.now());
  if (await exited([-child.pid, ...pids], Math.min(graceMs, graceLeft))) return complete;
  // Whatever ignored the request to stop is killed, with anything it started meanwhile.
  // Leave most of the lookup budget to the first snapshot on a busy machine; still fit the app's quit deadline.
  if (collectPrograms) {
    const workers = await descendantsKnown(pids.filter(alive), Math.min(rescanBudget, Math.max(0, forceBy - Date.now())));
    if (workers === undefined) complete = false;
    else pids.push(...workers);
  }
  pids = [...new Set(pids)].filter(alive);
  send([-child.pid], "SIGKILL");
  send(pids, "SIGKILL");
  return (await exited([-child.pid, ...pids], 1_000)) && complete;
}

export class AgentRun {
  private notes: TurnNotes | undefined;
  private accountBefore: AccountReading | undefined;
  private acceptsLiveInput = false;
  onPromptStarted?: () => void;

  get liveInput(): boolean { return this.acceptsLiveInput; }
  get prompting(): boolean { return this.state.turn !== undefined; }

  /** A lost reply is uncertain: it must never become an automatic second delivery. */
  async guide(text: string, messageId: string): Promise<"unsupported" | "unknown" | "current-turn" | "accepted" | "separate-turn" | "prompt-required" | "rejected"> {
    const live = ADAPTERS[this.profile.toolId]?.liveInput;
    if (!live || !this.acceptsLiveInput || !this.prompting) return "unsupported";
    const request = live.request(this.sessionId, text, messageId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onExit!: () => void;
    const gone = new Promise<never>((_, reject) => {
      onExit = () => reject(new Error("The tool stopped before confirming live input"));
      this.child.once("exit", onExit);
      if (!running(this.child)) onExit();
    });
    try {
      const response = await Promise.race([
        this.connection.extMethod(request.method, request.params),
        gone,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Live input was not confirmed")), 10_000); }),
      ]);
      return live.receipt(response);
    } catch (error) {
      const code = (error as { code?: number } | null)?.code;
      return code !== undefined && [-32600, -32601, -32602].includes(code) ? "rejected" : "unknown";
    } finally { clearTimeout(timer); this.child.removeListener("exit", onExit); }
  }

  /** Read native configuration without sending work to a model. Set when the session opens. */
  profileChoices!: (modelId?: string) => Promise<ProfileChoices>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: acp.ClientSideConnection,
    /** The tool's id for the conversation. */
    readonly sessionId: string,
    private readonly state: RunState,
    private readonly profile: AgentProfile,
    private readonly stopper: (graceMs?: number) => Promise<boolean>,
    /** How an earlier conversation was reopened; unset for a new one. */
    readonly reopened?: "resume" | "load",
    readonly browser?: AgentBrowser,
    private readonly callbacks?: RunCallbacks,
  ) {}

  /** What the tool confirmed the session runs on right now. */
  get settings(): SessionSettings {
    return { ...this.state.settings };
  }

  /** What the tool said during the last turn, also when the agent stopped before replying. */
  get lastTurn(): TurnNotes | undefined {
    return this.notes && { ...this.notes, changed: { ...this.notes.changed } };
  }

  /**
   * With `reopen`, pick up that conversation: by the tool's resume, which replays nothing, or by
   * load when that is all it offers. Anything that keeps it from reopening within the time limit
   * (no support, an error, no answer) throws ReopenFailed, and the agent process is gone. A tool that
   * does not start within `startTimeoutMs` is stopped and throws, so a step never waits forever.
   * A login probe gets a failed start at once while its tool stops; a task waits for the tool and
   * its programs to stop before it can release the working copy. `onGone` observes either stop.
   * With `sandbox`, the conversation opens in Claude Code's own sandbox; when Claude Code says it
   * cannot start, new or reopened, this throws SandboxUnavailable instead.
   */
  static async start(options: {
    profile: AgentProfile;
    cwd: string;
    callbacks: RunCallbacks;
    signal: AbortSignal;
    command?: readonly string[];
    env?: NodeJS.ProcessEnv;
    reopen?: string;
    reopenTimeoutMs?: number;
    startTimeoutMs?: number;
    onGone?: (gone: Promise<void>) => void;
    onProcess?: (child: ChildProcess) => void;
    /** A login check only opens a conversation, never sends work or runs in a product's copy. */
    probe?: boolean;
    /** Run the tool's native sign-in, only after an explicit coordinator action. */
    authenticate?: string;
    /** When false, no browser is started. Identity checks do not look at a page. Defaults to true. */
    browser?: boolean;
    sandbox?: ClaudeSandbox;
    browserRoot?: string;
  }): Promise<AgentRun> {
    const { profile, cwd, callbacks, signal } = options;
    const adapter = ADAPTERS[profile.toolId];
    if (!adapter) throw new Error(`No adapter for tool ${profile.toolId}`);
    // Stopped before it started: an aborted signal never fires again, so never start the agent at all.
    if (signal.aborted) throw new Error("Stopped before the agent started");

    const [program, ...args] = options.command ?? adapter.command ?? ["node", adapterEntry(adapter)];
    const env = ownSession(options.env ?? process.env);
    adapter.prepareEnv?.(env);

    // windowsHide: no console window flashes up on Windows when an agent starts.
    const child = spawn(program!, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env, detached: process.platform !== "win32", windowsHide: true });
    options.onProcess?.(child);
    child.stderr?.on("data", (chunk: Buffer) => callbacks.onLog?.(chunk.toString()));
    const killed = new Promise<never>((_, reject) => {
      child.once("exit", (code) => reject(new Error(`${adapter.name} stopped (exit ${code ?? "signal"})`)));
      child.once("error", (error) => reject(error));
    });
    killed.catch(() => undefined);
    // Login probes send no work. Every coding agent, including a parallel reviewer or a
    // reopened builder, gets a new engine-owned browser within the opening deadline.
    // An identity check never opens a page, so it starts no browser.
    const showBrowser = !signal.aborted && !options.probe && options.browser !== false;
    const browserReady = showBrowser ? AgentBrowser.start(options.browserRoot, options.env ?? process.env, callbacks.onLog) : Promise.resolve(undefined);
    browserReady.catch(() => undefined);
    let stopping: Promise<boolean> | undefined;
    let cleanupNoticeSent = false;
    let disposableSession: string | undefined;
    const stop = (graceMs = FORCE_AFTER_MS) => (stopping ??= Promise.all([
      stopAll(child, graceMs, !options.probe),
      browserReady.then((browser) => browser?.close()).then(() => true, () => false),
    ]).then(async (results) => {
      signal.removeEventListener("abort", abort);
      let complete = results.every(Boolean);
      if (complete && disposableSession && adapter.forgetProbe) {
        try { await adapter.forgetProbe(disposableSession, env); }
        catch { complete = false; }
      }
      if (!complete && !cleanupNoticeSent) {
        cleanupNoticeSent = true;
        callbacks.onCleanupIncomplete?.();
      }
      return complete;
    }));
    options.onGone?.(new Promise<void>((done) => {
      child.once("exit", () => done());
      child.once("error", () => done());
    }).then(async () => { await stopping; }));
    const abort = () => void stop();
    signal.addEventListener("abort", abort, { once: true });
    // Stopped while starting: give up at once, without waiting for a tool that ignores being stopped.
    let openingAborted!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      openingAborted = () => reject(new Error("Stopped before the agent started"));
      signal.addEventListener("abort", openingAborted, { once: true });
    });
    stopped.catch(() => undefined);
    if (signal.aborted) { abort(); openingAborted(); }

    // A reopened conversation stays quiet until Petrina's first message: what load replays is history,
    // already in the session view and timeline.
    const state: RunState = { text: "", messages: new AgentMessages(callbacks.onMessage), lastActivity: "", quiet: options.reopen !== undefined, settings: {} };
    // The session's options as the tool last sent them, while the model, effort and mode are set.
    let sessionOptions: ConfigOption[] = [];
    const optionIds = { model: adapter.options.model, effort: adapter.options.effort };
    // The tool can change the session's model or effort by itself (a fallback): keep what it says.
    const readSettings = (options: readonly ConfigOption[]) => {
      const next = settingsOf(options, optionIds);
      const turn = state.turn;
      if (turn) {
        if (next.model && next.model !== state.settings.model) turn.changed.model = next.modelName ?? next.model;
        if (next.effort && next.effort !== state.settings.effort) turn.changed.effort = next.effort;
        turn.next = next;
      } else {
        state.settings = next;
      }
    };
    const noteReroute = (text: string) => {
      const model = state.turn && reroutedTo(text);
      if (model && state.turn) {
        state.turn.changed.model = model;
        state.turn.rerouted = true;
      }
    };
    const tools = state.tools = new ToolInvocations(event => {
      if (event.isNew) state.messages.activity();
      callbacks.onToolActivity?.(event);
    });
    const publishTool = (call: ToolActivity, isNew = false) => {
      if (isPlumbing(call)) return;
      const line = describeTool(call);
      if (!isNew && line === state.lastActivity) return;
      state.messages.activity();
      state.lastActivity = line;
      callbacks.onActivity(line);
    };
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);

    const connection = new acp.ClientSideConnection(
      () => ({
        async requestPermission(params) {
          if (state.quiet) return { outcome: { outcome: "cancelled" } };
          const call = params.toolCall;
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
          const option = order.map((kind) => params.options.find((entry) => entry.kind === kind)).find((entry) => entry !== undefined);
          if (!option) return { outcome: { outcome: "cancelled" } };
          return { outcome: { outcome: "selected", optionId: option.optionId } };
        },
        async sessionUpdate(params) {
          if (state.accountText !== undefined) {
            if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") state.accountText = `${state.accountText}${params.update.content.text}`.slice(0, 32_000);
            return;
          }
          if (state.quiet) return;
          const update = params.update;
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              state.activeToolCall = undefined;
              if (update.content.type === "text") {
                const source = "messageId" in update && typeof update.messageId === "string" ? update.messageId : undefined;
                if (state.messages.push(update.content.text, source) && state.text) state.text += "\n\n";
                state.text += update.content.text;
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
            case "config_option_update":
              sessionOptions = update.configOptions as ConfigOption[];
              readSettings(sessionOptions);
              break;
            case "usage_update": {
              const meta = update._meta ?? {};
              const native = adapter.parseUsageUpdate?.(meta);
              const reports = native?.reports ?? [];
              for (const info of reports) callbacks.onUsage?.(info);
              // A rejected spend cap outranks an open session window from the same note.
              if (reports.length) state.latest = reports.find((info) => info.status === "rejected") ?? reports[0];
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
              if (state.activeToolCall === update.toolCallId && [update.title, update.kind, update.rawInput, update.locations, update._meta].some(value => value !== null && value !== undefined)) publishTool(merged);
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
        async extNotification(method, params) {
          if (method !== AUTH_STATUS_UPDATE && method !== AUTH_STATUS_UPDATE.slice(1)) return;
          const kind = (params as { authStatus?: { kind?: unknown } }).authStatus?.kind;
          if (typeof kind === "string") callbacks.onAuthStatus?.(kind);
        },
      }),
      stream,
    );

    let acceptsLiveInput = false;
    const open = async (): Promise<{ sessionId: string; configOptions?: unknown; how?: "resume" | "load" }> => {
      if (signal.aborted) throw new Error("Stopped before the agent started");
      // Notices let Codex announce a reroute as a typed update instead of text in the reply.
      const [init, browser] = await Promise.all([
        connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {} } } }),
        browserReady,
      ]);
      const sessionId = options.reopen;
      const live = adapter.liveInput;
      acceptsLiveInput = !options.probe && !!live?.supported(init);
      if (acceptsLiveInput && live?.probe) {
        const probe = live.probe;
        acceptsLiveInput = await connection.extMethod(probe.method, probe.params).then(() => false, error => probe.recognizedError(error));
      }
      if (options.authenticate) await connection.authenticate({ methodId: options.authenticate });
      // Keep the tool's session mode (Grok's auto mode) and add sandbox settings only for Claude Code.
      // The same metadata goes to new, resumed and loaded conversations.
      const baseMeta: Record<string, unknown> = { ...adapter.sessionMeta, ...(options.sandbox && adapter.sandboxMeta ? adapter.sandboxMeta(options.sandbox) : {}) };
      const sessionMeta = adapter.prepareSessionMeta ? await adapter.prepareSessionMeta(baseMeta, { cwd, browser: !!browser }) : baseMeta;
      const meta = Object.keys(sessionMeta).length ? { _meta: sessionMeta } : {};
      const mcpServers = browser ? [browser.mcp] : [];
      if (sessionId === undefined) {
        const opened = await connection.newSession({ cwd, mcpServers, ...meta });
        if (options.probe) disposableSession = opened.sessionId;
        return opened;
      }
      const how = init.agentCapabilities?.sessionCapabilities?.resume ? "resume" : init.agentCapabilities?.loadSession ? "load" : undefined;
      if (!how) throw new ReopenFailed(`${adapter.name} cannot reopen conversations`);
      const limit = options.reopenTimeoutMs ?? REOPEN_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new ReopenFailed(`${adapter.name} did not reopen the conversation within ${duration(limit)}`)), limit)));
      const params = { sessionId, cwd, mcpServers, ...meta };
      try {
        const opened = await Promise.race([how === "resume" ? connection.resumeSession(params) : connection.loadSession(params), late]);
        return { ...opened, sessionId, how };
      } catch (error) {
        if (error instanceof ReopenFailed || sandboxFailure(error) !== undefined) throw error;
        throw new ReopenFailed(`${adapter.name} could not reopen the conversation`);
      } finally {
        clearTimeout(timer);
      }
    };

    // The same rules for a new and a reopened conversation: model, effort, then the automatic safety mode.
    // Opening is limited as a whole, handshake and settings included, so a tool that never answers never
    // hangs the step: a reopen falls back to a fresh conversation, and a fresh one fails the step, to try again.
    let whole: ReturnType<typeof setTimeout> | undefined;
    const fresh = options.reopen === undefined;
    const limit = fresh ? (options.startTimeoutMs ?? START_TIMEOUT_MS) : (options.reopenTimeoutMs ?? REOPEN_TIMEOUT_MS);
    const deadline = new Promise<never>(
      (_, reject) =>
        (whole = setTimeout(
          () => reject(fresh ? new Error(`${adapter.name} did not start within ${duration(limit)}. Try again; if it keeps happening, check that ${adapter.name} starts in a terminal.`) : new ReopenFailed(`${adapter.name} did not reopen the conversation within ${duration(limit)}`)),
          limit,
        )),
    );
    deadline.catch(() => undefined);
    const ready = (async () => {
      const session = await open();
      sessionOptions = ((session as { configOptions?: ConfigOption[] }).configOptions ?? []) as ConfigOption[];
      // Account probes send no work. Opening already tests authentication; model, thinking and
      // permission configuration only adds failure points to this short readiness check.
      if (options.probe) return session;
      const set = async (configId: string, value: string | undefined): Promise<boolean> => {
        if (!value) return false;
        const option = sessionOptions.find((entry) => entry.id === configId);
        // A value the tool doesn't offer is not forced: the session keeps the tool's default, and that is recorded.
        if (!option || !choices(option).some((entry) => entry.value === value)) return false;
        if (option.currentValue === value) return true;
        const before = sessionOptions;
        const response = await connection.setSessionConfigOption({ sessionId: session.sessionId, configId, value });
        const echoed = (response as { configOptions?: ConfigOption[] } | undefined)?.configOptions;
        if (Array.isArray(echoed)) sessionOptions = echoed;
        // A bare acknowledgement doesn't say what the session ended up on: not confirmed, never assumed,
        // unless the tool sent its options in an update meanwhile.
        else if (sessionOptions === before) sessionOptions = sessionOptions.map((entry) => (entry.id === configId ? unconfirmed(entry) : entry));
        return true;
      };
      await set(adapter.options.model, profile.modelId);
      await set(adapter.options.effort, profile.effort);
      // Mode last: Claude Code drops Auto when the model changes after it. A tool whose mode is session
      // metadata (Grok's auto mode) has already asked for it, and has no config option to set.
      const automatic = adapter.sessionMeta !== undefined || (adapter.options.mode !== undefined && (await set(adapter.options.mode, adapter.mode)));
      if (!automatic) callbacks.onLog?.(`${adapter.name}'s automatic safety mode is not available here, so it will ask you before acting`);
      readSettings(sessionOptions);
      adapter.verifySessionSettings?.(profile, state.settings);
      return session;
    })();
    ready.catch(() => undefined);

    try {
      const session = await Promise.race([ready, killed, deadline, stopped]);
      const agent = new AgentRun(child, connection, session.sessionId, state, profile, stop, session.how, await browserReady, callbacks);
      agent.acceptsLiveInput = acceptsLiveInput;
      agent.profileChoices = async (requestedModel?: string): Promise<ProfileChoices> => {
        const modelOption = () => sessionOptions.find(option => option.id === adapter.options.model);
        const models = choices(modelOption()).map(choice => ({ id: choice.value, name: choice.name ?? choice.value }));
        const modelId = requestedModel ?? (typeof modelOption()?.currentValue === "string" ? modelOption()!.currentValue as string : models[0]?.id);
        if (!modelId || !models.some(model => model.id === modelId)) throw new Error(`${adapter.name} did not offer that model.`);
        if (modelOption()?.currentValue !== modelId) {
          const before = sessionOptions;
          const response = await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: adapter.options.model, value: modelId });
          const echoed = (response as { configOptions?: ConfigOption[] }).configOptions;
          if (Array.isArray(echoed)) sessionOptions = echoed;
          else if (sessionOptions === before) throw new Error(`${adapter.name} did not confirm its model settings.`);
        }
        if (modelOption()?.currentValue !== modelId) throw new Error(`${adapter.name} did not confirm the selected model.`);
        const known = new Set(["low", "medium", "high", "xhigh", "ultra"]);
        const efforts = choices(sessionOptions.find(option => option.id === adapter.options.effort)).map(choice => choice.value).filter(value => known.has(value)) as AgentProfile["effort"][];
        if (!efforts.length) throw new Error(`${adapter.name} did not report supported effort levels for this model.`);
        return { toolId: profile.toolId, models, modelId, efforts };
      };
      if (adapter.accountUsage && !options.probe) agent.accountBefore = await Promise.race([agent.readAccountUsage(), killed, deadline, stopped]);
      clearTimeout(whole);
      return agent;
    } catch (error) {
      clearTimeout(whole);
      // No agent left running behind a conversation that did not open, even one that ignores being stopped.
      signal.removeEventListener("abort", abort);
      const gone = stop();
      // A tool check must report its deadline promptly. It tracks onGone before checking again;
      // a task instead waits for all file handling before cleanup can remove its working copy.
      if (!options.probe) await gone;
      const unsandboxed = options.sandbox && !signal.aborted ? sandboxFailure(error) : undefined;
      if (unsandboxed !== undefined) throw new SandboxUnavailable(unsandboxed);
      if (options.reopen !== undefined && !(error instanceof ReopenFailed) && !signal.aborted) throw new ReopenFailed(`${adapter.name} could not reopen the conversation`);
      throw providerError(error);
    } finally {
      signal.removeEventListener("abort", openingAborted);
    }
  }

  /** Send one turn and wait for it to end. Returns everything the agent said in it, and what it used. */
  async prompt(text: string): Promise<TurnResult> {
    this.state.messages.boundary();
    this.state.quiet = false;
    this.state.text = "";
    delete this.state.latest;
    const turn: NonNullable<RunState["turn"]> = { changed: {}, rerouted: false, helpers: new Set() };
    this.state.turn = turn;
    this.state.activeToolCall = undefined;
    this.state.tools?.startTurn();
    this.notes = undefined;
    const notes = (): TurnNotes => ({ changed: { ...turn.changed }, rerouted: turn.rerouted, helpers: turn.helpers.size, ...(turn.modelSeen ? { modelSeen: turn.modelSeen } : {}) });
    let toolsEnded = false;
    const endTools = () => { if (!toolsEnded) { toolsEnded = true; this.state.tools?.endTurn(); } };
    let onExit!: (code: number | null) => void;
    const exited = new Promise<never>((_, reject) => {
      onExit = code => reject(new Error(`The agent stopped (exit ${code ?? "signal"})`));
      this.child.once("exit", onExit);
    });
    exited.catch(() => undefined);
    try {
      if (ADAPTERS[this.profile.toolId]?.accountUsage) { const out = this.rejected(); if (out) throw out; }
      const pending = this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] });
      this.onPromptStarted?.();
      const response = await Promise.race([pending, exited]).catch(async (error: unknown) => {
        endTools();
        if (ADAPTERS[this.profile.toolId]?.accountUsage) await this.readAccountUsage();
        throw this.capacityOf(error) ?? this.limitOf(error) ?? providerError(error);
      });
      endTools();
      if (response.stopReason !== "end_turn" && response.stopReason !== "cancelled") {
        const out = this.rejected();
        if (out) {
          if (this.state.messages.streamed) out.streamed = true;
          throw out;
        }
      }
      const accounting = ADAPTERS[this.profile.toolId]?.accountUsage;
      const report = accounting ? accounting.turnReport(this.accountBefore, await this.readAccountUsage()) : reportOf(response, this.profile.toolId);
      // A finished turn can carry the overloaded stop on the response itself, with no sentence in the agent's text.
      const full = this.capacityOf(response);
      if (full) throw full;
      return { stopReason: response.stopReason, text: this.state.text, ...(this.state.messages.streamed ? { streamed: true } : {}), ...(report ? { report } : {}), ...notes() };
    } finally {
      this.child.removeListener("exit", onExit);
      endTools();
      this.state.messages.boundary();
      this.notes = notes();
      this.state.turn = undefined;
      // Later turns run on whatever the tool switched the session to. A Codex reroute is per turn.
      if (turn.next) this.state.settings = turn.next;
    }
  }

  /** The adapter's native account command: no AI call or task message. */
  async readAccountUsage(): Promise<AccountReading | undefined> {
    if (!running(this.child)) { this.accountBefore = undefined; return undefined; }
    const adapter = ADAPTERS[this.profile.toolId];
    const accounting = adapter?.accountUsage;
    if (!accounting) return undefined;
    this.state.accountText = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let onExit!: () => void;
    const exited = new Promise<never>((_, reject) => {
      onExit = () => reject(new Error(`${adapter!.name} stopped before reporting usage`));
      this.child.once("exit", onExit);
    });
    try {
      const response = await Promise.race([
        this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text: accounting.command }] }),
        exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error(`${adapter!.name} did not report usage in time`)); }, 20_000); }),
      ]);
      if (response.stopReason !== "end_turn") throw new Error(`${adapter!.name} did not finish reporting account usage`);
      const reading = accounting.parse(this.state.accountText);
      if (this.callbacks?.onAccountUsage) this.callbacks.onAccountUsage(reading.reports);
      else for (const info of reading.reports) this.callbacks?.onUsage?.(info);
      this.accountBefore = reading;
      // The caller compares its saved baseline with this snapshot.
      return reading;
    } catch (error) {
      this.accountBefore = undefined;
      this.callbacks?.onLog?.(error instanceof Error ? error.message : `Could not read ${adapter!.name} usage`);
      // Do not leave an unanswered command racing a later turn.
      if (timedOut) await this.stop();
      return undefined;
    } finally {
      this.child.removeListener("exit", onExit);
      clearTimeout(timer);
      delete this.state.accountText;
    }
  }

  /**
   * Codex ended this turn because the selected model is full. A finished result after the sentence is not this.
   * `source` is a thrown provider failure, the prompt response, or the turn text. A warning is Codex still working.
   */
  private capacityOf(source: unknown): ModelAtCapacity | undefined {
    if (this.profile.toolId !== "codex") return undefined;
    const fromSource: { retryAfterMs?: number } | undefined = typeof source === "string" ? (codexModelAtCapacity(source) ? {} : undefined) : codexCapacityFailure(source);
    // The response can be a warning while the turn's own text still ends on the sentence.
    const fromText: { retryAfterMs?: number } | undefined = codexModelAtCapacity(this.state.text) ? {} : undefined;
    const found = fromSource ?? fromText;
    if (!found) return undefined;
    const out = new ModelAtCapacity(this.profile.toolId, this.profile.modelId ?? this.profile.model, this.profile.id, this.sessionId);
    if (found.retryAfterMs !== undefined) out.retryAfterMs = found.retryAfterMs;
    const said = this.state.text || (typeof source === "string" ? source : undefined);
    if (said) out.said = said;
    if (this.state.messages.streamed) out.streamed = true;
    return out;
  }

  /** The usage limit a failed turn ran into, when that is why it failed. */
  private limitOf(error: unknown): UsageLimited | undefined {
    const limited = this.rejected() ?? limitFromFailure(this.profile, error, this.state.text, Date.now());
    if (limited && this.state.messages.streamed) limited.streamed = true;
    return limited;
  }

  /** Claude Code said, during this turn, that it is out. */
  private rejected(): UsageLimited | undefined {
    const info = this.state.latest ?? this.accountBefore?.reports.find(report => report.status === "rejected" && (report.resetsAt ?? 0) > Date.now() && (!report.model || inFamily(this.profile, report.model)));
    return info?.status === "rejected" ? Object.assign(limitFromReport(this.profile, info, Date.now()), { said: this.state.text }) : undefined;
  }

  /** Stop the current turn (the interrupt button). */
  async cancel(): Promise<void> {
    await this.connection.cancel({ sessionId: this.sessionId }).catch(() => undefined);
  }

  /** Start stopping the agent and the programs it started, without waiting. */
  close(): void {
    void this.stopper();
  }

  /** Stop the agent and every program it started, and wait until they have exited; forced after a few seconds. */
  stop(graceMs = FORCE_AFTER_MS): Promise<boolean> {
    return this.stopper(graceMs);
  }
}
