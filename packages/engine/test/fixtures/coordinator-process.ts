import { runCommand, type CommandResult } from "@petrina/test-support/commands";
import { engineEnv } from "./engine-processes.js";
export type { CoordinatorProcess } from "./engine-processes.js";

/** A completed command's exact stdout/stderr/code, using the same private environment as app-mode fixtures. */
export function coordinatorCommand(home: string, argv: readonly string[]): Promise<CommandResult> {
  return runCommand([process.execPath, ...argv], { env: engineEnv(home) });
}
