import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Platform } from "@petrina/core";
import type { ToolProbeResult } from "@petrina/orchestrator";
import { run, type Gh, type RunResult, type StartFailure } from "./git.js";

/** Where a program is on the PATH, or null. Tests stand in their own. */
export type Which = (name: string) => string | null;

/** How long one check may take before it counts as "Couldn't check". */
export const CHECK_TIMEOUT_MS = 8_000;

const tail = (text: string) => text.trim().slice(-400);

const START_REASONS: Record<Exclude<StartFailure["kind"], "missing-executable">, string> = {
  "temporary-directory": "Petrina couldn't prepare the temporary folder it uses for checks.",
  "working-directory": "The folder this check runs from is unavailable.",
  permission: "The system refused permission to start this check.",
  other: "Petrina couldn't start this check.",
};

/** A failed launch says nothing about installation unless the executable itself is missing. */
function startCheckResult(result: RunResult): ToolProbeResult | undefined {
  const failure = result.startFailure;
  if (!failure) return undefined;
  if (failure.kind === "missing-executable") return { status: "not-installed" };
  return { status: "unknown", detail: `${START_REASONS[failure.kind]}\n${failure.message}`.slice(0, 400) };
}

/** Is the GitHub CLI installed and logged in to github.com, and as whom? */
export async function checkGh(gh: Gh, timeoutMs = CHECK_TIMEOUT_MS): Promise<ToolProbeResult> {
  const result = await run([...gh, "auth", "status", "--hostname", "github.com"], tmpdir(), undefined, { credentials: true, timeoutMs });
  const said = `${result.stdout}\n${result.stderr}`;
  const failedStart = startCheckResult(result);
  if (failedStart) return failedStart;
  if (result.timedOut) return { status: "unknown", detail: `The GitHub CLI did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
  const account = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(said)?.[1];
  if (result.code === 0) return { status: "ready", ...(account ? { account } : {}) };
  if (/not logged in|gh auth login|token .* is (invalid|expired)/i.test(said)) return { status: "logged-out", detail: tail(said) };
  return { status: "unknown", detail: tail(said) };
}

/**
 * Is Git there? On a Mac without Apple's developer tools, /usr/bin/git is a stand-in that opens
 * their installer when it runs, so that case is told apart without running it.
 */
export async function checkGit(which: Which, platform: Platform, options: { timeoutMs?: number; developerTools?: () => Promise<DeveloperToolsResult> } = {}): Promise<ToolProbeResult> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const path = which("git");
  if (!path) return { status: "not-installed" };
  if (platform === "darwin" && path === "/usr/bin/git") {
    const tools = await (options.developerTools ?? (() => developerTools(timeoutMs)))();
    if (tools.kind === "unknown") return { status: "unknown", detail: tools.detail };
    if (tools.kind === "missing" || !existsSync(join(tools.path, "usr", "bin", "git"))) return { status: "not-installed" };
  }
  return versionCheck([path, "--version"], timeoutMs);
}

/** Where Apple's developer tools are. xcode-select -p only prints it; it never offers to install them. */
export type DeveloperToolsResult = { kind: "found"; path: string } | { kind: "missing" } | { kind: "unknown"; detail: string };

async function developerTools(timeoutMs: number): Promise<DeveloperToolsResult> {
  const result = await run(["/usr/bin/xcode-select", "-p"], tmpdir(), undefined, { timeoutMs });
  const failedStart = startCheckResult(result);
  if (failedStart) return failedStart.status === "not-installed" ? { kind: "missing" } : { kind: "unknown", detail: failedStart.detail! };
  if (result.timedOut) return { kind: "unknown", detail: "Apple's developer tools lookup did not answer in time." };
  if (result.code !== 0) return { kind: "missing" };
  return result.stdout ? { kind: "found", path: result.stdout } : { kind: "unknown", detail: "Apple's developer tools lookup gave no answer." };
}

export async function versionCheck(command: readonly string[], timeoutMs: number): Promise<ToolProbeResult> {
  const result = await run(command, tmpdir(), undefined, { timeoutMs });
  const failedStart = startCheckResult(result);
  if (failedStart) return failedStart;
  if (result.code === 0) return { status: "ready" };
  return { status: "unknown", detail: tail(result.timedOut ? "It did not answer in time." : `${result.stderr}\n${result.stdout}`) };
}
