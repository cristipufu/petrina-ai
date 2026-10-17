// Petrina publishes deliveries itself: it pushes, opens the pull request with the builder's description, sets a
// release's version and creates the release, or moves main forward, checked on GitHub or in the main copy before
// it says so. The only agent at delivery is the Release Manager, writing a release's notes across everything since
// the previous release.
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { coordinator, finish, git, itemOf, makeWorld, removeDir, REPO, remoteRef, taskOf, until, type World } from "./support.js";

const worlds: World[] = [];
const world = (...args: Parameters<typeof makeWorld>) => {
  const made = makeWorld(...args);
  worlds.push(made);
  return made;
};
afterAll(() => {
  for (const made of worlds) removeDir(made.dir);
});

/** Every gh call was pinned to the product's repository, and none could merge. */
function pinned(w: World): void {
  for (const call of w.github().calls) {
    // `gh repo view` names the repository itself.
    if (call[0] === "repo") expect(call.slice(0, 3)).toEqual(["repo", "view", REPO]);
    else expect(call.slice(-2)).toEqual(["--repo", REPO]);
    expect(call).not.toContain("merge");
  }
}

/** The Release Manager never ran on this task. */
const noReleaseManager = (task: Task) => expect(task.timeline.some((entry) => entry.roleId === "release-manager" || entry.text === "Release Manager started")).toBe(false);

/** A release on GitHub at `at`, as a teammate published it. */
function released(w: World, tag: string, at: string): void {
  execFileSync("git", ["--git-dir", w.remote, "update-ref", `refs/tags/${tag}`, at]);
  w.setGitHub((github) => github.releases.push({ tagName: tag, url: `https://github.com/${REPO}/releases/tag/${tag}`, publishedAt: "2026-01-01T00:00:00Z", isDraft: false, name: tag, body: "" }));
}

/** Another task's commit landing on main on GitHub, with Petrina's kind of message. */
function landed(w: World, title: string, change: string): void {
  const file = `${title.toLowerCase().replace(/\W+/g, "-")}.txt`;
  writeFileSync(join(w.clone, file), `${title}\n`);
  git(w.clone, "add", file);
  git(w.clone, "commit", "-q", "-m", `${title}\n\nWhat it does.\n\n- ${change}\n\nBuilt by Petrina: Builder on Claude Code`);
  git(w.clone, "push", "-q", w.remote, "main");
}

/** A file as checked out, in one line-ending style: git on Windows writes CRLF. */
const checkedOut = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe.concurrent("Petrina publishes deliveries itself", () => {
  it("opens a pull request with no agent: the builder's title and description, as text, then Petrina's own part", async () => {
    const w = world("pr");
    const marker = join(w.dir, "pwned");
    const title = `$(touch ${marker}) --help; rm -rf ~ \`id\``;
    const description = `--base evil\n$(touch ${marker})\n\`touch ${marker}\` && echo done; | cat /etc/passwd`;
    w.setScript((script) => {
      script.title = title;
      script.description = description;
      script.envOut = join(w.dir, "builder-env.json");
    });
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      const product = engine.getState().products.find((entry) => entry.id === productId)!;
      expect(product.repo).toBe(REPO);
      expect(product.remote).toBe("https://github.com/acme/demo.git");
      engine.setProductDelivery(productId, "pull-request", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("pr-open");
      expect(task.column).toBe("ready");
      expect(task.pr).toMatchObject({ number: 1, url: `https://github.com/${REPO}/pull/1`, state: "open" });
      expect(task.statusLine).toBe("Pull request #1 is open. Merge it on GitHub when you are happy");
      expect(task.shipping).toBeUndefined();

      // The exact checked commit went out on the task's branch, as the task's one commit; main on GitHub did not move.
      const tested = git(task.worktree!, "rev-parse", "HEAD");
      expect(remoteRef(w.remote, `refs/heads/${task.branch}`)).toBe(tested);
      expect(git(task.worktree!, "rev-parse", `${tested}^`)).toBe(w.initial);
      expect(remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
      const [pr] = w.github().prs;
      expect(pr).toMatchObject({ headRefName: task.branch, baseRefName: "main", headRefOid: tested, state: "OPEN", title });
      // The builder's description first, then what Petrina saw for itself.
      expect(pr!.body.startsWith(`${description}\n\n## Checked by Petrina`)).toBe(true);
      expect(pr!.body).toContain("### Checks Petrina ran on this commit\n- Version: passed (`git --version`)");
      expect(pr!.body).toMatch(/### Reviewed by\n- Code reviewer on /);
      expect(existsSync(marker)).toBe(false);
      pinned(w);

      // No agent at delivery: the delivery check, then Petrina's own steps.
      noReleaseManager(task);
      const texts = task.timeline.map((entry) => entry.text);
      expect(texts.indexOf("You approved the delivery")).toBeGreaterThan(-1);
      expect(texts).toContain(`Ready to publish: ${tested.slice(0, 7)}, with the builder's description`);
      expect(texts).toContain(`Petrina pushed the branch at ${tested.slice(0, 7)}`);
      expect(texts).toContain("Petrina opened pull request #1, and checked it on GitHub");
      expect(task.timeline.find((entry) => entry.text.startsWith("Petrina opened"))?.roleId).toBeUndefined();
      expect(task.approvedFor).toEqual({ by: "coordinator", mode: "pull-request", destination: `${REPO}#main` });

      // Agents run in the coordinator's own environment: nothing waiting for a typed answer, in the background.
      const env = JSON.parse(readFileSync(join(w.dir, "builder-env.json"), "utf8"));
      expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", BROWSER: "none", PETRINA_AGENT: "1" });
      expect(env.GH_CONFIG_DIR).toBe(process.env.GH_CONFIG_DIR);
      expect(env.GIT_SSH_COMMAND).toBe(process.env.GIT_SSH_COMMAND);
      // Git's credential helpers as the coordinator set them up, none reset.
      let helper = "(none)";
      try {
        helper = execFileSync("git", ["config", "--get-all", "credential.helper"], { cwd: task.worktree! }).toString();
      } catch {}
      expect(env.helper).toBe(helper);
    } finally {
      engine.shutdown();
    }
  });

  it("writes a pull request's description from the builder's report when the builder gave none, with the design's acceptance checklist", async () => {
    const w = world("pr-template");
    w.setScript((script) => (script.description = ""));
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "pull-request", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file." });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("pr-open");
      expect(w.github().prs[0]!.title).toBe("Add a greeting");
      expect(w.github().prs[0]!.body.startsWith("Added a greeting.\n\n## What changed for users\n- People see a greeting\n\n## Checked by Petrina")).toBe(true);
      // Listed as the design has it: ticked only where a tester checked it.
      expect(w.github().prs[0]!.body).toContain("### Acceptance\n- A greeting file exists");
      expect(task.timeline.map((entry) => entry.text)).toContain(`Ready to publish: ${git(task.worktree!, "rev-parse", "HEAD").slice(0, 7)}, with a description from the builder's report`);
    } finally {
      engine.shutdown();
    }
  });

  it("releases everything since the previous release: Petrina sets the version, the Release Manager's notes cover every change", async () => {
    const w = world("release", { version: "1.4.0" });
    // The latest release is v1.4.0 on the first commit; this product bumps the minor number. Two other tasks landed since.
    released(w, "v1.4.0", w.initial);
    landed(w, "Faster search", "Search answers in a blink");
    landed(w, "Fix the login loop", "Signing in on Safari works again");
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "release", false);
      (engine.getState().products.find((entry) => entry.id === productId) as { releaseBump?: string }).releaseBump = "minor";
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const state = await finish(engine, taskId);
      const task = taskOf(state, taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      expect(task.statusLine).toBe("Released v1.5.0");
      expect(task.release).toEqual({ tag: "v1.5.0", url: `https://github.com/${REPO}/releases/tag/v1.5.0` });
      // No delivery check was asked for: the task's own setting was the permission.
      expect(task.timeline.some((entry) => entry.text === "You approved the delivery")).toBe(false);
      expect(state.inbox.some((item) => item.kind === "delivery")).toBe(false);

      // The Release Manager read every commit since v1.4.0, the task's own included, and its notes cover them all.
      const [prompt] = w.script().releaseManagerPrompts!;
      expect(prompt).toContain("You are the Release Manager in Petrina");
      expect(prompt).toContain("## Every commit on main since v1.4.0, oldest first (3)");
      expect(prompt).toContain("### Faster search\nWhat it does.\n\n- Search answers in a blink");
      expect(prompt).toContain("### Fix the login loop");
      expect(prompt).toContain("### Add a greeting\nAdded a greeting.\n\n- People see a greeting");
      expect(prompt).not.toContain("### init");
      const release = w.github().releases.find((entry) => entry.tagName === "v1.5.0")!;
      expect(release.body).toBe("## What's new\n- Faster search\n- Fix the login loop\n- Add a greeting");

      // What went out is Petrina's version commit on top of the task's one commit; main and the tag both point at it.
      const tested = git(task.worktree!, "rev-parse", "HEAD");
      expect(JSON.parse(git(task.worktree!, "show", `${tested}:package.json`)).version).toBe("1.5.0");
      expect(git(task.worktree!, "diff", "--name-only", `${tested}^`, tested)).toBe("package.json");
      expect(git(task.worktree!, "log", "-1", "--format=%s", tested)).toBe("Release v1.5.0");
      expect(remoteRef(w.remote, "refs/heads/main")).toBe(tested);
      expect(remoteRef(w.remote, "refs/tags/v1.5.0")).toBe(tested);
      expect(w.github().calls.some((call) => call[0] === "release" && call[1] === "create" && call.includes("--verify-tag"))).toBe(true);
      pinned(w);
      const texts = task.timeline.map((entry) => entry.text);
      expect(texts).toContain("Getting the release ready: Petrina sets the version to 1.5.0");
      expect(texts).toContain(`Petrina pushed main and the tag v1.5.0 at ${tested.slice(0, 7)}`);
      expect(texts).toContain("Petrina published release v1.5.0, and checked it on GitHub");
      // The checks ran again on the version commit before it went out.
      expect(task.checks?.sha).toBe(tested);
    } finally {
      engine.shutdown();
    }
  });

  it("undoes whatever the Release Manager commits: it writes the notes and nothing else", async () => {
    const w = world("release-manager-commits");
    w.setScript((script) => (script.releaseManagerCommits = true));
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "release", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.error).toBeUndefined();
      expect(task.release?.tag).toBe("v0.1.0");
      expect(task.timeline.map((entry) => entry.text)).toContain("Undid commits from Release Manager, which is read-only");
      const tagged = remoteRef(w.remote, "refs/tags/v0.1.0")!;
      expect(git(w.clone, "ls-tree", "--name-only", tagged)).not.toContain("notes-draft.md");
      expect(git(w.clone, "log", "--format=%s", tagged)).not.toContain("A draft of the notes");
    } finally {
      engine.shutdown();
    }
  });

  it("commits to main locally with no agent: moves main forward to the checked commit with no network, and the main copy's files with it", async () => {
    const w = world("local");
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      const tested = git(task.worktree!, "rev-parse", "HEAD");
      // Exactly the checked commit, no merge commit of Petrina's, and the files are there.
      expect(git(w.clone, "rev-parse", "main")).toBe(tested);
      expect(task.landed).toEqual({ branch: "main", sha: tested.slice(0, 7) });
      expect(checkedOut(join(w.clone, "greeting.txt"))).toBe("Hello (with left-pad)\n");
      expect(git(w.clone, "status", "--porcelain")).toBe("");
      // Nothing touched GitHub, and no agent ran at delivery.
      expect(w.github().calls).toEqual([]);
      noReleaseManager(task);
      expect(w.script().releaseManagerPrompts).toBeUndefined();
      expect(remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
      expect(task.timeline.map((entry) => entry.text)).toContain(`Petrina moved main forward to it (${tested.slice(0, 7)}), and checked the main copy`);
    } finally {
      engine.shutdown();
    }
  });

  it("moves main locally while the main copy has another branch checked out, leaving that branch's files alone", async () => {
    const w = world("local-elsewhere");
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      git(w.clone, "switch", "-q", "-c", "notes");
      writeFileSync(join(w.clone, "notes.txt"), "mine\n");
      engine.setProductDelivery(productId, "local", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      expect(git(w.clone, "rev-parse", "main")).toBe(git(task.worktree!, "rev-parse", "HEAD"));
      expect(git(w.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("notes");
      expect(existsSync(join(w.clone, "greeting.txt"))).toBe(false);
      expect(checkedOut(join(w.clone, "notes.txt"))).toBe("mine\n");
    } finally {
      engine.shutdown();
    }
  });

  it("stops before moving main when the main copy has uncommitted changes or main is checked out elsewhere", async () => {
    const w = world("local-unsafe");
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "local", false);
      writeFileSync(join(w.clone, "README.md"), "# Mine, not committed\n");
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      let task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain("has changes that are not committed");
      expect(git(w.clone, "rev-parse", "main")).toBe(w.initial);
      expect(checkedOut(join(w.clone, "README.md"))).toBe("# Mine, not committed\n");

      // main checked out in another folder: still nothing moves.
      git(w.clone, "checkout", "-q", "--", "README.md");
      git(w.clone, "switch", "-q", "-c", "other");
      git(w.clone, "worktree", "add", "-q", join(w.dir, "elsewhere"), "main");
      const first = task.error;
      engine.retry(itemOf(engine.getState(), taskId, "stuck")!.id);
      task = taskOf(await until(engine, (state) => taskOf(state, taskId).state === "failed" && taskOf(state, taskId).error !== first), taskId);
      expect(task.error).toContain("is checked out in another folder");
      expect(git(w.clone, "rev-parse", "main")).toBe(w.initial);

      // Free again: Retry publishes the same checked commit.
      git(w.clone, "worktree", "remove", join(w.dir, "elsewhere"));
      engine.retry(itemOf(engine.getState(), taskId, "stuck")!.id);
      task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("done");
      expect(git(w.clone, "rev-parse", "main")).toBe(git(task.worktree!, "rev-parse", "HEAD"));
    } finally {
      engine.shutdown();
    }
  });

  it("publishes nothing when the checks fail with the version set, goes back to the builder, and stops after the second time", async () => {
    const w = world("version-fails", { version: "1.4.0" });
    released(w, "v1.4.0", w.initial);
    // A check that pins the version: it passes on the work, and fails once Petrina sets the new version.
    w.setScript((script) => (script.checks = [{ name: "Pinned", argv: ["git", "grep", "-q", "--fixed-strings", '"version": "1.4.0"', "--", "package.json"], why: "A check that pins the version, for tests" }]));
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "release", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      let task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain("Getting the delivery ready failed 2 times");
      const texts = task.timeline.map((entry) => entry.text);
      const back = texts.findIndex((text) => text.startsWith("Not ready to publish: The product's checks fail with the version set to 1.4.1."));
      expect(back).toBeGreaterThan(-1);
      // Back through the builder and the review, with a blocking finding, and the approval gone.
      expect(task.timeline.slice(back).some((entry) => entry.roleId === "builder" && entry.tone === "milestone")).toBe(true);
      expect(task.findings.some((finding) => finding.raisedBy === "petrina" && finding.severity === "blocking" && finding.text.startsWith("Getting the delivery ready failed"))).toBe(true);
      expect(task.approvedFor).toBeUndefined();
      // Nothing was published, the version change is gone, and no notes were written for it.
      expect(remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
      expect(remoteRef(w.remote, "refs/tags/v1.4.1")).toBeUndefined();
      expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v1.4.0"]);
      expect(JSON.parse(readFileSync(join(task.worktree!, "package.json"), "utf8")).version).toBe("1.4.0");
      expect(w.script().releaseManagerPrompts).toBeUndefined();
      // Try again sends it back to the builder once more; it still publishes nothing while the check pins the version.
      engine.retry(itemOf(engine.getState(), taskId, "stuck")!.id);
      task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("failed");
      expect(w.github().releases).toHaveLength(1);
    } finally {
      engine.shutdown();
    }
  });

  it("asks again when where it goes changes after the coordinator approved", async () => {
    const w = world("destination");
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "pull-request", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      let state = await until(engine, (current) => !!itemOf(current, taskId, "delivery"), coordinator(["plan", "design"]));
      engine.setPoolPaused(true);
      engine.approve(itemOf(state, taskId, "delivery")!.id);
      expect(taskOf(engine.getState(), taskId).approvedFor).toEqual({ by: "coordinator", mode: "pull-request", destination: `${REPO}#main` });
      // The product's default branch changes before anything gets ready.
      (engine.getState().products.find((entry) => entry.id === productId) as { defaultBranch?: string }).defaultBranch = "trunk";
      engine.setPoolPaused(false);
      state = await until(engine, (current) => !!itemOf(current, taskId, "delivery"), coordinator(["plan", "design"]));
      const task = taskOf(state, taskId);
      expect(task.timeline.map((entry) => entry.text)).toContain("Where it goes changed after it was approved, so it needs your OK again");
      expect(task.approvedFor).toBeUndefined();
      expect(w.github().calls.filter((call) => call[1] === "create")).toEqual([]);
      engine.cancel(taskId);
    } finally {
      engine.shutdown();
    }
  });
});
