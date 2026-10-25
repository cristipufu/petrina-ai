import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { nativeSession } from "./native-session.js";

export function antigravityText(turn = 0, empty = false) {
  const reset = new Date(Date.now() + 7 * 86_400_000).toUTCString();
  return `### Session Usage\n- **Session total:** ${turn * 110} tokens (prompt: ${turn * 100}, completion: ${turn * 10})\n\n### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** 81% remaining (resets Oct 26, 2026, 16:50 UTC)\n  - **Five Hour Limit Remaining:** 60% remaining (resets Oct 19, 2026, 21:50 UTC)\n- **Gemini 4 Argon**\n  - **Gemini 4 Argon Weekly Limit:** ${empty ? 0 : 98}% remaining (resets ${reset})`;
}
const select = (id: string, currentValue: string, options: { value: string; name: string }[]): SessionConfigOption => ({ type: "select", id, name: id, currentValue, options });
export function antigravitySession(root: string, options: { empty?: boolean; hang?: boolean; resume?: boolean; turns?: number[] } = {}) {
  const config = [
    select("model", "default", [{ value: "default", name: "Default" }, { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "gemini-4-argon", name: "Gemini 4 Argon" }]),
    select("thinking_level", "high", ["medium", "high"].map(value => ({ value, name: value }))),
    select("mode", "auto_edit", ["auto_edit", "yolo"].map(value => ({ value, name: value }))),
  ];
  const peer = nativeSession(root, { config, ...(options.resume ? { reopen: "resume" } : {}),
    prompts: { "/usage": (options.turns ?? [0, 0, 0, 0, 0]).map(turn => ({ steps: options.hang ? [{ wait: "never-release-account" }] : [], reply: antigravityText(turn, options.empty) })) },
  });
  return { ...peer,
    accountRequests: () => peer.prompts().filter(request => request.params.text === "/usage"),
    workRequests: () => peer.prompts().filter(request => request.params.text !== "/usage"),
  };
}
