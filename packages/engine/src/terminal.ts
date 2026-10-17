// Take over in the coordinator's own terminal. Petrina writes one small launcher into a folder only
// the coordinator can read, and asks the usual terminal of the system to run it. The launcher opens
// the agent's own tool (Claude Code or Codex) on the same conversation, in the task's working copy,
// in the tool's normal mode with its usual prompts. It notes in a status file when it starts (its
// process id and start time) and when it ends, so Petrina can tell whether it is still open, and a
// second copy refuses to start.
//
// Nothing typed by a person or an agent goes into a launcher: every value in it is checked against a
// strict pattern first. No launcher, status file or command line holds a credential, and the terminal
// never gets Petrina's own environment variables.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
      const path = ["/System/Applications/Utilities", "/Applications/Utilities", "/Applications", join(probe.home, "Applications")].map((dir) => join(dir, app.bundle)).find((candidate) => probe.exists(candidate));
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
  /** The take-over folder: the launcher and its status file live here. */
  dir: string;
  worktree: string;
  tool: { id: "claude-code" | "codex"; name: string; path: string };
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

/**
 * The tool on the conversation, with the same model and effort, in its normal mode with its usual
 * prompts: Claude Code's "default" permission mode (it asks before acting), Codex's workspace sandbox
 * with on-request approvals that the coordinator answers. Never a skip-permissions or auto-approve option.
 */
export function toolArgs(input: Pick<LaunchInput, "tool" | "sessionId" | "model" | "effort">): string[] {
  const path = checkedPath(input.tool.path, `${input.tool.name}'s location`);
  const session = checked(input.sessionId, SESSION, "the conversation's id");
  const model = checked(input.model, MODEL, "the model's name");
  const effort = checked(input.effort, EFFORT, "the effort");
  if (input.tool.id === "claude-code") return [path, "--resume", session, "--model", model, "--effort", effort, "--permission-mode", "default"];
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
  if (input.platform === "win32") {
    const file = `${dir}\\open.ps1`;
    const script = [
      `# Petrina: take over in your terminal. Opens ${name} on the agent's conversation, in the task's working copy,`,
      "# in its normal mode. Notes when it starts and ends, so Petrina can tell whether it is still open.",
      `$dir = ${ps(dir)}`,
      "$status = Join-Path $dir 'status'",
      "function Test-Running {",
      "  if (-not (Test-Path -LiteralPath $status)) { return $false }",
      "  $lines = @(Get-Content -LiteralPath $status)",
      "  if ($lines -notcontains 'state=running') { return $false }",
      "  $id = ($lines | Where-Object { $_ -like 'pid=*' } | Select-Object -First 1) -replace '^pid=', ''",
      "  $at = ($lines | Where-Object { $_ -like 'started=*' } | Select-Object -First 1) -replace '^started=', ''",
      "  if (-not $id -or -not $at) { return $false }",
      "  $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue",
      "  return [bool]($p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $at)",
      "}",
      "function Write-Note([string[]]$lines) {",
      '  Set-Content -LiteralPath "$status.tmp" -Value $lines -Encoding ascii',
      "  Move-Item -LiteralPath \"$status.tmp\" -Destination $status -Force",
      "}",
      "if (Test-Running) {",
      `  Write-Host ${ps(`${name} is already open in your terminal for this task. Use that window.`)}`,
      "  Read-Host 'Press Enter to close this window'",
      "  exit 1",
      "}",
      'Write-Note @(\'state=running\', "pid=$PID", "started=$((Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks)")',
      "$code = ''",
      "try {",
      `  Set-Location -LiteralPath ${ps(worktree)}`,
      `  & ${args.map(ps).join(" ")}`,
      "  $code = $LASTEXITCODE",
      "} finally {",
      "  Write-Note @('state=ended', \"code=$code\")",
      "}",
      "Write-Host ''",
      `Write-Host ${ps(`${name} has closed. You can close this window and click Hand back in Petrina.`)}`,
      "",
    ].join("\r\n");
    return { file, script, args, copy: `powershell ${POWERSHELL_ARGS.join(" ")} "${file}"` };
  }
  // macOS opens a .command file in a new Terminal window; Linux terminals run it by path.
  const file = `${dir}/open.${input.platform === "darwin" ? "command" : "sh"}`;
  const script = [
    "#!/bin/sh",
    `# Petrina: take over in your terminal. Opens ${name} on the agent's conversation, in the task's working copy,`,
    "# in its normal mode. Notes when it starts and ends, so Petrina can tell whether it is still open.",
    `dir=${sh(dir)}`,
    'status="$dir/status"',
    "running() {",
    '  [ -f "$status" ] || return 1',
    "  grep -qx 'state=running' \"$status\" || return 1",
    "  pid=$(sed -n 's/^pid=//p' \"$status\")",
    "  started=$(sed -n 's/^started=//p' \"$status\")",
    '  [ -n "$pid" ] && [ -n "$started" ] && kill -0 "$pid" 2>/dev/null && [ "$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null)" = "$started" ]',
    "}",
    "note() {",
    "  printf '%s\\n' \"$@\" > \"$status.tmp\" && mv -f \"$status.tmp\" \"$status\"",
    "}",
    "if running; then",
    `  echo ${sh(`${name} is already open in your terminal for this task. Use that window.`)}`,
    "  exit 1",
    "fi",
    'note \'state=running\' "pid=$$" "started=$(LC_ALL=C ps -o lstart= -p $$ 2>/dev/null)"',
    "trap 'note state=ended; exit 129' HUP TERM",
    `cd ${sh(worktree)} || { note state=ended; exit 1; }`,
    args.map(sh).join(" "),
    "code=$?",
    'note state=ended "code=$code"',
    "trap - HUP TERM",
    "echo",
    `echo ${sh(`${name} has closed. You can close this window and click Hand back in Petrina.`)}`,
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


/**
 * Whether the tool Petrina opened is still running, from the launcher's status file. A process id
 * only counts with the same start time, so a number the system gave to another process is not mistaken for it.
 */
export async function sessionState(dir: string, platform: Platform = thisMachine().platform): Promise<SessionState> {
  let text: string;
  try {
    text = await readFile(join(dir, "status"), "utf8");
  } catch {
    return "unknown";
  }
  const lines = text.split(/\r?\n/);
  if (lines.includes("state=ended")) return "ended";
  if (!lines.includes("state=running")) return "unknown";
  const pid = Number(/^pid=(\d{1,10})$/m.exec(text)?.[1]);
  const started = /^started=(.*)$/m.exec(text)?.[1]?.trim();
  if (!pid || !started) return "unknown";
  try {
    process.kill(pid, 0);
  } catch (error) {
    // Gone without a word: the window was closed.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "ended";
  }
  const now = await startTime(pid, platform);
  if (now === undefined) return "unknown";
  return now === started ? "running" : "ended";
}

/** When a process started, as the launcher records it: `ps` in the C locale, or .NET ticks on Windows. */
async function startTime(pid: number, platform: Platform): Promise<string | undefined> {
  const command =
    platform === "win32"
      ? ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`]
      : ["ps", "-o", "lstart=", "-p", String(pid)];
  try {
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" }, windowsHide: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const output = await Promise.race([new Response(proc.stdout).text(), new Promise<string>((resolve) => (timer = setTimeout(() => resolve(""), 10_000)))]);
    clearTimeout(timer);
    proc.kill();
    const value = output.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
