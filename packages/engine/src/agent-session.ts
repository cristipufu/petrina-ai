import type { Role } from "@petrina/core";
import type { AgentRun } from "./acp-run.js";

/** A session cannot be continued; controllers decide whether a fresh participant is allowed. */
export class ReopenFailed extends Error {}

/** The workflow uses a session; ACP and native process ownership stay in AgentRun. */
export type AgentSession = Pick<AgentRun,
  "sessionId" | "reopened" | "browser" | "settings" | "lastTurn" | "onPromptStarted" |
  "liveInput" | "prompting" | "prompt" | "guide" | "cancel" | "close" | "stop"
>;

export type AgentSessionOptions = Parameters<typeof AgentRun.start>[0];
/** Private runtime effect, never a product setting or serialized engine option. */
export type StartAgentSession = (options: AgentSessionOptions, role: Role) => Promise<AgentSession>;
