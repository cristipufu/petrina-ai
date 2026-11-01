// Grok's own ACP billing extension and whole-prompt usage. No prompts, credential-file
// reads or direct billing HTTP calls: the installed CLI uses the coordinator's login.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { grokReports } from "./grok-report.js";
import type { ReadOptions } from "./codex-usage.js";
import type { UsageInfo } from "./failures.js";
import { UsageReader } from "./usage-reader.js";
import { withUsageProcess } from "./usage-process.js";

export const GROK_AGENT_COMMAND = ["grok", "--permission-mode", "auto", "agent", "stdio"] as const;

/** Initialize ACP, ask its read-only billing extension, then stop. No session or AI turn. */
export async function readGrokUsage(options: ReadOptions): Promise<UsageInfo[]> {
  const [program, ...args] = options.command ?? GROK_AGENT_COMMAND;
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
    child.stdin!.on("error", () => undefined);
    child.stderr!.resume();
    let abort = () => {};
    const gone = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      child.on("error", () => reject(new Error("Grok could not start")));
      child.on("exit", () => reject(new Error("Grok stopped before reporting usage")));
      child.on("close", () => reject(new Error("Grok stopped before reporting usage")));
    });
    if (signal.aborted) abort();
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const connection = new acp.ClientSideConnection(
      () => ({
      sessionUpdate: async () => undefined,
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } })
    }),
      stream
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((
      _,
      reject
    ) => { timer = setTimeout(
      () => reject(new Error("Grok did not report usage in time")),
      options.timeoutMs ?? 20_000
    ); });
    const read = (async () => {
      if (signal.aborted) throw signal.reason;
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
        fs: {
        readTextFile: false,
        writeTextFile: false
      },
        terminal: false
      }
      });
      if (signal.aborted) throw signal.reason;
      return grokReports(await connection.request("_x.ai/billing", {}));
    })();
    try { return await Promise.race([read, gone, late]); }
    catch (error) {
      // A failed spawn closes the protocol stream too. Its AbortError can win the race
      // against node's error event, but a missing process is still a startup failure.
      if (child.pid === undefined) throw new Error("Grok could not start", { cause: error });
      throw error;
    }
    finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  });
}

export class GrokUsage extends UsageReader {
  constructor(options: {
    command: readonly string[];
    env: () => NodeJS.ProcessEnv;
    record: (reports: UsageInfo[]) => void;
    log: (text: string) => void;
    changed?: () => void;
    timeoutMs?: number
  }) {
    super({
      name: "Grok",
      record: options.record,
      log: options.log,
      ...(options.changed ? { changed: options.changed } : {}),
      read: context => readGrokUsage({
      command: options.command,
      env: options.env(),
      ...context,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
    })
    });
  }
}
