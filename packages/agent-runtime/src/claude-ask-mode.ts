import { terminalOutput } from "./terminal-output.js";
import type { AskMode } from "./terminal-plan.js";

/** Claude Code's ask-before-acting mode, by the name the installed copy lists in its help. */
export async function askMode(path: string): Promise<AskMode> {
  const help = (await terminalOutput([path, "--help"])) ?? "";
  return /"manual"/.test(help) ? "manual" : "default";
}
