// One agent session over ACP: start the tool's adapter, open a session in the task's
// worktree (or reopen an earlier one), pin model, effort and mode, then send turns and report
// what happens. It also reads back what the tool says the session runs on, and what each turn used.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentProfile, TokenCounts, TurnReport } from "@petrina/core";
import { type ClaudeSandbox, SandboxUnavailable, sandboxFailure } from "./sandbox.js";
import { adapterEntry, ADAPTERS } from "./tools.js";
import { AgentBrowser } from "./browser.js";
import { claudeBackground } from "./claude-background.js";
import { BACKGROUND_FEATURES } from "./codex-background.js";
import { join } from "node:path";
import { grokTurnReport } from "./grok-usage.js";
import { descendants, descendantsKnown } from "./process-tree.js";
import { claudeReports, limitFromFailure, limitFromReport, type UsageInfo, type UsageLimited } from "./usage.js";
import { AgentMessages, type AgentMessage } from "./agent-messages.js";

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
  /** The step of its own plan the agent is on. */
  onPlanStep(text: string): void;
  onPermission(info: PermissionInfo): Promise<"allow" | "deny">;
  onLog?(text: string): void;
  /** A bounded stop could not confirm that all programs started by this tool have exited. */
  onCleanupIncomplete?(): void;
  /** The tool said how much of a usage limit is used (every report, whether or not it is close). */
  onUsage?(info: UsageInfo): void;
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
  if (toolId === "grok") return grokTurnReport(response);
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

// Windows tools report paths with backslashes.
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

interface ToolActivity {
  title?: string | null;
  kind?: string | null;
  locations?: { path: string }[] | null;
  rawInput?: unknown;
  _meta?: Record<string, unknown> | null;
}

function grokTool(update: ToolActivity): Record<string, unknown> | undefined {
  const value = update._meta?.["x.ai/tool"];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function browserAction(update: ToolActivity): { action: string; input: Record<string, unknown> } | undefined {
  const metadata = grokTool(update);
  let name = typeof metadata?.name === "string" ? metadata.name : update.title ?? "";
  let input = update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput) ? update.rawInput as Record<string, unknown> : {};
  if (/^(?:use_tool|call_tool)$/i.test(name)) {
    const wrapped = input.tool_name ?? input.name;
    if (typeof wrapped !== "string") return undefined;
    name = wrapped;
    const args = input.arguments ?? input.args ?? input.parameters;
    input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  }
  const action = /(?:^|__)browser_([a-z_]+)$/i.exec(name)?.[1]?.toLowerCase();
  return action ? { action, input } : undefined;
}

const BROWSER_ACTIONS: Record<string, string> = {
  navigate: "Opening a page", navigate_back: "Going back a page", snapshot: "Reading the page",
  find: "Finding text on the page", take_screenshot: "Taking a picture", click: "Clicking on the page",
  type: "Typing on the page", fill_form: "Filling in a form", select_option: "Choosing an option",
  press_key: "Using the keyboard", hover: "Pointing at the page", drag: "Dragging on the page",
  wait_for: "Waiting for the page", console_messages: "Checking page messages",
  network_requests: "Checking page requests", tabs: "Checking browser tabs", close: "Closing the page",
  resize: "Resizing the page", evaluate: "Checking the page", run_code: "Checking the page",
};

/** Permission targets come only from named fields, never from executable browser payloads. */
export function browserTarget(update: ToolActivity): string | undefined {
  const browser = browserAction(update);
  if (!browser) return undefined;
  const input = browser.input;
  if (typeof input.url === "string") {
    try {
      const url = new URL(input.url);
      if (url.protocol === "http:" || url.protocol === "https:") return `Page: ${url.origin}${url.pathname}`.slice(0, 240);
    } catch { /* Missing or malformed metadata gives no target. */ }
  }
  if (typeof input.element === "string" && input.element.trim()) return `On the page: ${input.element.trim().replace(/\s+/g, " ")}`.slice(0, 240);
  return undefined;
}

// Grok puts the kind in its metadata, and older tools sometimes send only their name.
// All of them use the same descriptions below once the action is identified.
const TOOL_NAMES: Record<string, string> = {
  read: "read", readfile: "read", hashlineread: "read", listdir: "read",
  grep: "search", hashlinegrep: "search", glob: "search",
  bash: "execute", shell: "execute", execcommand: "execute", runterminalcmd: "execute", runterminalcommand: "execute", monitor: "execute",
  edit: "edit", write: "edit", searchreplace: "edit", hashlineedit: "edit", strreplace: "edit", editnotebook: "edit", applypatch: "edit",
  delete: "delete", websearch: "fetch", webfetch: "fetch", xsearch: "fetch",
};

function kindOf(update: ToolActivity): string {
  if (update.kind && update.kind !== "other") return update.kind;
  const tool = grokTool(update);
  const kind = tool?.kind;
  if (typeof kind === "string") {
    if (["read", "search", "edit", "delete", "move", "execute", "think", "fetch"].includes(kind)) return kind;
    if (kind === "write") return "edit";
    if (kind === "list") return "read";
    if (kind === "monitor") return "execute";
  }
  const name = typeof tool?.name === "string" ? tool.name : update.title ?? "";
  return TOOL_NAMES[name.trim().replace(/_/g, "").toLowerCase()] ?? "other";
}

function fileOf(update: ToolActivity): string | undefined {
  const location = update.locations?.[0]?.path;
  if (location) return location;
  if (!update.rawInput || typeof update.rawInput !== "object") return undefined;
  const input = update.rawInput as Record<string, unknown>;
  const file = input.target_file ?? input.file_path ?? input.path ?? input.filePath;
  return typeof file === "string" && file.trim() ? file : undefined;
}

export function describeTool(update: ToolActivity): string {
  const browser = browserAction(update);
  if (browser) return BROWSER_ACTIONS[browser.action] ?? "Using the browser";
  const kind = kindOf(update);
  const command = commandOf(update.rawInput);
  const file = fileOf(update);
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
    case "execute": {
      // Use the agent's description when it says what the command is for.
      const purpose = purposeOf(update.rawInput);
      return purpose ?? (command ? humanizeCommand(command) : "Running a command");
    }
    case "think":
      return "Thinking it through";
    case "fetch":
      return "Looking something up";
    default:
      return update.title ? (!/\s/.test(update.title) && /[_]|^(?:mcp|functions)[.:]/i.test(update.title) ? "Using a tool" : update.title.slice(0, 80)) : "Working";
  }
}

/** The agent's own one-line description of a command, when its tool gives one. */
function purposeOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const value = (rawInput as { description?: unknown }).description;
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length < 3) return undefined;
  const line = text.length > 90 ? `${text.slice(0, 89).trimEnd()}…` : text;
  return line[0]!.toUpperCase() + line.slice(1);
}

/** The tools' own plumbing (loading tools, to-do bookkeeping): never shown as what the agent is doing. */
const PLUMBING = /^(ToolSearch|TodoWrite|TodoRead|Task(Output|Stop|Create|Update|Get|List)?|Skill|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|todo_write|search_tool|enter_plan_mode|exit_plan_mode|get_task_output|get_command_or_subagent_output|wait_tasks|wait_commands_or_subagents|kill_task|kill_command_or_subagent)$/i;

export function isPlumbing(update: ToolActivity): boolean {
  const tool = grokTool(update);
  const name = typeof tool?.name === "string" ? tool.name : update.title ?? "";
  return kindOf(update) === "other" && (tool?.kind === "plan" || PLUMBING.test(name.trim()));
}

function commandOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const input = rawInput as { command?: unknown; cmd?: unknown };
  const value = input.command ?? input.cmd;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((part) => typeof part === "string").join(" ");
  return undefined;
}

interface RunState {
  text: string;
  messages: AgentMessages;
  lastActivity: string;
  quiet: boolean;
  settings: SessionSettings;
  latest?: UsageInfo;
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
  if (await exited([-child.pid, ...pids], graceMs)) return complete;
  // Whatever ignored the request to stop is killed, with anything it started meanwhile.
  // Leave most of the lookup budget to the first snapshot on a busy machine; still fit the app's quit deadline.
  if (collectPrograms) {
    const workers = await descendantsKnown(pids.filter(alive), 1_200);
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
    /** A login check only opens a conversation, never sends work or runs in a product's copy. */
    probe?: boolean;
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
    const env = { ...(options.env ?? process.env) };
    if (profile.toolId === "codex") {
      env.CODEX_CONFIG = JSON.stringify({
        ...JSON.parse(env.CODEX_CONFIG ?? "{}"),
        ...Object.fromEntries(BACKGROUND_FEATURES.map((feature) => [`features.${feature}`, false])),
      });
      env.DISABLE_MCP_CONFIG_FILTERING = "true";
      if (env.CODEX_PATH) env.PETRINA_CODEX_EXECUTABLE = env.CODEX_PATH;
      env.CODEX_PATH = join(import.meta.dir, "codex-background.ts");
    }
    // windowsHide: no console window flashes up on Windows when an agent starts.
    const child = spawn(program!, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env, detached: process.platform !== "win32", windowsHide: true });
    child.stderr?.on("data", (chunk: Buffer) => callbacks.onLog?.(chunk.toString()));
    const killed = new Promise<never>((_, reject) => {
      child.once("exit", (code) => reject(new Error(`${adapter.name} stopped (exit ${code ?? "signal"})`)));
      child.once("error", (error) => reject(error));
    });
    killed.catch(() => undefined);
    // Login probes send no work. Every coding agent, including a parallel reviewer or a
    // reopened builder, gets a new engine-owned browser within the opening deadline.
    // An identity check never opens a page, so it starts no browser.
    const showBrowser = !options.probe && options.browser !== false;
    const browserReady = showBrowser ? AgentBrowser.start(options.browserRoot, options.env ?? process.env, callbacks.onLog) : Promise.resolve(undefined);
    browserReady.catch(() => undefined);
    let stopping: Promise<boolean> | undefined;
    let cleanupNoticeSent = false;
    const stop = (graceMs = FORCE_AFTER_MS) => (stopping ??= Promise.all([
      stopAll(child, graceMs, !options.probe),
      browserReady.then((browser) => browser?.close()).then(() => true, () => false),
    ]).then((results) => {
      const complete = results.every(Boolean);
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
    const stopped = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("Stopped before the agent started")), { once: true }));
    stopped.catch(() => undefined);

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
    const titles = new Map<string, ToolActivity>();
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);

    const connection = new acp.ClientSideConnection(
      () => ({
        async requestPermission(params) {
          if (state.quiet) return { outcome: { outcome: "cancelled" } };
          const call = params.toolCall;
          const known = titles.get(call.toolCallId) ?? {};
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
          if (state.quiet) return;
          const update = params.update;
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              if (update.content.type === "text") {
                const source = "messageId" in update && typeof update.messageId === "string" ? update.messageId : undefined;
                if (state.messages.push(update.content.text, source) && state.text) state.text += "\n\n";
                state.text += update.content.text;
              }
              break;
            case "agent_thought_chunk":
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
              const reports = claudeReports(profile.toolId, meta);
              for (const info of reports) callbacks.onUsage?.(info);
              // A rejected spend cap outranks an open session window from the same note.
              if (reports.length) state.latest = reports.find((info) => info.status === "rejected") ?? reports[0];
              const seen = meta["_claude/model"];
              if (state.turn && typeof seen === "string") state.turn.modelSeen = seen;
              break;
            }
            case "tool_call": {
              // A Codex agent starting a helper agent shows up as a tool call named spawnAgent.
              const input = update.rawInput as { receiverThreadIds?: unknown } | undefined;
              if (state.turn && (update.title === "spawnAgent" || Array.isArray(input?.receiverThreadIds))) state.turn.helpers.add(update.toolCallId);
              titles.set(update.toolCallId, update);
              if (isPlumbing(update)) break;
              state.messages.activity();
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

    const open = async (): Promise<{ sessionId: string; configOptions?: unknown; how?: "resume" | "load" }> => {
      // Notices let Codex announce a reroute as a typed update instead of text in the reply.
      const [init, browser] = await Promise.all([
        connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {} } } }),
        browserReady,
      ]);
      const sessionId = options.reopen;
      // Keep the tool's session mode (Grok's auto mode) and add sandbox settings only for Claude Code.
      // The same metadata goes to new, resumed and loaded conversations.
      const sessionMeta: Record<string, unknown> = { ...adapter.sessionMeta, ...(options.sandbox && adapter.sandboxMeta ? adapter.sandboxMeta(options.sandbox) : {}) };
      if (browser && profile.toolId === "claude-code") {
        const claude = sessionMeta.claudeCode as { options?: Record<string, unknown> } | undefined;
        sessionMeta.claudeCode = { ...claude, options: { ...claude?.options, ...await claudeBackground(cwd) } };
      }
      const meta = Object.keys(sessionMeta).length ? { _meta: sessionMeta } : {};
      const mcpServers = browser ? [browser.mcp] : [];
      if (sessionId === undefined) return connection.newSession({ cwd, mcpServers, ...meta });
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
      const set = async (configId: string, value: string | undefined): Promise<boolean> => {
        if (!value) return false;
        const option = sessionOptions.find((entry) => entry.id === configId);
        // A value the tool doesn't offer is not forced: the session keeps the tool's default, and that is recorded.
        if (!option || !choices(option).some((entry) => entry.value === value)) return false;
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
      return session;
    })();
    ready.catch(() => undefined);

    try {
      const session = await Promise.race([ready, killed, deadline, stopped]);
      clearTimeout(whole);
      return new AgentRun(child, connection, session.sessionId, state, profile, stop, session.how, await browserReady);
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
      throw error;
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
    this.notes = undefined;
    const notes = (): TurnNotes => ({ changed: { ...turn.changed }, rerouted: turn.rerouted, helpers: turn.helpers.size, ...(turn.modelSeen ? { modelSeen: turn.modelSeen } : {}) });
    const exited = new Promise<never>((_, reject) => this.child.once("exit", (code) => reject(new Error(`The agent stopped (exit ${code ?? "signal"})`))));
    exited.catch(() => undefined);
    try {
      const response = await Promise.race([this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }), exited]).catch((error: unknown) => { throw this.limitOf(error) ?? error; });
      if (response.stopReason !== "end_turn" && response.stopReason !== "cancelled") {
        const out = this.rejected();
        if (out) {
          if (this.state.messages.streamed) out.streamed = true;
          throw out;
        }
      }
      const report = reportOf(response, this.profile.toolId);
      return { stopReason: response.stopReason, text: this.state.text, ...(this.state.messages.streamed ? { streamed: true } : {}), ...(report ? { report } : {}), ...notes() };
    } finally {
      this.state.messages.boundary();
      this.notes = notes();
      this.state.turn = undefined;
      // Later turns run on whatever the tool switched the session to. A Codex reroute is per turn.
      if (turn.next) this.state.settings = turn.next;
    }
  }

  /** The usage limit a failed turn ran into, when that is why it failed. */
  private limitOf(error: unknown): UsageLimited | undefined {
    const limited = this.rejected() ?? limitFromFailure(this.profile, error, this.state.text, Date.now());
    if (limited && this.state.messages.streamed) limited.streamed = true;
    return limited;
  }

  /** Claude Code said, during this turn, that it is out. */
  private rejected(): UsageLimited | undefined {
    const info = this.state.latest;
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
