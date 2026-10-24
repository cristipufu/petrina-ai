import type { Hunt, Vote } from "../../src/model.js";
import { ballotOf } from "../../src/verifier-panel.js";

const NAMES: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", grok: "Grok", antigravity: "Antigravity" };
export const name = (tool: string) => NAMES[tool] ?? tool;
const PROFILE: Readonly<Record<string, string>> = { "claude-code": "opus-high", codex: "sol-high", grok: "grok-high", antigravity: "argon-high" };
export const candidate = (toolId: string, usableNow = true) => ({ toolId, profileId: PROFILE[toolId]!, usableNow });
export const hunt = { stageId: "review", round: 1, input: { file: "input.json", digest: "d1", heads: { product: "abc" } } } as const satisfies Pick<Hunt, "stageId" | "round" | "input">;
export const answer = (seat: string, toolId: string, verdict: Vote["verdict"], reason = `${toolId} checked it`): Vote => ({ by: PROFILE[toolId]!, toolId, plannedProfileId: seat, verdict, reason, ballot: ballotOf(hunt, seat) });
