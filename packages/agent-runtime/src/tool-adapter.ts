import type { LimitFailure } from "./provider-limits.js";
export type { LimitFailure } from "./provider-limits.js";
import type { AgentProfile, TurnReport } from "@petrina/core";
import type { ClaudeSandbox } from "./sandbox.js";
import type { UsageInfo } from "./failures.js";
import type { UsageReader } from "./usage-reader.js";
import type { ToolInterruptions } from "./provider-interruptions.js";
export interface AccountReading {
  reports: UsageInfo[];
  tokens?: { total: number; input: number; output: number; reasoning: number; cached?: number };
}
export interface ReaderOptions {
  command: readonly string[];
  cwd: string;
  env: () => NodeJS.ProcessEnv;
  record: (reports: UsageInfo[]) => void;
  log: (text: string) => void;
  changed: () => void;
}

/** How Petrina drives one tool through ACP. */
export interface ToolAdapter {
  /** Connector extensions requested during ACP initialization, separate from task instructions. */
  clientMeta?: Record<string, unknown>;
  /** Provider-owned live input. No cancellation or personal settings changes. */
  liveInput?: {
    supported: (initialize: unknown) => boolean;
    probe?: { method: string; params: Record<string, unknown>; recognizedError: (error: unknown) => boolean };
    request: (sessionId: string, text: string, messageId: string) => { method: string; params: Record<string, unknown> };
    receipt: (response: unknown) => "current-turn" | "accepted" | "separate-turn" | "prompt-required" | "rejected";
  };
  prepareEnv?: (env: NodeJS.ProcessEnv) => void;
  prepareSessionMeta?: (meta: Record<string, unknown>, context: { cwd: string; browser: boolean }) => Promise<Record<string, unknown>>;
  verifySessionSettings?: (profile: AgentProfile, settings: { model?: string; effort?: string }) => void;
  parseTurnReport?: (response: unknown) => TurnReport | undefined;
  parseUsageUpdate?: (meta: Record<string, unknown>) => { reports: UsageInfo[]; model?: string };
  /** Reconcile overlapping plan and overage allowance windows across live notices and account snapshots. */
  reconcilesAllowanceWindows?: boolean;
  toolMetadata?: (meta: Readonly<Record<string, unknown>>) => Record<string, unknown> | undefined;
  parseLimitError?: (data: Record<string, unknown>, message: string) => LimitFailure | null | undefined;
  /**
   * How this tool's connector reports a terminal capacity stop and its own native retries, in the reporting
   * mode Petrina uses. Unset: the tool exposes neither, and its failures keep their usual handling.
   */
  interruptions?: ToolInterruptions;
  accountUsage?: {
    command: string;
    parse: (text: string) => AccountReading;
    turnReport: (before: AccountReading | undefined, after: AccountReading | undefined) => TurnReport | undefined;
  };
  usageReader?: {
    command: () => readonly string[];
    create: (options: ReaderOptions) => UsageReader;
    /** A live session already reports its own account usage. */
    liveSession?: boolean;
    /** Native startup reads may have a different refresh cadence. */
    startGapMs?: number;
  };
  terminalArgs?: import("./terminal-arguments.js").TerminalArgumentFormatter;
  resolveTerminalMode?: (path: string) => Promise<import("./terminal-plan.js").AskMode | undefined>;
  id: string;
  name: string;
  /** The adapter's entry point, resolved from node_modules. Unset when `command` is the agent itself. */
  entry?: string;
  /** Embedded ACP protocol translator subcommand inside `petrina-engine` (or its source module under Bun). */
  internalSubcommand?: `__internal-${string}-acp`;
  /** Source module under `packages/agent-runtime/src/` backing `internalSubcommand` during non-compiled runs. */
  internalSourceFile?: string;
  /** In-process entrypoint invoked when `petrina-engine` dispatches `internalSubcommand`. */
  internalRunner?: (rawArgs?: readonly string[]) => Promise<void> | void;
  /** The program to spawn when the agent is the ACP server. Otherwise Petrina launches the ACP connector. */
  command?: readonly string[];
  /** The CLI the tool needs on PATH, for detection and for taking over in a terminal. */
  cli: string;
  /** Forget a disposable identity/account probe, only after its process has stopped. */
  forgetProbe?: (sessionId: string, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Session config option ids the adapter exposes. `mode` is unset when the mode is session metadata instead. */
  options: { model: string; effort: string; mode?: string };
  /** The tool's own working mode; permission requests still reach the coordinator. */
  mode: string;
  /** Sent on `session/new`, `session/resume` and `session/load`. Grok's auto mode lives here, not in a config option. */
  sessionMeta?: Readonly<Record<string, unknown>>;
  /**
   * How the tool says whether it is logged in, without a message to the AI. "report": its connector sends
   * the login it runs on (`_auth/status_update`), and opens conversations either way. "open": it checks its
   * login as a conversation opens and refuses with ACP's "log in first" error when there is none, so a
   * conversation that opens is its own word.
   */
  login: "report" | "open";
  models: readonly string[];
  /** Whether this tool reports its own sandbox state for the Session tab. */
  reportsSandbox?: boolean;
  /**
   * The session option that carries Claude Code's own sandbox settings to its adapter. Unset: the
   * tool keeps its own setup (including Codex's workspace sandbox) and gets no sandbox settings from Petrina.
   */
  sandboxMeta?: (sandbox: ClaudeSandbox) => Record<string, unknown>;
}
