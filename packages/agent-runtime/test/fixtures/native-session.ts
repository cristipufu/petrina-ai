import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import type { NativePrompt } from "./protocol-actions.js";

export interface NativePlan {
  reopen?: "resume" | "load";
  prompt?: NativePrompt;
  prompts?: Record<string, NativePrompt | NativePrompt[]>;
  config?: SessionConfigOption[];
  recordInitialize?: boolean;
  recordEnvironment?: boolean;
  recordRequests?: boolean;
}
export interface NativeRequest { method: string; params: { sessionId?: string; text?: string; configId?: string; value?: string; _meta?: Record<string, unknown> }; pid: number }

/** A real SDK peer with explicit protocol observations, never workflow roles or repository behavior. */
export function nativeSession(root: string, plan: NativePlan = {}) {
  const write = (next: NativePlan) => writeFixtureJson(join(root, ".native-peer.json"), { ...next, recordRequests: true });
  write(plan);
  const requests = (): NativeRequest[] => {
    const file = join(root, ".native-requests.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  return { root, command: [process.execPath, join(import.meta.dir, "session-agent.ts"), `--peer-root=${root}`], write, requests,
    prompts: () => requests().filter(request => request.method === "session/prompt"),
  };
}
