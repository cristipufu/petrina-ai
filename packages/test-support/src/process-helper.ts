import { ChildProcess } from "node:child_process";

/**
 * A stand-in for a process-list helper whose exit a test reports itself. Its output has ended, as a real
 * helper's has when its reported success is a complete list, so the read takes that success as one.
 */
export function finishedHelper(): ChildProcess {
  return Object.defineProperty(new ChildProcess(), "stdout", { value: { readableEnded: true } });
}
