import type { AgentProfile } from "@petrina/core";
import type { SessionNotice } from "../../src/provider-interruptions.js";

export const PROFILES = {
  codex: { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" },
  grok: { id: "grok-high", toolId: "grok", model: "Grok 4.7", modelId: "grok-4.7", effort: "high" },
  claude: { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" },
} as const satisfies Record<string, AgentProfile>;

// Representative envelopes, as each installed connector sends them in the mode Petrina uses.

/** codex-acp 2.2.2 without typed session failures: Codex's own retry rides a session info update. */
export const codexRetry = (codexErrorInfo: unknown, willRetry = true) => ({
  sessionUpdate: "session_info_update",
  _meta: { codex: { error: { message: "Reconnecting... 2/5 (stream disconnected before completion: error sending request)", codexErrorInfo, additionalDetails: null, turnId: "turn-1", willRetry } } },
});
export const STREAM_LOST = { responseStreamDisconnected: { httpStatusCode: null } };
export const CONNECT_FAILED = { httpConnectionFailed: { httpStatusCode: null } };

/** Grok 1.0.62's own route, with the fields as its recorded conversations carry them. */
export const grokRetry = (reason: string, extra: Record<string, unknown> = {}) => ({
  method: "_x.ai/session/update",
  params: { update: { sessionUpdate: "retry_state", type: "retrying", attempt: 1, max_retries: 15, reason, error_type: "http", ...extra } },
});
export const DNS = "request error: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses): client error (Connect): dns error: failed to lookup address information: nodename nor servname provided, or not known";
export const RESET = "request error: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses): client error (SendRequest): connection error: connection reset";
export const GARBLED = "reqwest error stream: Transport error: error decoding response body";

export const update = (value: unknown): SessionNotice => ({ kind: "update", sessionId: "s", update: value });
export const extension = (value: { method: string; params: unknown }): SessionNotice => ({ kind: "extension", ...value });
export const air = (category: string, severity: "warning" | "error", title: string, actions: string[] = ["retry", "new_session"]) => ({ jetbrains: { air: { version: 1, sessionFailure: { id: "turn:error", revision: 1, category, severity, title, actions } } } });
