import { AgentRun } from "@petrina/agent-runtime/acp-run";
import type { AgentSession } from "@petrina/orchestrator";

/** Native lifecycle assertions must name an actual ACP child, never a scripted workflow session. */
export function nativeAgentProcess(session: AgentSession) {
  if (!(session instanceof AgentRun)) throw new TypeError("This assertion requires a native ACP agent process");
  return session["child"];
}
