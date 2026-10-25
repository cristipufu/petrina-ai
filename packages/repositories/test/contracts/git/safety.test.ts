import { afterAll, describe, expect, it } from "bun:test";
import { plantedGitProgram } from "@petrina/test-support/git-program";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, ensureWorktree, fetchBranch, isClean, repoInfo, riskySettings } from "../../../src/git.js";
import { removeDir } from "@petrina/test-support/fixtures";
import { git } from "@petrina/test-support/commands";

const temp = mkdtempSync(join(tmpdir(), "petrina-git-"));

describe("Petrina's own git steps", () => {
  afterAll(() => removeDir(temp));

  it("never run hooks or the file monitor an agent planted", async () => {
    const repo = join(temp, "repo");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    const program = plantedGitProgram(join(temp, "planted helper"), "ran");
    program.writeHook(join(repo, ".git", "hooks", "pre-commit"));
    await git(repo, "config", "core.fsmonitor", program.command);
    writeFileSync(join(repo, "a.txt"), "hello\n");

    expect(await isClean(repo)).toBe(false);
    expect(await commitAll(repo, "Add a")).toMatch(/^[0-9a-f]{40}$/);
    expect(program.marks()).toEqual([]);
  });

  it("names the product's repository from its origin, and one cloned from a folder on this computer by the clone's own folder", async () => {
    const repo = join(temp, "named");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "remote", "add", "origin", "git@github.com:acme/shop.git");
    expect(await repoInfo(repo)).toMatchObject({ owner: "acme", name: "shop" });
    for (const folder of ["C:\\Users\\ana\\origin.git", "C:/Users/ana/origin.git", "/home/ana/origin.git", "file:///home/ana/origin.git"]) {
      await git(repo, "remote", "set-url", "origin", folder);
      expect(await repoInfo(repo)).toMatchObject({ owner: "local", name: "named" });
    }
  });

  it("will not fetch with the coordinator's login when the repository's settings could misuse it", async () => {
    const repo = join(temp, "risky");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "remote", "add", "origin", "https://github.com/acme/shop.git");
    await git(repo, "config", "branch.main.remote", "origin");
    await git(repo, "config", "core.hooksPath", ".husky");
    expect(await riskySettings(repo)).toEqual([]);
    await git(repo, "config", "credential.helper", "!sh -c 'touch /tmp/stolen'");
    await git(repo, "config", "url.https://evil.example/.insteadOf", "https://github.com/");
    await git(repo, "config", "http.extraHeader", "X-Leak: 1");
    await git(repo, "config", "core.alternateRefsCommand", "sh -c id");
    expect((await riskySettings(repo)).sort()).toEqual(["core.alternaterefscommand", "credential.helper", "http.extraheader", "url.https://evil.example/.insteadof"]);
  });

  it("never waits on a stalled fetch", async () => {
    const origin = join(temp, "origin");
    mkdirSync(origin, { recursive: true });
    await git(origin, "init", "-q", "-b", "main");
    await git(origin, "config", "user.email", "test@example.com");
    await git(origin, "config", "user.name", "Test");
    writeFileSync(join(origin, "a.txt"), "a\n");
    await git(origin, "add", ".");
    await git(origin, "commit", "-q", "-m", "init");
    // An https address that accepts the connection and never answers.
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const started = Date.now();
    let result;
    try { result = await fetchBranch(origin, { url: `https://127.0.0.1:${server.port}/acme/shop.git` }, "main", 1500); }
    finally { server.stop(true); }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ ok: false, timedOut: true });
    await ensureWorktree(origin, join(temp, "wt"), "petrina/x", "main");
    expect(existsSync(join(temp, "wt", "a.txt"))).toBe(true);
  });

  it("treats a remote section named after an address as unsafe", async () => {
    const repo = join(temp, "named");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "remote.origin.url", "git@github-work:acme/shop");
    expect(await riskySettings(repo)).toEqual([]);
    await git(repo, "config", "remote.git@github-work:acme/shop.url", "/tmp/evil.git");
    expect(await riskySettings(repo)).toEqual(["remote.git@github-work:acme/shop.url"]);
  });
});
