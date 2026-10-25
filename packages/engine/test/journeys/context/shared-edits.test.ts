import { draftOf } from "@petrina/core";
import { afterAll, describe, expect, it } from "bun:test";
import { coordinator, finish, git, itemOf, removeDir, taskOf, until, type World } from "../../support.js";
import { sharedWorld } from "../../fixtures/shared-world.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const setup = (name: string) => sharedWorld(name, worlds);

describe.concurrent("one task across products", () => {
  it("saves an editing architect's work separately in each product before the shared review", async () => {
    const { shop, api, start, fakes } = await setup("editing-design"); const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const architect = engine.getState().roles.find((role) => role.result === "brief")!;
      engine.saveRole(architect.id, { ...draftOf(architect), canEdit: true });
      fakes.scenario({ builder: "plain", architect: "writes" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Keep each design's edits" });
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.repositories!.every((work) => work.completedStages.some((stage) => stage.includes(":author:")))).toBe(true);
      for (const work of task.repositories!) expect(await git(work.worktree!, "show", "HEAD:architecture.txt")).toContain("Before the design review");
    } finally { await engine.shutdown(); }
  });
});

describe.concurrent("shared-task repair regressions", () => {
  it("keeps each editing role's product report available to the next product and the combined reviewers", async () => {
    const { shop, api, start, fakes } = await setup("editing-notes"); const engine = start();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      engine.addRole({ ...draftOf(engine.getState().roles.find((role) => role.result === "notes")!), name: "Copywriter", result: "notes", canEdit: true });
      fakes.scenario({ planner: "copy", builder: "plain" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Keep both copy reports" });
      const task = taskOf(await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"])), id);
      expect(task.error).toBeUndefined();
      const reports = task.handedBack!.filter((entry) => entry.roleName === "Copywriter");
      expect(reports.map((entry) => entry.productId)).toEqual([first, second]);
      const names = task.repositories!.map((work) => work.source!.product.name);
      const reviews = fakes.received("code reviewer");
      expect(reviews.length).toBeGreaterThan(0);
      for (const review of reviews) for (const name of names) expect(review.text).toContain(`Copywriter · ${name}`);
      expect(fakes.received("copywriter")[1]!.text).toContain(`Copywriter · ${names[0]}`);
    } finally { await engine.shutdown(); }
  });
});
