import { join } from "node:path";
import { acmeDemoProduct, installPreparedProduct } from "../../fixtures/prepared-product.js";
import { queuePreparedDelivery } from "../../fixtures/queued-delivery.js";
import { commitLooseOnRef, looseContains, readLooseBlobInCommit, readLooseCommit, readRef } from "../../fixtures/shared-preparation.js";
// Full release/publication races retain real planning, review and delivery.
import { afterAll, describe, expect, it } from "bun:test";
import { commitFiles, pkg, releaseVersionFixtures } from "../../fixtures/release-versions.js";
import { coordinator, finish, git, itemOf, remoteRef, taskOf, until } from "../../support.js";

const { world, close } = releaseVersionFixtures();
afterAll(close);

describe.concurrent("Release versions on real deliveries", () => {

  it("starts at 0.1.0 with no version files, and two release tasks get the next free version each, with notes on what each ships", () => world("first-release", {}, async ({ world: w, deliver }) => {
    w.setScript((script) => (script.ownFiles = true));
    const [first, second] = await deliver("release", 2);
    expect(first!.error).toBeUndefined();
    expect(first!.release?.tag).toBe("v0.1.0");
    expect(second!.error).toBeUndefined();
    expect(second!.release?.tag).toBe("v0.1.1");
    // No version files: what went out is the task's own commit, and the tags sit on main's history.
    const firstTag = (await remoteRef(w.remote, "refs/tags/v0.1.0"))!;
    const secondTag = (await remoteRef(w.remote, "refs/tags/v0.1.1"))!;
    expect(await remoteRef(w.remote, "refs/heads/main")).toBe(secondTag);
    expect(looseContains(w.remote, secondTag, firstTag) === true ? "" : await git(w.clone, "merge-base", "--is-ancestor", firstTag, secondTag)).toBe("");
    expect(w.github().releases.map((entry) => entry.tagName)).toEqual(["v0.1.0", "v0.1.1"]);
    // The first release's notes come from every commit there is; the next one's from what came since.
    const [firstPrompt, secondPrompt] = w.script().releaseManagerPrompts!;
    expect(firstPrompt).toContain("## The first release: every commit on main, oldest first (2)");
    expect(firstPrompt).toContain("### init");
    expect(firstPrompt).toContain("### Add greeting 1");
    expect(secondPrompt).toContain("## Every commit on main since v0.1.0, oldest first (1)");
    expect(secondPrompt).toContain("### Add greeting 2");
    expect(secondPrompt).not.toContain("### Add greeting 1");
  }));

  it("works the version and the notes out again when a release comes out before its push", () => world("meanwhile", {}, async ({ world: w, deliver }) => {
    await commitFiles(w, { "package.json": pkg("0.1.0") });
    // A teammate publishes v0.1.0 as Petrina looks for this delivery's release, right after getting it ready.
    w.setGitHub((github) => (github.meanwhile = { command: "release view", withTag: true, times: 1, release: "v0.1.0" }));
    const [task] = await deliver("release");
    expect(task!.error).toBeUndefined();
    expect(task!.release?.tag).toBe("v0.1.1");
    const prompts = w.script().releaseManagerPrompts!;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("## Every commit on main since v0.1.0, oldest first (1)");
    const tested = (await remoteRef(w.remote, "refs/tags/v0.1.1"))!;
    expect(JSON.parse(readLooseBlobInCommit(w.remote, tested, "package.json") ?? await git(w.clone, "show", `${tested}:package.json`)).version).toBe("0.1.1");
    expect(readLooseCommit(w.remote, tested)?.body.split("\n")[0] ?? await git(w.clone, "log", "-1", "--format=%s", tested)).toBe("Release v0.1.1");
    expect(task!.timeline.map((entry) => entry.text)).toContain("main moved on GitHub, so Petrina gets it ready again (1 of 3)");
  }));

  it("gets a release ready again when main moves before its push, but not a pull request", () => world("moved-release", {}, async ({ world: releasing, deliver }) => {
    releasing.setGitHub((github) => (github.meanwhile = { command: "release view", withTag: true, times: 1 }));
    const [r] = await deliver("release");
    expect(r!.release?.tag).toBe("v0.1.0");
    expect(releasing.script().releaseManagerPrompts).toHaveLength(2);
    expect(await remoteRef(releasing.remote, "refs/heads/main")).toBe(await remoteRef(releasing.remote, "refs/tags/v0.1.0"));
    // On top of the teammate's change, as one commit: a fast-forward, never a merge.
    const releasingTip = (await remoteRef(releasing.remote, "refs/heads/main"))!;
    const releasingParent = readLooseCommit(releasing.remote, releasingTip)?.parents[0];
    expect(releasingParent ? readLooseCommit(releasing.remote, releasingParent)?.body.split("\n")[0] : await git(releasing.clone, "log", "-1", "--format=%s", `${releasingTip}^`)).toBe("A teammate's change");

    await world("moved-pr", {}, async ({ world: pr, deliver }) => {
      pr.setGitHub((github) => (github.meanwhile = { command: "pr list", times: 1 }));
      const [p] = await deliver("pull-request");
      expect(p!.state).toBe("pr-open");
      expect(pr.script().releaseManagerPrompts).toBeUndefined();
      });
  }));

  it("brings local delivery up to date when main moved after the delivery check, and moves main forward on top of it", () => world("moved-local", {}, async ({ world: w, engine }) => {
    await engine(async engine => {
      const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
      engine.setProductDelivery(productId, "local", true);
      const taskId = await queuePreparedDelivery(engine, { productId, title: "Add a greeting", description: "A greeting file. [quick]" }, { checks: "none" });
      const state = await until(engine, (current) => !!itemOf(current, taskId, "delivery"), coordinator(["plan", "design"]));
      // A teammate's commit lands on the main copy's main before the coordinator says yes.
      if (!commitLooseOnRef(join(w.clone, ".git"), { ref: "refs/heads/main", message: "A teammate's change" })) {
        await git(w.clone, "commit", "-q", "--allow-empty", "-m", "A teammate's change");
      }
      engine.approve(itemOf(state, taskId, "delivery")!.id);
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("done");
      expect(task.timeline.map((entry) => entry.text)).toContain("Brought up to date with main (1 new commit there), with no conflicts");
      const cloneGit = join(w.clone, ".git");
      const localTip = readRef(cloneGit, "refs/heads/main")!;
      const localCommit = readLooseCommit(cloneGit, localTip);
      const parentCommit = localCommit?.parents[0] ? readLooseCommit(cloneGit, localCommit.parents[0]) : undefined;
      expect(parentCommit?.body.split("\n")[0] ?? await git(w.clone, "log", "-1", "--format=%s", "main^")).toBe("A teammate's change");
      expect(localCommit && localCommit.parents.length <= 1 && parentCommit && parentCommit.parents.length <= 1 ? "0" : await git(w.clone, "rev-list", "--merges", "--count", "main")).toBe("0");
    });
  }));


});
