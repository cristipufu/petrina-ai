import { mkdir } from "node:fs/promises";
import { DEFAULT_PROFILES as ENGINE_PROFILES } from "@petrina/core";
import { AgentRun } from "./acp-run.js";
import type { ReadOptions } from "./codex-usage.js";
import type { UsageInfo } from "./failures.js";
import { UsageReader } from "./usage-reader.js";
import { usageChild, usageResult } from "./usage-process.js";

/** One native account command in Petrina's empty check folder, then stop the whole harness. */
export async function readAntigravityUsage(options: ReadOptions & { cwd: string }): Promise<UsageInfo[]> {
  const controller = new AbortController();
  const done = Promise.withResolvers<void>();
  void done.promise.catch(() => undefined);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let agent: AgentRun | undefined;
  let reading: ReturnType<AgentRun["readAccountUsage"]> | undefined;
  let native: Promise<void> | undefined;
  let owned: ReturnType<typeof usageChild> | undefined;
  return usageResult(async () => {
    options.onGone?.(done.promise);
    await mkdir(options.cwd, { recursive: true, mode: 0o700 });
    if (controller.signal.aborted) throw new Error("The account usage read was stopped");
    timer = setTimeout(abort, options.timeoutMs ?? 20_000);
    agent = await AgentRun.start({
      profile: ENGINE_PROFILES.find(profile => profile.toolId === "antigravity")!,
      cwd: options.cwd, env: options.env, signal: controller.signal, probe: true,
      ...(options.command ? { command: options.command } : {}),
      onGone(gone) {
        native = gone;
        void gone.catch(() => undefined);
      },
      onProcess(actual) {
        // AgentRun publishes native cleanup first; retain the actual handle before the external observer.
        owned = usageChild(actual);
        options.onProcess?.(actual);
      },
      callbacks: { onActivity: () => undefined, onPlanStep: () => undefined, onPermission: async () => "deny" },
    });
    const aborted = new Promise<never>((
      _,
      reject
    ) => controller.signal.addEventListener(
      "abort",
      () => reject(new Error("The account usage read was stopped")),
      { once: true }
    ));
    if (controller.signal.aborted) throw new Error("The account usage read was stopped");
    reading = agent.readAccountUsage();
    return (await Promise.race([reading, aborted]))?.reports ?? [];
  }, async () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
    const results = await Promise.allSettled([
      ...(agent ? [agent.stop()] : []), ...(native ? [native] : []),
    ]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (agent && results[0]?.status === "fulfilled" && results[0].value !== true && !failures.length)
      failures.push(new Error("Account usage cleanup was not confirmed"));
    // AgentRun owns its protocol/probe cleanup first; the same actual child's descriptors remain ours too.
    if (owned) try { await owned.stop(); } catch (error) { failures.push(error); }
    if (!failures.length) await Promise.allSettled(reading ? [reading] : []);
    const distinct = failures.filter((error, index) => !failures.slice(0, index).some(previous => Object.is(previous, error)));
    if (distinct.length) {
      const error = distinct.length === 1 ? distinct[0] : new AggregateError(distinct, "Account usage cleanup was not confirmed");
      done.reject(error);
      throw error;
    }
    done.resolve();
  });
}

export class AntigravityUsage extends UsageReader {
  constructor(options: {
    command: readonly string[];
    cwd: string;
    env: () => NodeJS.ProcessEnv;
    record: (reports: UsageInfo[]) => void;
    log: (text: string) => void;
    changed?: () => void
  }) {
    super({
      name: "Antigravity",
      record: options.record,
      log: options.log,
      ...(options.changed ? { changed: options.changed } : {}),
      read: context => readAntigravityUsage({
      command: options.command,
      cwd: options.cwd,
      env: options.env(),
      ...context
    })
    });
  }
}
