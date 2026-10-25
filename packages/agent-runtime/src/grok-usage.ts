// Grok's own ACP billing extension and whole-prompt usage. No prompts, credential-file
// reads or direct billing HTTP calls: the installed CLI uses the coordinator's login.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { grokReports } from "./grok-report.js";
import { ADAPTERS } from "./tools.js";
import type { ReadOptions } from "./codex-usage.js";
import type { UsageInfo } from "./failures.js";
import { UsageReader } from "./usage-reader.js";

/** Initialize ACP, ask its read-only billing extension, then stop. No session or AI turn. */
export async function readGrokUsage(options: ReadOptions): Promise<UsageInfo[]> {
  const [program, ...args] = options.command ?? ADAPTERS.grok!.command!;
  const child = spawn(program!, args, { stdio: ["pipe", "pipe", "pipe"], env: options.env, windowsHide: true });
  options.onProcess?.(child);
  child.stdin!.on("error", () => undefined);
  child.stderr!.resume();
  const gone = new Promise<never>((_, reject) => {
    child.on("error", () => reject(new Error("Grok could not start")));
    child.on("exit", () => reject(new Error("Grok stopped before reporting usage")));
  });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
  const connection = new acp.ClientSideConnection(() => ({ sessionUpdate: async () => undefined, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), stream);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Grok did not report usage in time")), options.timeoutMs ?? 20_000); });
  const read = (async () => {
    await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
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
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2000);
      child.once("exit", () => clearTimeout(force));
    }
  }
}

export class GrokUsage extends UsageReader {
  constructor(options: { command: readonly string[]; env: () => NodeJS.ProcessEnv; record: (reports: UsageInfo[]) => void; log: (text: string) => void; changed?: () => void; timeoutMs?: number }) {
    super({ name: "Grok", record: options.record, log: options.log, ...(options.changed ? { changed: options.changed } : {}), read: (onProcess) => readGrokUsage({ command: options.command, env: options.env(), onProcess, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }) });
  }
}
