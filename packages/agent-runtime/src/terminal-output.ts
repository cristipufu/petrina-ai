import { readOwnedProcessOutput, type OutputProcess } from "@petrina/platform/process-output";
import type { ProcessDeadline } from "@petrina/platform/process-capabilities";
import { terminalEnv } from "./terminal-plan.js";

const arm: ProcessDeadline = (expired, ms) => {
  const timer = setTimeout(expired, ms);
  return () => clearTimeout(timer);
};
export interface TerminalOutputOptions {
  /** Private native composition effects; ownership transfers to the shared output owner. */
  start?: (command: readonly string[], env: NodeJS.ProcessEnv) => OutputProcess;
  arm?: ProcessDeadline;
  signal?: AbortSignal;
}

/** Help and process-identity probes trust complete output only after a successful owned command exit. */
export function terminalOutput(command: readonly string[], options: TerminalOutputOptions = {}): Promise<string | undefined> {
  return readOwnedProcessOutput({
    start: () => {
      const env = { ...terminalEnv(process.env), LC_ALL: "C" };
      return options.start ? options.start(command, env)
        : Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env, windowsHide: true });
    },
    arm: options.arm ? (expired, ms) => options.arm!(expired, ms) : arm, signal: options.signal,
    completion: "successful-exit", timeoutMs: 10_000, graceMs: 1_000, forceMs: 1_000,
  });
}
