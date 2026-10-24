import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitWith, headNow, makeProduct, makeWorld, removeDir, repositorySeed, tempDir, testGitEnv } from "./support.js";
import { rejectionOf } from "@petrina/test-support/rejections";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("copies seed objects rather than sharing writable repositories or alternates between worlds", async () => {
  const one = await makeWorld("isolated-seed-one"), two = await makeWorld("isolated-seed-two");
  roots.push(one.dir, two.dir);
  expect(one.initial).toBe(two.initial);
  const object = join("objects", one.initial.slice(0, 2), one.initial.slice(2));
  expect(statSync(join(one.remote, object)).ino).not.toBe(statSync(join(two.remote, object)).ino);
  expect(statSync(join(one.clone, ".git", object)).ino).not.toBe(statSync(join(two.clone, ".git", object)).ino);
  for (const world of [one, two]) {
    expect(existsSync(join(world.remote, "objects/info/alternates"))).toBe(false);
    expect(existsSync(join(world.clone, ".git/objects/info/alternates"))).toBe(false);
    expect(await git(world.clone, "config", "user.name")).toBe("Test");
    expect(await git(world.clone, "config", "user.email")).toBe("test@example.com");
    expect(await git(world.clone, "remote", "get-url", "origin")).toBe("https://github.com/acme/demo.git");
    expect(await git(world.clone, "for-each-ref", "refs/remotes")).toBe("");
    expect(await git(world.clone, "config", "--local", "--list")).not.toContain("branch.main.");
    expect(await git(world.remote, "remote")).toBe("");
  }
  writeFileSync(join(one.clone, "README.md"), "Only one world's change\n");
  await git(one.clone, "add", "."); await git(one.clone, "commit", "-qm", "Change one world");
  await git(one.clone, "push", "-q", one.remote, "main");
  expect(await git(two.clone, "show", "HEAD:README.md")).toBe("# Demo");
  expect(await git(two.remote, "rev-parse", "main")).toBe(two.initial);
  await git(one.clone, "config", "user.name", "Changed");
  expect(await git(two.clone, "config", "user.name")).toBe("Test");
});

it("retains each fixture recipe and version without carrying earlier changes into a new clone", async () => {
  const root = tempDir("petrina-seed-recipes-"); roots.push(root);
  const a = await makeProduct(join(root, "a")), b = await makeProduct(join(root, "b"));
  const versioned = await makeWorld("seed-version", { version: "2.3.4" }), plain = await makeWorld("seed-plain");
  const custom = await makeWorld("seed-custom-address", { address: "https://github.com/acme/other.git" });
  const empty = await makeWorld("seed-empty-address", { address: "" });
  roots.push(versioned.dir, plain.dir, custom.dir, empty.dir);
  expect(await git(a, "show", "HEAD:VERSION")).toBe("1.0.0");
  expect(await git(a, "rev-parse", "@{upstream}")).toBe(await git(a, "rev-parse", "HEAD"));
  expect(await git(a, "remote", "get-url", "origin")).toBe(join(root, "a", "origin.git"));
  writeFileSync(join(a, "VERSION"), "Changed locally\n");
  expect(await git(b, "show", "HEAD:VERSION")).toBe("1.0.0");
  expect(JSON.parse(await git(versioned.clone, "show", "HEAD:package.json")).version).toBe("2.3.4");
  expect(await git(plain.clone, "ls-tree", "--name-only", "HEAD")).toBe("README.md");
  expect(await git(custom.clone, "config", "remote.origin.url")).toBe("https://github.com/acme/other.git");
  expect(await git(empty.clone, "config", "remote.origin.url")).toBe("");
});

it("checks files out as written in seed copies and their linked working copies, whatever line endings this machine's Git settings convert to", async () => {
  const root = tempDir("petrina-seed-line-endings-"); roots.push(root);
  // Stands in for Git for Windows' own settings, which convert text to CRLF, for these commands only: read even where
  // the parent tells Git to skip machine settings. Personal settings outrank them and a personal attributes file can turn
  // conversion off, so both are empty private ones here. Settings a parent Git command hands on outrank every file: dropped.
  const settings = join(root, "gitconfig"), personal = join(root, "personal");
  writeFileSync(settings, "[core]\n\tautocrlf = true\n");
  mkdirSync(personal); writeFileSync(join(personal, "gitconfig"), "");
  const machine: NodeJS.ProcessEnv = { ...testGitEnv(), GIT_CONFIG_NOSYSTEM: "0", GIT_CONFIG_SYSTEM: settings, GIT_CONFIG_GLOBAL: join(personal, "gitconfig"), XDG_CONFIG_HOME: personal };
  delete machine.GIT_CONFIG_PARAMETERS;
  const world = await makeWorld("seed-line-endings"); roots.push(world.dir);
  for (const [name, clone] of [["product", await makeProduct(join(root, "product"))], ["world", world.clone]] as const) {
    const copy = join(root, `${name}-copy`), file = join(copy, "README.md");
    const restore = async () => { writeFileSync(file, "Changed\n"); await gitWith({ cwd: copy, env: machine }, "reset", "-q", "--hard"); return readFileSync(file, "utf8"); };
    await gitWith({ cwd: clone, env: machine }, "worktree", "add", "-q", "--detach", copy);
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("# Demo\n");
    expect(readFileSync(file, "utf8")).toBe("# Demo\n");
    expect(await restore()).toBe("# Demo\n");
    // Without the copy's own setting, the machine's applies.
    await git(clone, "config", "--unset", "core.autocrlf");
    expect(await restore()).toBe("# Demo\r\n");
  }
});

it("shares one recipe's preparation among fixtures asking at once, and gives each its own writable copies", async () => {
  const [first, second] = await Promise.all([repositorySeed("7.7.7"), repositorySeed("7.7.7")]);
  expect(second).toBe(first);
  expect(Object.isFrozen(first)).toBe(true);
  const worlds = await Promise.all(["one", "two", "three"].map((name) => makeWorld(`concurrent-seed-${name}`, { version: "7.7.7" })));
  roots.push(...worlds.map((world) => world.dir));
  expect(new Set(worlds.map((world) => world.initial))).toEqual(new Set([first!.head]));
  const object = join("objects", first!.head.slice(0, 2), first!.head.slice(2));
  expect(new Set(worlds.map((world) => statSync(join(world.remote, object)).ino)).size).toBe(3);
  writeFileSync(join(worlds[0]!.clone, "README.md"), "Only the first copy\n");
  await git(worlds[0]!.clone, "commit", "-qam", "Change one copy");
  await git(worlds[0]!.clone, "push", "-q", worlds[0]!.remote, "main");
  for (const world of worlds.slice(1)) {
    expect(await git(world.clone, "show", "HEAD:README.md")).toBe("# Demo");
    expect(await git(world.remote, "rev-parse", "main")).toBe(first!.head);
  }
});

it("leaves no reusable seed or partial folder behind when preparing one fails, and prepares it afresh", async () => {
  // Git refuses an unknown object format, so this recipe's preparation fails.
  const broken = "sha999" as "sha1";
  const folderOf = (error: unknown) => /starting repository in (.+?): /.exec((error as Error).message)?.[1];
  const together = await Promise.all([rejectionOf(repositorySeed(undefined, false, broken)), rejectionOf(repositorySeed(undefined, false, broken))]);
  expect(together[1]).toBe(together[0]);
  expect((together[0] as Error).message).toContain("sha999");
  const failed = folderOf(together[0]);
  expect(failed).toBeDefined();
  expect(existsSync(failed!)).toBe(false);
  const again = await rejectionOf(repositorySeed(undefined, false, broken));
  expect(folderOf(again)).toBeDefined();
  expect(folderOf(again)).not.toBe(failed);
  expect(existsSync(folderOf(again)!)).toBe(false);
});

it("reads a working copy's HEAD from Git's files as Git itself does, for callbacks that cannot wait", async () => {
  const root = tempDir("petrina-head-now-"); roots.push(root);
  const clone = await makeProduct(root);
  expect(headNow(clone)).toBe(await git(clone, "rev-parse", "HEAD"));
  // An engine-style linked working copy on its own branch, then moved by a commit.
  const copy = join(root, "copy");
  await git(clone, "worktree", "add", "-q", "-b", "task", copy);
  writeFileSync(join(copy, "change.txt"), "A change\n");
  await git(copy, "add", "."); await git(copy, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "A change");
  expect(headNow(copy)).toBe(await git(copy, "rev-parse", "HEAD"));
  expect(headNow(copy)).not.toBe(headNow(clone));
  // Packed branch refs, and a detached head.
  await git(clone, "pack-refs", "--all");
  expect(existsSync(join(clone, ".git", "refs", "heads", "task"))).toBe(false);
  expect(headNow(copy)).toBe(await git(copy, "rev-parse", "HEAD"));
  await git(copy, "switch", "-q", "--detach", "HEAD~1");
  expect(headNow(copy)).toBe(await git(clone, "rev-parse", "main"));
  expect(() => headNow(join(root, "missing"))).toThrow();
});
