import { join } from "node:path";
import { runCommand } from "@petrina/test-support/commands";

type TimerCommand = (argv: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export async function timerObservation(root: string, kind: "registration", execute?: TimerCommand): Promise<{ checkpointCalls: number }>;
export async function timerObservation(root: string, kind: "stopped-screen", execute?: TimerCommand): Promise<{ releaseSeen: boolean; schedulesAfterRelease: number; screens: number; commits: number }>;
export async function timerObservation(root: string, kind: "registration" | "stopped-screen", execute: TimerCommand = runCommand) {
  const result = await execute([process.execPath, "--no-env-file", join(import.meta.dir, "native-timer-control.ts"), kind, root]);
  if (result.code !== 0) throw new Error(`The timer control exited ${result.code}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
