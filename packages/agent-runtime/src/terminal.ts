import { terminalOutput } from "./terminal-output.js";
import { ADAPTERS } from "./tools.js";
// Take over in the coordinator's own terminal. Petrina writes one small launcher into a folder only
// the coordinator can read, and asks the usual terminal of the system to run it. The launcher opens
// the agent's own tool (Claude Code or Codex) on the same conversation, in the task's working copy,
// in the tool's normal mode with its usual prompts. Only one copy runs per task: a second one, even
// started at the same moment, refuses. Each copy keeps a record (its process id and start time) while
// it runs, and the one that opened the tool notes when it ends, so Petrina can tell whether any is open.
//
// Nothing typed by a person or an agent goes into a launcher: every value in it is checked against a
// strict pattern first. No launcher, status file or command line holds a credential, and the terminal
// never gets Petrina's own environment variables.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionState } from "@petrina/core";

import {
  terminalEnv,
  launchPlan as prepareLaunchPlan,
  toolArgs as prepareToolArgs,
  type Platform,
  type Probe,
  type FoundTerminal,
  type LaunchPlan,
  type LaunchInput,
} from "./terminal-plan.js";
export { detectTerminals, pickTerminal, terminalEnv, UnsafeValue } from "./terminal-plan.js";
export type { Platform, Probe, FoundTerminal, LaunchPlan, LaunchInput, AskMode } from "./terminal-plan.js";

/** Native catalog binding; the formatters themselves perform no process or account reads. */
export function toolArgs(input: Pick<LaunchInput, "tool" | "sessionId" | "model" | "effort">): string[] {
  return prepareToolArgs(input, ADAPTERS[input.tool.id]?.terminalArgs);
}
export function launchPlan(input: LaunchInput): LaunchPlan {
  return prepareLaunchPlan(input, ADAPTERS[input.tool.id]?.terminalArgs);
}

/** This machine, as detection sees it. */
export function thisMachine(): Probe {
  const platform: Platform = process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
  return { platform, env: process.env, which: (program) => Bun.which(program), exists: existsSync, home: homedir() };
}

/** Write the launcher, in a folder only the coordinator can read. A fresh take-over starts from an empty folder. */
export async function writeLauncher(plan: LaunchPlan, dir: string, fresh: boolean): Promise<void> {
  if (fresh) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  await writeFile(plan.file, plan.script, { mode: 0o700 });
  await chmod(plan.file, 0o700).catch(() => undefined);
}

export async function removeLauncher(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Open a new terminal window running the launcher. Resolves with a plain reason when it did not open
 * (the program is missing, or it gave up at once), or undefined once it is on its way.
 */
export function openTerminal(terminal: FoundTerminal, launcher: string): Promise<string | undefined> {
  const [program, ...args] = terminal.open(launcher);
  return new Promise((resolve) => {
    let done = false;
    const finish = (problem: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(problem);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // A PowerShell window of its own on Windows; everywhere else the terminal opens its own window.
      child = spawn(program!, args, { detached: true, stdio: "ignore", env: terminalEnv(process.env), windowsHide: !terminal.ownConsole });
    } catch {
      return resolve(`${terminal.name} could not be started`);
    }
    child.once("error", () => finish(`${terminal.name} could not be started`));
    child.once("exit", (code) => finish(code === 0 || code === null ? undefined : `${terminal.name} did not open (it stopped with code ${code})`));
    child.unref();
    // Still running a moment later: the terminal is the window itself, and it is open.
    const timer = setTimeout(() => finish(undefined), 1500);
  });
}

// ── Is it still open? ──────────────────────────────────────────────────────

const RECORD = /^run\.\d{1,10}$/;

/**
 * Whether the tool Petrina opened is still running, from the records the launcher's copies keep while
 * they run. Running while any copy is. A process id only counts with the same start time, so a number
 * the system gave to another process is not mistaken for it. Ended once the copy that opened the tool
 * said so, or every copy is gone. Unknown when no copy ever reported starting, or a record can't be checked.
 */
export async function sessionState(dir: string, platform: Platform = thisMachine().platform): Promise<SessionState> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return "unknown";
  }
  let unsure = false;
  let gone = false;
  for (const name of names.filter((entry) => RECORD.test(entry))) {
    const state = await recordState(join(dir, name), platform);
    if (state === "running") return "running";
    if (state === "unknown") unsure = true;
    else gone = true;
  }
  if (unsure) return "unknown";
  const status = await readFile(join(dir, "status"), "utf8").catch(() => "");
  if (status.split(/\r?\n/).includes("state=ended")) return "ended";
  // Gone without a word: the window was closed.
  return gone ? "ended" : "unknown";
}

/** Before the terminal opens again: what the last session left says nothing about the next one. Records of running copies stay. */
export async function clearEnded(dir: string, platform: Platform = thisMachine().platform): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter((entry) => RECORD.test(entry))) {
    if ((await recordState(join(dir, name), platform)) === "ended") await rm(join(dir, name), { force: true });
  }
  await rm(join(dir, "status"), { force: true });
}

async function recordState(file: string, platform: Platform): Promise<SessionState> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return "ended";
  const pid = Number(/^pid=(\d{1,10})\r?$/m.exec(text)?.[1]);
  const started = /^started=(.*)$/m.exec(text)?.[1]?.trim();
  if (!pid || !started) return "unknown";
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "ended";
  }
  const now = await startTime(pid, platform);
  if (now === undefined) return "unknown";
  return sameStart(now, started, platform) ? "running" : "ended";
}

/**
 * The same start time. On Windows these are .NET ticks (tenths of a microsecond) read by two
 * processes, which can differ slightly where .NET works the time out (PowerShell 7 on Linux does):
 * within a tenth of a second is the same start, far too soon for the number to have been reused.
 */
function sameStart(now: string, noted: string, platform: Platform): boolean {
  if (platform !== "win32") return now === noted;
  if (!/^\d{1,20}$/.test(now) || !/^\d{1,20}$/.test(noted)) return false;
  const apart = BigInt(now) - BigInt(noted);
  return apart >= -1_000_000n && apart <= 1_000_000n;
}

export { askMode } from "./claude-ask-mode.js";

/** When a process started, as the launcher records it: `ps` in the C locale, or .NET ticks on Windows. */
async function startTime(pid: number, platform: Platform): Promise<string | undefined> {
  const command =
    platform === "win32"
      ? [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`
      ]
      : ["ps", "-o", "lstart=", "-p", String(pid)];
  return (await terminalOutput(command) ?? "").trim() || undefined;
}
