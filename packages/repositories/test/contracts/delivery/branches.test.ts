import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastForward, push } from "../../../src/git.js";
import { removeDir } from "@petrina/test-support/fixtures";
import { git, gitWith } from "@petrina/test-support/commands";

const temp = mkdtempSync(join(tmpdir(), "petrina-git-"));

/** A file as checked out, in one line-ending style: git on Windows writes CRLF. */
const checkedOut = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("Petrina's own git steps", () => {
  afterAll(() => removeDir(temp));

  describe("pushes and local updates", () => {
    const setup = async (name: string) => {
      const remote = join(temp, `${name}.git`);
      await gitWith({}, "init", "-q", "--bare", "-b", "main", remote);
      const repo = join(temp, name);
      mkdirSync(repo, { recursive: true });
      await git(repo, "init", "-q", "-b", "main");
      await git(repo, "config", "user.email", "test@example.com");
      await git(repo, "config", "user.name", "Test");
      await git(repo, "commit", "-q", "--allow-empty", "-m", "one");
      const one = await git(repo, "rev-parse", "HEAD");
      await git(repo, "push", "-q", remote, "main");
      await git(repo, "commit", "-q", "--allow-empty", "-m", "two");
      const two = await git(repo, "rev-parse", "HEAD");
      return { remote, repo, one, two, at: (ref: string) => gitWith({}, "--git-dir", remote, "for-each-ref", "--format=%(objectname)", ref) };
    };

    it("pushes main and a tag all or nothing, and refuses an existing tag", async () => {
      const { remote, repo, one, two, at } = await setup("atomic");
      await gitWith({}, "--git-dir", remote, "update-ref", "refs/tags/v1.0.0", one);
      const pushed = await push(repo, { url: remote, local: true }, [{ sha: two, ref: "refs/heads/main" }, { sha: two, ref: "refs/tags/v1.0.0" }], true);
      expect(pushed.ok).toBe(false);
      expect(await at("refs/heads/main")).toBe(one);
      expect(await at("refs/tags/v1.0.0")).toBe(one);
      expect((await push(repo, { url: remote, local: true }, [{ sha: two, ref: "refs/heads/main" }, { sha: two, ref: "refs/tags/v1.0.1" }], true)).ok).toBe(true);
      expect(await at("refs/heads/main")).toBe(two);
      expect(await at("refs/tags/v1.0.1")).toBe(two);
    });

    it("never forces: a branch that moved elsewhere on GitHub is refused, not overwritten", async () => {
      const { remote, repo, one, two, at } = await setup("forward");
      await git(repo, "commit", "-q", "--allow-empty", "-m", "elsewhere");
      const elsewhere = await git(repo, "rev-parse", "HEAD");
      await git(repo, "push", "-q", remote, "HEAD:main");
      expect((await push(repo, { url: remote, local: true }, [{ sha: two, ref: "refs/heads/main" }])).ok).toBe(false);
      expect(await at("refs/heads/main")).toBe(elsewhere);
      expect((await push(repo, { url: "--receive-pack=sh", local: true }, [{ sha: one, ref: "refs/heads/x" }])).ok).toBe(false);
      // The file transport is only for a test stand-in: without it, a folder is refused.
      expect((await push(repo, { url: remote }, [{ sha: two, ref: "refs/heads/other" }])).ok).toBe(false);
      expect(await at("refs/heads/other")).toBe("");
    });

    it("refuses a local update when the branch moved meanwhile, checked out or not", async () => {
      const { repo, one, two } = await setup("racing");
      // Not checked out: main must still be where Petrina saw it.
      await git(repo, "switch", "-q", "-c", "side", one);
      await git(repo, "commit", "-q", "--allow-empty", "-m", "a teammate's commit");
      const teammate = await git(repo, "rev-parse", "HEAD");
      await git(repo, "branch", "-f", "main", teammate);
      expect((await fastForward(repo, "main", one, two, false)).ok).toBe(false);
      expect(await git(repo, "rev-parse", "main")).toBe(teammate);
      // Checked out: refused just the same, history that is not ahead of it or not.
      await git(repo, "switch", "-q", "main");
      expect((await fastForward(repo, "main", one, two, true)).ok).toBe(false);
      expect(await git(repo, "rev-parse", "main")).toBe(teammate);
      await git(repo, "reset", "-q", "--hard", two);
      writeFileSync(join(repo, "greeting.txt"), "Hello\n");
      await git(repo, "add", "greeting.txt");
      await git(repo, "commit", "-q", "-m", "three");
      const three = await git(repo, "rev-parse", "HEAD");
      // Moved forward since Petrina looked, to a commit the tested one has: still refused, files untouched.
      await git(repo, "reset", "-q", "--hard", two);
      expect((await fastForward(repo, "main", one, three, true)).ok).toBe(false);
      expect(await git(repo, "rev-parse", "main")).toBe(two);
      expect(existsSync(join(repo, "greeting.txt"))).toBe(false);
      // A change in the way: the branch goes back and the change stays.
      writeFileSync(join(repo, "greeting.txt"), "Mine\n");
      expect((await fastForward(repo, "main", two, three, true)).ok).toBe(false);
      expect(await git(repo, "rev-parse", "main")).toBe(two);
      expect(checkedOut(join(repo, "greeting.txt"))).toBe("Mine\n");
      rmSync(join(repo, "greeting.txt"));
      expect((await fastForward(repo, "main", two, three, true)).ok).toBe(true);
      expect(await git(repo, "rev-parse", "main")).toBe(three);
      expect(checkedOut(join(repo, "greeting.txt"))).toBe("Hello\n");
      expect(await git(repo, "status", "--porcelain")).toBe("");
      expect(await git(repo, "rev-list", "--merges", "--count", "main")).toBe("0");
    });

    it("refuses a local update when the main copy switches branches at that moment, and stages nothing anywhere", async () => {
      const { repo, one } = await setup("switching");
      writeFileSync(join(repo, "greeting.txt"), "Hello\n");
      await git(repo, "add", "greeting.txt");
      await git(repo, "commit", "-q", "-m", "greeting");
      const tested = await git(repo, "rev-parse", "HEAD");
      await git(repo, "reset", "-q", "--hard", one);
      const lock = join(repo, ".git", "index.lock");
      const untouched = async () => {
        expect(await git(repo, "rev-parse", "main")).toBe(one);
        expect(await git(repo, "status", "--porcelain")).toBe("");
        expect(existsSync(join(repo, "greeting.txt"))).toBe(false);
      };
      // Petrina saw main open; the coordinator switches to another branch just before the update.
      await git(repo, "switch", "-q", "-c", "feature");
      expect(await fastForward(repo, "main", one, tested, true)).toEqual({ ok: false, error: "the main copy switched branches at that moment, so main stays where it was" });
      await untouched();
      expect(existsSync(lock)).toBe(false);
      // Petrina saw main not open; the copy switches to main just before: refused too.
      await git(repo, "switch", "-q", "main");
      expect((await fastForward(repo, "main", one, tested, false)).ok).toBe(false);
      await untouched();
      // A switch half done: the staging area and files are already another branch's, main still open.
      await git(repo, "switch", "-q", "-c", "other");
      writeFileSync(join(repo, "other.txt"), "Other\n");
      await git(repo, "add", "other.txt");
      await git(repo, "commit", "-q", "-m", "other");
      await git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
      expect((await fastForward(repo, "main", one, tested, true)).ok).toBe(false);
      await git(repo, "symbolic-ref", "HEAD", "refs/heads/other");
      expect(await git(repo, "status", "--porcelain")).toBe("");
      await git(repo, "switch", "-q", "main");
      await untouched();
      // Another git command holds the lock: refused, and its lock stays.
      writeFileSync(lock, "");
      expect(await fastForward(repo, "main", one, tested, true)).toEqual({ ok: false, error: "another git command was working in the main copy at that moment" });
      expect(existsSync(lock)).toBe(true);
      rmSync(lock);
      await untouched();
      // Still on main: it goes through, and leaves no lock behind.
      expect((await fastForward(repo, "main", one, tested, true)).ok).toBe(true);
      expect(await git(repo, "rev-parse", "main")).toBe(tested);
      expect(checkedOut(join(repo, "greeting.txt"))).toBe("Hello\n");
      expect(await git(repo, "status", "--porcelain")).toBe("");
      expect(existsSync(lock)).toBe(false);
    });
  });
});
