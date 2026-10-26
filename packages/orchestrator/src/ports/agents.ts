import type { AgentProfile, AgentToolActivity, Role, ToolInvocation, TurnReport } from "@petrina/core";

/** A conversation could not be continued. The controller decides whether a fresh start is allowed. */
export class ReopenFailed extends Error {}

/** Public progress, never private reasoning. Updates with the same id replace its text. */
export interface AgentMessage { id: number; text: string }

export interface PermissionInfo {
  title: string;
  kind: string;
  command?: string;
  paths: string[];
  /** A plain description of a browser target, when the tool actually names it. */
  target?: string;
}

export interface ToolActivityEvent {
  turnId: string;
  invocation?: ToolInvocation;
  isNew?: boolean;
  lastActivity?: string;
  runningTool?: AgentToolActivity["runningTool"];
  turnEndedAt?: number;
}

/** Network means a reported connection interruption; transient makes no claim about the network. */
export type RetryCause = "network" | "transient";

/** A retry owned by the tool. The controller observes it and must not retry on top of it. */
export interface NativeRetryReport {
  toolId: string;
  profileId: string;
  sessionId: string;
  cause: RetryCause;
  retryAfterMs?: number;
}

/** What the tool confirmed. Missing values remain unconfirmed. */
export interface SessionSettings {
  model?: string;
  modelName?: string;
  effort?: string;
}

/** Observations retained even when a turn never finishes. */
export interface TurnNotes {
  changed: { model?: string; effort?: string };
  rerouted: boolean;
  helpers: number;
  modelSeen?: string;
}

export interface TurnResult extends TurnNotes {
  stopReason: string;
  text: string;
  /** Public messages have already reached the saved conversation through onMessage. */
  streamed?: boolean;
  /** Missing means the tool reported no token usage. */
  report?: TurnReport;
}

export interface AgentSessionCallbacks {
  onMessage?(message: AgentMessage): void;
  onActivity(text: string): void;
  onToolActivity?(event: ToolActivityEvent): void;
  onPlanStep(text: string): void;
  onPermission(info: PermissionInfo): Promise<"allow" | "deny">;
  /** A bounded stop could not confirm that every owned program exited. */
  onCleanupIncomplete?(): void;
  /** Undefined ends the tool's previously reported retry. */
  onRetrying?(report: NativeRetryReport | undefined): void;
}

/** A lost live-input reply is uncertain, never permission to deliver the input again. */
export type AgentInputReceipt = "unsupported" | "unknown" | "current-turn" | "accepted" | "separate-turn" | "prompt-required" | "rejected";

/** Workflow operations; transports, child handles and browser ownership belong to adapters. */
export interface AgentSession {
  readonly sessionId: string;
  readonly reopened?: "resume" | "load";
  /** The only browser fact the workflow needs to give instructions and retain captures. */
  readonly browser?: { readonly directory: string };
  readonly settings: SessionSettings;
  readonly lastTurn: TurnNotes | undefined;
  readonly liveInput: boolean;
  readonly prompting: boolean;
  onPromptStarted?: () => void;
  prompt(text: string): Promise<TurnResult>;
  guide(text: string, messageId: string): Promise<AgentInputReceipt>;
  /** Request cancellation; completion alone does not confirm native cleanup. */
  cancel(): Promise<void>;
  close(): void;
  /** True confirms cleanup; false must remain observable before releasing owned resources. */
  stop(graceMs?: number): Promise<boolean>;
}

export interface AgentSessionOptions {
  profile: AgentProfile;
  cwd: string;
  callbacks: AgentSessionCallbacks;
  signal: AbortSignal;
  reopen?: string;
  reopenTimeoutMs?: number;
  startTimeoutMs?: number;
  /** Whether this role can use a browser. The adapter owns its setup and cleanup. */
  browser?: boolean;
  /** Adapter-owned native cleanup, published even if opening never returns a session. */
  onGone?: (gone: Promise<void>) => void;
}

/** Runtime dependency supplied by the host, never a product setting or serialized option. */
export type StartAgentSession = (options: AgentSessionOptions, role: Role) => Promise<AgentSession>;
