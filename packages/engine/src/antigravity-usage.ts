import { mkdir } from "node:fs/promises";
import { AgentRun } from "./acp-run.js";
import { ENGINE_PROFILES } from "./tools.js";
import type { ReadOptions } from "./codex-usage.js";
import type { UsageInfo } from "./usage.js";
import { UsageReader } from "./usage-reader.js";

/** One native account command in Petrina's empty check folder, then stop the whole harness. */
export async function readAntigravityUsage(options: ReadOptions & { cwd: string }): Promise<UsageInfo[]> {
  await mkdir(options.cwd, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  let agent: AgentRun | undefined;
  try {
    agent = await AgentRun.start({
      profile: ENGINE_PROFILES.find(profile => profile.toolId === "antigravity")!,
      cwd: options.cwd, env: options.env, signal: controller.signal, probe: true,
      ...(options.command ? { command: options.command } : {}),
      ...(options.onProcess ? { onProcess: options.onProcess } : {}),
      callbacks: { onActivity: () => undefined, onPlanStep: () => undefined, onPermission: async () => "deny" },
    });
    return (await agent.readAccountUsage())?.reports ?? [];
  } finally {
    clearTimeout(timer);
    await agent?.stop();
  }
}

export class AntigravityUsage extends UsageReader {
  constructor(options: { command: readonly string[]; cwd: string; env: () => NodeJS.ProcessEnv; record: (reports: UsageInfo[]) => void; log: (text: string) => void; changed?: () => void }) {
    super({ name: "Antigravity", record: options.record, log: options.log, ...(options.changed ? { changed: options.changed } : {}), read: onProcess => readAntigravityUsage({ command: options.command, cwd: options.cwd, env: options.env(), onProcess }) });
  }
}
