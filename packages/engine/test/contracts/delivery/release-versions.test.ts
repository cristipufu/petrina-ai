// Real version preparation, product checks and publication start from built/reviewed private inputs.
import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitFiles, pkg, release, releaseVersionFixtures } from "../../fixtures/release-versions.js";
import { git, gitWith, remoteRef } from "../../support.js";

const { world, close } = releaseVersionFixtures();
afterAll(close);

describe.concurrent("Release versions on real deliveries", () => {

  it("uses the version already in the version files for the first release", () => world("declared", { version: "1.4.0" }, async ({ world: w, preparedRelease }) => {
    const [task] = await preparedRelease();
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v1.4.0");
    expect(JSON.parse(await git(w.clone, "show", `${await remoteRef(w.remote, "refs/tags/v1.4.0")}:package.json`)).version).toBe("1.4.0");
  }));

  it("stops when the version files disagree before the first release", () => world("disagree", { version: "1.0.0" }, async ({ world: w, preparedRelease }) => {
    writeFileSync(join(w.clone, "Cargo.toml"), '[package]\nname = "demo"\nversion = "2.0.0"\n');
    await git(w.clone, "add", ".");
    await git(w.clone, "commit", "-q", "-m", "cargo");
    await git(w.clone, "push", "-q", w.remote, "main");
    const [task] = await preparedRelease();
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("the version files disagree (package.json says 1.0.0, Cargo.toml says 2.0.0)");
    expect(w.github().releases).toEqual([]);
  }));

  it("reads only the product's main version files for the first release", () => world("main-files-first", {}, async ({ world: w, preparedRelease }) => {
    // Subfolders and other files are the reviewers' to check: they do not decide the version.
    await commitFiles(w, { "package.json": pkg("0.3.0"), "src-tauri/tauri.conf.json": pkg("0.3.0"), VERSION: "0.9.0\n", "apps/desktop/package.json": pkg("0.9.0") });
    const [task] = await preparedRelease();
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v0.3.0");
  }));

  it("sets the version itself in every main version file, and nowhere else", () => world("main-files", { version: "1.4.0" }, async ({ world: w, preparedRelease }) => {
    const tauri = "src-tauri/tauri.conf.json";
    await commitFiles(w, { [tauri]: pkg("1.4.0"), "test/fixtures/old/package.json": pkg("9.9.9"), "apps/desktop/package.json": pkg("1.4.0") });
    await release(w, "v1.4.0", (await remoteRef(w.remote, "refs/heads/main"))!);
    const [task] = await preparedRelease();
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v1.4.1");
    const tagged = (await remoteRef(w.remote, "refs/tags/v1.4.1"))!;
    for (const file of ["package.json", tauri]) expect(JSON.parse(await git(w.clone, "show", `${tagged}:${file}`)).version).toBe("1.4.1");
    // A fixture and a package in a subfolder keep theirs, and the version commit changes nothing else.
    expect(JSON.parse(await git(w.clone, "show", `${tagged}:test/fixtures/old/package.json`)).version).toBe("9.9.9");
    expect(JSON.parse(await git(w.clone, "show", `${tagged}:apps/desktop/package.json`)).version).toBe("1.4.0");
    expect((await git(w.clone, "diff", "--name-only", `${tagged}^`, tagged)).split("\n").sort()).toEqual(["package.json", tauri]);
    expect(await git(w.clone, "show", `${tagged}:package.json`)).toBe(pkg("1.4.1").trim());
  }));

  it("sets Cargo.toml's version and the product's own entry in Cargo.lock, never a dependency's", () => world("cargo", { version: "1.4.0" }, async ({ world: w, preparedRelease }) => {
    await commitFiles(w, {
      "Cargo.toml": '[package]\nname = "demo"\nversion = "1.4.0" # the product\n\n[dependencies]\nserde = "1"\n',
      "Cargo.lock": 'version = 3\n\n[[package]]\nname = "demo"\nversion = "1.4.0"\n\n[[package]]\nname = "serde"\nversion = "1.4.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n',
    });
    await release(w, "v1.4.0", (await remoteRef(w.remote, "refs/heads/main"))!);
    const [task] = await preparedRelease();
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v1.4.1");
    const tagged = (await remoteRef(w.remote, "refs/tags/v1.4.1"))!;
    expect(await git(w.clone, "show", `${tagged}:Cargo.toml`)).toBe('[package]\nname = "demo"\nversion = "1.4.1" # the product\n\n[dependencies]\nserde = "1"');
    const lock = await git(w.clone, "show", `${tagged}:Cargo.lock`);
    expect(lock).toContain('name = "demo"\nversion = "1.4.1"');
    expect(lock).toContain('name = "serde"\nversion = "1.4.0"');
  }));

  it("stops, publishing nothing, when it cannot set the version in a main version file on its own", () => world("cargo-inline", { version: "1.4.0" }, async ({ world: w, preparedRelease }) => {
    await commitFiles(w, { "Cargo.toml": 'package = { name = "demo", version = "1.4.0" }\n' });
    await release(w, "v1.4.0", (await remoteRef(w.remote, "refs/heads/main"))!);
    const before = await remoteRef(w.remote, "refs/heads/main");
    const [task] = await preparedRelease();
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("Petrina could not set the version to 1.4.1: Cargo.toml does not state it in a way Petrina can change on its own. It published nothing.");
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.4.0"]);
    expect(await remoteRef(w.remote, "refs/tags/v1.4.1")).toBeUndefined();
    expect(await remoteRef(w.remote, "refs/heads/main")).toBe(before);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  }));

  it("stops when a main version file has a version Petrina cannot read", () => world("unreadable", { version: "1.4.0" }, async ({ world: w, preparedRelease }) => {
    await commitFiles(w, { "Cargo.toml": '[package]\nname = "demo"\nversion = "1.4"\n' });
    const [task] = await preparedRelease();
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("Petrina cannot read the version in Cargo.toml");
    expect(w.github().releases).toEqual([]);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  }));

  it("never picks a first-release version when the login cannot see the repository, though GitHub says 'not found'", () => world("hidden", { version: "1.4.0" }, async ({ world: w, preparedRelease }) => {
    w.setGitHub((github) => (github.hidden = true));
    const [task] = await preparedRelease();
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("cannot see acme/demo");
    expect(task!.shipping?.version).toBeUndefined();
    expect(w.script().releaseManagerPrompts).toBeUndefined();
    expect(await remoteRef(w.remote, "refs/tags/v1.4.0")).toBeUndefined();
    expect(await remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
  }));

  it("stops when the version files do not follow the latest release", () => world("off", { version: "2.0.0" }, async ({ world: w, preparedRelease }) => {
    await release(w, "v1.2.0", w.initial);
    const [task] = await preparedRelease();
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("The latest release is v1.2.0, but the version files say otherwise (package.json says 2.0.0)");
    expect(await remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.2.0"]);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  }));

  it("stops rather than skip a version when the new tag is already on GitHub", () => world("occupied", {}, async ({ world: w, preparedRelease }) => {
    await release(w, "v1.0.0", w.initial);
    await gitWith({}, "--git-dir", w.remote, "update-ref", "refs/tags/v1.0.1", w.initial);
    const [task] = await preparedRelease();
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("The tag v1.0.1 already exists on GitHub");
    expect(await remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.0.0"]);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  }));
});
