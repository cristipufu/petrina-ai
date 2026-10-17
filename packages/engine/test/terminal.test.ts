import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../src/server.js";
import { detectTerminals, launchPlan, type LaunchInput, pickTerminal, type Platform, type Probe, sessionState, terminalEnv, toolArgs, UnsafeValue } from "../src/terminal.js";
import { removeDir, tempDir } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const SESSION = "0b6f3c2e-6d2a-4f6e-9a51-2f1f7d5c9a10";
const PATHS: Record<Platform, { dir: string; worktree: string; claude: string; codex: string }> = {
  darwin: { dir: "/Users/ana/.petrina/takeover/task-7", worktree: "/Users/ana/.petrina/worktrees/shop/task-7", claude: "/Users/ana/.local/bin/claude", codex: "/opt/homebrew/bin/codex" },
  linux: { dir: "/home/ana/.petrina/takeover/task-7", worktree: "/home/ana/.petrina/worktrees/shop/task-7", claude: "/home/ana/.local/bin/claude", codex: "/usr/local/bin/codex" },
  win32: {
    dir: "C:\\Users\\Ana María\\.petrina\\takeover\\task-7",
    worktree: "C:\\Users\\Ana María\\.petrina\\worktrees\\shop\\task-7",
    claude: "C:\\Users\\Ana María\\AppData\\Roaming\\npm\\claude.cmd",
    codex: "C:\\Program Files (x86)\\Codex\\codex.exe",
  },
};

function input(platform: Platform, toolId: "claude-code" | "codex", change: Partial<LaunchInput> = {}): LaunchInput {
  const paths = PATHS[platform];
  return {
    platform,
    dir: paths.dir,
    worktree: paths.worktree,
    tool: toolId === "claude-code" ? { id: toolId, name: "Claude Code", path: paths.claude } : { id: toolId, name: "Codex", path: paths.codex },
    sessionId: SESSION,
    model: toolId === "claude-code" ? "opus" : "gpt-6.1-sol",
    effort: "xhigh",
    ...change,
  };
}

/** Anything that looks like a credential or Petrina's own secrets. */
const SECRETS = [/token/i, /secret/i, /password/i, /api[_-]?key/i, /GH_|GITHUB_|ANTHROPIC_|OPENAI_/, /PETRINA_/, /Bearer/i, /ghp_/];

describe("each system's launch plan", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    for (const toolId of ["claude-code", "codex"] as const) {
      it(`${platform}, ${toolId}: the tool on the same conversation in its normal mode, with no credentials`, () => {
        const plan = launchPlan(input(platform, toolId));
        for (const pattern of SECRETS) {
          expect(plan.script).not.toMatch(pattern);
          expect(plan.copy).not.toMatch(pattern);
        }
        // Never a skip-permissions or auto-approve option.
        for (const flag of ["dangerously", "bypass", "approve-for-me", "auto_review", "acceptEdits", "dontAsk", "never", "danger-full-access"]) expect(plan.args.join(" ").toLowerCase()).not.toContain(flag.toLowerCase());
        expect(plan.args).toContain(SESSION);
        expect(plan.args).toContain(toolId === "claude-code" ? "opus" : "gpt-6.1-sol");
        expect(plan.script).toContain(PATHS[platform].worktree);
        // The copied command runs the launcher, nothing else.
        expect(plan.copy).toContain(plan.file);
        expect(plan.copy).not.toContain(SESSION);
        if (platform === "win32") {
          expect(plan.file).toBe(`${PATHS.win32.dir}\\open.ps1`);
          expect(plan.copy).toBe(`powershell -NoLogo -ExecutionPolicy Bypass -File "${plan.file}"`);
        } else {
          expect(plan.file).toBe(`${PATHS[platform].dir}/open.${platform === "darwin" ? "command" : "sh"}`);
          expect(plan.script.startsWith("#!/bin/sh\n")).toBe(true);
          expect(plan.copy).toBe(`'${plan.file}'`);
        }
      });
    }
  }

  it("asks Claude Code for its default permission mode, and Codex for its workspace sandbox with approvals the coordinator answers", () => {
    expect(toolArgs(input("darwin", "claude-code"))).toEqual([PATHS.darwin.claude, "--resume", SESSION, "--model", "opus", "--effort", "xhigh", "--permission-mode", "default"]);
    expect(toolArgs(input("darwin", "codex"))).toEqual([PATHS.darwin.codex, "resume", SESSION, "--model", "gpt-6.1-sol", "-c", "model_reasoning_effort=xhigh", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", "approvals_reviewer=user", "--no-daemon"]);
  });

  const unsafe: [string, Partial<LaunchInput>][] = [
    ["a folder with a quote", { worktree: "/Users/o'neil/.petrina/worktrees/shop/task-7" }],
    ["a folder with a $", { worktree: "/Users/ana/$HOME/task-7" }],
    ["a folder with a ;", { dir: "/Users/ana/.petrina/takeover/a;rm -rf ~" }],
    ["a folder with a backtick", { worktree: "/Users/ana/`whoami`" }],
    ["a folder with a line break", { worktree: "/Users/ana/x\ny" }],
    ["a folder with ..", { worktree: "/Users/ana/../../etc" }],
    ["a relative folder", { worktree: "worktrees/task-7" }],
    ["a conversation id that is not one", { sessionId: "abc; rm -rf /" }],
    ["a model with a space", { model: "opus --dangerously-skip-permissions" }],
    ["an unknown effort", { effort: "max" }],
    ["a tool path with a pipe", { tool: { id: "claude-code", name: "Claude Code", path: "/usr/bin/claude|sh" } }],
    ["a Windows folder with a %", { platform: "win32", worktree: "C:\\Users\\%USERNAME%\\task-7" }],
    ["a Windows folder with a smart quote", { platform: "win32", worktree: "C:\\Users\\Ana‘s\\task-7" }],
  ];
  for (const [what, change] of unsafe) {
    it(`refuses ${what}`, () => {
      expect(() => launchPlan(input(change.platform ?? "darwin", "claude-code", change))).toThrow(UnsafeValue);
    });
  }

  it("leaves Petrina's own variables out of the terminal and keeps the coordinator's", () => {
    const env = terminalEnv({ PATH: "/usr/bin", HOME: "/Users/ana", PETRINA_HOME: "/x", PETRINA_BRIDGE_SECRET: "s", GH_TOKEN: "theirs" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/ana", GH_TOKEN: "theirs" });
  });
});

describe("the usual terminal on each system", () => {
  const probe = (platform: Platform, programs: string[], files: string[] = [], env: Record<string, string> = {}): Probe => ({
    platform,
    env,
    home: "/Users/ana",
    which: (program) => (programs.includes(program) ? (platform === "win32" ? `C:\\Windows\\${program}.exe` : `/usr/bin/${program}`) : null),
    exists: (path) => files.includes(path),
  });

  it("macOS: Terminal first, then iTerm2 and the other installed ones", () => {
    const found = detectTerminals(probe("darwin", [], ["/System/Applications/Utilities/Terminal.app", "/Applications/iTerm.app", "/Users/ana/Applications/Ghostty.app"]));
    expect(found.map((entry) => entry.name)).toEqual(["Terminal", "iTerm2", "Ghostty"]);
    expect(found[0]!.open("/x/open.command")).toEqual(["open", "-a", "/System/Applications/Utilities/Terminal.app", "/x/open.command"]);
    expect(found[2]!.open("/x/open.command")).toEqual(["open", "-na", "/Users/ana/Applications/Ghostty.app", "--args", "-e", "/x/open.command"]);
    expect(pickTerminal(found, "iterm")?.name).toBe("iTerm2");
    expect(pickTerminal(found, "warp")?.name).toBe("Terminal");
  });

  it("Windows: Windows Terminal, or else a PowerShell window", () => {
    const withWt = detectTerminals(probe("win32", ["wt", "powershell"]));
    expect(withWt.map((entry) => entry.name)).toEqual(["Windows Terminal", "PowerShell window"]);
    expect(withWt[0]!.open("C:\\p\\open.ps1")).toEqual(["C:\\Windows\\wt.exe", "-w", "new", "C:\\Windows\\powershell.exe", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", "C:\\p\\open.ps1"]);
    const without = detectTerminals(probe("win32", ["powershell"]));
    expect(without.map((entry) => entry.name)).toEqual(["PowerShell window"]);
    expect(without[0]!.ownConsole).toBe(true);
  });

  it("Linux: the system default, then the desktop's own, then common ones; none without a desktop", () => {
    const kde = detectTerminals(probe("linux", ["xterm", "konsole", "gnome-terminal", "x-terminal-emulator"], [], { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "KDE" }));
    expect(kde.map((entry) => entry.id)).toEqual(["x-terminal-emulator", "konsole", "gnome-terminal", "xterm"]);
    expect(kde[1]!.open("/x/open.sh")).toEqual(["/usr/bin/konsole", "-e", "/x/open.sh"]);
    const gnome = detectTerminals(probe("linux", ["xterm", "gnome-terminal"], [], { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }));
    expect(gnome.map((entry) => entry.id)).toEqual(["gnome-terminal", "xterm"]);
    expect(gnome[0]!.open("/x/open.sh")).toEqual(["/usr/bin/gnome-terminal", "--", "/x/open.sh"]);
    expect(detectTerminals(probe("linux", ["xterm", "gnome-terminal"]))).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("whether the app Petrina opened is still running", () => {
  const status = (lines: string[]) => {
    const dir = tempDir("petrina-status-");
    roots.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status"), `${lines.join("\n")}\n`);
    return dir;
  };
  const startedOf = async (pid: number) => (await new Response(Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } }).stdout).text()).trim();

  it("running only when the process id has the start time the launcher noted", async () => {
    expect(await sessionState(status(["state=running", `pid=${process.pid}`, `started=${await startedOf(process.pid)}`]))).toBe("running");
    // The same number, a different start time: the system gave it to another process.
    expect(await sessionState(status(["state=running", `pid=${process.pid}`, "started=Mon Jan  1 00:00:00 2001"]))).toBe("ended");
  });

  it("ended when the launcher said so, or its process is gone", async () => {
    expect(await sessionState(status(["state=ended", "code=0"]))).toBe("ended");
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    expect(await sessionState(status(["state=running", `pid=${gone.pid}`, "started=whenever"]))).toBe("ended");
  });

  it("unknown when the launcher never reported starting, or its record cannot be checked", async () => {
    const empty = tempDir("petrina-status-");
    roots.push(empty);
    expect(await sessionState(empty)).toBe("unknown");
    expect(await sessionState(status(["state=running", `pid=${process.pid}`]))).toBe("unknown");
    expect(await sessionState(status(["something else"]))).toBe("unknown");
  });
});

describe("the local API's limits on take over and hand back", () => {
  const calls: unknown[][] = [];
  const engine = {
    takeOver: (...args: unknown[]) => calls.push(["takeOver", ...args]),
    handBack: (...args: unknown[]) => calls.push(["handBack", ...args]),
    setTerminal: (...args: unknown[]) => calls.push(["setTerminal", ...args]),
  } as never;

  it("takes a task id and a note of at most 4000 characters", async () => {
    await dispatch(engine, { name: "takeOver", args: ["task-7", "copy"] });
    await dispatch(engine, { name: "handBack", args: ["task-7", "x".repeat(4000), true] });
    expect(calls).toEqual([
      ["takeOver", "task-7", "copy"],
      ["handBack", "task-7", "x".repeat(4000), true],
    ]);
    await expect(dispatch(engine, { name: "handBack", args: ["task-7", "x".repeat(4001)] })).rejects.toThrow();
    await expect(dispatch(engine, { name: "takeOver", args: ["../task-7"] })).rejects.toThrow();
    await expect(dispatch(engine, { name: "takeOver", args: ["task-7", "shell"] })).rejects.toThrow();
    await expect(dispatch(engine, { name: "setTerminal", args: ["iTerm; rm"] })).rejects.toThrow();
  });
});
