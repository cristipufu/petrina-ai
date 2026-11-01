import type { ChildProcess } from "node:child_process";
import type { AgentProfile } from "@petrina/core";
import type { AccountReading } from "./tool-adapter.js";

export interface AntigravityProbeStartOptions {
  profile: AgentProfile;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  probe: true;
  command?: readonly string[];
  onGone: (gone: Promise<void>) => void;
  onProcess: (actual: ChildProcess) => void;
  callbacks: {
    onActivity: () => void;
    onPlanStep: () => void;
    onPermission: () => Promise<"deny">;
  };
}

export interface AntigravityProbeSession {
  readAccountUsage(): Promise<AccountReading | undefined>;
  stop(): Promise<boolean>;
}

export type AntigravityProbeStarter = (options: AntigravityProbeStartOptions) => Promise<AntigravityProbeSession>;

let registeredStarter: AntigravityProbeStarter | undefined;

export function registerAntigravityProbeStarter(starter: AntigravityProbeStarter): void {
  registeredStarter = starter;
}

export function startAntigravityProbe(options: AntigravityProbeStartOptions): Promise<AntigravityProbeSession> {
  if (!registeredStarter) {
    throw new Error("Antigravity probe starter is not initialized");
  }
  return registeredStarter(options);
}
