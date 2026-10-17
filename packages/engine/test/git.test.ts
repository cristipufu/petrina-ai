import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, commitTree, ensureWorktree, isClean, mergeTree, moveTo, patchId, repoInfo, riskySettings } from "../src/git.js";
import { removeDir } from "./support.js";

const temp = mkdtempSync(join(tmpdir(), "petrina-git-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();

describe("Petrina's own git steps", () => {
  afterAll(() => removeDir(temp));

  it("never run hooks or the file monitor an agent planted", async () => {
    const repo = join(temp, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    const marker = join(temp, "ran");
    const script = join(temp, "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);
    git(repo, "config", "core.fsmonitor", script);
    writeFileSync(join(repo, "a.txt"), "hello\n");

    expect(await isClean(repo)).toBe(false);
    expect(await commitAll(repo, "Add a")).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(marker)).toBe(false);
  });

  it("names the product's repository from its origin, and one cloned from a folder on this computer by the clone's own folder", async () => {
    const repo = join(temp, "named");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", "git@github.com:acme/shop.git");
    expect(await repoInfo(repo)).toMatchObject({ owner: "acme", name: "shop" });
    for (const folder of ["C:\\Users\\ana\\origin.git", "C:/Users/ana/origin.git", "/home/ana/origin.git", "file:///home/ana/origin.git"]) {
      git(repo, "remote", "set-url", "origin", folder);
      expect(await repoInfo(repo)).toMatchObject({ owner: "local", name: "named" });
    }
  });

  it("will not fetch with the coordinator's login when the repository's settings could misuse it", async () => {
    const repo = join(temp, "risky");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", "https://github.com/acme/shop.git");
    git(repo, "config", "branch.main.remote", "origin");
    git(repo, "config", "core.hooksPath", ".husky");
    expect(await riskySettings(repo)).toEqual([]);
    git(repo, "config", "credential.helper", "!sh -c 'touch /tmp/stolen'");
    git(repo, "config", "url.https://evil.example/.insteadOf", "https://github.com/");
    git(repo, "config", "http.extraHeader", "X-Leak: 1");
    git(repo, "config", "core.alternateRefsCommand", "sh -c id");
    expect((await riskySettings(repo)).sort()).toEqual(["core.alternaterefscommand", "credential.helper", "http.extraheader", "url.https://evil.example/.insteadof"]);
  });

  it("never waits on a stalled fetch: it works from the local copy", async () => {
    const origin = join(temp, "origin");
    mkdirSync(origin, { recursive: true });
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.email", "test@example.com");
    git(origin, "config", "user.name", "Test");
    writeFileSync(join(origin, "a.txt"), "a\n");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "init");
    // An https remote that accepts the connection and never answers.
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    git(origin, "remote", "add", "origin", `https://127.0.0.1:${server.port}/acme/shop.git`);
    const started = Date.now();
    const result = await ensureWorktree(origin, join(temp, "wt"), "petrina/x", "main", 1500);
    server.stop(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.fetchTimedOut).toBe(true);
    expect(result.base).toBe("main");
    expect(existsSync(join(temp, "wt", "a.txt"))).toBe(true);
  });
});

describe("the change's fingerprint", () => {
  const folder = mkdtempSync(join(tmpdir(), "petrina-patch-"));
  afterAll(() => removeDir(folder));

  /** A repository with a task branch that changes one line in the middle of a file. */
  function repo(): { path: string; run: (...args: string[]) => string } {
    const path = mkdtempSync(join(folder, "repo-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "T");
    writeFileSync(join(path, "app.py"), "def a():\n    return 1\n\n\ndef b():\n    return 2\n");
    run("add", ".");
    run("commit", "-q", "-m", "init");
    run("checkout", "-q", "-b", "task");
    writeFileSync(join(path, "app.py"), "def a():\n    return 1\n\n\ndef b():\n    return 3\n");
    run("commit", "-qam", "task");
    return { path, run };
  }

  it("stays the same when the change lands lower in a file that grew above it", async () => {
    const { path, run } = repo();
    const before = await patchId(path, run("rev-parse", "main"), "HEAD");
    run("checkout", "-q", "main");
    writeFileSync(join(path, "NEWS.md"), "News\n");
    writeFileSync(join(path, "app.py"), "import os\n\n\ndef a():\n    return 1\n\n\ndef b():\n    return 2\n");
    run("add", ".");
    run("commit", "-q", "-m", "main moved");
    run("checkout", "-q", "task");
    const merged = await mergeTree(path, run("rev-parse", "main"));
    expect(merged?.conflicts).toEqual([]);
    await moveTo(path, await commitTree(path, merged!.tree, run("rev-parse", "main"), "task"));
    expect(await patchId(path, run("rev-parse", "main"), "HEAD")).toBe(before!);
  });

  it("changes when only whitespace differs, which is meaning in Python", async () => {
    const { path, run } = repo();
    const before = await patchId(path, run("rev-parse", "main"), "HEAD");
    writeFileSync(join(path, "app.py"), "def a():\n    return 1\n\n\ndef b():\n        return 3\n");
    run("commit", "-qam", "indented");
    expect(await patchId(path, run("rev-parse", "main"), "HEAD")).not.toBe(before!);
  });
});
