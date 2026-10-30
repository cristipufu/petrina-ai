import { draftOf } from "@petrina/core";
import { afterAll, describe, expect, it } from "bun:test";
import * as gitOps from "@petrina/repositories/git";
import { coordinator, taskOf, until } from "../../support.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());

describe.concurrent("one task across products", () => {
  it("saves an editing architect's work separately in each product before the shared review", async () => {
    await fixtures.world("editing-design", async ({ shop, api, engine: withEngine, fakes }) => {
    await withEngine(async engine => {

      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      const architect = engine.getState().roles.find((role) => role.result === "brief")!;
      engine.saveRole(architect.id, { ...draftOf(architect), canEdit: true });
      fakes.scenario({ builder: "plain", architect: "writes" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Keep each design's edits" });
      const task = taskOf(await until(engine, state => {
        const current = taskOf(state, id);
        return !!current.error || !!current.repositories?.every(work => work.completedStages.some(stage => stage.includes(":author:")))
          && fakes.received("design reviewer").length > 0;
      }, coordinator(["plan", "design"])), id);
      expect(task.error).toBeUndefined();
      expect(task.repositories!.every((work) => work.completedStages.some((stage) => stage.includes(":author:")))).toBe(true);
      for (const work of task.repositories!) expect(await gitOps.fileAt(work.worktree!, "HEAD", "architecture.txt")).toContain("Before the design review");

    });
    });
  });
});

describe.concurrent("shared-task repair regressions", () => {
  it("keeps each editing role's product report available to the next product and the combined reviewers", async () => {
    await fixtures.world("editing-notes", async ({ shop, api, engine: withEngine, fakes }) => {
    await withEngine(async engine => {

      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      engine.addRole({ ...draftOf(engine.getState().roles.find((role) => role.result === "notes")!), name: "Copywriter", result: "notes", canEdit: true });
      fakes.scenario({ planner: "copy", builder: "plain" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Keep both copy reports" });
      const task = taskOf(await until(engine, state => {
        const current = taskOf(state, id);
        return !!current.error || current.handedBack?.filter(entry => entry.roleName === "Copywriter").length === 2
          && fakes.received("code reviewer").length > 0;
      }, coordinator(["plan", "design"])), id);
      expect(task.error).toBeUndefined();
      const reports = task.handedBack!.filter((entry) => entry.roleName === "Copywriter");
      expect(reports.map((entry) => entry.productId)).toEqual([first, second]);
      const names = task.repositories!.map((work) => work.source!.product.name);
      const reviews = fakes.received("code reviewer");
      expect(reviews.length).toBeGreaterThan(0);
      for (const review of reviews) for (const name of names) expect(review.text).toContain(`Copywriter · ${name}`);
      expect(fakes.received("copywriter")[1]!.text).toContain(`Copywriter · ${names[0]}`);

    });
    });
  });
});
