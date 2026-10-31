// Taking over a step in the coordinator's own terminal, and handing it back. The engine and the
// app share these rules and words, so the button is only enabled when the engine would accept it.

import type { Role, State, Task } from "./model.js";
import { roleForTask } from "./roles.js";

/** The tools whose own app Petrina can open on an agent's conversation. */
export const TAKE_OVER_TOOLS: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  grok: "Grok",
  antigravity: "Antigravity",
};

export const TAKE_OVER_WORDS = {
  noAgent: "No agent is working on this right now",
  releaseManager: "Delivery runs on its own, so it can't be taken over",
  starting: "The agent is still starting. Try again in a moment",
  unsupported: "This agent's tool can't be opened in a terminal",
  missing: (tool: string) => `${tool} isn't installed on this machine`,
  driving: "You're driving it already",
  several: "Several agents are working on this step at once. Take over when one is working alone",
  handBackFirst: "Hand back first",
  status: "You're driving in your terminal",
  inCharge: (tool: string) =>
    `${tool} opens in your terminal on the agent's conversation, in this task's working copy. It runs in its normal mode with its usual prompts. Some actions may run without a prompt, and you are in charge of the session: Petrina adds no blocks there.`,
  stillOpen: (tool: string) => `${tool} is still open in your terminal. Close it there, then hand back.`,
  cannotTell: (tool: string) => `Petrina can't tell whether ${tool} is still open. Hand back anyway only if you closed it: if it is still running, it and the agent could change the same files.`,
  alreadyOpen: (tool: string) => `${tool} is already open in your terminal for this task. Use that window.`,
  noTerminal: "Petrina can't find a terminal to open. Choose one, or take over and copy a command to run yourself.",
  /** Another take-over step for the same task is under way. */
  busy: {
    "taking over": "Petrina is still taking this over. Try again in a moment.",
    reopening: "Petrina is opening the terminal. Try again in a moment.",
    "handing back": "Petrina is handing this back already.",
  },
} as const;

/** Whether the tool Petrina opened is still running. `unknown`: the launcher never reported starting, or its record cannot be checked. */
export type SessionState = "running" | "ended" | "unknown";

/** What a take-over or a reopen did: the command that runs the launcher, and the terminal it opened in. */
export interface Launched {
  command: string;
  terminal?: string;
  /** Why the terminal did not open, in plain words. */
  problem?: string;
}

/** What the coordinator sees before handing back. */
export interface HandBackPreview {
  open: SessionState;
  tool: string;
  /** Why hand back cannot go on (the working copy left the task's branch, or a merge is half done). */
  problem?: string;
  commits: number;
  /** Files added, changed or removed since the take-over, and a few of their names. */
  files: number;
  names: string[];
  /** Changes not saved in a commit yet: Petrina saves them as the coordinator's commit. */
  unsaved: boolean;
  /** The agent's unfinished work Petrina saved before the take-over. */
  saved?: { files: number; names: string[] };
}

/** The tool's name, for the coordinator. */
export function toolName(toolId: string | undefined): string {
  return (toolId && TAKE_OVER_TOOLS[toolId]) || "The agent's tool";
}

/**
 * Why the coordinator cannot take over this task right now, in one line, or undefined when they can.
 * An agent other than the Release Manager must be working or waiting on them, on Claude Code, Codex or Grok,
 * in a conversation that already has its instructions.
 */
export function takeOverBlock(task: Task, state: Pick<State, "profiles" | "tools"> & { readonly roles?: readonly Pick<Role, "id" | "result">[] }): string | undefined {
  if (task.driving) return TAKE_OVER_WORDS.driving;
  const agent = task.agent;
  if (!agent || !task.holdsSlot || (task.state !== "running" && task.state !== "needs-you")) return TAKE_OVER_WORDS.noAgent;
  const delivery = state.roles ? roleForTask(state.roles, agent.roleId, task)?.result === "delivery" : agent.roleId === "release-manager";
  if (delivery) return TAKE_OVER_WORDS.releaseManager;
  if (task.helpers?.length) return TAKE_OVER_WORDS.several;
  const toolId = state.profiles.find((profile) => profile.id === agent.profileId)?.toolId;
  if (!toolId || !TAKE_OVER_TOOLS[toolId]) return TAKE_OVER_WORDS.unsupported;
  if (state.tools.find((tool) => tool.id === toolId)?.status !== "ready") return TAKE_OVER_WORDS.missing(toolName(toolId));
  const conversation = task.conversation;
  if (!conversation?.briefed || conversation.roleId !== agent.roleId || conversation.profileId !== agent.profileId) return TAKE_OVER_WORDS.starting;
  return undefined;
}
