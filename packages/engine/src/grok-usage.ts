// Grok's own ACP billing extension and whole-prompt usage. No prompts, credential-file
// reads or direct billing HTTP calls: the installed CLI uses the coordinator's login.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { TokenCounts, TurnReport } from "@petrina/core";
import { ADAPTERS } from "./tools.js";
import type { ReadOptions } from "./codex-usage.js";
import type { UsageInfo } from "./usage.js";
import { UsageReader } from "./usage-reader.js";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** ACP input includes cache reads and writes; Petrina keeps those in disjoint buckets. */
function countsOf(value: unknown): TokenCounts | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const input = number(raw.inputTokens), output = number(raw.outputTokens), cacheRead = number(raw.cachedReadTokens), cacheWrite = number(raw.cacheCreationTokens);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || input < cacheRead + cacheWrite) return undefined;
  const reasoning = number(raw.reasoningTokens);
  return { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite, total: input + output, ...(reasoning !== undefined ? { reasoning } : {}) };
}

/** `_meta.usage` counts the whole prompt, including folded subagents. Sibling token
 * fields describe only the last model call; `_meta.totalTokens` is context size. */
export function grokTurnReport(response: unknown): TurnReport | undefined {
  const usage = object(object(object(response)?._meta)?.usage);
  // An unfinished bill cannot be presented as a complete turn. It stays unreported,
  // which the existing work-log accounting marks as missing from the total.
  if (!usage || usage.usageIsIncomplete === true) return undefined;
  const main = countsOf(usage);
  const models = Object.entries(object(usage.modelUsage) ?? {}).flatMap(([model, value]) => {
    const counts = countsOf(value);
    return model.trim() && counts ? [{ model, counts }] : [];
  });
  // A missing per-model row must not make a valid whole-prompt total disappear.
  const completeModels = models.length && (!main || models.reduce((sum, row) => sum + row.counts.total!, 0) === main.total);
  const modelId = object(object(response)?._meta)?.modelId;
  const primary = completeModels && (models.length === 1 ? models[0]!.model : models.some(row => row.model === modelId) ? modelId as string : undefined);
  // An aggregate with no complete breakdown may include other models. Keep its
  // tokens under "Model not reported" instead of crediting them all to the session model.
  const lines = completeModels ? models : main ? [{ model: "", counts: main }] : undefined;
  return main || completeModels ? { ...(main ? { main } : {}), ...(lines ? { models: lines } : {}), ...(primary ? { model: primary } : {}) } : undefined;
}

/** Only capacity leaves this function. Financial account details are never retained. */
export function grokReports(response: unknown): UsageInfo[] {
  const config = object(object(response)?.config);
  const percent = number(config?.creditUsagePercent);
  if (!config || percent === undefined) return [];
  const period = object(config.currentPeriod);
  const end = typeof period?.end === "string" ? Date.parse(period.end) : NaN;
  const kind = period?.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "seven_day" : period?.type === "USAGE_PERIOD_TYPE_MONTHLY" ? "monthly" : "limit";
  return [{ toolId: "grok", kind, utilization: percent / 100, status: percent >= 100 ? "rejected" : percent >= 90 ? "allowed_warning" : "allowed", ...(Number.isFinite(end) ? { resetsAt: end } : {}) }];
}

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
  constructor(options: { command: readonly string[]; env: () => NodeJS.ProcessEnv; record: (reports: UsageInfo[]) => void; log: (text: string) => void; timeoutMs?: number }) {
    super({ name: "Grok", record: options.record, log: options.log, read: (onProcess) => readGrokUsage({ command: options.command, env: options.env(), onProcess, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }) });
  }
}
