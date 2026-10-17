// Petrina publishes deliveries itself: the shipper only gets them ready, and Petrina pushes, opens the pull
// request, creates the release or moves main forward, checked on GitHub or in the main copy before it says so.
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe.concurrent("Petrina publishes deliveries itself", () => {
  it("opens a pull request: pushes the exact checked commit and opens it with the shipper's text, as text", async () => {
    const w = world("pr");
    const marker = join(w.dir, "pwned");
    const title = `$(touch ${marker}) --help; rm -rf ~ \`id\``;
    const body = `--base evil\n$(touch ${marker})\n\`touch ${marker}\` && echo done; | cat /etc/passwd`;
    w.setScript((script) => {
      script.title = title;
      script.body = body;
      script.envOut = join(w.dir, "shipper-env.json");
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
      expect(pr).toMatchObject({ headRefName: task.branch, baseRefName: "main", headRefOid: tested, state: "OPEN", title, body });
      expect(existsSync(marker)).toBe(false);
      pinned(w);

      // The delivery check came before any preparation, and the updates say who did what.
      const texts = task.timeline.map((entry) => entry.text);
      const approved = texts.indexOf("You approved the delivery");
      expect(approved).toBeGreaterThan(-1);
      expect(task.timeline.findIndex((entry) => entry.roleId === "shipper")).toBeGreaterThan(approved);
      expect(texts).toContain("Getting the delivery ready: the shipper writes the pull request");
      expect(texts).toContain(`Ready to publish: ${tested.slice(0, 7)}`);
      expect(texts).toContain(`Petrina pushed the branch at ${tested.slice(0, 7)}`);
      expect(texts).toContain("Petrina opened pull request #1, and checked it on GitHub");
      expect(task.timeline.find((entry) => entry.text.startsWith("Petrina opened"))?.roleId).toBeUndefined();
      expect(task.approvedFor).toEqual({ by: "coordinator", mode: "pull-request", destination: `${REPO}#main` });

      // The shipper ran in the agents' environment: the coordinator's own, nothing waiting for a typed answer, in the background.
      const env = JSON.parse(readFileSync(join(w.dir, "shipper-env.json"), "utf8"));
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

  it("publishes a release on its own: one all-or-nothing push of main and the new tag, then the release on that tag", async () => {
    const w = world("release", { version: "1.4.0" });
    // The latest release is v1.4.0 on the first commit; this product bumps the minor number.
    execFileSync("git", ["--git-dir", w.remote, "update-ref", "refs/tags/v1.4.0", w.initial]);
    w.setGitHub((github) => github.releases.push({ tagName: "v1.4.0", url: `https://github.com/${REPO}/releases/tag/v1.4.0`, publishedAt: "2026-01-01T00:00:00Z", isDraft: false, name: "v1.4.0", body: "" }));
    w.setScript((script) => (script.notes = "People see a greeting.\n$(rm -rf ~)"));
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

      // What went out is the version commit on top of the task's one commit; main and the tag both point at it.
      const tested = git(task.worktree!, "rev-parse", "HEAD");
      expect(JSON.parse(git(task.worktree!, "show", `${tested}:package.json`)).version).toBe("1.5.0");
      expect(git(task.worktree!, "diff", "--name-only", `${tested}^`, tested)).toBe("package.json");
      expect(git(task.worktree!, "rev-parse", `${tested}~2`)).toBe(w.initial);
      expect(remoteRef(w.remote, "refs/heads/main")).toBe(tested);
      expect(remoteRef(w.remote, "refs/tags/v1.5.0")).toBe(tested);
      const release = w.github().releases.find((entry) => entry.tagName === "v1.5.0")!;
      expect(release.body).toBe("People see a greeting.\n$(rm -rf ~)");
      expect(w.github().calls.some((call) => call[0] === "release" && call[1] === "create" && call.includes("--verify-tag"))).toBe(true);
      pinned(w);
      const texts = task.timeline.map((entry) => entry.text);
      expect(texts).toContain(`Petrina pushed main and the tag v1.5.0 at ${tested.slice(0, 7)}`);
      expect(texts).toContain("Petrina published release v1.5.0, and checked it on GitHub");
      // The checks ran again on the version commit before it went out.
      expect(task.checks?.sha).toBe(tested);
    } finally {
      engine.shutdown();
    }
  });

  it("commits to main locally with no shipper: moves main forward to the checked commit with no network, and the main copy's files with it", async () => {
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
      expect(readFileSync(join(w.clone, "greeting.txt"), "utf8")).toBe("Hello (with left-pad)\n");
      expect(git(w.clone, "status", "--porcelain")).toBe("");
      // Nothing touched GitHub, and no shipper was needed.
      expect(w.github().calls).toEqual([]);
      expect(w.script().runs ?? 0).toBe(0);
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
      expect(readFileSync(join(w.clone, "notes.txt"), "utf8")).toBe("mine\n");
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
      expect(readFileSync(join(w.clone, "README.md"), "utf8")).toBe("# Mine, not committed\n");

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

  for (const mode of ["pull-request", "release"] as const) {
    it(`publishes nothing when getting a ${mode} ready fails, and goes back through the builder, review and the delivery check`, async () => {
      const w = world(`fail-${mode}`);
      w.setScript((script) => (script.fail = 1));
      let engine = w.start();
      try {
        const productId = await engine.addProduct(w.clone);
        engine.setProductDelivery(productId, mode, true);
        const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
        // Approve the first delivery check only.
        let approvals = 0;
        const once = (current: typeof engine, state: ReturnType<typeof engine.getState>) => {
          coordinator(["plan", "design"])(current, state);
          const check = itemOf(state, taskId, "delivery");
          if (check && approvals === 0) {
            approvals += 1;
            current.approve(check.id);
          }
        };
        let state = await until(engine, (current) => taskOf(current, taskId).timeline.some((entry) => entry.text.startsWith("Not ready to publish")), once);
        let task = taskOf(state, taskId);
        const failed = task.findings.find((finding) => finding.raisedBy === "petrina" && finding.text.startsWith("Getting the delivery ready failed"));
        expect(failed).toMatchObject({ severity: "blocking" });
        expect(task.approvedFor).toBeUndefined();
        expect(task.shipping?.failures).toBe(1);
        // Nothing was published anywhere.
        expect(remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
        expect(git(w.clone, "rev-parse", "main")).toBe(w.initial);
        expect(w.github().prs).toEqual([]);
        expect(w.github().releases).toEqual([]);
        expect(remoteRef(w.remote, `refs/heads/${task.branch}`)).toBeUndefined();

        // A restart publishes nothing either: the work goes through the builder and review to a new delivery check.
        engine.shutdown();
        engine = w.start();
        state = await until(engine, (current) => !!itemOf(current, taskId, "delivery"), once);
        task = taskOf(state, taskId);
        expect(task.approvedFor).toBeUndefined();
        const texts = task.timeline.map((entry) => entry.text);
        const back = texts.findIndex((text) => text.startsWith("Not ready to publish"));
        expect(task.timeline.slice(back).some((entry) => entry.roleId === "builder" && entry.tone === "milestone")).toBe(true);
        expect(task.timeline.slice(back).some((entry) => entry.roleId === "code-reviewer" && entry.tone === "milestone")).toBe(true);
        expect(remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
        expect(w.github().prs).toEqual([]);

        // Approving the new check delivers.
        engine.approve(itemOf(state, taskId, "delivery")!.id);
        task = taskOf(await finish(engine, taskId), taskId);
        expect(task.error).toBeUndefined();
        expect(task.state).toBe(mode === "pull-request" ? "pr-open" : "done");
        expect(w.script().runs).toBe(2);
      } finally {
        engine.shutdown();
      }
    });
  }

  it("stops and asks after getting it ready fails twice", async () => {
    const w = world("fail-twice");
    w.setScript((script) => (script.fail = 2));
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "pull-request", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      let task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain("Getting the delivery ready failed 2 times");
      expect(w.github().prs).toEqual([]);
      expect(remoteRef(w.remote, `refs/heads/${task.branch}`)).toBeUndefined();
      // Trying again sends it back to the builder; the next preparation passes and goes out.
      engine.retry(itemOf(engine.getState(), taskId, "stuck")!.id);
      task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("pr-open");
      expect(w.script().runs).toBe(3);
    } finally {
      engine.shutdown();
    }
  });

  it("sends a handoff with work left behind back to the shipper, and never commits for it", async () => {
    const w = world("leftover");
    w.setScript((script) => (script.leftover = 1));
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "pull-request", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("pr-open");
      expect(w.script().sentBack).toContain("there is uncommitted work on");
      const tested = remoteRef(w.remote, `refs/heads/${task.branch}`)!;
      expect(git(task.worktree!, "ls-tree", "-r", "--name-only", tested)).not.toContain("test-output.log");
      expect(existsSync(join(task.worktree!, "test-output.log"))).toBe(false);
      expect(w.script().runs).toBe(1);
    } finally {
      engine.shutdown();
    }
  });

  for (const offBranch of ["side", "detached"] as const) {
    it(`sends a release made ready ${offBranch === "side" ? "on a side branch" : "on no branch"} back to the shipper, and publishes the task branch itself`, async () => {
      const w = world(`off-branch-${offBranch}`, { version: "0.1.0" });
      // v0.1.0 is out, so this release sets a new version in its own commit.
      execFileSync("git", ["--git-dir", w.remote, "update-ref", "refs/tags/v0.1.0", w.initial]);
      w.setGitHub((github) => github.releases.push({ tagName: "v0.1.0", url: `https://github.com/${REPO}/releases/tag/v0.1.0`, publishedAt: "2026-01-01T00:00:00Z", isDraft: false, name: "v0.1.0", body: "" }));
      w.setScript((script) => (script.offBranch = offBranch));
      const engine = w.start();
      try {
        const productId = await engine.addProduct(w.clone);
        engine.setProductDelivery(productId, "release", false);
        const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
        const task = taskOf(await finish(engine, taskId), taskId);
        expect(task.error).toBeUndefined();
        expect(task.state).toBe("done");
        expect(w.script().sentBack).toContain(offBranch === "side" ? `the working copy is on getting-ready, not on ${task.branch}` : `the working copy is not on any branch, not on ${task.branch}`);
        // What went out is where the task branch itself points: the version commit on top of the work.
        const tip = git(task.worktree!, "rev-parse", `refs/heads/${task.branch}`);
        expect(remoteRef(w.remote, "refs/tags/v0.1.1")).toBe(tip);
        expect(git(task.worktree!, "log", "-1", "--format=%s", tip)).toBe("Version 0.1.1");
        expect(w.script().runs).toBe(1);
      } finally {
        engine.shutdown();
      }
    });
  }

  it("sends a pull request's shipper back when it commits, since a pull request needs only its text", async () => {
    const w = world("pr-commits");
    w.setScript((script) => (script.commit = true));
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "pull-request", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("pr-open");
      expect(w.script().sentBack).toContain("but a pull request needs only its text");
      // What went out is the task's one commit, without the shipper's.
      const tip = git(task.worktree!, "rev-parse", `refs/heads/${task.branch}`);
      expect(git(task.worktree!, "rev-parse", `${tip}^`)).toBe(w.initial);
      expect(w.github().prs[0]!.headRefOid).toBe(tip);
      expect(git(task.worktree!, "ls-tree", "--name-only", tip)).not.toContain("extra.txt");
    } finally {
      engine.shutdown();
    }
  });

  it("publishes nothing when the pull request text is longer than GitHub allows", async () => {
    const w = world("too-long");
    w.setScript((script) => (script.title = "A".repeat(300)));
    const engine = w.start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "pull-request", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain("the title is longer than GitHub allows (256 characters)");
      expect(w.github().calls.filter((call) => call[1] === "create")).toEqual([]);
      expect(remoteRef(w.remote, `refs/heads/${task.branch}`)).toBeUndefined();
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
      expect(w.script().runs ?? 0).toBe(0);
      expect(w.github().calls.filter((call) => call[1] === "create")).toEqual([]);
      engine.cancel(taskId);
    } finally {
      engine.shutdown();
    }
  });
});
