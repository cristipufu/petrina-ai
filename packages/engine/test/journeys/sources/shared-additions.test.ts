import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { coordinator, finish, git, itemOf, taskOf, until } from "../../support.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());

describe.concurrent("one task across products", () => {
  it("clones a proposed product into the confirmed folder only after the complete plan is approved", async () => {
    await fixtures.world("addition", async ({ shop, api, engine: withEngine, fakes }) => {

    await withEngine(async engine => {

      const first = await engine.addProduct(shop.clone);
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: "acme/api", repo: "acme/api", startFrom: { kind: "default" }, delivery: "pull-request", reason: "The API also needs to greet people." }] });
      const id = engine.addTask({ productId: first, title: "A greeting in both places" });
      const state = await until(engine, (state) => !!itemOf(state, id, "plan") || taskOf(state, id).state === "failed", coordinator([]));
      const folder = join(shop.dir, "confirmed-api");
      expect(taskOf(state, id).workRows![1]!.error).toContain("Needs adding");
      expect(() => engine.approve(itemOf(state, id, "plan")!.id)).toThrow();
      await engine.setTaskAddition(id, "acme/api", "Shop API", folder);
      expect(existsSync(folder)).toBe(false);
      engine.approve(itemOf(engine.getState(), id, "plan")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(existsSync(join(folder, ".git"))).toBe(true);
      expect(await git(folder, "branch", "--show-current")).toBe("main");
      expect(task.repositories!.every((work) => work.worktree !== folder)).toBe(true);
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);

    });
    });
  });
});
