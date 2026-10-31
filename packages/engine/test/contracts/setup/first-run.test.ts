import { afterAll } from "bun:test";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type State } from "@petrina/core";
import { Store } from "@petrina/storage/store";
import { setupFixtures } from "../../fixtures/setup.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());


const { fresh, agents, makeGitHubClone } = setupFixtures();
const probe = { toolProbe: privateAgentToolProbe() };

describe("Setup and the first task", () => {
it("starts a fresh install on first run, keeps where it got to, and finishes it once the first task is saved", async () => {
  return engineCases.use("petrina-setup-case-", async caseOwner => {
    const data = fresh("data", caseOwner.root);
    const repo = await makeGitHubClone(fresh("shop", caseOwner.root));
    let engine = caseOwner.open(data, { agentCommand: agents({}), ...probe });
    try {
      expect(engine.getState().setup).toMatchObject({ done: false });
      engine.setSetupStep("tools");
      engine.setSetupStep("product");
      engine.setSetupStep("welcome");
      expect(engine.getState().setup?.step).toBe("product");
      const productId = await caseOwner.run(engine, async () => engine.addProduct(repo));
      await caseOwner.stop(engine);
      // Closed partway: it reopens where it got to.
      engine = caseOwner.open(data, { agentCommand: agents({}), ...probe });
      expect(engine.getState().setup).toMatchObject({ done: false, step: "product" });

      engine.setPoolPaused(true);
      const first = { productId, title: "Add a greeting", approvePlan: true, clientId: "first-task-1" };
      const id = engine.startFirstTask(first);
      // Sent again after the reply was lost: the same task, not a second card.
      expect(engine.startFirstTask(first)).toBe(id);
      expect(engine.getState().tasks).toHaveLength(1);
      expect(engine.getState().setup).toMatchObject({ done: true, firstTaskId: id });
      // A genuinely new task is never refused as a resend.
      engine.addTask({ productId, title: "Another", clientId: "other-1" });
      expect(engine.getState().tasks).toHaveLength(2);
      engine.dismissTip();
      await caseOwner.stop(engine);
      engine = caseOwner.open(data, { agentCommand: agents({}), ...probe });
      expect(engine.getState().setup).toMatchObject({ done: true, firstTaskId: id, tipDismissed: true });
      expect(engine.getState().tasks).toHaveLength(2);
    } finally {
      await caseOwner.stop(engine);
    }

  });
});
it("never shows first run to an install that already has products or tasks, and Skip setup is for good", async () => {
  return engineCases.use("petrina-setup-case-", async caseOwner => {
    const existing = fresh("data", caseOwner.root);
    mkdirSync(existing, { recursive: true });
    const store = new Store(join(existing, "petrina.db"));
    const closeStore = caseOwner.afterBody(() => store.close());
    const blank = caseOwner.open(fresh("data", caseOwner.root), probe);
    const before = structuredClone(blank.getState());
    await caseOwner.stop(blank);
    store.save({ ...before, setup: undefined, products: [{ id: "shop", name: "Shop", repo: "acme/shop", tone: "blue" }] } as unknown as State);
    await closeStore();
    const updated = caseOwner.open(existing, probe);
    expect(updated.getState().setup?.done).toBe(true);
    await caseOwner.stop(updated);

    const data = fresh("data", caseOwner.root);
    let engine = caseOwner.open(data, probe);
    expect(engine.getState().setup?.done).toBe(false);
    engine.skipSetup();
    await caseOwner.stop(engine);
    engine = caseOwner.open(data, probe);
    expect(engine.getState().setup?.done).toBe(true);
    await caseOwner.stop(engine);

  });
});
it("opens only its own guides", async () => {
  return engineCases.use("petrina-setup-case-", async caseOwner => {
    const engine = caseOwner.open(fresh("data", caseOwner.root), probe);
    try {
      expect(() => engine.openGuide("https://example.com/")).toThrow("only opens the guides");
    } finally {
      await caseOwner.stop(engine);
    }

  });
});
it("drops retired Node.js check rows and inbox tool references when loading an older saved database", async () => {
  return engineCases.use("petrina-setup-case-", async caseOwner => {
    const existing = fresh("data", caseOwner.root);
    mkdirSync(existing, { recursive: true });
    const store = new Store(join(existing, "petrina.db"));
    const closeStore = caseOwner.afterBody(() => store.close());
    const blank = caseOwner.open(fresh("data", caseOwner.root), probe);
    const before = structuredClone(blank.getState());
    await caseOwner.stop(blank);
    store.save({
      ...before,
      setup: {
        done: false,
        platform: "darwin",
        checks: [
          { id: "git", status: "ready" },
          { id: "node", status: "not-installed" },
          { id: "claude-code", status: "ready" },
        ],
      },
      inbox: [
        {
          id: "legacy-node-stuck",
          taskId: "t-legacy",
          kind: "stuck",
          title: "Legacy tool check",
          at: 1,
          blocking: false,
          toolId: "node",
          toolProblem: "not-installed",
        },
      ],
    } as unknown as State);
    await closeStore();
    const upgraded = caseOwner.open(existing, probe);
    try {
      expect(upgraded.getState().setup?.checks.map((check) => check.id)).toEqual(["git", "claude-code"]);
      expect(upgraded.getState().inbox[0]?.toolId).toBeUndefined();
      expect(upgraded.getState().inbox[0]?.toolProblem).toBeUndefined();
    } finally {
      await caseOwner.stop(upgraded);
    }
  });
});
});
