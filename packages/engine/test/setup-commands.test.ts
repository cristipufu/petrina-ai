import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as commands from "../src/git.js";
import { checkGh, checkGit, checkNode, type CheckResult } from "../src/setup.js";
import { removeDir, SLOW, tempDir, testGitEnv } from "./fixtures.js";

const temp = tempDir("petrina-setup-commands-");
afterAll(() => removeDir(temp));
const limit = 2_000 * SLOW;

/** A separate runner owns each fresh helper cache; no real user configuration is changed. */
async function probe(blocked: boolean) {
  const root = join(temp, blocked ? "blocked" : "healthy");
  mkdirSync(root);
  const home = join(root, "home");
  if (blocked) writeFileSync(home, "A regular file cannot hold runtime-tmp");
  else mkdirSync(home);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "tool-check-probe.ts"), root, String(limit)], {
    cwd: root, env: { ...testGitEnv(), PETRINA_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  let expired = false;
  // The parent enforces a kill deadline outside the checker, including startup and cleanup.
  const deadline = setTimeout(() => { expired = true; child.kill("SIGTERM"); }, limit * 10);
  const killDeadline = setTimeout(() => child.kill("SIGKILL"), limit * 10 + 2_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(expired, `Incomplete probe: deadline reached. ${stderr}`).toBe(false);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout) as { raw: commands.RunResult } & Record<"git" | "macGit" | "node" | "gh", CheckResult>;
  } finally {
    clearTimeout(deadline); clearTimeout(killDeadline);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await child.exited;
  }
}

describe("Command preparation and tool readiness", () => {
  for (const blocked of [true, false]) it(`checks installed stand-ins with a ${blocked ? "blocked" : "healthy"} private home`, async () => {
    const answers = await probe(blocked);
    if (blocked) {
      expect(answers.raw.code).toBe(127);
      expect(answers.raw.stdout).toBe("");
      expect(answers.raw.startFailure?.kind).toBe("temporary-directory");
      expect(answers.raw.startFailure?.message).toBe(answers.raw.stderr);
      expect(answers.raw.stderr).toContain("runtime-tmp");
      for (const answer of [answers.git, answers.macGit, answers.node, answers.gh]) {
        expect(answer.status).toBe("unknown");
        expect(answer.detail).toStartWith("Petrina couldn't prepare the temporary folder it uses for checks.");
        expect(answer.detail).toContain(answers.raw.stderr);
        expect(answer.detail!.length).toBeLessThanOrEqual(400);
      }
    } else {
      expect(answers.raw.code).toBe(0);
      expect(answers.raw.startFailure).toBeUndefined();
      expect(answers.git).toEqual({ status: "ready" });
      expect(answers.macGit).toEqual({ status: "ready" });
      expect(answers.node).toEqual({ status: "ready" });
      expect(answers.gh).toEqual({ status: "ready", account: "fixture-user" });
    }
  });

  it("keeps launch causes and original system messages apart without changing legacy failures", async () => {
    const missing = ["petrina-no-such-program-114005", join(temp, "missing-program")];
    for (const command of missing) {
      const answer = await commands.run([command], temp, undefined, { timeoutMs: limit });
      expect(answer.code).toBe(127);
      expect(answer.stdout).toBe("");
      expect(answer.startFailure).toEqual({ kind: "missing-executable", message: answer.stderr, systemCode: "ENOENT" });
      expect(answer.stderr).toContain(command);
    }
    const folder = join(temp, "missing-folder");
    const answer = await commands.run([process.execPath, "--version"], folder, undefined, { timeoutMs: limit });
    expect(answer.code).toBe(127);
    expect(answer.startFailure?.kind).toBe("working-directory");
    expect(answer.startFailure?.message).toBe(answer.stderr);
    expect(answer.stderr).not.toBe("");
    const spawning = spyOn(Bun, "spawn");
    try {
      // Platform-independent permission and unexpected launch failures, with their exact system error.
      for (const [code, kind] of [["EACCES", "permission"], ["EPERM", "permission"], ["EIO", "other"]] as const) {
        const error = Object.assign(new Error(`System refused launch: ${code}`), { code });
        spawning.mockImplementationOnce(() => { throw error; });
        expect(await commands.run([process.execPath], temp)).toEqual({ code: 127, stdout: "", stderr: error.message, startFailure: { kind, message: error.message, systemCode: code } });
      }
    } finally { spawning.mockRestore(); }
  });

  it("does not call an existing program missing when its interpreter is absent or execution is refused", async () => {
    const script = join(temp, "unlaunchable");
    writeFileSync(script, "#!/petrina-no-such-interpreter-114005\n", { mode: 0o755 });
    // Windows has no POSIX interpreter/execute bits; its native start failure is still never 'missing'.
    let answer = await commands.run([script], temp, undefined, { timeoutMs: limit });
    expect(answer.code).toBe(127);
    expect(answer.startFailure?.kind).not.toBe("missing-executable");
    if (process.platform !== "win32") {
      expect(answer.startFailure?.kind).toBe("other");
      chmodSync(script, 0o600);
      answer = await commands.run([script], temp, undefined, { timeoutMs: limit });
      expect(answer.startFailure?.kind).toBe("permission");
      expect(answer.startFailure?.systemCode).toBe("EACCES");
    }
    expect(answer.startFailure?.message).toBe(answer.stderr);
  });

  it("requires real missing-program evidence and keeps nonzero answers, including 127, uncertain", async () => {
    expect(await checkGit(() => null, "linux")).toEqual({ status: "not-installed" });
    expect(await checkNode(() => null)).toEqual({ status: "not-installed" });
    expect(await checkGh(["petrina-no-such-program-114005"], limit)).toEqual({ status: "not-installed" });
    expect(await checkGh([join(temp, "missing-gh")], limit)).toEqual({ status: "not-installed" });
    // Use the installed Bun as the version stand-in, replacing only the version command's arguments.
    const nativeSpawn = Bun.spawn;
    let exit = 1;
    const version = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: Parameters<typeof Bun.spawn>[1]) => nativeSpawn(cmd[1] === "--version" ? [process.execPath, "-e", `console.error("No selected version"); process.exit(${exit})`] : cmd, options)) as typeof Bun.spawn);
    try {
      for (exit of [1, 127]) {
        expect(await checkGit(() => process.execPath, "linux", { timeoutMs: limit })).toEqual({ status: "unknown", detail: "No selected version" });
        expect(await checkNode(() => process.execPath, limit)).toEqual({ status: "unknown", detail: "No selected version" });
        expect(await checkGh([process.execPath, "-e", `console.error("No selected version"); process.exit(${exit})`, "--"], limit)).toEqual({ status: "unknown", detail: "No selected version" });
      }
    } finally { version.mockRestore(); }
  });

  it("keeps real native timeouts uncertain and stops every owned stand-in", async () => {
    const nativeSpawn = Bun.spawn;
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const spawning = spyOn(Bun, "spawn").mockImplementation(((_cmd: string[], options: Parameters<typeof Bun.spawn>[1]) => {
      if (children.some(child => child.exitCode === null && child.signalCode === null)) throw new Error("Timeout stand-in process cap exceeded");
      // Independent of run(): a lost test owner or a broken timeout cannot leave this child alive.
      const child = nativeSpawn([process.execPath, "-e", `
        const owner = process.ppid;
        setTimeout(() => process.exit(2), 10_000);
        setInterval(() => {
          try { process.kill(owner, 0); } catch (error) { if (error.code === 'ESRCH') process.exit(3); }
          if (process.ppid !== owner) process.exit(3);
        }, 50);
      `], options);
      children.push(child);
      return child;
    }) as typeof Bun.spawn);
    const stopped = async (checking: Promise<CheckResult>) => {
      const answer = await checking;
      await Promise.all(children.map(child => child.exited));
      return answer;
    };
    try {
      expect(await stopped(checkGit(() => process.execPath, "linux", { timeoutMs: 30 }))).toEqual({ status: "unknown", detail: "It did not answer in time." });
      expect(await stopped(checkNode(() => process.execPath, 30))).toEqual({ status: "unknown", detail: "It did not answer in time." });
      expect(await stopped(checkGh([process.execPath], 30))).toEqual({ status: "unknown", detail: "The GitHub CLI did not answer within 0 seconds." });
      expect(await stopped(checkGit(() => "/usr/bin/git", "darwin", { timeoutMs: 30 }))).toEqual({ status: "unknown", detail: "Apple's developer tools lookup did not answer in time." });
      expect(children).toHaveLength(4);
    } finally {
      spawning.mockRestore();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all(children.map(child => child.exited));
    }
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  });

  it("never starts Apple's Git when its developer tools are absent or the lookup is uncertain", async () => {
    const lookup = spyOn(commands, "run");
    try {
      for (const result of [
        { code: 1, stdout: "", stderr: "No developer tools selected" },
        { code: 0, stdout: join(temp, "tools-without-git"), stderr: "" },
        { code: 127, stdout: "", stderr: "Wrapper has no selected version" },
      ]) {
        lookup.mockResolvedValueOnce(result);
        expect(await checkGit(() => "/usr/bin/git", "darwin")).toEqual({ status: "not-installed" });
      }
      lookup.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      expect(await checkGit(() => "/usr/bin/git", "darwin")).toEqual({ status: "unknown", detail: "Apple's developer tools lookup gave no answer." });
      for (const kind of ["working-directory", "permission", "other"] as const) {
        lookup.mockResolvedValueOnce({ code: 127, stdout: "", stderr: "Original system message", startFailure: { kind, message: "Original system message" } });
        const answer = await checkGit(() => "/usr/bin/git", "darwin");
        expect(answer.status).toBe("unknown");
        expect(answer.detail).toContain("Original system message");
      }
      expect(lookup).toHaveBeenCalledTimes(7);
      expect(lookup.mock.calls.every(([command]) => command[0] === "/usr/bin/xcode-select")).toBe(true);
      const detail = "The system refused permission to ask about Apple's tools.";
      expect(await checkGit(() => "/usr/bin/git", "darwin", { developerTools: async () => ({ kind: "unknown", detail }) })).toEqual({ status: "unknown", detail });
      expect(lookup).toHaveBeenCalledTimes(7);
    } finally { lookup.mockRestore(); }
  });

  it("shares failed-launch advice across Git, Node.js and the GitHub CLI", async () => {
    const lookup = spyOn(commands, "run");
    try {
      for (const [kind, sentence] of [
        ["working-directory", "The folder this check runs from is unavailable."],
        ["permission", "The system refused permission to start this check."],
        ["other", "Petrina couldn't start this check."],
      ] as const) {
        lookup.mockResolvedValue({ code: 127, stdout: "", stderr: "System detail", startFailure: { kind, message: "System detail" } });
        expect(await checkGit(() => process.execPath, "linux")).toEqual({ status: "unknown", detail: `${sentence}\nSystem detail` });
        expect(await checkNode(() => process.execPath)).toEqual({ status: "unknown", detail: `${sentence}\nSystem detail` });
        expect(await checkGh([process.execPath])).toEqual({ status: "unknown", detail: `${sentence}\nSystem detail` });
      }
    } finally { lookup.mockRestore(); }
  });
});
