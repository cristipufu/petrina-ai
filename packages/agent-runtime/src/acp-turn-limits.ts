import type { ChildProcess } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import { inFamily, type AgentProfile } from "@petrina/core";
import { stopAgentPrograms, type StopDiagnostic } from "@petrina/platform/agent-stop";
import { processHost } from "@petrina/platform/process-host";
import { readProcessGroups, readProcessList, type ProcessListRead } from "@petrina/platform/process-tree";
import { FORCE_AFTER_MS, type RunCallbacks, type RunState } from "./acp-protocol.js";
import { AGENT_CLEANUP_NOTE } from "./browser-cleanup.js";
import { cleanupNote } from "./browser.js";
import type { AccountReading } from "./tool-adapter.js";
import { ADAPTERS } from "./tool-catalog.js";
import { limitFromFailure, limitFromReport, ModelAtCapacity, type UsageLimited } from "./usage.js";

export const isChildRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

/**
 * Stop the tool and every program it started (a build, a test run, a server), which could otherwise keep
 * writing in the working copy after the tool is gone. Pause known owners before collecting their
 * descendants: an owner running during a delayed snapshot could fork a detached worker it misses.
 * Resolves when they have all exited; forced after a few seconds. When that cannot be confirmed, `note` gets
 * one private line saying why: which process lists could not be read, and what stayed present.
 */
export async function stopAll(
  child: ChildProcess,
  graceMs = FORCE_AFTER_MS,
  collectPrograms = true,
  note?: (line: string) => void,
  read: ProcessListRead = readProcessGroups,
): Promise<boolean> {
  if (child.pid === undefined) return true;
  if (processHost.stopTree) {
    if (!isChildRunning(child)) return true;
    return processHost.stopTree(child.pid, 3000);
  }
  return stopAgentPrograms({ pid: child.pid, running: () => isChildRunning(child) }, graceMs, collectPrograms, {
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    selfPid: process.pid,
    alive(target) {
      try {
        process.kill(target, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    possiblyPresent(target) {
      try {
        process.kill(target, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    },
    signal: (target, sig) => {
      process.kill(target, sig);
    },
    readParents: (timeout) => readProcessList(timeout),
    readGroups: (timeout) => read(timeout),
    ...(note
      ? {
          incomplete: (facts: StopDiagnostic) =>
            note(
              cleanupNote(
                AGENT_CLEANUP_NOTE,
                [
                  ["stage", facts.stage],
                  ["elapsed", `${facts.elapsedMs}ms`],
                  ["lists", facts.lists.join(",") || "none"],
                ],
                facts.processes,
              ),
            ),
        }
      : {}),
  });
}

export async function readAcpAccountUsage(options: {
  child: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  profile: AgentProfile;
  state: RunState;
  callbacks?: RunCallbacks;
  onStop: () => Promise<boolean>;
  setAccountBefore: (reading: AccountReading | undefined) => void;
}): Promise<AccountReading | undefined> {
  const { child, connection, sessionId, profile, state, callbacks, onStop, setAccountBefore } = options;
  if (!isChildRunning(child)) {
    setAccountBefore(undefined);
    return undefined;
  }
  const adapter = ADAPTERS[profile.toolId];
  const accounting = adapter?.accountUsage;
  if (!accounting) return undefined;
  state.accountText = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let onExit!: () => void;
  const exited = new Promise<never>((_, reject) => {
    onExit = () => reject(new Error(`${adapter!.name} stopped before reporting usage`));
    child.once("exit", onExit);
  });
  try {
    const response = await Promise.race([
      connection.prompt({ sessionId, prompt: [{ type: "text", text: accounting.command }] }),
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`${adapter!.name} did not report usage in time`));
        }, 20_000);
      }),
    ]);
    if (response.stopReason !== "end_turn") {
      throw new Error(`${adapter!.name} did not finish reporting account usage`);
    }
    const reading = accounting.parse(state.accountText);
    if (callbacks?.onAccountUsage) callbacks.onAccountUsage(reading.reports);
    else for (const info of reading.reports) callbacks?.onUsage?.(info);
    setAccountBefore(reading);
    return reading;
  } catch (error) {
    setAccountBefore(undefined);
    callbacks?.onLog?.(error instanceof Error ? error.message : `Could not read ${adapter!.name} usage`);
    if (timedOut) await onStop();
    return undefined;
  } finally {
    child.removeListener("exit", onExit);
    clearTimeout(timer);
    delete state.accountText;
  }
}

export function acpRejectedUsage(
  profile: AgentProfile,
  state: RunState,
  accountBefore: AccountReading | undefined,
  source: "report" | "refusal" = "report",
): UsageLimited | undefined {
  const info =
    state.latest
    ?? accountBefore?.reports.find(
      (report) =>
        report.status === "rejected"
        && (report.resetsAt ?? 0) > Date.now()
        && (!report.model || inFamily(profile, report.model)),
    );
  return info?.status === "rejected"
    && !info.overage
    && (!info.model || inFamily(profile, info.model))
    && (info.resetsAt === undefined || info.resetsAt > Date.now())
    ? Object.assign(limitFromReport(profile, info, Date.now(), source), { said: state.response.text })
    : undefined;
}

export function acpCapacityOf(
  profile: AgentProfile,
  sessionId: string,
  state: RunState,
  accountBefore: AccountReading | undefined,
  source: unknown,
): ModelAtCapacity | undefined {
  const read = ADAPTERS[profile.toolId]?.interruptions?.capacity;
  if (!read || acpRejectedUsage(profile, state, accountBefore)) return undefined;
  const found = read(source, state.response.ending);
  if (!found) return undefined;
  const out = new ModelAtCapacity(profile.toolId, profile.modelId ?? profile.model, profile.id, sessionId);
  if (found.retryAfterMs !== undefined) out.retryAfterMs = found.retryAfterMs;
  if (state.response.text) out.said = state.response.text;
  if (state.messages.streamed) out.streamed = true;
  return out;
}

export function acpLimitOf(
  profile: AgentProfile,
  state: RunState,
  accountBefore: AccountReading | undefined,
  error: unknown,
  explicitOnly = false,
): UsageLimited | undefined {
  const failure = limitFromFailure(profile, error, state.response.ending, Date.now());
  if (explicitOnly && !failure) return undefined;
  const limited = failure?.independent
    ? failure
    : (acpRejectedUsage(profile, state, accountBefore, failure ? "refusal" : "report") ?? failure);
  if (limited) {
    limited.said ??= state.response.text;
    if (state.messages.streamed) limited.streamed = true;
  }
  return limited;
}
