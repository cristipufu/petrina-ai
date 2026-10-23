import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as commands from "../src/git.js";
import { canSee, findRelease, inGitHubTerms } from "../src/github.js";
import { branchExists } from "../src/source-github.js";
import { makeProduct, removeDir, SLOW, tempDir, testGitEnv } from "./fixtures.js";
import { rejectionOf } from "./rejections.js";

const temp = tempDir("petrina-repository-reads-");
afterAll(() => removeDir(temp));
const limit = 2_000 * SLOW;
const visible = [process.execPath, "-e", 'console.log("example/project")', "--"];

async function probe(blocked: boolean) {
  const root = join(temp, blocked ? "blocked" : "healthy");
  const repo = makeProduct(root);
  const home = join(root, "home");
  if (blocked) writeFileSync(home, "A private file cannot hold runtime-tmp", { mode: 0o600 });
  else mkdirSync(home, { mode: 0o700 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "repository-read-probe.ts"), repo, String(limit)], {
    cwd: root, env: { ...testGitEnv(), PETRINA_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  let expired = false;
  const deadline = setTimeout(() => { expired = true; child.kill("SIGTERM"); }, limit * 10);
  const killDeadline = setTimeout(() => child.kill("SIGKILL"), limit * 10 + 2_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (expired) throw new Error(`Incomplete repository probe: deadline reached. ${stderr}`);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout) as {
      lookup: commands.Check<void>;
      savedFile: { ok: boolean; text?: string; message?: string; cause?: commands.StartFailure };
      started: number;
    };
  } finally {
    clearTimeout(deadline); clearTimeout(killDeadline);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

function startCause(error: unknown): commands.StartFailure {
  expect(error).toBeInstanceOf(Error);
  const failure = (error as Error).cause as commands.StartFailure;
  expect((error as Error).message).toContain("Git could not read the repository's saved files");
  expect((error as Error).message).toContain(failure.message);
  return failure;
}

describe("repository visibility and saved-file failures", () => {
  for (const blocked of [true, false]) it(`preserves lookup and read results with a ${blocked ? "blocked" : "healthy"} private home`, async () => {
    const result = await probe(blocked);
    if (blocked) {
      expect(result.started).toBe(0);
      expect(result.savedFile.ok).toBe(false);
      expect(result.savedFile.cause?.kind).toBe("temporary-directory");
      expect(typeof result.savedFile.cause?.systemCode).toBe("string");
      expect(result.savedFile.cause?.message).toContain("runtime-tmp");
      expect(result.savedFile.message).toContain(result.savedFile.cause!.message);
      expect(result.lookup.ok).toBe(false);
      if (result.lookup.ok) throw new Error("The blocked home unexpectedly allowed a lookup");
      expect(result.lookup.error).toContain("couldn't start");
      expect(result.lookup.error).toContain("example/project");
      expect(result.lookup.error).toContain(result.savedFile.cause!.message);
      expect(result.lookup.error).not.toContain("your GitHub login cannot see");
    } else {
      expect(result.started).toBe(2);
      expect(result.lookup.ok).toBe(true);
      expect(result.savedFile).toEqual({ ok: true, text: "# Demo\n" });
    }
  });

  it("retains a missing executable and an unavailable working folder as launch failures", async () => {
    const missing = join(temp, "no-such-executable");
    const lookup = await canSee("example/project", [missing]);
    expect(lookup.ok).toBe(false);
    if (lookup.ok) throw new Error("A missing executable unexpectedly answered");
    expect(lookup.error).toContain("couldn't start");
    expect(lookup.error).toContain(missing);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = temp;
      const missingGit = startCause(await rejectionOf(commands.fileAt(temp, "HEAD", "README.md", limit)));
      expect(missingGit.kind).toBe("missing-executable");
      expect(missingGit.systemCode).toBe("ENOENT");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    const folder = join(temp, "no-such-folder");
    const previousTemp = ["TMPDIR", "TMP", "TEMP"].map(name => [name, process.env[name]] as const);
    try {
      for (const [name] of previousTemp) process.env[name] = folder;
      const raw = await commands.run(visible, folder, undefined, { credentials: true, timeoutMs: limit });
      expect(raw.startFailure?.kind).toBe("working-directory");
      const unavailable = await canSee("example/project", visible);
      expect(unavailable).toEqual({ ok: false, error: `Petrina couldn't start the repository check for example/project (${raw.stderr})` });
      const missingFolder = startCause(await rejectionOf(commands.fileAt(folder, "HEAD", "README.md", limit)));
      expect(missingFolder.kind).toBe("working-directory");
      expect(missingFolder.systemCode).toBe("ENOENT");
    } finally {
      for (const [name, value] of previousTemp) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("keeps permission refusals and other system launch errors without blaming the login or hiding a read failure", async () => {
    const spawn = Bun.spawn;
    const spawning = spyOn(Bun, "spawn");
    try {
      if (process.platform !== "win32") {
        const refused = join(temp, "private-non-executable");
        writeFileSync(refused, "Not an executable", { mode: 0o600 });
        const raw = await commands.run([refused], temp, undefined, { timeoutMs: limit });
        expect(raw.startFailure?.kind).toBe("permission");
        expect(await canSee("example/project", [refused])).toEqual({ ok: false, error: `Petrina couldn't start the repository check for example/project (${raw.stderr})` });
        spawning.mockImplementationOnce(((_cmd: string[], options: Parameters<typeof Bun.spawn>[1]) => spawn([refused], options)) as typeof Bun.spawn);
        expect(startCause(await rejectionOf(commands.fileAt(temp, "HEAD", "README.md", limit)))).toEqual(raw.startFailure!);
      }
      for (const [code, kind] of [["EACCES", "permission"], ["EPERM", "permission"], ["EIO", "other"]] as const) {
        const error = Object.assign(new Error(`System refused launch: ${code}`), { code });
        spawning.mockImplementationOnce(() => { throw error; });
        const lookup = await canSee("example/project", visible);
        expect(lookup).toEqual({ ok: false, error: `Petrina couldn't start the repository check for example/project (${error.message})` });
        spawning.mockImplementationOnce(() => { throw error; });
        expect(startCause(await rejectionOf(commands.fileAt(temp, "HEAD", "README.md", limit)))).toEqual({ kind, message: error.message, systemCode: code });
      }
    } finally { spawning.mockRestore(); }
  });

  it("keeps genuine invisible repositories and actual nonzero command results on their existing paths", async () => {
    for (const code of [1, 127]) {
      const lookup = await canSee("example/project", [process.execPath, "-e", `console.error("Repository not found"); process.exit(${code})`, "--"]);
      expect(lookup).toEqual({ ok: false, error: "your GitHub login cannot see example/project (Repository not found)" });
    }
    const spawn = Bun.spawn;
    const spawning = spyOn(Bun, "spawn");
    try {
      for (const code of [1, 128, 127]) {
        spawning.mockImplementationOnce(((_cmd: string[], options: Parameters<typeof Bun.spawn>[1]) => spawn([process.execPath, "-e", `console.error("Git command failed"); process.exit(${code})`], options)) as typeof Bun.spawn);
        const read = commands.fileAt(temp, "HEAD", "README.md", limit);
        if (code === 127) {
          const error = await rejectionOf(read) as Error;
          expect(error.message).toBe("Git could not read the repository's saved files");
          expect(error.cause).toBeUndefined();
        } else expect(await read).toBeUndefined();
      }
    } finally { spawning.mockRestore(); }
    const repo = makeProduct(join(temp, "absent-file"));
    expect(await commands.fileAt(repo, "HEAD", "ABSENT.md", limit)).toBeUndefined();
    expect(await commands.fileAt(repo, "HEAD", "README.md", limit)).toBe("# Demo\n");
  });

  it("keeps timeouts and unreported exits as failed lookups and failed reads, and says GitHub never answered", async () => {
    const running = spyOn(commands, "run");
    try {
      for (const [result, why] of [
        [{ code: 124, stdout: "", stderr: "timed out", timedOut: true }, "GitHub did not answer within 30 seconds"],
        [{ code: 124, stdout: "example/project", stderr: `gh: slow network\n${commands.EXIT_UNREPORTED}`, timedOut: true, exitUnreported: true },
          "the GitHub command ended, but the system did not report its exit, so GitHub's answer is unknown\ngh: slow network"],
        [{ code: 124, stdout: "example/pro", stderr: commands.OUTPUT_INCOMPLETE, timedOut: true }, "the GitHub command ended, but GitHub's answer did not finish arriving"],
        [{ code: 124, stdout: "", stderr: `${commands.OUTPUT_UNREADABLE}: Error: stream broke`, timedOut: true }, "GitHub's answer could not be read: Error: stream broke"],
      ] as const) {
        running.mockResolvedValue(result);
        // Unknown, never visible and never a refusal: GitHub gave no answer about the login.
        expect(await canSee("example/project", visible)).toEqual({ ok: false, error: `Petrina could not confirm whether your GitHub login can see example/project (${why})` });
        const error = await rejectionOf(commands.fileAt(temp, "HEAD", "README.md", limit)) as Error;
        expect(error.message).toBe("Git did not finish reading the repository's saved files");
        expect(error.cause).toBeUndefined();
        // Partial words that look like "not there" are no answer either: never a missing release or branch.
        running.mockClear();
        running.mockResolvedValue({ ...result, stderr: `release not found\nHTTP 404: Not Found\n${result.stderr}` });
        const release = await findRelease("example/project", "v1.0.0", visible);
        expect(running).toHaveBeenCalledTimes(1);
        if (release.ok) throw new Error("An unanswered release lookup unexpectedly counted");
        for (const message of [release.error, (await rejectionOf(branchExists("example/project", "main", visible)) as Error).message]) {
          expect(message).toContain(why.split("\n")[0]!);
          expect(message).not.toContain("Git finished");
          expect(message).not.toContain("Git's output");
          expect(message).not.toContain("cannot see");
          expect(message).not.toContain("is unavailable in");
        }
      }
    } finally { running.mockRestore(); }
  });

  it("words a real unfinished GitHub command's result as GitHub's missing answer, and leaves finished results alone", async () => {
    const slow = await commands.run([process.execPath, "-e", 'console.error("gh: waiting"); setInterval(() => {}, 1_000)'], temp, undefined, { timeoutMs: 500 * SLOW });
    expect(slow.timedOut).toBe(true);
    const unanswered = inGitHubTerms(slow);
    expect(unanswered.code).toBe(124);
    expect(unanswered.stderr.split("\n")[0]).toBe("GitHub did not answer within 30 seconds");
    expect(unanswered.stderr).not.toContain("timed out");
    const refused = await commands.run([process.execPath, "-e", 'console.error("Repository not found"); process.exit(1)'], temp, undefined, { timeoutMs: limit });
    expect(inGitHubTerms(refused)).toBe(refused);
  });
});
