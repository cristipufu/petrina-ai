import { AgentRun } from "../src/acp-run.js";
import type { AgentSession } from "../src/agent-session.js";

/** Native lifecycle assertions must name an actual ACP child, never a scripted workflow session. */
export function nativeAgentProcess(session: AgentSession) {
  if (!(session instanceof AgentRun)) throw new TypeError("This assertion requires a native ACP agent process");
  return session["child"];
}
