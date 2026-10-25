// Native coding-provider readiness, using the same session boundary as task execution.
import type { AgentProfile } from "@petrina/core";
import type { ToolProbeResult } from "@petrina/orchestrator";
import { isAuthRequired } from "./failures.js";
import { AgentRun } from "./acp-run.js";
import { adapterEntry, type ToolAdapter } from "./tools.js";

export type ExecutableLookup = (name: string) => string | null;
/** Native agents open a full session; cold startup can exceed a simple command's deadline. */
export const AGENT_CHECK_TIMEOUT_MS = 30_000;
const tail = (text: string) => text.trim().slice(-400);


/**
 * Is an agent tool installed and logged in? Opens a conversation in an empty folder with the same
 * command and environment its agents get, then closes it: no message reaches the AI. Ready needs the
 * tool's own word, given the way that tool gives it (its adapter's `login`). Claude Code and Codex
 * open a conversation while logged out (Claude Code asks for a login only at the first message), so
 * their connectors' report of the login they run on decides, where "none" is Not logged in. Grok sends
 * no report: it signs in as the conversation opens and refuses with ACP's "log in first" error when it
 * can't, so opening is its word. A tool that says nothing within the time limit is "Couldn't check",
 * never assumed Ready. The answer never waits past the time limit, even for a tool that ignores being
 * stopped: it is forced to stop afterwards, and `onGone` hears when it has.
 */
export async function checkAgentTool(options: {
  adapter: ToolAdapter;
  profile: AgentProfile;
  /** The command agents run with, when it is not the tool's own adapter (tests). */
  command?: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  which: ExecutableLookup;
  timeoutMs?: number;
  onGone?: (gone: Promise<void>) => void;
  /** Quitting Petrina also stops probes that have not finished checking yet. */
  signal?: AbortSignal;
  /** Explicit coordinator sign-in only; ordinary checks never open the browser. */
  authenticate?: string;
}): Promise<ToolProbeResult> {
  const { adapter } = options;
  if (!options.command) {
    try {
      if (!adapter.command) adapterEntry(adapter);
    } catch {
      return { status: "not-installed", detail: `Petrina's connector for ${adapter.name} is missing. Run bun install in Petrina's folder.` };
    }
    if (!options.which(adapter.cli)) return { status: "not-installed" };
    if (adapter.installed && !adapter.installed()) return { status: "not-installed", detail: `${adapter.name}'s connector is missing. Run bun run petrina antigravity install.` };
  }
  const limit = options.timeoutMs ?? AGENT_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), limit);
  let said = "";
  let login: string | undefined;
  let reported: () => void = () => undefined;
  const heard = new Promise<void>((done) => (reported = done));
  const late = new Promise<void>((done) => controller.signal.addEventListener("abort", () => done(), { once: true }));
  try {
    const agent = await AgentRun.start({
      probe: true,
      ...(options.authenticate ? { authenticate: options.authenticate } : {}),
      profile: options.profile,
      cwd: options.cwd,
      env: options.env,
      signal: controller.signal,
      startTimeoutMs: limit,
      ...(options.command ? { command: options.command } : {}),
      ...(options.onGone ? { onGone: options.onGone } : {}),
      callbacks: {
        onActivity: () => undefined,
        onPlanStep: () => undefined,
        onPermission: async () => "deny",
        onLog: (text) => (said = `${said}${text}`.slice(-2000)),
        onAuthStatus: (kind) => {
          login = kind;
          reported();
        },
      },
    });
    // A tool that signs in as the conversation opens has answered by opening it. Otherwise the report
    // can come before the conversation opens, or a moment after.
    if (adapter.login === "open") login ??= "opened";
    else await Promise.race([heard, late]);
    void agent.stop(2_000);
    if (login === undefined) return { status: "unknown", detail: `${adapter.name} started but did not say whether it is logged in within ${Math.round(limit / 1000)} seconds.` };
    return { status: login === "none" ? "logged-out" : "ready" };
  } catch (error) {
    if (isAuthRequired(error)) return { status: "logged-out" };
    const message = controller.signal.aborted ? `${adapter.name} did not answer within ${Math.round(limit / 1000)} seconds.` : error instanceof Error ? error.message : String(error);
    // Keep the cause first: a verbose connector must never displace it with debug output.
    return { status: "unknown", detail: [message.slice(0, 400), tail(said)].filter(Boolean).join("\n") };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
