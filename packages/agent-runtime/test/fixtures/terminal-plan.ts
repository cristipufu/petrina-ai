import {
  antigravityTerminalArguments,
  claudeTerminalArguments,
  codexTerminalArguments,
  grokTerminalArguments,
  opencodeTerminalArguments,
  piTerminalArguments,
} from "../../src/terminal-arguments.js";
import { launchPlan as prepare, type LaunchInput } from "../../src/terminal-plan.js";
const formats = {
  antigravity: antigravityTerminalArguments,
  "claude-code": claudeTerminalArguments,
  codex: codexTerminalArguments,
  grok: grokTerminalArguments,
  opencode: opencodeTerminalArguments,
  pi: piTerminalArguments,
};
export const launchPlan = (input: LaunchInput) => prepare(input, formats[input.tool.id]);
