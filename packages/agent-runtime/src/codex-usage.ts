// Codex's usage, read from Codex itself. Its ACP adapter reads the rate limits from Codex's app-server for its
// own status line and never passes them on over ACP, so Petrina runs `codex app-server` the way the adapter
// does (the same handshake, with the coordinator's own environment, prompts off), asks once with
// `account/rateLimits/read`, and stops the process. Read when the engine starts, whenever a Codex agent starts,
// and every ten minutes while any agent runs. A failure (not installed, not logged in, no answer) is said once
// in the engine's log and never fails a task: Petrina then goes by what Codex says when a turn fails.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { codexReports } from "./codex-report.js";
import type { UsageInfo } from "./failures.js";
import { UsageReader } from "./usage-reader.js";
import { withUsageProcess, type UsageProcessOptions } from "./usage-process.js";

/** How often Codex's usage is read while agents run. */
export const CODEX_USAGE_EVERY_MS = 10 * 60_000;

/** How long one read may take, handshake included, before the process is stopped. */
export const CODEX_USAGE_TIMEOUT_MS = 20_000;

/** What Petrina runs to read it: Codex's own app-server, found on PATH like the agents' tools. */
export const CODEX_USAGE_COMMAND: readonly string[] = ["codex", "app-server"];

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Who is asking, in the shape the adapter sends. */
const CLIENT_INFO = { name: "petrina", title: "Petrina", version };

export interface ReadOptions extends UsageProcessOptions {
  /** The app-server to run; tests hand in a fake. */
  command?: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Hears the process as it starts, so a shutdown can stop it. */
  onProcess?: (child: ChildProcess) => void;
}

/**
 * One read: start the app-server, `initialize` as the adapter does, `account/rateLimits/read`, stop it.
 * Throws with a plain reason when Codex is not there, refuses, stops, or does not answer in time.
 */
export async function readCodexUsage(options: ReadOptions): Promise<UsageInfo[]> {
  const [program, ...args] = options.command ?? CODEX_USAGE_COMMAND;
  const timeoutMs = options.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS;
  return withUsageProcess(options, () => spawn(
    program!,
    args,
    {
    stdio: [
    "pipe",
    "pipe",
    "pipe"
  ],
    env: options.env,
    windowsHide: true
  }
  ), async (child, signal) => {
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const failAll = (error: Error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } | null };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          // A line that is not JSON (a log) is dropped, as the adapter drops it.
          continue;
        }
        // Notifications (account/updated and the like) carry no id and are not answers.
        const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (!waiter) continue;
        pending.delete(message.id as number);
        if (message.error) waiter.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Codex refused the request"));
        else waiter.resolve(message.result);
      }
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.stdin!.on("error", () => undefined);
    child.on(
      "error",
      (error: NodeJS.ErrnoException) => failAll(error.code === "ENOENT" ? new Error(`Codex is not installed: no \`${program}\` on PATH`) : error)
    );
    const stopped = (code: number | null) => {
      const last = stderr.trim().split("\n").at(-1);
      failAll(new Error(`Codex's app-server stopped (exit ${code ?? "signal"})${last ? `: ${last}` : ""}`));
    };
    child.on("exit", stopped);
    child.on("close", stopped);
    const abort = () => failAll(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let next = 1;
    const request = (method: string, params?: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const id = next++;
        pending.set(id, { resolve, reject });
        // JSON lines without the jsonrpc field, as the adapter writes them; the app-server answers the same way.
        child.stdin!.write(`${JSON.stringify(params === undefined ? { id, method } : { id, method, params })}\n`);
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Codex did not answer within ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
    });
    late.catch(() => undefined);
    const read = (async () => {
      await request("initialize", { capabilities: { experimentalApi: true, requestAttestation: false }, clientInfo: CLIENT_INFO });
      if (signal.aborted) throw signal.reason;
      child.stdin!.write(`${JSON.stringify({ method: "initialized" })}\n`);
      return codexReports(await request("account/rateLimits/read"));
    })();
    read.catch(() => undefined);
    try {
      return await Promise.race([read, late]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  });
}

export interface CodexUsageOptions {
  command: readonly string[];
  /** The environment for the process, taken when it starts. */
  env: () => NodeJS.ProcessEnv;
  /** Where the reports go. */
  record: (reports: UsageInfo[]) => void;
  /** The engine's log. */
  log: (text: string) => void;
  changed?: () => void;
  timeoutMs?: number;
}

/** Reads Codex's usage for the engine, one read at a time, and says once per reason when it cannot. */
export class CodexUsage extends UsageReader {
  constructor(options: CodexUsageOptions) {
    super({
      name: "Codex",
      record: options.record,
      log: options.log,
      ...(options.changed ? { changed: options.changed } : {}),
      read: context => readCodexUsage({
      command: options.command,
      env: options.env(),
      ...context,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
    })
    });
  }
}
