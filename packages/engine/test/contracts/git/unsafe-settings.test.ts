import { afterAll, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBranch, fetchRef, push, remoteRefs } from "../../../src/git.js";
import { git, makeProduct, removeDir, remoteRef, tempDir, testGitEnv } from "../../fixtures.js";
import { runGit } from "../../commands.js";
import { plantedGitProgram } from "../../fixtures/git-program.js";
import { unsafeGitSettings } from "../../fixtures/git-safety.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
function folder() { const root = tempDir("petrina-git-safety-"); roots.push(root); return root; }

it("runs the planted helper and hook through real Git, including spaces and quotes in their paths", async () => {
  const root = folder(), repo = await makeProduct(root);
  const program = plantedGitProgram(join(root, "Git helper's private folder"), "probe");
  const reading = await runGit(["-c", "credential.helper=", "-c", `credential.helper=!${program.command}`, "credential", "fill"],
    { cwd: repo, env: { ...testGitEnv(), GIT_TERMINAL_PROMPT: "0" }, input: "protocol=https\nhost=petrina-fixture.invalid\n\n" });
  expect(reading.code).not.toBe(0);
  expect(program.marks()).toEqual(["probe"]);
  program.clear();
  program.writeHook(join(repo, ".git", "hooks", "pre-commit"));
  const commit = await runGit(["commit", "--allow-empty", "-m", "The planted hook refuses"], { cwd: repo });
  expect(commit.code).not.toBe(0);
  expect(program.marks()).toEqual(["probe"]);
});

for (const variant of unsafeGitSettings) it(`refuses credentialed Git operations for a planted ${variant.name}`, async () => {
  const root = folder(), repo = await makeProduct(root), remote = { url: join(root, "origin.git"), local: true };
  const program = plantedGitProgram(root, "evil");
  const key = variant.key, setting = variant.configure(root, program.command);
  writeFileSync(join(repo, "change.txt"), "This commit must never travel\n");
  await git(repo, "add", "."); await git(repo, "commit", "-qm", "A local change");
  const sha = await git(repo, "rev-parse", "HEAD"), before = await git(root, "--git-dir", remote.url, "show-ref");
  rmSync(join(repo, ".git", "FETCH_HEAD"), { force: true });
  if (setting[0] === "--worktree") await git(repo, "config", "extensions.worktreeConfig", "true");
  await git(repo, "config", ...setting);

  const fetched = await fetchBranch(repo, remote, "main");
  expect(fetched.ok).toBe(false);
  if (fetched.ok) throw new Error("An unsafe repository must not fetch");
  expect(fetched.error).toBe("unsafe git settings");
  expect(fetched.risky?.some(name => name.startsWith(key))).toBe(true);
  const source = await fetchRef(repo, remote, "refs/heads/main", "refs/remotes/petrina/source");
  expect(source).toEqual(fetched);
  expect(existsSync(join(repo, ".git", "FETCH_HEAD"))).toBe(false);
  const published = await push(repo, remote, [{ sha, ref: "refs/heads/forbidden" }]);
  expect(published.ok).toBe(false);
  if (published.ok) throw new Error("An unsafe repository must not publish");
  expect(published.error).toContain(key);
  const lookedUp = await remoteRefs(repo, remote, ["refs/heads/main"]);
  expect(lookedUp.ok).toBe(false);
  if (lookedUp.ok) throw new Error("An unsafe repository must not use credentials for a lookup");
  expect(lookedUp.error).toContain(key);
  expect(await git(root, "--git-dir", remote.url, "show-ref")).toBe(before);
  expect(await remoteRef(remote.url, "refs/heads/forbidden")).toBeUndefined();
  expect(program.marks()).toEqual([]);
});
