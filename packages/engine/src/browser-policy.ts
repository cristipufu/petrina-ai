import type { Role } from "@petrina/core";
import { mayAskScreen } from "./prompts.js";

/** Real agents get a browser in every role that may check pages. A scripted fake agent never opens a page, so it gets one only when its test asks. */
export function opensBrowser(role: Role, options: { agentCommand?: unknown; browser?: boolean }): boolean {
  return mayAskScreen(role) && (options.browser ?? !options.agentCommand);
}
