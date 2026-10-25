import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coordinator, finish, git, itemOf, removeDir, taskOf, until, type World } from "../../support.js";
import { sharedWorld } from "../../fixtures/shared-world.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const setup = (name: string) => sharedWorld(name, worlds);

describe.concurrent("one task across products", () => {
  for (const recovery of ["unchanged", "fresh", "retry", "restart"] as const) it(`delivers to an addition's approved local branch after remote default changes: ${recovery}`, async () => {
    const { shop, api, start, fakes, remotes } = await setup(`local-default-${recovery}`);
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone);
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "local" }, { productId: "acme/api", repo: "acme/api", startFrom: { kind: "default" }, delivery: "local", reason: "The API also needs the greeting." }] });
      const id = engine.addTask({ productId: first, title: "A local greeting in both places" });
      await until(engine, (state) => !!itemOf(state, id, "plan") || !!taskOf(state, id).error, coordinator([]));
      const folder = join(shop.dir, "confirmed-local-api");
      await engine.setTaskAddition(id, "acme/api", "API", folder);
      expect(taskOf(engine.getState(), id).workRows![1]!.source!.product.defaultBranch).toBe("main");
      let trunk: string | undefined;
      if (recovery !== "unchanged") {
        await git(api.clone, "switch", "-q", "-c", "trunk");
        writeFileSync(join(api.clone, "TRUNK_ONLY.md"), "Unapproved new default\n");
        await git(api.clone, "add", "."); await git(api.clone, "commit", "-qm", "A distinct new default");
        await git(api.clone, "push", "-q", api.remote, "trunk");
        trunk = await git(api.clone, "rev-parse", "trunk");
        await git(api.remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
      }
      if (recovery === "retry" || recovery === "restart") remotes["acme/api"] = join(api.dir, "unavailable.git");
      engine.approve(itemOf(engine.getState(), id, "plan")!.id);
      if (recovery === "retry" || recovery === "restart") {
        await until(engine, (state) => !!taskOf(state, id).error);
        expect(taskOf(engine.getState(), id).workRows![1]!.addition?.created).toBe(true);
        remotes["acme/api"] = api.remote;
        await git(shop.dir, "clone", "-q", api.remote, folder);
        expect(await git(folder, "branch", "--list", "main")).toBe("");
        writeFileSync(join(folder, "keep.txt"), "Preserved completed clone\n");
        if (recovery === "restart") { await engine.shutdown(); engine = start(); }
        engine.retry(itemOf(engine.getState(), id, "stuck")!.id);
      }
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      const work = task.repositories!.find((entry) => entry.source?.product.repo === "acme/api")!;
      expect(work.source!.initialSha).toBe(api.initial);
      expect(work.source!.product.defaultBranch).toBe("main");
      expect(work.source!.start.branch).toBe("main");
      expect(work.source!.destination.branch).toBe("main");
      expect(work.landed?.branch).toBe("main");
      expect(work.nothingToPublish).not.toBe(true);
      const landed = await git(folder, "rev-parse", "refs/heads/main");
      expect(await git(folder, "rev-parse", `refs/heads/${work.branch}`)).toBe(landed);
      expect(await git(api.remote, "rev-parse", "refs/heads/main")).toBe(landed);
      expect(await git(folder, "show", `${landed}:greeting.txt`)).toContain("Hello");
      expect(await git(folder, "ls-tree", "--name-only", landed, "TRUNK_ONLY.md")).toBe("");
      if (trunk) {
        expect(await git(api.remote, "rev-parse", "refs/heads/trunk")).toBe(trunk);
        expect(await git(folder, "rev-parse", "refs/heads/trunk")).toBe(trunk);
        expect(await git(folder, "branch", "--show-current")).toBe("trunk");
      }
      if (recovery === "retry" || recovery === "restart") expect(await git(folder, "status", "--short")).toContain("keep.txt");
      expect(api.github().prs).toHaveLength(0);
    } finally { await engine.shutdown(); }
  });

  for (const invalid of ["branch", "pull-request", "release"] as const) it(`requires a confirmed folder after correcting a proposed repository's invalid ${invalid} choice`, async () => {
    const { shop, api, start, fakes } = await setup(`invalid-addition-${invalid}`);
    let engine = start();
    try {
      const first = await engine.addProduct(shop.clone);
      fakes.scenario({ worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: "acme/api", repo: "acme/api", startFrom: invalid === "pull-request" ? { kind: "pull-request", value: "999" } : { kind: "branch", name: "missing-branch" }, delivery: invalid === "release" ? "release" : "pull-request" }] });
      const id = engine.addTask({ productId: first, title: "Correct the proposed API source" });
      const state = await until(engine, (state) => !!itemOf(state, id, "plan") || taskOf(state, id).state === "failed", coordinator([]));
      expect(taskOf(state, id).error).toBeUndefined();
      const before = taskOf(state, id).workRows![1]!;
      expect(before.error).toBeTruthy();
      expect(before.addition).toBeUndefined();
      await engine.setTaskStart(id, { ...before.choice, startFrom: { kind: "default" }, delivery: "pull-request" });
      const corrected = taskOf(engine.getState(), id).workRows![1]!;
      expect(corrected.error).toContain("Needs adding");
      expect(corrected.addition).toBeUndefined();
      expect(() => engine.approve(itemOf(engine.getState(), id, "plan")!.id)).toThrow();
      expect(engine.task(id)!.repositories).toBeUndefined();
      await engine.shutdown(); engine = start();
      expect(() => engine.approve(itemOf(engine.getState(), id, "plan")!.id)).toThrow();
      // Guard older saved validation placeholders too: an empty folder is never coordinator approval.
      const row = engine.task(id)!.workRows![1]!;
      delete row.error;
      row.addition = { name: "Shop API", path: "", productId: row.source!.product.id };
      row.source!.product.path = "";
      expect(() => engine.approve(itemOf(engine.getState(), id, "plan")!.id)).toThrow();
      const folder = join(shop.dir, "confirmed-api");
      await engine.setTaskAddition(id, "acme/api", "Shop API", folder);
      expect(existsSync(folder)).toBe(false);
      engine.approve(itemOf(engine.getState(), id, "plan")!.id);
      const finished = taskOf(await finish(engine, id), id);
      expect(finished.error).toBeUndefined();
      expect(finished.state).toBe("pr-open");
      expect(await git(folder, "branch", "--show-current")).toBe("main");
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });

  it("retries an interrupted clone in its saved folder and leaves an unrelated occupied folder untouched", async () => {
    const { shop, api, start, fakes, remotes } = await setup("clone-retry"); let engine = start();
    try {
      const first = await engine.addProduct(shop.clone);
      fakes.scenario({ planner: "short", builder: "plain", worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: "acme/api", repo: "acme/api", reason: "Both repositories need the greeting", startFrom: { kind: "default" }, delivery: "pull-request" }] });
      const id = engine.addTask({ productId: first, title: "Resume an addition" });
      await until(engine, (state) => !!itemOf(state, id, "plan"), coordinator([]));
      await expectRejection(engine.setTaskAddition(id, "acme/api", "API", shop.clone), "already exists");
      const folder = join(shop.dir, "api-addition");
      await engine.setTaskAddition(id, "acme/api", "API", folder);
      remotes["acme/api"] = join(api.dir, "unavailable.git");
      engine.approve(itemOf(engine.getState(), id, "plan")!.id);
      const failed = await until(engine, (state) => !!taskOf(state, id).error);
      const firstCopy = taskOf(failed, id).repositories![0]!.worktree;
      expect(taskOf(failed, id).repositories![0]!.preparation).toBe("ready");
      expect(taskOf(failed, id).workRows![1]!.addition?.created).toBe(true);
      mkdirSync(join(folder, ".git"), { recursive: true }); writeFileSync(join(folder, ".git", "interrupted"), "unfinished clone");
      remotes["acme/api"] = api.remote;
      await engine.shutdown(); engine = start();
      engine.retry(itemOf(engine.getState(), id, "stuck")!.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined();
      expect(done.repositories![0]!.worktree).toBe(firstCopy);
      expect(await git(folder, "branch", "--show-current")).toBe("main");
      expect(await git(shop.clone, "show", "HEAD:README.md")).toContain("Demo");
      expect(api.github().prs).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });
});
