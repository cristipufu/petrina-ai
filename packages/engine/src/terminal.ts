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
import { join, posix } from "node:path";
import type { SessionState } from "@petrina/core";

export type Platform = "darwin" | "win32" | "linux";

/** A terminal found on this machine, and how to make it run a launcher. */
export interface FoundTerminal {
  id: string;
  name: string;
  /** The command that opens a new window running `launcher`. */
  open(launcher: string): string[];
  /** Windows: a PowerShell window of its own, started straight from Petrina. */
  ownConsole?: boolean;
}

/** What detection may look at, so tests can describe any machine. */
export interface Probe {
  platform: Platform;
  env: Readonly<Record<string, string | undefined>>;
  which(program: string): string | null;
  exists(path: string): boolean;
  home: string;
}

interface MacApp {
  id: string;
  name: string;
  bundle: string;
  /** Apps that open a script handed to them; the others run it from their command line. */
  args?: (launcher: string) => string[];
}

const MAC_APPS: readonly MacApp[] = [
  { id: "terminal", name: "Terminal", bundle: "Terminal.app" },
  { id: "iterm", name: "iTerm2", bundle: "iTerm.app" },
  { id: "ghostty", name: "Ghostty", bundle: "Ghostty.app", args: (launcher) => ["-e", launcher] },
  { id: "wezterm", name: "WezTerm", bundle: "WezTerm.app", args: (launcher) => ["start", "--", launcher] },
  { id: "alacritty", name: "Alacritty", bundle: "Alacritty.app", args: (launcher) => ["-e", launcher] },
  { id: "kitty", name: "kitty", bundle: "kitty.app", args: (launcher) => [launcher] },
];

interface LinuxTerminal {
  id: string;
  name: string;
  args: (launcher: string) => string[];
  /** The desktops this is the usual terminal of, as XDG_CURRENT_DESKTOP names them. */
  desktops?: readonly string[];
}

const LINUX_DEFAULTS: readonly LinuxTerminal[] = [
  { id: "xdg-terminal-exec", name: "System default (xdg-terminal-exec)", args: (launcher) => [launcher] },
  { id: "x-terminal-emulator", name: "System default (x-terminal-emulator)", args: (launcher) => ["-e", launcher] },
];

const LINUX_TERMINALS: readonly LinuxTerminal[] = [
  { id: "ptyxis", name: "Ptyxis", args: (launcher) => ["--new-window", "--", launcher], desktops: ["GNOME"] },
  { id: "kgx", name: "Console", args: (launcher) => ["--", launcher], desktops: ["GNOME"] },
  { id: "gnome-terminal", name: "GNOME Terminal", args: (launcher) => ["--", launcher], desktops: ["GNOME", "UNITY", "CINNAMON"] },
  { id: "konsole", name: "Konsole", args: (launcher) => ["-e", launcher], desktops: ["KDE"] },
  { id: "xfce4-terminal", name: "Xfce Terminal", args: (launcher) => ["-x", launcher], desktops: ["XFCE"] },
  { id: "mate-terminal", name: "MATE Terminal", args: (launcher) => ["-x", launcher], desktops: ["MATE"] },
  { id: "lxterminal", name: "LXTerminal", args: (launcher) => ["-e", launcher], desktops: ["LXDE"] },
  { id: "alacritty", name: "Alacritty", args: (launcher) => ["-e", launcher] },
  { id: "kitty", name: "kitty", args: (launcher) => [launcher] },
  { id: "wezterm", name: "WezTerm", args: (launcher) => ["start", "--", launcher] },
  { id: "foot", name: "foot", args: (launcher) => [launcher] },
  { id: "xterm", name: "XTerm", args: (launcher) => ["-e", launcher] },
];

/**
 * The terminals on this machine, the usual one first: Terminal on macOS (then iTerm2 and others that
 * are installed), Windows Terminal or else a PowerShell window on Windows, and on Linux the system
 * default, then the desktop's own, then common ones. None on a Linux machine without a desktop.
 */
export function detectTerminals(probe: Probe): FoundTerminal[] {
  if (probe.platform === "darwin") {
    const found: FoundTerminal[] = [];
    for (const app of MAC_APPS) {
      // macOS paths, joined the same way whichever system works them out.
      const path = ["/System/Applications/Utilities", "/Applications/Utilities", "/Applications", posix.join(probe.home, "Applications")].map((dir) => posix.join(dir, app.bundle)).find((candidate) => probe.exists(candidate));
      if (!path) continue;
      const args = app.args;
      found.push({ id: app.id, name: app.name, open: args ? (launcher) => ["open", "-na", path, "--args", ...args(launcher)] : (launcher) => ["open", "-a", path, launcher] });
    }
    return found;
  }
  if (probe.platform === "win32") {
    const found: FoundTerminal[] = [];
    const wt = probe.which("wt");
    const powershell = probe.which("powershell") ?? "powershell.exe";
    if (wt) found.push({ id: "windows-terminal", name: "Windows Terminal", open: (launcher) => [wt, "-w", "new", powershell, ...POWERSHELL_ARGS, launcher] });
    found.push({ id: "powershell", name: "PowerShell window", open: (launcher) => [powershell, ...POWERSHELL_ARGS, launcher], ownConsole: true });
    return found;
  }
  if (!probe.env.DISPLAY && !probe.env.WAYLAND_DISPLAY) return [];
  const desktops = (probe.env.XDG_CURRENT_DESKTOP ?? "").toUpperCase().split(":").filter(Boolean);
  const own = LINUX_TERMINALS.filter((entry) => entry.desktops?.some((desktop) => desktops.includes(desktop)));
  const ordered = [...LINUX_DEFAULTS, ...own, ...LINUX_TERMINALS.filter((entry) => !own.includes(entry))];
  const found: FoundTerminal[] = [];
  for (const entry of ordered) {
    const program = probe.which(entry.id);
    if (program) found.push({ id: entry.id, name: entry.name, open: (launcher) => [program, ...entry.args(launcher)] });
  }
  return found;
}

/** This machine, as detection sees it. */
export function thisMachine(): Probe {
  const platform: Platform = process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
  return { platform, env: process.env, which: (program) => Bun.which(program), exists: existsSync, home: homedir() };
}

/** The coordinator's choice when it is installed, otherwise the usual one. */
export function pickTerminal(found: readonly FoundTerminal[], chosen: string | undefined): FoundTerminal | undefined {
  return found.find((entry) => entry.id === chosen) ?? found[0];
}

const POWERSHELL_ARGS = ["-NoLogo", "-ExecutionPolicy", "Bypass", "-File"] as const;

// ── The launcher ───────────────────────────────────────────────────────────

/** A value that failed its pattern: take-over refuses rather than put it in a launcher. */
export class UnsafeValue extends Error {}

/** Folders and programs: letters, digits, spaces and the punctuation paths use. No quotes, `$`, `;`, `&`, `|`, `%` or line breaks. */
const PATH = /^[\p{L}\p{N} ._\-/\\:~+@()]{1,400}$/u;
const ABSOLUTE = /^(\/|[A-Za-z]:\\)/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9._-]{1,64}$/;
const EFFORT = /^(low|medium|high|xhigh)$/;

function checked(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new UnsafeValue(`Petrina can't put ${what} in a launcher safely`);
  return value;
}

function checkedPath(value: string, what: string): string {
  checked(value, PATH, what);
  if (!ABSOLUTE.test(value) || value.split(/[\\/]/).includes("..")) throw new UnsafeValue(`Petrina can't put ${what} in a launcher safely`);
  return value;
}

export interface LaunchInput {
  platform: Platform;
  /** The take-over folder: the launcher, its lock, records and status file live here. */
  dir: string;
  worktree: string;
  /** `mode`: Claude Code's ask-before-acting mode, by the name the installed copy lists. */
  tool: { id: "claude-code" | "codex"; name: string; path: string; mode?: AskMode };
  sessionId: string;
  model: string;
  effort: string;
}

export interface LaunchPlan {
  /** The launcher, and what it holds. */
  file: string;
  script: string;
  /** The tool's command line inside it. */
  args: readonly string[];
  /** A command the coordinator can run in any terminal: the launcher, nothing else. */
  copy: string;
}

/** Claude Code's ask-before-acting mode: "manual" in current versions, "default" before (still accepted). */
export type AskMode = "manual" | "default";

/**
 * The tool on the conversation, with the same model and effort, in its normal mode with its usual
 * prompts: Claude Code's ask-before-acting permission mode, Codex's workspace sandbox with on-request
 * approvals that the coordinator answers. Never a skip-permissions or auto-approve option.
 */
export function toolArgs(input: Pick<LaunchInput, "tool" | "sessionId" | "model" | "effort">): string[] {
  const path = checkedPath(input.tool.path, `${input.tool.name}'s location`);
  const session = checked(input.sessionId, SESSION, "the conversation's id");
  const model = checked(input.model, MODEL, "the model's name");
  const effort = checked(input.effort, EFFORT, "the effort");
  if (input.tool.id === "claude-code") return [path, "--resume", session, "--model", model, "--effort", effort, "--permission-mode", checked(input.tool.mode ?? "default", /^(manual|default)$/, "the permission mode")];
  // --no-daemon: Codex keeps the conversation in this window only, so the agent can reopen it once the window closes.
  return [path, "resume", session, "--model", model, "-c", `model_reasoning_effort=${effort}`, "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", "approvals_reviewer=user", "--no-daemon"];
}

const sh = (value: string) => `'${value}'`;
const ps = (value: string) => `'${value}'`;

/** The launcher for this system. Throws UnsafeValue when any value fails its pattern. */
export function launchPlan(input: LaunchInput): LaunchPlan {
  const dir = checkedPath(input.dir, "Petrina's folder");
  const worktree = checkedPath(input.worktree, "the working copy's folder");
  const args = toolArgs(input);
  const name = input.tool.name;
  const already = `${name} is already open in your terminal for this task. Use that window.`;
  const closed = `${name} has closed. You can close this window and click Hand back in Petrina.`;
  if (input.platform === "win32") {
    const file = `${dir}\\open.ps1`;
    // Windows PowerShell reads a script without a byte order mark in the system's code page, which
    // garbles folder names with accented letters: the mark makes it read the script as UTF-8.
    const script = `\uFEFF${[
      `# Petrina: take over in your terminal. Opens ${name} on the agent's conversation, in the task's working copy,`,
      "# in its normal mode. Only one copy runs per task, and it notes when it starts and ends, so Petrina can tell whether it is still open.",
      `$dir = ${ps(dir)}`,
      "$status = Join-Path $dir 'status'",
      '$me = Join-Path $dir "run.$PID"',
      "function Write-Note([string]$path, [string[]]$lines) {",
      '  Set-Content -LiteralPath "$path.tmp" -Value $lines -Encoding ascii',
      '  Move-Item -LiteralPath "$path.tmp" -Destination $path -Force',
      "}",
      "# This copy's record while it runs: its process id and when it started, so a reused number is not mistaken for it.",
      'Write-Note $me @("pid=$PID", "started=$((Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks)")',
      "# Only one copy at a time: it holds the lock file open for itself until it ends, and the system lets go of it if it is killed.",
      "try {",
      "  $lock = [System.IO.File]::Open((Join-Path $dir 'lock'), 'OpenOrCreate', 'ReadWrite', 'None')",
      "} catch {",
      "  Remove-Item -LiteralPath $me -Force -ErrorAction SilentlyContinue",
      `  Write-Host ${ps(already)}`,
      "  Read-Host 'Press Enter to close this window'",
      "  exit 1",
      "}",
      "$code = ''",
      "try {",
      `  Set-Location -LiteralPath ${ps(worktree)}`,
      `  & ${args.map(ps).join(" ")}`,
      "  $code = $LASTEXITCODE",
      "} finally {",
      "  Write-Note $status @('state=ended', \"code=$code\")",
      "  $lock.Dispose()",
      "  Remove-Item -LiteralPath $me -Force -ErrorAction SilentlyContinue",
      "}",
      "Write-Host ''",
      `Write-Host ${ps(closed)}`,
      "",
    ].join("\r\n")}`;
    return { file, script, args, copy: `powershell ${POWERSHELL_ARGS.join(" ")} "${file}"` };
  }
  // macOS opens a .command file in a new Terminal window; Linux terminals run it by path.
  const file = `${dir}/open.${input.platform === "darwin" ? "command" : "sh"}`;
  const script = [
    "#!/bin/sh",
    `# Petrina: take over in your terminal. Opens ${name} on the agent's conversation, in the task's working copy,`,
    "# in its normal mode. Only one copy runs per task, and it notes when it starts and ends, so Petrina can tell whether it is still open.",
    `dir=${sh(dir)}`,
    'status="$dir/status"',
    'lock="$dir/lock"',
    'me="$dir/run.$$"',
    "# Whether the copy with this record is running: the same process id, with the same start time.",
    "alive() {",
    "  pid=$(printf '%s\\n' \"$1\" | sed -n 's/^pid=//p')",
    "  started=$(printf '%s\\n' \"$1\" | sed -n 's/^started=//p')",
    '  [ -n "$pid" ] && [ -n "$started" ] && kill -0 "$pid" 2>/dev/null && [ "$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null)" = "$started" ]',
    "}",
    "note() {",
    "  file=$1",
    "  shift",
    "  printf '%s\\n' \"$@\" > \"$file.tmp\" && mv -f \"$file.tmp\" \"$file\"",
    "}",
    "finish() {",
    '  if [ "$(cat "$lock" 2>/dev/null)" = "$(cat "$me" 2>/dev/null)" ]; then',
    '    note "$status" state=ended "code=$1"',
    '    rm -f "$lock"',
    "  fi",
    '  rm -f "$me"',
    "}",
    "refuse() {",
    '  rm -f "$me"',
    `  echo ${sh(already)}`,
    "  [ -t 0 ] && printf 'Press Enter to close this window. ' && read -r _",
    "  exit 1",
    "}",
    "# A closed window is noted from the moment this copy has a record, so no record outlives it unnoticed.",
    "trap 'finish 129; exit 129' HUP TERM",
    "# This copy's record while it runs: its process id and when it started, so a reused number is not mistaken for it.",
    'note "$me" "pid=$$" "started=$(LC_ALL=C ps -o lstart= -p $$ 2>/dev/null)" || exit 1',
    "# Only one copy at a time: the lock appears holding its owner's record in one step, and a copy that finds it",
    "# held by a running copy stops. One left by a copy that is gone is set aside, unless another copy just took it.",
    "tries=0",
    'until ln "$me" "$lock" 2>/dev/null; do',
    "  tries=$((tries + 1))",
    "  if [ \"$tries\" -gt 50 ]; then rm -f \"$me\"; echo 'Petrina could not start this. Try Reopen terminal in Petrina.'; exit 1; fi",
    '  held=$(cat "$lock" 2>/dev/null) || continue',
    '  alive "$held" && refuse',
    '  mv -f "$lock" "$dir/stale.$$" 2>/dev/null || continue',
    '  [ "$(cat "$dir/stale.$$")" = "$held" ] || ln "$dir/stale.$$" "$lock" 2>/dev/null',
    '  rm -f "$dir/stale.$$"',
    "done",
    "# Ctrl-C belongs to the tool: this launcher waits for it to close.",
    "trap : INT",
    `cd ${sh(worktree)} || { finish 1; exit 1; }`,
    args.map(sh).join(" "),
    "code=$?",
    'finish "$code"',
    "trap - HUP TERM INT",
    "echo",
    `echo ${sh(closed)}`,
    "",
  ].join("\n");
  return { file, script, args, copy: sh(file) };
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

/** Petrina's own variables stay out of the terminal; everything else is the coordinator's. */
export function terminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!/^PETRINA_/i.test(name)) out[name] = value;
  return out;
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

/** Claude Code's ask-before-acting mode, by the name the installed copy lists in its help. */
export async function askMode(path: string): Promise<AskMode> {
  const help = await output([path, "--help"]);
  return /"manual"/.test(help) ? "manual" : "default";
}

/** What a short command prints, or nothing when it fails or takes longer than 10 seconds. */
async function output(command: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...terminalEnv(process.env), LC_ALL: "C" }, windowsHide: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const text = await Promise.race([new Response(proc.stdout).text(), new Promise<string>((resolve) => (timer = setTimeout(() => resolve(""), 10_000)))]);
    clearTimeout(timer);
    proc.kill();
    return text;
  } catch {
    return "";
  }
}

/** When a process started, as the launcher records it: `ps` in the C locale, or .NET ticks on Windows. */
async function startTime(pid: number, platform: Platform): Promise<string | undefined> {
  const command =
    platform === "win32"
      ? ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`]
      : ["ps", "-o", "lstart=", "-p", String(pid)];
  return (await output(command)).trim() || undefined;
}
