import { legacyDeliveryAgents } from "../../fixtures/legacy-delivery-agents.js";
// Release versions: worked out by Petrina at publish time from the latest release and the product's main
// version files, set by Petrina itself in a version commit of its own, and checked before anything goes out.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { coordinator, finish, git, gitWith, itemOf, makeWorld, removeDir, remoteRef, taskOf, until, type World } from "../../support.js";

const worlds: World[] = [];
const world = async (...args: Parameters<typeof makeWorld>) => {
  const made = await makeWorld(...args);
  worlds.push(made);
  return made;
};
afterAll(() => {
  for (const made of worlds) removeDir(made.dir);
});

const release = async (w: World, tag: string, at: string) => {
  await gitWith({}, "--git-dir", w.remote, "update-ref", `refs/tags/${tag}`, at);
  w.setGitHub((github) => github.releases.push({ tagName: tag, url: `https://github.com/acme/demo/releases/tag/${tag}`, publishedAt: new Date().toISOString(), isDraft: false, name: tag, body: "" }));
};

const pkg = (version: string) => `${JSON.stringify({ name: "demo", version }, null, 2)}\n`;

/** Files committed on main and pushed to the stand-in GitHub. */
const commitFiles = async (w: World, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(w.clone, file)), { recursive: true });
    writeFileSync(join(w.clone, file), text);
  }
  await git(w.clone, "add", ".");
  await git(w.clone, "commit", "-q", "-m", "Version files");
  await git(w.clone, "push", "-q", w.remote, "main");
};

async function deliver(w: World, mode: "release" | "local" | "pull-request", count = 1) {
  const engine = w.start(legacyDeliveryAgents(w));
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
    await engine.shutdown();
  }
}


describe.concurrent("Release versions on real deliveries", () => {
it("starts at 0.1.0 with no version files, and two release tasks get the next free version each, with notes on what each ships", async () => {
    const w = await world("first-release");
    w.setScript((script) => (script.ownFiles = true));
    const [first, second] = await deliver(w, "release", 2);
    expect(first!.error).toBeUndefined();
    expect(first!.release?.tag).toBe("v0.1.0");
    expect(second!.error).toBeUndefined();
    expect(second!.release?.tag).toBe("v0.1.1");
    // No version files: what went out is the task's own commit, and the tags sit on main's history.
    const firstTag = (await remoteRef(w.remote, "refs/tags/v0.1.0"))!;
    const secondTag = (await remoteRef(w.remote, "refs/tags/v0.1.1"))!;
    expect(await remoteRef(w.remote, "refs/heads/main")).toBe(secondTag);
    expect(await git(w.clone, "merge-base", "--is-ancestor", firstTag, secondTag)).toBe("");
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
    const w = await world("declared", { version: "1.4.0" });
    const [task] = await deliver(w, "release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v1.4.0");
    expect(JSON.parse(await git(w.clone, "show", `${await remoteRef(w.remote, "refs/tags/v1.4.0")}:package.json`)).version).toBe("1.4.0");
  });

it("stops when the version files disagree before the first release", async () => {
    const w = await world("disagree", { version: "1.0.0" });
    writeFileSync(join(w.clone, "Cargo.toml"), '[package]\nname = "demo"\nversion = "2.0.0"\n');
    await git(w.clone, "add", ".");
    await git(w.clone, "commit", "-q", "-m", "cargo");
    await git(w.clone, "push", "-q", w.remote, "main");
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("the version files disagree (package.json says 1.0.0, Cargo.toml says 2.0.0)");
    expect(w.github().releases).toEqual([]);
  });

it("reads only the product's main version files for the first release", async () => {
    const w = await world("main-files-first");
    // Subfolders and other files are the reviewers' to check: they do not decide the version.
    await commitFiles(w, { "package.json": pkg("0.3.0"), "src-tauri/tauri.conf.json": pkg("0.3.0"), VERSION: "0.9.0\n", "apps/desktop/package.json": pkg("0.9.0") });
    const [task] = await deliver(w, "release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v0.3.0");
  });

it("sets the version itself in every main version file, and nowhere else", async () => {
    const w = await world("main-files", { version: "1.4.0" });
    const tauri = "src-tauri/tauri.conf.json";
    await commitFiles(w, { [tauri]: pkg("1.4.0"), "test/fixtures/old/package.json": pkg("9.9.9"), "apps/desktop/package.json": pkg("1.4.0") });
    await release(w, "v1.4.0", (await remoteRef(w.remote, "refs/heads/main"))!);
    const [task] = await deliver(w, "release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v1.4.1");
    const tagged = (await remoteRef(w.remote, "refs/tags/v1.4.1"))!;
    for (const file of ["package.json", tauri]) expect(JSON.parse(await git(w.clone, "show", `${tagged}:${file}`)).version).toBe("1.4.1");
    // A fixture and a package in a subfolder keep theirs, and the version commit changes nothing else.
    expect(JSON.parse(await git(w.clone, "show", `${tagged}:test/fixtures/old/package.json`)).version).toBe("9.9.9");
    expect(JSON.parse(await git(w.clone, "show", `${tagged}:apps/desktop/package.json`)).version).toBe("1.4.0");
    expect((await git(w.clone, "diff", "--name-only", `${tagged}^`, tagged)).split("\n").sort()).toEqual(["package.json", tauri]);
    expect(await git(w.clone, "show", `${tagged}:package.json`)).toBe(pkg("1.4.1").trim());
  });

it("sets Cargo.toml's version and the product's own entry in Cargo.lock, never a dependency's", async () => {
    const w = await world("cargo", { version: "1.4.0" });
    await commitFiles(w, {
      "Cargo.toml": '[package]\nname = "demo"\nversion = "1.4.0" # the product\n\n[dependencies]\nserde = "1"\n',
      "Cargo.lock": 'version = 3\n\n[[package]]\nname = "demo"\nversion = "1.4.0"\n\n[[package]]\nname = "serde"\nversion = "1.4.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n',
    });
    await release(w, "v1.4.0", (await remoteRef(w.remote, "refs/heads/main"))!);
    const [task] = await deliver(w, "release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v1.4.1");
    const tagged = (await remoteRef(w.remote, "refs/tags/v1.4.1"))!;
    expect(await git(w.clone, "show", `${tagged}:Cargo.toml`)).toBe('[package]\nname = "demo"\nversion = "1.4.1" # the product\n\n[dependencies]\nserde = "1"');
    const lock = await git(w.clone, "show", `${tagged}:Cargo.lock`);
    expect(lock).toContain('name = "demo"\nversion = "1.4.1"');
    expect(lock).toContain('name = "serde"\nversion = "1.4.0"');
  });

it("stops, publishing nothing, when it cannot set the version in a main version file on its own", async () => {
    const w = await world("cargo-inline", { version: "1.4.0" });
    await commitFiles(w, { "Cargo.toml": 'package = { name = "demo", version = "1.4.0" }\n' });
    await release(w, "v1.4.0", (await remoteRef(w.remote, "refs/heads/main"))!);
    const before = await remoteRef(w.remote, "refs/heads/main");
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("Petrina could not set the version to 1.4.1: Cargo.toml does not state it in a way Petrina can change on its own. It published nothing.");
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.4.0"]);
    expect(await remoteRef(w.remote, "refs/tags/v1.4.1")).toBeUndefined();
    expect(await remoteRef(w.remote, "refs/heads/main")).toBe(before);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  });

it("stops when a main version file has a version Petrina cannot read", async () => {
    const w = await world("unreadable", { version: "1.4.0" });
    await commitFiles(w, { "Cargo.toml": '[package]\nname = "demo"\nversion = "1.4"\n' });
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("Petrina cannot read the version in Cargo.toml");
    expect(w.github().releases).toEqual([]);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  });

it("never picks a first-release version when the login cannot see the repository, though GitHub says 'not found'", async () => {
    const w = await world("hidden", { version: "1.4.0" });
    w.setGitHub((github) => (github.hidden = true));
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("cannot see acme/demo");
    expect(task!.shipping?.version).toBeUndefined();
    expect(w.script().releaseManagerPrompts).toBeUndefined();
    expect(await remoteRef(w.remote, "refs/tags/v1.4.0")).toBeUndefined();
    expect(await remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
  });

it("stops when the version files do not follow the latest release", async () => {
    const w = await world("off", { version: "2.0.0" });
    await release(w, "v1.2.0", w.initial);
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("The latest release is v1.2.0, but the version files say otherwise (package.json says 2.0.0)");
    expect(await remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.2.0"]);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  });

it("stops rather than skip a version when the new tag is already on GitHub", async () => {
    const w = await world("occupied");
    await release(w, "v1.0.0", w.initial);
    await gitWith({}, "--git-dir", w.remote, "update-ref", "refs/tags/v1.0.1", w.initial);
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("The tag v1.0.1 already exists on GitHub");
    expect(await remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.0.0"]);
    expect(w.script().releaseManagerPrompts).toBeUndefined();
  });

it("works the version and the notes out again when a release comes out before its push", async () => {
    const w = await world("meanwhile", { version: "0.1.0" });
    // A teammate publishes v0.1.0 as Petrina looks for this delivery's release, right after getting it ready.
    w.setGitHub((github) => (github.meanwhile = { command: "release view", withTag: true, times: 1, release: "v0.1.0" }));
    const [task] = await deliver(w, "release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v0.1.1");
    const prompts = w.script().releaseManagerPrompts!;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("## Every commit on main since v0.1.0, oldest first (1)");
    const tested = (await remoteRef(w.remote, "refs/tags/v0.1.1"))!;
    expect(JSON.parse(await git(w.clone, "show", `${tested}:package.json`)).version).toBe("0.1.1");
    expect(await git(w.clone, "log", "-1", "--format=%s", tested)).toBe("Release v0.1.1");
    expect(task!.timeline.map((entry) => entry.text)).toContain("main moved on GitHub, so Petrina gets it ready again (1 of 3)");
  });

it("gets a release ready again when main moves before its push, but not a pull request", async () => {
    const releasing = await world("moved-release");
    releasing.setGitHub((github) => (github.meanwhile = { command: "release view", withTag: true, times: 1 }));
    const [r] = await deliver(releasing, "release");
    expect(r!.release?.tag).toBe("v0.1.0");
    expect(releasing.script().releaseManagerPrompts).toHaveLength(2);
    expect(await remoteRef(releasing.remote, "refs/heads/main")).toBe(await remoteRef(releasing.remote, "refs/tags/v0.1.0"));
    // On top of the teammate's change, as one commit: a fast-forward, never a merge.
    expect(await git(releasing.clone, "log", "-1", "--format=%s", `${await remoteRef(releasing.remote, "refs/heads/main")}^`)).toBe("A teammate's change");

    const pr = await world("moved-pr");
    pr.setGitHub((github) => (github.meanwhile = { command: "pr list", times: 1 }));
    const [p] = await deliver(pr, "pull-request");
    expect(p!.state).toBe("pr-open");
    expect(pr.script().releaseManagerPrompts).toBeUndefined();
  });

it("brings local delivery up to date when main moved after the delivery check, and moves main forward on top of it", async () => {
    const w = await world("moved-local");
    const engine = w.start(legacyDeliveryAgents(w));
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const state = await until(engine, (current) => !!itemOf(current, taskId, "delivery"), coordinator(["plan", "design"]));
      // A teammate's commit lands on the main copy's main before the coordinator says yes.
      await git(w.clone, "commit", "-q", "--allow-empty", "-m", "A teammate's change");
      engine.approve(itemOf(state, taskId, "delivery")!.id);
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("done");
      expect(task.timeline.map((entry) => entry.text)).toContain("Brought up to date with main (1 new commit there), with no conflicts");
      expect(await git(w.clone, "log", "-1", "--format=%s", "main^")).toBe("A teammate's change");
      expect(await git(w.clone, "rev-list", "--merges", "--count", "main")).toBe("0");
    } finally {
      await engine.shutdown();
    }
  });

it("stops after three new preparations when main keeps moving", async () => {
    const w = await world("keeps-moving");
    w.setGitHub((github) => (github.meanwhile = { command: "release view", withTag: true, times: 4 }));
    const [task] = await deliver(w, "release");
    expect(task!.state).toBe("failed");
    expect(task!.error).toContain("main kept moving while Petrina was delivering, so it stopped after 3 new preparations");
    expect(w.script().releaseManagerPrompts).toHaveLength(4);
    expect(w.github().releases).toEqual([]);
    expect(await remoteRef(w.remote, "refs/tags/v0.1.0")).toBeUndefined();
  });
});
