import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../src/server.js";
import { askMode, clearEnded, detectTerminals, launchPlan, type LaunchInput, pickTerminal, type Platform, type Probe, sessionState, terminalEnv, toolArgs, UnsafeValue, writeLauncher } from "../src/terminal.js";
import { newProgramsStart, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const SESSION = "0b6f3c2e-6d2a-4f6e-9a51-2f1f7d5c9a10";
const PATHS: Record<Platform, { dir: string; worktree: string; claude: string; codex: string; grok: string }> = {
  darwin: { dir: "/Users/ana/.petrina/takeover/task-7", worktree: "/Users/ana/.petrina/worktrees/shop/task-7", claude: "/Users/ana/.local/bin/claude", codex: "/opt/homebrew/bin/codex", grok: "/Users/ana/.grok/bin/grok" },
  linux: { dir: "/home/ana/.petrina/takeover/task-7", worktree: "/home/ana/.petrina/worktrees/shop/task-7", claude: "/home/ana/.local/bin/claude", codex: "/usr/local/bin/codex", grok: "/home/ana/.grok/bin/grok" },
  win32: {
    dir: "C:\\Users\\Ana María\\.petrina\\takeover\\task-7",
    worktree: "C:\\Users\\Ana María\\.petrina\\worktrees\\shop\\task-7",
    claude: "C:\\Users\\Ana María\\AppData\\Roaming\\npm\\claude.cmd",
    codex: "C:\\Program Files (x86)\\Codex\\codex.exe",
    grok: "C:\\Users\\Ana María\\AppData\\Local\\grok\\grok.exe",
  },
};

function input(platform: Platform, toolId: "claude-code" | "codex" | "grok", change: Partial<LaunchInput> = {}): LaunchInput {
  const paths = PATHS[platform];
  const tool = toolId === "claude-code" ? { id: toolId, name: "Claude Code", path: paths.claude } : toolId === "grok" ? { id: toolId, name: "Grok", path: paths.grok } : { id: toolId, name: "Codex", path: paths.codex };
  const model = toolId === "claude-code" ? "opus" : toolId === "grok" ? "grok-4.7" : "gpt-6.1-sol";
  return { platform, dir: paths.dir, worktree: paths.worktree, tool, sessionId: SESSION, model, effort: "xhigh", ...change };
}

/** Anything that looks like a credential or Petrina's own secrets. */
const SECRETS = [/token/i, /secret/i, /password/i, /api[_-]?key/i, /GH_|GITHUB_|ANTHROPIC_|OPENAI_/, /PETRINA_/, /Bearer/i, /ghp_/];

describe("each system's launch plan", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    for (const toolId of ["claude-code", "codex", "grok"] as const) {
      it(`${platform}, ${toolId}: the tool on the same conversation in its normal mode, with no credentials`, () => {
        const plan = launchPlan(input(platform, toolId));
        for (const pattern of SECRETS) {
          expect(plan.script).not.toMatch(pattern);
          expect(plan.copy).not.toMatch(pattern);
        }
        // Never a skip-permissions, always-approve or yolo option.
        for (const flag of ["dangerously", "bypass", "approve-for-me", "auto_review", "acceptEdits", "dontAsk", "never", "danger-full-access", "yolo", "always-approve"]) expect(plan.args.join(" ").toLowerCase()).not.toContain(flag.toLowerCase());
        expect(plan.args).toContain(SESSION);
        expect(plan.args).toContain(toolId === "claude-code" ? "opus" : toolId === "grok" ? "grok-4.7" : "gpt-6.1-sol");
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

  it("asks Claude Code for its ask-before-acting mode, and Codex for its workspace sandbox with approvals the coordinator answers", () => {
    expect(toolArgs(input("darwin", "claude-code"))).toEqual([PATHS.darwin.claude, "--resume", SESSION, "--model", "opus", "--effort", "xhigh", "--permission-mode", "default"]);
    const current = input("darwin", "claude-code");
    expect(toolArgs({ ...current, tool: { ...current.tool, mode: "manual" } }).slice(-2)).toEqual(["--permission-mode", "manual"]);
    expect(toolArgs(input("darwin", "codex"))).toEqual([PATHS.darwin.codex, "resume", SESSION, "--model", "gpt-6.1-sol", "-c", "model_reasoning_effort=xhigh", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", "approvals_reviewer=user", "--no-daemon"]);
    expect(toolArgs(input("darwin", "grok"))).toEqual([PATHS.darwin.grok, "--resume", SESSION, "--model", "grok-4.7", "--effort", "xhigh"]);
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
    ["a permission mode that skips prompts", { tool: { id: "claude-code", name: "Claude Code", path: "/usr/bin/claude", mode: "bypassPermissions" as never } }],
  ];
  for (const [what, change] of unsafe) {
    it(`refuses ${what}`, () => {
      expect(() => launchPlan(input(change.platform ?? "darwin", "claude-code", change))).toThrow(UnsafeValue);
    });
  }

  it("Windows: the launcher carries a byte order mark, so Windows PowerShell reads accented folder names as written", () => {
    const plan = launchPlan(input("win32", "codex"));
    expect(plan.script.startsWith("\uFEFF# Petrina")).toBe(true);
    expect(plan.script).toContain("Set-Location -LiteralPath 'C:\\Users\\Ana María\\.petrina\\worktrees\\shop\\task-7'");
    expect(Buffer.from(plan.script, "utf8").subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    // One copy at a time: the lock file is held open for this copy alone until it ends.
    expect(plan.script).toContain("[System.IO.File]::Open((Join-Path $dir 'lock'), 'OpenOrCreate', 'ReadWrite', 'None')");
  });

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
  const folder = (files: Record<string, string[]>) => {
    const dir = tempDir("petrina-status-");
    roots.push(dir);
    mkdirSync(dir, { recursive: true });
    for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
    return dir;
  };
  const startedOf = async (pid: number) => (await new Response(Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } }).stdout).text()).trim();
  const record = async (pid: number) => [`pid=${pid}`, `started=${await startedOf(pid)}`];
  const gone = async () => {
    const proc = Bun.spawn(["true"]);
    await proc.exited;
    return proc.pid;
  };

  it("running only when a copy's process id has the start time it noted", async () => {
    expect(await sessionState(folder({ [`run.${process.pid}`]: await record(process.pid) }))).toBe("running");
    // The same number, a different start time: the system gave it to another process.
    expect(await sessionState(folder({ [`run.${process.pid}`]: [`pid=${process.pid}`, "started=Mon Jan  1 00:00:00 2001"] }))).toBe("ended");
  });

  it("running while any copy runs, even after another one said it ended", async () => {
    const other = Bun.spawn(["sleep", "30"]);
    try {
      const pid = await gone();
      const dir = folder({ status: ["state=ended", "code=0"], [`run.${pid}`]: [`pid=${pid}`, "started=whenever"], [`run.${other.pid}`]: await record(other.pid) });
      expect(await sessionState(dir)).toBe("running");
    } finally {
      other.kill();
    }
  });

  it("ended when the copy that opened the tool said so, or every copy is gone", async () => {
    expect(await sessionState(folder({ status: ["state=ended", "code=0"] }))).toBe("ended");
    const pid = await gone();
    expect(await sessionState(folder({ [`run.${pid}`]: [`pid=${pid}`, "started=whenever"] }))).toBe("ended");
  });

  it("unknown when no copy ever reported starting, or a record cannot be checked", async () => {
    const empty = tempDir("petrina-status-");
    roots.push(empty);
    expect(await sessionState(empty)).toBe("unknown");
    expect(await sessionState(join(empty, "missing"))).toBe("unknown");
    expect(await sessionState(folder({ [`run.${process.pid}`]: [`pid=${process.pid}`] }))).toBe("unknown");
    expect(await sessionState(folder({ status: ["something else"] }))).toBe("unknown");
  });

  it("opening again forgets what the last session left, and keeps the records of copies still running", async () => {
    const pid = await gone();
    const dir = folder({ status: ["state=ended", "code=0"], [`run.${pid}`]: [`pid=${pid}`, "started=whenever"], [`run.${process.pid}`]: await record(process.pid) });
    await clearEnded(dir);
    expect(readdirSync(dir).sort()).toEqual([`run.${process.pid}`]);
    rmSync(join(dir, `run.${process.pid}`));
    expect(await sessionState(dir)).toBe("unknown");
  });
});

describe.skipIf(process.platform === "win32")("the launcher runs one copy per task", () => {
  beforeAll(() => newProgramsStart());

  /** A real launcher whose "tool" notes each start and stays open while the hold file exists. */
  async function launcher() {
    const root = tempDir("petrina-launcher-");
    roots.push(root);
    const dir = join(root, "takeover", "task-7");
    const worktree = join(root, "work");
    mkdirSync(worktree, { recursive: true });
    const tool = join(root, "tool");
    const hold = join(root, "hold");
    const starts = join(root, "starts");
    writeFileSync(tool, `#!/bin/sh\necho "$$" >> '${starts}'\nwhile [ -f '${hold}' ]; do sleep 0.05; done\n`);
    chmodSync(tool, 0o755);
    const platform: Platform = process.platform === "darwin" ? "darwin" : "linux";
    const plan = launchPlan({ platform, dir, worktree, tool: { id: "codex", name: "Codex", path: tool }, sessionId: SESSION, model: "gpt-6.1-sol", effort: "high" });
    await writeLauncher(plan, dir, true);
    const startCount = () => (existsSync(starts) ? readFileSync(starts, "utf8").split("\n").filter(Boolean).length : 0);
    const run = (env: Record<string, string> = {}) => Bun.spawn(["/bin/sh", "-c", plan.copy], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    /** The process ids of the tool's starts, in order. */
    const toolPids = () => readFileSync(starts, "utf8").split("\n").filter(Boolean).map(Number);
    return { root, dir, hold, plan, startCount, toolPids, run };
  }

  /** Four copies started at the same moment: every one but one stops at once, saying the tool is open already, and the tool opens once. */
  async function together(it: Awaited<ReturnType<typeof launcher>>) {
    const before = it.startCount();
    const copies = Array.from({ length: 4 }, () => it.run());
    const refused = copies.map((copy) => copy.exited.then((code) => code === 1));
    await waitFor(async () => {
      const done = await Promise.all(refused.map((result) => Promise.race([result, Bun.sleep(10).then(() => false)])));
      return done.filter(Boolean).length === copies.length - 1 && it.startCount() === before + 1;
    }, "all copies but one to refuse");
    return copies;
  }

  /** A lock left by a copy that is gone: its process ended, and the start time is not its own. */
  async function goneCopysLock(dir: string) {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(join(dir, "lock"), `pid=${dead.pid}\nstarted=Mon Jan  1 00:00:00 2001\n`);
  }

  it("refuses every copy but one, even when they all start at the same moment", async () => {
    const it = await launcher();
    for (let round = 0; round < 8; round++) {
      writeFileSync(it.hold, "");
      const before = it.startCount();
      const copies = await together(it);
      expect(await sessionState(it.dir)).toBe("running");
      rmSync(it.hold);
      const codes = await Promise.all(copies.map((copy) => copy.exited));
      expect([...codes].sort()).toEqual([0, 1, 1, 1]);
      for (const [index, copy] of copies.entries()) if (codes[index] === 1) expect(await new Response(copy.stdout).text()).toContain("Codex is already open in your terminal for this task. Use that window.");
      expect(it.startCount()).toBe(before + 1);
      expect(await sessionState(it.dir)).toBe("ended");
      // Nothing is left behind but the launcher, the ended note and the locks: one for each time the tool opened.
      const left = readdirSync(it.dir).filter((name) => !name.startsWith("open."));
      expect(left.filter((name) => !name.startsWith("lock"))).toEqual(["status"]);
      expect(left.filter((name) => name.startsWith("lock"))).toHaveLength(round + 1);
    }
  }, 60_000);

  it("takes over a lock left by a copy that is gone, and still refuses a second copy", async () => {
    const it = await launcher();
    await goneCopysLock(it.dir);
    writeFileSync(it.hold, "");
    const first = it.run();
    await waitFor(() => it.startCount() === 1, "the first copy to open the tool");
    const second = it.run();
    expect(await second.exited).toBe(1);
    expect(await sessionState(it.dir)).toBe("running");
    rmSync(it.hold);
    expect(await first.exited).toBe(0);
    expect(it.startCount()).toBe(1);
    // The gone copy's lock stays as it was, and so does this copy's, taken over after it, for the next copy to take over after this one.
    expect(readFileSync(join(it.dir, "lock"), "utf8")).toStartWith("pid=");
    expect(readdirSync(it.dir).filter((name) => !name.startsWith("open.")).sort()).toEqual(["lock", expect.stringMatching(/^lock\.after\.pid_\d+_started_/), "status"]);
  }, 30_000);

  it("opens the app once when four copies start together on a lock left by a copy that is gone", async () => {
    const it = await launcher();
    await goneCopysLock(it.dir);
    const bin = join(it.root, "barrier");
    mkdirSync(bin);
    const release = join(bin, "release");
    const finished = join(bin, "finished");
    const gap = join(bin, "gap");
    const starts = join(it.root, "starts");
    const lock = join(it.dir, "lock");
    // Each cat reads the real lock before waiting: all four copies see the same dead owner,
    // regardless of how the system schedules them after the barrier opens.
    writeFileSync(join(bin, "cat"), `#!/bin/sh
if [ "$1" = '${lock}' ] && [ ! -f '${bin}/read.'"$TAKEOVER_TEST_COPY" ]; then
  '${Bun.which("cat")}' "$@" > '${bin}/record.'"$TAKEOVER_TEST_COPY" || exit $?
  : > '${bin}/read.'"$TAKEOVER_TEST_COPY"
  while [ ! -f '${release}' ]; do sleep 0.01; done
  exec '${Bun.which("cat")}' '${bin}/record.'"$TAKEOVER_TEST_COPY"
fi
exec '${Bun.which("cat")}' "$@"
`);
    // The old launcher moves the lock away before trying to claim it. Force that race:
    // copy 1 opens the tool, copy 2 moves its live lock away and pauses, then copy 3
    // claims the gap and opens a second tool. The fixed launcher never moves a lock.
    // These stand-ins only control timing; every cat and mv still does its real work.
    writeFileSync(join(bin, "mv"), `#!/bin/sh
if [ "$1" = '-f' ] && [ "$2" = '${lock}' ]; then
  case "$TAKEOVER_TEST_COPY" in
    2) while [ ! -s '${starts}' ] && [ ! -f '${finished}' ]; do sleep 0.01; done ;;
    3) while [ ! -f '${gap}' ] && [ ! -f '${finished}' ]; do sleep 0.01; done ;;
    4) while [ ! -f '${finished}' ]; do sleep 0.01; done ;;
  esac
  '${Bun.which("mv")}' "$@"
  code=$?
  if [ "$TAKEOVER_TEST_COPY" = 2 ] && [ "$code" = 0 ]; then
    : > '${gap}'
    while [ ! -f '${finished}' ]; do sleep 0.01; done
  fi
  exit "$code"
fi
exec '${Bun.which("mv")}' "$@"
`);
    for (const name of ["cat", "mv"]) chmodSync(join(bin, name), 0o755);
    writeFileSync(it.hold, "");
    const copies = Array.from({ length: 4 }, (_, index) => it.run({ PATH: `${bin}:${process.env.PATH}`, TAKEOVER_TEST_COPY: String(index + 1) }));
    const codes: (number | undefined)[] = [];
    const exits = copies.map((copy, index) => copy.exited.then((code) => (codes[index] = code)));
    try {
      await waitFor(() => copies.every((_, index) => existsSync(join(bin, `read.${index + 1}`))), "all four copies to read the dead owner's lock");
      writeFileSync(release, "");
      await waitFor(() => it.startCount() > 1 || (it.startCount() === 1 && codes.filter((code) => code === 1).length === 3), "one app and three refusals, or the old launcher's second app");
      expect(it.startCount()).toBe(1);
      expect(codes.filter((code) => code === 1)).toHaveLength(3);
      expect(await sessionState(it.dir)).toBe("running");
    } finally {
      // Release every gate and close the fake apps even if an assertion fails against the old launcher.
      writeFileSync(release, "");
      writeFileSync(finished, "");
      rmSync(it.hold, { force: true });
      await Promise.all(exits);
    }
    expect([...codes].sort()).toEqual([0, 1, 1, 1]);
    for (const [index, copy] of copies.entries()) if (codes[index] === 1) expect(await new Response(copy.stdout).text()).toContain("Codex is already open in your terminal for this task. Use that window.");
    expect(it.startCount()).toBe(1);
  });

  /**
   * A copy slow to check whether the copy holding the lock is still running: its ps, while the gate
   * names the process it is asked about, notes that it is waiting and waits for the gate to go.
   */
  function slowCheck(root: string) {
    const bin = join(root, "slow");
    mkdirSync(bin, { recursive: true });
    const gate = join(root, "gate");
    const waiting = join(root, "waiting");
    const ps = join(bin, "ps");
    writeFileSync(ps, `#!/bin/sh\nif [ "$(cat '${gate}' 2>/dev/null)" = "$4" ]; then\n  : > '${waiting}'\n  while [ -f '${gate}' ]; do sleep 0.05; done\nfi\nexec '${Bun.which("ps")}' "$@"\n`);
    chmodSync(ps, 0o755);
    return { env: { PATH: `${bin}:${process.env.PATH}` }, gate, waiting };
  }

  for (const [what, gone] of [
    ["from no lock", false],
    ["from a lock left by a copy that is gone", true],
  ] as const)
    it(`refuses a copy slow to check on the open app once that app has closed and another copy opened it again, ${what}`, async () => {
      const it = await launcher();
      if (gone) await goneCopysLock(it.dir);
      writeFileSync(it.hold, "");
      const first = it.run();
      await waitFor(() => it.startCount() === 1, "the first copy to open the tool");
      const firstPid = Number(readdirSync(it.dir).find((name) => name.startsWith("run."))!.slice(4));
      // The late copy finds the first one holding the lock, and is held while it checks that it still runs.
      const slow = slowCheck(it.root);
      writeFileSync(slow.gate, String(firstPid));
      const late = it.run(slow.env);
      await waitFor(() => existsSync(slow.waiting), "the late copy to check on the first one");
      // Meanwhile the app closes, and another copy opens it again.
      process.kill(it.toolPids()[0]!, "SIGTERM");
      await first.exited;
      const next = it.run();
      await waitFor(() => it.startCount() === 2, "the next copy to open the tool");
      rmSync(slow.gate);
      const stopped = late.exited.then(() => true);
      await waitFor(async () => it.startCount() > 2 || (await Promise.race([stopped, Bun.sleep(10).then(() => false)])), "the late copy to stop or open the tool");
      expect(it.startCount()).toBe(2);
      expect(await late.exited).toBe(1);
      expect(await new Response(late.stdout).text()).toContain("Codex is already open in your terminal for this task. Use that window.");
      expect(await sessionState(it.dir)).toBe("running");
      rmSync(it.hold);
      expect(await next.exited).toBe(0);
      expect(it.startCount()).toBe(2);
    }, 60_000);

  it("notes the end when the terminal window is closed", async () => {
    const it = await launcher();
    writeFileSync(it.hold, "");
    const copy = it.run();
    // Running, and holding the lock: the window's close is now this copy's to note.
    await waitFor(async () => (await sessionState(it.dir)) === "running" && readdirSync(it.dir).includes("lock"), "the copy to start");
    const pid = Number(readdirSync(it.dir).find((name) => name.startsWith("run."))!.slice(4));
    process.kill(pid, "SIGHUP");
    rmSync(it.hold);
    await copy.exited;
    expect(await sessionState(it.dir)).toBe("ended");
    expect(readFileSync(join(it.dir, "status"), "utf8")).toContain("state=ended");
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("Claude Code's ask-before-acting mode", () => {
  beforeAll(() => newProgramsStart());

  const help = (text: string) => {
    const dir = tempDir("petrina-help-");
    roots.push(dir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude");
    writeFileSync(file, `#!/bin/sh\necho '${text}'\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it("uses the name the installed copy lists: manual now, default before", async () => {
    expect(await askMode(help('--permission-mode <mode> (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")'))).toBe("manual");
    expect(await askMode(help('--permission-mode <mode> (choices: "acceptEdits", "bypassPermissions", "default", "plan")'))).toBe("default");
    expect(await askMode("/nowhere/claude")).toBe("default");
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
    await expectRejection(dispatch(engine, { name: "handBack", args: ["task-7", "x".repeat(4001)] }));
    await expectRejection(dispatch(engine, { name: "takeOver", args: ["../task-7"] }));
    await expectRejection(dispatch(engine, { name: "takeOver", args: ["task-7", "shell"] }));
    await expectRejection(dispatch(engine, { name: "setTerminal", args: ["iTerm; rm"] }));
  });
});
