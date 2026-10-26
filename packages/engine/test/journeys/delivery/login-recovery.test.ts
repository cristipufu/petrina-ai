import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { engineProcessCases, Fakes, makeWorld, tempDir } from "../../support.js";
import { setupFixtures } from "../../fixtures/setup.js";

const { taskOf } = setupFixtures();
const cases = engineProcessCases();
afterEach(() => cases.close());

describe("Delivering to GitHub", () => {
  it("asks for a GitHub login before shipping, and nothing ships half way", async () => {
    const root = tempDir("petrina-login-");
    return cases.use(root, async owners => {
      const w = await makeWorld("login", { owner: { root, open() { throw new Error("This world uses the owned app process, never an in-process Engine"); } } });
      const fakes = new Fakes(w.dir);
      fakes.scenario({ planner: "short", builder: "plain" });
      w.setGitHub((github) => (github.loggedOut = true));
      // Its own process, the way the app runs it, with a folder standing in for GitHub.
      const engine = await owners.harness(join(w.dir, "home"), w.dir, w.remote);
      try {
        const productId = (await owners.run(engine, async () => engine.act("addProduct", w.clone))) as string;
        await owners.run(engine, async () => engine.act("setProductDelivery", productId, "pull-request", false));
        const taskId = (await owners.run(engine, async () => engine.act("addTask", { productId, title: "Add a greeting" }))) as string;
        let state = await owners.run(engine, async () => engine.until((current) => current.inbox.some((item) => item.kind === "stuck"), "a Stuck item"));
        const item = state.inbox.find((entry) => entry.kind === "stuck")!;
        expect(item.toolId).toBe("gh");
        expect(item.title).toContain("GitHub CLI isn't logged in");
        expect(item.body).toContain("not logged in");
        expect(taskOf(state, taskId).shipping).toBeUndefined();
        // Nothing went to GitHub: no branch, no pull request.
        expect(w.github().calls.filter((call) => call[1] === "create")).toEqual([]);
        expect(w.github().logins).toBeGreaterThan(0);

        w.setGitHub((github) => (github.loggedOut = false));
        await owners.run(engine, async () => engine.act("retry", item.id));
        state = await owners.run(engine, async () => engine.until((current) => ["pr-open", "failed"].includes(taskOf(current, taskId).state), "the pull request"));
        expect(taskOf(state, taskId).error).toBeUndefined();
        expect(taskOf(state, taskId).pr?.number).toBe(1);
        expect(w.github().prs).toHaveLength(1);
      } finally {
        await engine.quit();
      }

    });
  });
});
