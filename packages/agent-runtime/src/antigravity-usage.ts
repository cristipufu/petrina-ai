import { AgentRun } from "./acp-run.js";
import { createAntigravityUsageReader, readAntigravityUsageWith } from "./antigravity-usage-core.js";
import type { ReadOptions } from "./codex-usage.js";
import type { UsageInfo } from "./failures.js";
import { UsageReader } from "./usage-reader.js";

/** One native account command in Petrina's empty check folder, then stop the whole harness. */
export async function readAntigravityUsage(options: ReadOptions & { cwd: string }): Promise<UsageInfo[]> {
  return readAntigravityUsageWith((probeOptions) => AgentRun.start(probeOptions), options);
}

export class AntigravityUsage extends UsageReader {
  constructor(options: {
    command: readonly string[];
    cwd: string;
    env: () => NodeJS.ProcessEnv;
    record: (reports: UsageInfo[]) => void;
    log: (text: string) => void;
    changed?: () => void;
  }) {
    const reader = createAntigravityUsageReader((probeOptions) => AgentRun.start(probeOptions), options);
    super({
      name: "Antigravity",
      record: options.record,
      log: options.log,
      ...(options.changed ? { changed: options.changed } : {}),
      read: (context) =>
        readAntigravityUsage({
          command: options.command,
          cwd: options.cwd,
          env: options.env(),
          ...context,
        }),
    });
    void reader;
  }
}
