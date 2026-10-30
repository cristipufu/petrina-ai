// Claude Code's local get_usage control request. No user prompt or AI turn is sent.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { ReadOptions } from "./codex-usage.js";
import type { UsageInfo } from "./failures.js";
import { UsageReader } from "./usage-reader.js";
import { withUsageProcess } from "./usage-process.js";
import type { ReaderOptions } from "./tool-adapter.js";
import { claudeAccountReports } from "./claude-account-report.js";

export const CLAUDE_USAGE_COMMAND = [
  "claude",
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}'
] as const;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
export async function readClaudeUsage(options: ReadOptions & { cwd: string }): Promise<UsageInfo[]> {
  await mkdir(options.cwd, { recursive: true, mode: 0o700 });
  const [program, ...args] = options.command ?? CLAUDE_USAGE_COMMAND;
  return withUsageProcess(options, () => spawn(
    program!,
    args,
    {
    cwd: options.cwd,
    env: options.env,
    stdio: [
    "pipe",
    "pipe",
    "pipe"
  ],
    windowsHide: true
  }
  ), async (child, signal) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      return await new Promise<UsageInfo[]>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        let buffer = "";
        const send = (id: string, request: object) => {
          if (signal.aborted) {
            abort();
            return;
          }
          child.stdin!.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
        };
        child.on("error", () => reject(new Error("Claude Code could not start its account usage check")));
        child.on("exit", () => reject(new Error("Claude Code stopped before reporting account usage")));
        child.on("close", () => reject(new Error("Claude Code stopped before reporting account usage")));
        child.stdin!.on("error", () => reject(new Error("Claude Code closed its account usage connection")));
        child.stderr!.resume();
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 2_000_000) {
            reject(new Error("Claude Code's account response was too large"));
            return;
          }
          for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            let message: Record<string, unknown>;
            try { message = object(JSON.parse(line)); } catch { continue; }
            if (message.type !== "control_response") continue;
            const response = object(message.response);
            if (response.request_id !== "usage-init" && response.request_id !== "usage-read") continue;
            if (response.subtype !== "success") {
              reject(new Error("Claude Code could not read account usage; check its login"));
              return;
            }
            if (response.request_id === "usage-init") send("usage-read", { subtype: "get_usage", skip_behaviors: true });
            else resolve(claudeAccountReports(response.response));
          }
        });
        timer = setTimeout(() => reject(new Error("Claude Code did not answer its account usage check in time")), options.timeoutMs ?? 30_000);
        send("usage-init", { subtype: "initialize", hooks: {} });
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  });
}

export class ClaudeUsage extends UsageReader {
  constructor(options: ReaderOptions) {
    super({ name: "Claude Code", record: options.record, log: options.log, changed: options.changed,
      read: context => readClaudeUsage({ command: options.command, cwd: options.cwd, env: options.env(), ...context }),
    });
  }
}
