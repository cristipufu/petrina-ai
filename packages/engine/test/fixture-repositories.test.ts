import { afterAll, expect, it } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeProduct, makeWorld, removeDir, tempDir } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("copies seed objects rather than sharing writable repositories or alternates between worlds", () => {
  const one = makeWorld("isolated-seed-one"), two = makeWorld("isolated-seed-two");
  roots.push(one.dir, two.dir);
  expect(one.initial).toBe(two.initial);
  const object = join("objects", one.initial.slice(0, 2), one.initial.slice(2));
  expect(statSync(join(one.remote, object)).ino).not.toBe(statSync(join(two.remote, object)).ino);
  expect(statSync(join(one.clone, ".git", object)).ino).not.toBe(statSync(join(two.clone, ".git", object)).ino);
  for (const world of [one, two]) {
    expect(existsSync(join(world.remote, "objects/info/alternates"))).toBe(false);
    expect(existsSync(join(world.clone, ".git/objects/info/alternates"))).toBe(false);
    expect(git(world.clone, "config", "user.name")).toBe("Test");
    expect(git(world.clone, "config", "user.email")).toBe("test@example.com");
    expect(git(world.clone, "remote", "get-url", "origin")).toBe("https://github.com/acme/demo.git");
    expect(git(world.clone, "for-each-ref", "refs/remotes")).toBe("");
    expect(git(world.clone, "config", "--local", "--list")).not.toContain("branch.main.");
    expect(git(world.remote, "remote")).toBe("");
  }
  writeFileSync(join(one.clone, "README.md"), "Only one world's change\n");
  git(one.clone, "add", "."); git(one.clone, "commit", "-qm", "Change one world");
  git(one.clone, "push", "-q", one.remote, "main");
  expect(git(two.clone, "show", "HEAD:README.md")).toBe("# Demo");
  expect(git(two.remote, "rev-parse", "main")).toBe(two.initial);
  git(one.clone, "config", "user.name", "Changed");
  expect(git(two.clone, "config", "user.name")).toBe("Test");
});

it("retains each fixture recipe and version without carrying earlier changes into a new clone", () => {
  const root = tempDir("petrina-seed-recipes-"); roots.push(root);
  const a = makeProduct(join(root, "a")), b = makeProduct(join(root, "b"));
  const versioned = makeWorld("seed-version", { version: "2.3.4" }), plain = makeWorld("seed-plain");
  const custom = makeWorld("seed-custom-address", { address: "https://github.com/acme/other.git" });
  const empty = makeWorld("seed-empty-address", { address: "" });
  roots.push(versioned.dir, plain.dir, custom.dir, empty.dir);
  expect(git(a, "show", "HEAD:VERSION")).toBe("1.0.0");
  expect(git(a, "rev-parse", "@{upstream}")).toBe(git(a, "rev-parse", "HEAD"));
  expect(git(a, "remote", "get-url", "origin")).toBe(join(root, "a", "origin.git"));
  writeFileSync(join(a, "VERSION"), "Changed locally\n");
  expect(git(b, "show", "HEAD:VERSION")).toBe("1.0.0");
  expect(JSON.parse(git(versioned.clone, "show", "HEAD:package.json")).version).toBe("2.3.4");
  expect(git(plain.clone, "ls-tree", "--name-only", "HEAD")).toBe("README.md");
  expect(git(custom.clone, "config", "remote.origin.url")).toBe("https://github.com/acme/other.git");
  expect(git(empty.clone, "config", "remote.origin.url")).toBe("");
});
