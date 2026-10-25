import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { finish, git, itemOf, REPO, remoteRef, taskOf } from "../../support.js";
import { sourceWorlds, branch, pull, planGate, taskCommit } from "../../fixtures/source-world.js";
const { setup, close } = sourceWorlds();
afterAll(close);

describe.concurrent("one approved product and starting point",()=>{
for (const delivery of ["pull-request", "local"] as const) it(`starts from a branch and delivers with ${delivery}, keeping existing source commits`, async () => {
    const { w, start } = await setup(`branch-${delivery}`);
    const source = await branch(w);
    const engine = start();
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "A greeting", startFrom: { kind: "branch", name: "release-2.x" }, delivery, approvePlan: false });
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.source).toMatchObject({ initialSha: source, start: { kind: "branch", branch: "release-2.x" }, destination: { repo: REPO, branch: "release-2.x", mode: delivery } });
      const tested = await taskCommit(w, task);
      expect(await git(w.clone, "rev-parse", `${tested}^`)).toBe(source);
      expect(task.timeline.some((entry) => entry.text === "You approved the plan")).toBe(false);
      expect(task.plan?.stages.find((stage) => stage.roleId === "release-manager" && stage.kind === "do")?.title).toBe(delivery === "local" ? "Commit to release-2.x" : "Open a pull request");
      if (delivery === "pull-request") {
        expect(w.github().prs[0]?.baseRefName).toBe("release-2.x");
        expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(source);
      } else {
        expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(tested);
        expect(await git(w.clone, "rev-parse", "release-2.x")).toBe(tested);
        expect(await git(w.clone, "branch", "--show-current")).toBe("main");
        expect(w.github().prs).toHaveLength(0);
      }
      expect(await remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);
    } finally { await engine.shutdown(); }
  });
});

describe.concurrent("one approved product and starting point",()=>{
it("uses an exact branch name with Unicode and punctuation", async () => {
    const { w, start } = await setup("exact-name"); const name = "release/été+2"; await branch(w, name); const engine = start();
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "A greeting", startFrom: { kind: "branch", name }, delivery: "local" });
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.source?.start.branch).toBe(name);
      expect(await remoteRef(w.remote, `refs/heads/${name}`)).toBe(await taskCommit(w, task));
    } finally { await engine.shutdown(); }
  });
});

describe.concurrent("one approved product and starting point",()=>{
for (const fork of [false, true]) for (const link of [false, true]) it(`updates the original ${fork ? "fork" : "same-repository"} PR from a ${link ? "link" : "number"}, without folding its commits or creating another PR`, async () => {
    const { w } = await setup(`pr-${fork}-${link}`);
    const source = await pull(w, fork);
    const engine = new Engine(w.data, { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), `--script=${join(w.dir, "agents.json")}`], gh: [process.execPath, join(import.meta.dir, "../../fake-gh.ts"), join(w.dir, "github.json"), w.remote], remote: w.remote, sourceRemotes: { "contributor/demo": source.remote } });
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "A greeting", description: "[quick]", startFrom: { kind: "pull-request", value: link ? `https://github.com/${REPO}/pull/7` : "#7" } });
      const waiting = await planGate(engine, id);
      expect(taskOf(waiting, id).worktree).toBeUndefined();
      expect(taskOf(waiting, id).source).toBeUndefined();
      expect(taskOf(waiting, id).proposedSource?.destination.repo).toBe(fork ? "contributor/demo" : REPO);
      expect((await git(w.clone, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
      expect(w.github().calls.some((args) => args[0] === "api")).toBe(false);
      engine.approve(itemOf(waiting, id, "plan")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("pr-open"); expect(task.pr?.number).toBe(7);
      expect(task.statusLine).toStartWith("Updated PR #7");
      expect(task.plan?.stages.find((stage) => stage.roleId === "release-manager" && stage.kind === "do")?.title).toBe("Update PR #7");
      const tested = await git(task.worktree!, "rev-parse", "HEAD");
      expect(await git(task.worktree!, "rev-parse", "HEAD^")).toBe(source.sha);
      expect(task.source?.initialSha).toBe(source.sha);
      expect(await remoteRef(source.remote, "refs/heads/review-work")).toBe(tested);
      expect(w.github().prs).toHaveLength(1);
      expect(w.github().prs[0]).toMatchObject({ title: "Original PR title", body: "Original description" });
      expect(w.github().calls.some((args) => args[0] === "pr" && ["create", "edit", "comment", "merge"].includes(args[1]!))).toBe(false);
      expect(w.script().releaseManagerPrompts ?? []).toHaveLength(0);
      for (const args of w.github().calls) if (args[0] === "pr") expect(args.slice(-2)).toEqual(["--repo", REPO]);
      expect(w.github().cwds?.every((cwd) => !cwd.startsWith(w.clone) && !cwd.startsWith(w.data))).toBe(true);
    } finally { await engine.shutdown(); }
  });
});
