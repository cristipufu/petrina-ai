import { terminalArgumentsFor } from "../../src/terminal-arguments.js";
import { launchPlan as prepare, type LaunchInput } from "../../src/terminal-plan.js";

export const launchPlan = (input: LaunchInput) => prepare(input, terminalArgumentsFor(input.tool.id));
