// Release versions: worked out by Petrina at publish time from the latest release and the product's main
// version files, set by Petrina itself in a version commit of its own, and checked before anything goes out.
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { declaredVersion, nextVersion, parseVersion, onlyVersionChanged, isVersionFile } from "../src/version.js";
import { coordinator, finish, git, itemOf, makeWorld, removeDir, remoteRef, taskOf, until, type World } from "./support.js";

const worlds: World[] = [];
const world = (...args: Parameters<typeof makeWorld>) => {
  const made = makeWorld(...args);
  worlds.push(made);
  return made;
};
afterAll(() => {
  for (const made of worlds) removeDir(made.dir);
});

const release = (w: World, tag: string, at: string) => {
  execFileSync("git", ["--git-dir", w.remote, "update-ref", `refs/tags/${tag}`, at]);
  w.setGitHub((github) => github.releases.push({ tagName: tag, url: `https://github.com/acme/demo/releases/tag/${tag}`, publishedAt: new Date().toISOString(), isDraft: false, name: tag, body: "" }));
};

const pkg = (version: string) => `${JSON.stringify({ name: "demo", version }, null, 2)}\n`;

/** Files committed on main and pushed to the stand-in GitHub. */
const commitFiles = (w: World, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(w.clone, file)), { recursive: true });
    writeFileSync(join(w.clone, file), text);
  }
  git(w.clone, "add", ".");
  git(w.clone, "commit", "-q", "-m", "Version files");
  git(w.clone, "push", "-q", w.remote, "main");
};

async function deliver(w: World, mode: "release" | "local" | "pull-request", count = 1) {
  const engine = w.start();
  try {
    const productId = await engine.addProduct(w.clone);
    engine.setProductDelivery(productId, mode, false);
    const tasks = [];
    for (let index = 0; index < count; index += 1) {
      const taskId = engine.addTask({ productId, title: `Add greeting ${index + 1}`, description: "A greeting file. [quick]" });
      tasks.push(taskOf(await finish(engine, taskId), taskId));
    }
    return tasks;
  } finally {
    engine.shutdown();
  }
}

describe("Release versions", () => {
  it("counts up from tags like v1.2.3 and keeps their style", () => {
    expect(nextVersion("v1.2.3", "patch")).toEqual({ version: "1.2.4", tag: "v1.2.4" });
    expect(nextVersion("1.2.3", "minor")).toEqual({ version: "1.3.0", tag: "1.3.0" });
    expect(nextVersion("v1.2.3", "major")).toEqual({ version: "2.0.0", tag: "v2.0.0" });
    expect(nextVersion("release-7", "patch")).toBeUndefined();
    expect(parseVersion("1.4.0")?.version).toBe("1.4.0");
  });

  it("reads what a main version file says, and never passes one it cannot read", () => {
    expect(declaredVersion("package.json", pkg("1.2.3"))).toEqual({ version: "1.2.3" });
    expect(declaredVersion("package.json", '{"name": "demo", "private": true}')).toBe("none");
    expect(declaredVersion("package.json", '{"version": "1.2"}')).toBe("unreadable");
    expect(declaredVersion("package.json", '{"version": 3}')).toBe("unreadable");
    expect(declaredVersion("package.json", "{ not json")).toBe("unreadable");
    expect(declaredVersion("src-tauri/tauri.conf.json", '{"version": "../package.json"}')).toBe("none");
    expect(declaredVersion("Cargo.toml", '[package] # the app\nname = "demo"\nversion = \'1.2.3\'\n\n[dependencies]\nserde = { version = "1.0" }\n')).toEqual({ version: "1.2.3" });
    expect(declaredVersion("Cargo.toml", '[workspace]\nmembers = ["app"]\n\n[workspace.package]\nversion = "0.4.0"\n\n[package]\nversion.workspace = true\n')).toEqual({ version: "0.4.0" });
    expect(declaredVersion("Cargo.toml", '[workspace]\nmembers = ["app"]\n')).toBe("none");
    expect(declaredVersion("Cargo.toml", '[package]\nversion = "1.2"\n')).toBe("unreadable");
    expect(declaredVersion("Cargo.toml", '[package]\nversion = "1.2.3"\n[workspace.package]\nversion = "2.0.0"\n')).toBe("unreadable");
  });

  it("reads every legal way of writing Cargo.toml's version, and stops on any it cannot read", () => {
    for (const text of [
      '[package]\nname = "demo"\n"version" = "1.2.3"\n',
      'package.name = "demo"\npackage.version = "1.2.3"\n',
      '["package"]\nname = "demo"\nversion = "1.2.3"\n',
      'package = { name = "demo", version = "1.2.3" }\n',
      '[package]\nname = "demo"\nversion = { workspace = true }\n\n[workspace.package]\nversion = "1.2.3"\n',
      '[project]\nname = "demo"\nversion = "1.2.3"\n',
    ]) {
      expect(declaredVersion("Cargo.toml", text)).toEqual({ version: "1.2.3" });
    }
    for (const text of [
      '[package]\nname = "demo"\n',
      '[package]\nname = "demo"\nversion.workspace = true\n',
      "[package]\nversion = 1.2\n",
      '[package]\nversion = "1.2.3"\nversion = "1.2.4"\n',
      '[[package]]\nversion = "1.2.3"\n',
      'package = "demo"\n',
      '[package\nversion = "1.2.3"\n',
    ]) {
      expect(declaredVersion("Cargo.toml", text)).toBe("unreadable");
    }
  });
});

describe.concurrent("Release versions on real deliveries", () => {
  it("starts at 0.1.0 with no version files, and two release tasks get the next free version each, with notes on what each ships", async () => {
    const w = world("first-release");
    w.setScript((script) => (script.ownFiles = true));
    const [first, second] = await deliver(w, "release", 2);
    expect(first!.error).toBeUndefined();
    expect(first!.release?.tag).toBe("v0.1.0");
    expect(second!.error).toBeUndefined();
    expect(second!.release?.tag).toBe("v0.1.1");
    // No version files: what went out is the task's own commit, and the tags sit on main's history.
    const firstTag = remoteRef(w.remote, "refs/tags/v0.1.0")!;
    const secondTag = remoteRef(w.remote, "refs/tags/v0.1.1")!;
    expect(remoteRef(w.remote, "refs/heads/main")).toBe(secondTag);
    expect(git(w.clone, "merge-base", "--is-ancestor", firstTag, secondTag)).toBe("");
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v0.1.0", "v0.1.1"]);
    // The first release's notes come from every commit there is; the next one's from what came since.
    const [firstPrompt, secondPrompt] = w.script().releaseManagerPrompts!;
    expect(firstPrompt).toContain("## The first release: every commit on main, oldest first (2)");
    expect(firstPrompt).toContain("### init");
    expect(firstPrompt).toContain("### Add greeting 1");
    expect(secondPrompt).toContain("## Every commit on main since v0.1.0, oldest first (1)");
    expect(secondPrompt).toContain("### Add greeting 2");
    expect(secondPrompt).not.toContain("### Add greeting 1");
  });

  it("uses the version already in the version files for the first release", async () => {
    const w = world("declared", { version: "1.4.0" });
    const [task] = await deliver(w, "release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v1.4.0");
    expect(JSON.parse(git(w.clone, "show", `${remoteRef(w.remote, "refs/tags/v1.4.0")}:package.json`)).version).toBe("1.4.0");
  });

  it("stops when the version files disagree before the first release", async () => {
    const w = world("disagree", { version: "1.0.0" });
    writeFileSync(join(w.clone, "Cargo.toml"), '[package]\nname = "demo"\nversion = "2.0.0"\n');
    git(w.clone, "add", ".");
    git(w.clone, "commit", "-q", "-m", "cargo");
    git(w.clone, "push", "-q", w.remote, "main");
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("the version files disagree (package.json says 1.0.0, Cargo.toml says 2.0.0)");
    expect(w.github().releases).toEqual([]);
  });

  it("reads only the product's main version files for the first release", async () => {
    const w = world("main-files-first");
    // Subfolders and other files are the reviewers' to check: they do not decide the version.
    commitFiles(w, { "package.json": pkg("0.3.0"), "src-tauri/tauri.conf.json": pkg("0.3.0"), VERSION: "0.9.0\n", "apps/desktop/package.json": pkg("0.9.0") });
    const [task] = await deliver(w, "release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v0.3.0");
  });

  it("sets the version itself in every main version file, and nowhere else", async () => {
    const w = world("main-files", { version: "1.4.0" });
    const tauri = "src-tauri/tauri.conf.json";
    commitFiles(w, { [tauri]: pkg("1.4.0"), "test/fixtures/old/package.json": pkg("9.9.9"), "apps/desktop/package.json": pkg("1.4.0") });
    release(w, "v1.4.0", remoteRef(w.remote, "refs/heads/main")!);
    const [task] = await deliver(w, "release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v1.4.1");
    const tagged = remoteRef(w.remote, "refs/tags/v1.4.1")!;
    for (const file of ["package.json", tauri]) expect(JSON.parse(git(w.clone, "show", `${tagged}:${file}`)).version).toBe("1.4.1");
    // A fixture and a package in a subfolder keep theirs, and the version commit changes nothing else.
    expect(JSON.parse(git(w.clone, "show", `${tagged}:test/fixtures/old/package.json`)).version).toBe("9.9.9");
    expect(JSON.parse(git(w.clone, "show", `${tagged}:apps/desktop/package.json`)).version).toBe("1.4.0");
    expect(git(w.clone, "diff", "--name-only", `${tagged}^`, tagged).split("\n").sort()).toEqual(["package.json", tauri]);
    expect(git(w.clone, "show", `${tagged}:package.json`)).toBe(pkg("1.4.1").trim());
  });

  it("sets Cargo.toml's version and the product's own entry in Cargo.lock, never a dependency's", async () => {
    const w = world("cargo", { version: "1.4.0" });
    commitFiles(w, {
      "Cargo.toml": '[package]\nname = "demo"\nversion = "1.4.0" # the product\n\n[dependencies]\nserde = "1"\n',
      "Cargo.lock": 'version = 3\n\n[[package]]\nname = "demo"\nversion = "1.4.0"\n\n[[package]]\nname = "serde"\nversion = "1.4.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n',
    });
    release(w, "v1.4.0", remoteRef(w.remote, "refs/heads/main")!);
    const [task] = await deliver(w, "release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v1.4.1");
    const tagged = remoteRef(w.remote, "refs/tags/v1.4.1")!;
    expect(git(w.clone, "show", `${tagged}:Cargo.toml`)).toBe('[package]\nname = "demo"\nversion = "1.4.1" # the product\n\n[dependencies]\nserde = "1"');
    const lock = git(w.clone, "show", `${tagged}:Cargo.lock`);
    expect(lock).toContain('name = "demo"\nversion = "1.4.1"');
    expect(lock).toContain('name = "serde"\nversion = "1.4.0"');
  });

  it("stops, publishing nothing, when it cannot set the version in a main version file on its own", async () => {
    const w = world("cargo-inline", { version: "1.4.0" });
    commitFiles(w, { "Cargo.toml": 'package = { name = "demo", version = "1.4.0" }\n' });
    release(w, "v1.4.0", remoteRef(w.remote, "refs/heads/main")!);
    const before = remoteRef(w.remote, "refs/heads/main");
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("Petrina could not set the version to 1.4.1: Cargo.toml does not state it in a way Petrina can change on its own. It published nothing.");
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.4.0"]);
    expect(remoteRef(w.remote, "refs/tags/v1.4.1")).toBeUndefined();
    expect(remoteRef(w.remote, "refs/heads/main")).toBe(before);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  });

  it("stops when a main version file has a version Petrina cannot read", async () => {
    const w = world("unreadable", { version: "1.4.0" });
    commitFiles(w, { "Cargo.toml": '[package]\nname = "demo"\nversion = "1.4"\n' });
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("Petrina cannot read the version in Cargo.toml");
    expect(w.github().releases).toEqual([]);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  });

  it("never picks a first-release version when the login cannot see the repository, though GitHub says 'not found'", async () => {
    const w = world("hidden", { version: "1.4.0" });
    w.setGitHub((github) => (github.hidden = true));
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("cannot see acme/demo");
    expect(task!.shipping?.version).toBeUndefined();
    expect(w.script().releaseManagerPrompts).toBeUndefined();
    expect(remoteRef(w.remote, "refs/tags/v1.4.0")).toBeUndefined();
    expect(remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
  });

  it("stops when the version files do not follow the latest release", async () => {
    const w = world("off", { version: "2.0.0" });
    release(w, "v1.2.0", w.initial);
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("The latest release is v1.2.0, but the version files say otherwise (package.json says 2.0.0)");
    expect(remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.2.0"]);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  });

  it("stops rather than skip a version when the new tag is already on GitHub", async () => {
    const w = world("occupied");
    release(w, "v1.0.0", w.initial);
    execFileSync("git", ["--git-dir", w.remote, "update-ref", "refs/tags/v1.0.1", w.initial]);
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("The tag v1.0.1 already exists on GitHub");
    expect(remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.0.0"]);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  });

  it("works the version and the notes out again when a release comes out before its push", async () => {
    const w = world("meanwhile", { version: "0.1.0" });
    // A teammate publishes v0.1.0 as Petrina looks for this delivery's release, right after getting it ready.
    w.setGitHub((github) => (github.meanwhile = { command: "release view", withTag: true, times: 1, release: "v0.1.0" }));
    const [task] = await deliver(w, "release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v0.1.1");
    const prompts = w.script().releaseManagerPrompts!;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("## Every commit on main since v0.1.0, oldest first (1)");
    const tested = remoteRef(w.remote, "refs/tags/v0.1.1")!;
    expect(JSON.parse(git(w.clone, "show", `${tested}:package.json`)).version).toBe("0.1.1");
    expect(git(w.clone, "log", "-1", "--format=%s", tested)).toBe("Release v0.1.1");
    expect(task!.timeline.map((entry) => entry.text)).toContain("main moved on GitHub, so Petrina gets it ready again (1 of 3)");
  });

  it("gets a release ready again when main moves before its push, but not a pull request", async () => {
    const releasing = world("moved-release");
    releasing.setGitHub((github) => (github.meanwhile = { command: "release view", withTag: true, times: 1 }));
    const [r] = await deliver(releasing, "release");
    expect(r!.release?.tag).toBe("v0.1.0");
    expect(releasing.script().releaseManagerPrompts).toHaveLength(2);
    expect(remoteRef(releasing.remote, "refs/heads/main")).toBe(remoteRef(releasing.remote, "refs/tags/v0.1.0"));
    // On top of the teammate's change, as one commit: a fast-forward, never a merge.
    expect(git(releasing.clone, "log", "-1", "--format=%s", `${remoteRef(releasing.remote, "refs/heads/main")}^`)).toBe("A teammate's change");

    const pr = world("moved-pr");
    pr.setGitHub((github) => (github.meanwhile = { command: "pr list", times: 1 }));
    const [p] = await deliver(pr, "pull-request");
    expect(p!.state).toBe("pr-open");
    expect(pr.script().releaseManagerPrompts).toBeUndefined();
  });

  it("brings local delivery up to date when main moved after the delivery check, and moves main forward on top of it", async () => {
    const w = world("moved-local");
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const state = await until(engine, (current) => !!itemOf(current, taskId, "delivery"), coordinator(["plan", "design"]));
      // A teammate's commit lands on the main copy's main before the coordinator says yes.
      git(w.clone, "commit", "-q", "--allow-empty", "-m", "A teammate's change");
      engine.approve(itemOf(state, taskId, "delivery")!.id);
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("done");
      expect(task.timeline.map((entry) => entry.text)).toContain("Brought up to date with main (1 new commit there), with no conflicts");
      expect(git(w.clone, "log", "-1", "--format=%s", "main^")).toBe("A teammate's change");
      expect(git(w.clone, "rev-list", "--merges", "--count", "main")).toBe("0");
    } finally {
      engine.shutdown();
    }
  });

  it("stops after three new preparations when main keeps moving", async () => {
    const w = world("keeps-moving");
    w.setGitHub((github) => (github.meanwhile = { command: "release view", withTag: true, times: 4 }));
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("main kept moving while Petrina was delivering, so it stopped after 3 new preparations");
    expect(w.script().releaseManagerPrompts).toHaveLength(4);
    expect(w.github().releases).toEqual([]);
    expect(remoteRef(w.remote, "refs/tags/v0.1.0")).toBeUndefined();
  });
});

describe("a release's version commit sets the version and nothing else", () => {
  const pkg = (version: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "app", version, scripts: { test: "bun test" }, ...extra }, null, 2);

  it("accepts the version fields, and only them, changing to the new version", () => {
    expect(onlyVersionChanged("package.json", pkg("1.2.3"), pkg("1.2.4"), "1.2.4", "1.2.3")).toBe(true);
    expect(onlyVersionChanged("package.json", pkg("1.2.3"), pkg("1.2.5"), "1.2.4", "1.2.3")).toBe(false);
    const lock = (version: string) => JSON.stringify({ name: "app", version, lockfileVersion: 3, packages: { "": { name: "app", version }, "node_modules/left-pad": { version: "1.3.0" } } });
    expect(onlyVersionChanged("package-lock.json", lock("1.2.3"), lock("1.2.4"), "1.2.4", "1.2.3")).toBe(true);
    expect(onlyVersionChanged("VERSION", "1.2.3\n", "1.2.4\n", "1.2.4")).toBe(true);
    expect(onlyVersionChanged("src-tauri/Cargo.toml", '[package]\nname = "app"\nversion = "1.2.3"\n\n[dependencies]\nserde = "1"\n', '[package]\nname = "app"\nversion = "1.2.4"\n\n[dependencies]\nserde = "1"\n', "1.2.4", "1.2.3")).toBe(true);
  });

  it("refuses a dependency, a script or a pinned version riding along", () => {
    expect(onlyVersionChanged("package.json", pkg("1.2.3"), pkg("1.2.4", { dependencies: { "evil-pkg": "1.0.0" } }), "1.2.4", "1.2.3")).toBe(false);
    expect(onlyVersionChanged("package.json", pkg("1.2.3"), pkg("1.2.4", { scripts: { test: "bun test", postinstall: "curl x | sh" } }), "1.2.4", "1.2.3")).toBe(false);
    expect(onlyVersionChanged("Cargo.toml", '[package]\nversion = "1.2.3"\n', '[package]\nversion = "1.2.4"\nbuild = "steal.rs"\n', "1.2.4", "1.2.3")).toBe(false);
    // A dependency's version written as a table's own line, set to the release's number.
    const table = (serde: string) => `[package]\nname = "app"\nversion = "1.2.3"\n\n[dependencies.serde]\nversion = "${serde}"\n`;
    expect(onlyVersionChanged("Cargo.toml", table("1.0"), table("1.2.4").replace('version = "1.2.3"', 'version = "1.2.4"'), "1.2.4", "1.2.3")).toBe(false);
    expect(onlyVersionChanged("pyproject.toml", '[project]\nname = "app"\nversion = "1.2.3"\ndependencies = ["requests"]\n', '[project]\nname = "app"\nversion = "1.2.4"\ndependencies = ["requests", "evil"]\n', "1.2.4", "1.2.3")).toBe(false);
    // In the lock file only the product's own (local) entries move; a registry package's pin never does.
    const cargoLock = (own: string, dep: string) => `version = 3\n\n[[package]]\nname = "app"\nversion = "${own}"\n\n[[package]]\nname = "serde"\nversion = "${dep}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n`;
    expect(onlyVersionChanged("Cargo.lock", cargoLock("1.2.3", "1.0.0"), cargoLock("1.2.4", "1.0.0"), "1.2.4", "1.2.3")).toBe(true);
    expect(onlyVersionChanged("Cargo.lock", cargoLock("1.2.3", "1.2.3"), cargoLock("1.2.4", "1.2.4"), "1.2.4", "1.2.3")).toBe(false);
    // A first release has no previous version: its lock file does not change at all.
    expect(onlyVersionChanged("Cargo.lock", cargoLock("1.2.3", "1.0.0"), cargoLock("1.2.4", "1.0.0"), "1.2.4")).toBe(false);
    // Version files at any depth (a monorepo's packages), and nothing else.
    expect(isVersionFile("apps/desktop/package.json")).toBe(true);
    expect(isVersionFile("src/index.ts")).toBe(false);
    expect(onlyVersionChanged("package.json", undefined, pkg("1.2.4"), "1.2.4")).toBe(false);
  });
});
