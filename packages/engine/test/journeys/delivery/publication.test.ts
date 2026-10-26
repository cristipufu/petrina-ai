import { acmeDemoProduct, installPreparedProduct } from "../../fixtures/prepared-product.js";
import { queuePreparedDelivery } from "../../fixtures/queued-delivery.js";
// Petrina publishes deliveries itself: it pushes, opens the pull request with the builder's description, sets a
// release's version and creates the release, or moves main forward, checked on GitHub or in the main copy before
// it says so. The only agent at delivery is the Release Manager, writing a release's notes across everything since
// the previous release.
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLEANUP_WORDS, slotUses, type DeliveryMode, type Task } from "@petrina/core";
import { coordinator, finish, git, gitWith, itemOf, REPO, remoteRef, runGit, taskOf, until } from "../../support.js";
import type { Engine } from "../../engine.js";
import { nativeWorldFixtures, type NativeWorld } from "../../fixtures/native-worlds.js";
const fixtures = nativeWorldFixtures();
afterAll(fixtures.close);

/** Every gh call was pinned to the product's repository, and none could merge. */
function pinned(w: NativeWorld): void {
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
async function released(w: NativeWorld, tag: string, at: string): Promise<void> {
  await gitWith({}, "--git-dir", w.remote, "update-ref", `refs/tags/${tag}`, at);
  w.setGitHub((github) => github.releases.push({ tagName: tag, url: `https://github.com/${REPO}/releases/tag/${tag}`, publishedAt: "2026-01-01T00:00:00Z", isDraft: false, name: tag, body: "" }));
}

/** Another task's commit landing on main on GitHub, with Petrina's kind of message. */
async function landed(w: NativeWorld, title: string, change: string): Promise<void> {
  const file = `${title.toLowerCase().replace(/\W+/g, "-")}.txt`;
  writeFileSync(join(w.clone, file), `${title}\n`);
  await git(w.clone, "add", file);
  await git(w.clone, "commit", "-q", "-m", `${title}\n\nWhat it does.\n\n- ${change}\n\nBuilt by Petrina: Builder on Claude Code`);
  await git(w.clone, "push", "-q", w.remote, "main");
}

/** A file as checked out, in one line-ending style: git on Windows writes CRLF. */
const checkedOut = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** One task at its delivery check, while another task's builder fills the only agent slot. */
async function busyDelivery(w: NativeWorld, engine: Engine, delivery: DeliveryMode) {
  try {
    engine.setPoolLimit(1);
    const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
    engine.setProductDelivery(productId, delivery, true);
    const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
    const state = await until(engine, (current) => !!itemOf(current, taskId, "delivery"), coordinator(["plan", "design"]));
    const approvalId = itemOf(state, taskId, "delivery")!.id;
    const hold = join(w.dir, "busy-builder");
    writeFileSync(hold, "");
    w.setScript((script) => (script.hold = { title: "Keep an agent busy", file: hold }));
    const busyId = engine.addTask({ productId, title: "Keep an agent busy", description: "A greeting file. [quick]" });
    await until(engine, () => existsSync(`${hold}.reached`), coordinator(["plan", "design"]));
    expect(slotUses(engine.getState())).toHaveLength(1);
    expect(taskOf(engine.getState(), busyId).agent?.roleId).toBe("builder");
    return { taskId, busyId, approvalId };
  } catch (error) {
    await engine.shutdown();
    throw error;
  }
}

describe.concurrent("Petrina publishes deliveries itself", () => {


  it("waits for agent capacity and an unpaused pool before writing release notes", async () => {
    let releasePeers = () => {};
    await fixtures.world("notes-pool", async ({ world: w, engine: ownedEngine }) => {
      releasePeers = () => { rmSync(join(w.dir, "busy-builder"), { force: true }); rmSync(join(w.dir, "busy-notes"), { force: true }); };
      await ownedEngine(async engine => {
      const { taskId, busyId, approvalId } = await busyDelivery(w, engine, "release");
    const notesHold = join(w.dir, "busy-notes");
    try {
      engine.approve(approvalId);
      expect(taskOf(engine.getState(), taskId).state).toBe("waiting");
      expect(taskOf(engine.getState(), taskId).statusLine).toBe("Waiting for a free slot");
      expect(w.script().releaseManagerPrompts).toBeUndefined();
      expect(w.github().releases).toHaveLength(0);
      engine.setPoolPaused(true);
      engine.cancel(busyId);
      expect(slotUses(engine.getState())).toHaveLength(0);
      expect(taskOf(engine.getState(), taskId).statusLine).toBe("Waiting for the pool to resume");
      writeFileSync(notesHold, "");
      w.setScript((script) => (script.hold = { title: "Add a greeting", file: notesHold, role: "release manager" }));
      engine.setPoolPaused(false);
      await until(engine, () => existsSync(`${notesHold}.reached`));
      expect(slotUses(engine.getState()).map((use) => use.roleId)).toEqual(["release-manager"]);
      expect(w.github().releases).toHaveLength(0);
      rmSync(notesHold);
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      expect(w.script().releaseManagerPrompts).toHaveLength(1);
      expect(w.github().releases).toHaveLength(1);
      expect(taskOf(engine.getState(), busyId).state).toBe("cancelled");
    } finally {
      await engine.shutdown();
    }

      });
    }, {}, { stopPeers: () => releasePeers() });
  });



  it("opens a pull request with no agent: the builder's title and description, as text, then Petrina's own part", async () => {
    await fixtures.world("pr", async ({ world: w, engine: ownedEngine }) => {
    const marker = join(w.dir, "pwned");
    // Keep the title valid even when the temporary folder has a long name. The
    // description below still checks that shell-like text cannot write the marker.
    const title = "--help; $(printf injected) `id`";
    const description = `--base evil\n$(touch ${marker})\n\`touch ${marker}\` && echo done; | cat /etc/passwd`;
    w.setScript((script) => {
      script.title = title;
      script.description = description;
      script.envOut = join(w.dir, "builder-env.json");
    });
      await ownedEngine(async engine => {
    try {
      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
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
      const tested = await git(w.clone, "rev-parse", task.branch!);
      expect(await remoteRef(w.remote, `refs/heads/${task.branch}`)).toBe(tested);
      expect(await git(task.worktree!, "rev-parse", `${tested}^`)).toBe(w.initial);
      expect(await remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
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
      const helpers = await runGit(["config", "--get-all", "credential.helper"], { cwd: task.worktree! });
      // Git says nothing and exits 1 only when no helper is set; any other answer fails the test.
      if (helpers.code !== 0 && (helpers.code !== 1 || helpers.stdout || helpers.stderr)) throw new Error(`git config --get-all credential.helper failed (${helpers.code}): ${helpers.stderr}`);
      expect(env.helper).toBe(helpers.code === 0 ? helpers.stdout : "(none)");
    } finally {
      await engine.shutdown();
    }

      });
    }, {});
  });

  it("writes a pull request's description from the builder's report when the builder gave none, with the design's acceptance checklist", async () => {
    await fixtures.world("pr-template", async ({ world: w, engine: ownedEngine }) => {
    w.setScript((script) => (script.description = ""));
      await ownedEngine(async engine => {
    try {
      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
      engine.setProductDelivery(productId, "pull-request", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file." });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("pr-open");
      expect(w.github().prs[0]!.title).toBe("Add a greeting");
      expect(w.github().prs[0]!.body.startsWith("Added a greeting.\n\n## What changed for users\n- People see a greeting\n\n## Checked by Petrina")).toBe(true);
      // Listed as the design has it: ticked only where a tester checked it.
      expect(w.github().prs[0]!.body).toContain("### Acceptance\n- A greeting file exists");
      expect(task.timeline.map((entry) => entry.text)).toContain(`Ready to publish: ${(await git(w.clone, "rev-parse", task.branch!)).slice(0, 7)}, with a description from the builder's report`);
    } finally {
      await engine.shutdown();
    }

      });
    }, {});
  });

  it("releases everything since the previous release: Petrina sets the version, the Release Manager's notes cover every change", async () => {
    await fixtures.world("release", async ({ world: w, engine: ownedEngine }) => {
    // The latest release is v1.4.0 on the first commit; this product bumps the minor number. Two other tasks landed since.
    await released(w, "v1.4.0", w.initial);
    await landed(w, "Faster search", "Search answers in a blink");
    await landed(w, "Fix the login loop", "Signing in on Safari works again");
      await ownedEngine(async engine => {
    try {
      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
      engine.setProductDelivery(productId, "release", false);
      (engine.getState().products.find((entry) => entry.id === productId) as { releaseBump?: string }).releaseBump = "minor";
      const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
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
      const tested = await git(w.clone, "rev-parse", task.branch!);
      expect(JSON.parse(await git(w.clone, "show", `${tested}:package.json`)).version).toBe("1.5.0");
      expect(await git(w.clone, "diff", "--name-only", `${tested}^`, tested)).toBe("package.json");
      expect(await git(w.clone, "log", "-1", "--format=%s", tested)).toBe("Release v1.5.0");
      expect(await remoteRef(w.remote, "refs/heads/main")).toBe(tested);
      expect(await remoteRef(w.remote, "refs/tags/v1.5.0")).toBe(tested);
      expect(w.github().calls.some((call) => call[0] === "release" && call[1] === "create" && call.includes("--verify-tag"))).toBe(true);
      pinned(w);
      const texts = task.timeline.map((entry) => entry.text);
      expect(texts).toContain("Getting the release ready: Petrina sets the version to 1.5.0");
      expect(texts).toContain(`Petrina pushed main and the tag v1.5.0 at ${tested.slice(0, 7)}`);
      expect(texts).toContain("Petrina published release v1.5.0, and checked it on GitHub");
      // The checks ran again on the version commit before it went out.
      expect(task.checks?.sha).toBe(tested);
    } finally {
      await engine.shutdown();
    }

      });
    }, { version: "1.4.0" });
  });

  it("undoes whatever the Release Manager commits: it writes the notes and nothing else", async () => {
    await fixtures.world("release-manager-commits", async ({ world: w, engine: ownedEngine }) => {
    w.setScript((script) => (script.releaseManagerCommits = true));
      await ownedEngine(async engine => {
    try {
      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
      engine.setProductDelivery(productId, "release", false);
      const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.error).toBeUndefined();
      expect(task.release?.tag).toBe("v0.1.0");
      expect(task.timeline.map((entry) => entry.text)).toContain("Undid commits from Release Manager, which is read-only");
      const tagged = (await remoteRef(w.remote, "refs/tags/v0.1.0"))!;
      expect(await git(w.clone, "ls-tree", "--name-only", tagged)).not.toContain("notes-draft.md");
      expect(await git(w.clone, "log", "--format=%s", tagged)).not.toContain("A draft of the notes");
    } finally {
      await engine.shutdown();
    }

      });
    }, {});
  });

  it("commits to main locally with no agent: moves main forward to the checked commit, the main copy's files with it, then pushes main to GitHub", async () => {
    await fixtures.world("local", async ({ world: w, engine: ownedEngine }) => {
      await ownedEngine(async engine => {
    try {
      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      const tested = await git(w.clone, "rev-parse", task.branch!);
      // Exactly the checked commit, no merge commit of Petrina's, and the files are there.
      expect(await git(w.clone, "rev-parse", "main")).toBe(tested);
      expect(task.landed).toEqual({ branch: "main", sha: tested.slice(0, 7) });
      expect(checkedOut(join(w.clone, "greeting.txt"))).toBe("Hello (with left-pad)\n");
      expect(await git(w.clone, "status", "--porcelain")).toBe("");
      // GitHub's main got the push, nothing else was asked of GitHub, and no agent ran at delivery.
      expect(w.github().calls).toEqual([]);
      noReleaseManager(task);
      expect(w.script().releaseManagerPrompts).toBeUndefined();
      expect(await remoteRef(w.remote, "refs/heads/main")).toBe(tested);
      expect(task.timeline.map((entry) => entry.text)).toContain(`Petrina moved main forward to it (${tested.slice(0, 7)}), and checked the main copy`);
      expect(task.timeline.map((entry) => entry.text)).toContain(`Petrina pushed main to GitHub (${tested.slice(0, 7)})`);
    } finally {
      await engine.shutdown();
    }

      });
    }, {});
  });

  it("brings in a teammate's newer GitHub commit before advancing and pushing main", async () => {
    await fixtures.world("local-push", async ({ world: w, engine: ownedEngine }) => {
      await ownedEngine(async engine => {
    try {
      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
      engine.setProductDelivery(productId, "local", true);
      const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      // Right before the coordinator approves, a teammate's commit reaches GitHub's main, unknown to the main copy.
      let teammate = "";
      const approving = coordinator();
      const state = await finish(engine, taskId, async (current, snapshot) => {
        const delivery = itemOf(snapshot, taskId, "delivery");
        if (delivery && !teammate) {
          const other = join(w.dir, "teammate");
          await git(w.dir, "clone", "-q", w.remote, other);
          writeFileSync(join(other, "teammate.txt"), "theirs\n");
          await git(other, "add", "teammate.txt");
          await git(other, "-c", "user.email=t@example.com", "-c", "user.name=Teammate", "commit", "-q", "-m", "A teammate's commit");
          await git(other, "push", "-q", "origin", "main");
          teammate = await git(other, "rev-parse", "main");
        }
        // The snapshot predates the teammate's push: answer from what the engine shows now.
        approving(current, delivery && teammate ? current.getState() : snapshot);
      });
      const task = taskOf(state, taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      // Cleanup may already have removed the working copy. The task branch in the product copy still names the commit.
      const tested = await git(w.clone, "rev-parse", task.branch!);
      expect(await git(w.clone, "rev-parse", "main")).toBe(tested);
      expect(await remoteRef(w.remote, "refs/heads/main")).toBe(tested);
      expect(await git(w.clone, "merge-base", "--is-ancestor", teammate, tested)).toBe("");
      expect(await git(w.clone, "show", "main:teammate.txt")).toBe("theirs");
      expect(task.timeline.filter((entry) => entry.text === "You approved the delivery")).toHaveLength(1);
      expect(task.timeline.map((entry) => entry.text)).toContain(`Petrina pushed main to GitHub (${tested.slice(0, 7)})`);
      const cleaned = taskOf(await until(engine, (snapshot) => taskOf(snapshot, taskId).cleanup?.removedAt !== undefined), taskId);
      expect(existsSync(task.worktree!)).toBe(false);
      const history = cleaned.timeline.map((entry) => entry.text);
      expect(history.indexOf(`Petrina pushed main to GitHub (${tested.slice(0, 7)})`)).toBeLessThan(history.indexOf(CLEANUP_WORDS.removed));
    } finally {
      await engine.shutdown();
    }

      });
    }, {});
  });

  it("moves main locally while the main copy has another branch checked out, leaving that branch's files alone", async () => {
    await fixtures.world("local-elsewhere", async ({ world: w, engine: ownedEngine }) => {
      await ownedEngine(async engine => {
    try {
      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
      await git(w.clone, "switch", "-q", "-c", "notes");
      writeFileSync(join(w.clone, "notes.txt"), "mine\n");
      engine.setProductDelivery(productId, "local", false);
      const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      expect(await git(w.clone, "rev-parse", "main")).toBe(await git(w.clone, "rev-parse", task.branch!));
      expect(await git(w.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("notes");
      expect(existsSync(join(w.clone, "greeting.txt"))).toBe(false);
      expect(checkedOut(join(w.clone, "notes.txt"))).toBe("mine\n");
    } finally {
      await engine.shutdown();
    }

      });
    }, {});
  });

  it("stops before moving main when the main copy has uncommitted changes or main is checked out elsewhere", async () => {
    await fixtures.world("local-unsafe", async ({ world: w, engine: ownedEngine }) => {
      await ownedEngine(async engine => {
    try {
      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
      engine.setProductDelivery(productId, "local", false);
      writeFileSync(join(w.clone, "README.md"), "# Mine, not committed\n");
      const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      let task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain("has changes that are not committed");
      expect(await git(w.clone, "rev-parse", "main")).toBe(w.initial);
      expect(checkedOut(join(w.clone, "README.md"))).toBe("# Mine, not committed\n");

      // main checked out in another folder: still nothing moves.
      await git(w.clone, "checkout", "-q", "--", "README.md");
      await git(w.clone, "switch", "-q", "-c", "other");
      await git(w.clone, "worktree", "add", "-q", join(w.dir, "elsewhere"), "main");
      const first = task.error;
      engine.retry(itemOf(engine.getState(), taskId, "stuck")!.id);
      task = taskOf(await until(engine, (state) => taskOf(state, taskId).state === "failed" && taskOf(state, taskId).error !== first), taskId);
      expect(task.error).toContain("is checked out in another folder");
      expect(await git(w.clone, "rev-parse", "main")).toBe(w.initial);

      // Free again: Retry publishes the same checked commit.
      await git(w.clone, "worktree", "remove", join(w.dir, "elsewhere"));
      engine.retry(itemOf(engine.getState(), taskId, "stuck")!.id);
      task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("done");
      expect(await git(w.clone, "rev-parse", "main")).toBe(await git(w.clone, "rev-parse", task.branch!));
    } finally {
      await engine.shutdown();
    }

      });
    }, {});
  });



  it("keeps the approved destination when the product default branch changes", async () => {
    await fixtures.world("destination", async ({ world: w, engine: ownedEngine }) => {
      await ownedEngine(async engine => {
    try {
      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
      engine.setProductDelivery(productId, "pull-request", true);
      const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      let state = await until(engine, (current) => !!itemOf(current, taskId, "delivery"), coordinator(["plan", "design"]));
      engine.setPoolPaused(true);
      engine.approve(itemOf(state, taskId, "delivery")!.id);
      expect(taskOf(engine.getState(), taskId).approvedFor).toEqual({ by: "coordinator", mode: "pull-request", destination: `${REPO}#main` });
      // The product's default branch changes before anything gets ready.
      (engine.getState().products.find((entry) => entry.id === productId) as { defaultBranch?: string }).defaultBranch = "trunk";
      engine.setPoolPaused(false);
      state = await finish(engine, taskId);
      const task = taskOf(state, taskId);
      expect(task.state).toBe("pr-open");
      expect(task.approvedFor?.destination).toBe(`${REPO}#main`);
      expect(task.source?.destination.branch).toBe("main");
      expect(w.github().prs[0]?.baseRefName).toBe("main");
      expect(task.timeline.filter((entry) => entry.text === "You approved the delivery")).toHaveLength(1);
    } finally {
      await engine.shutdown();
    }

      });
    }, {});
  });
});
