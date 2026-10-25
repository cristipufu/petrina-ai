import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type State } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Store } from "@petrina/storage/store";
import { setupFixtures } from "../../fixtures/setup.js";

const { fresh, agents, makeGitHubClone } = setupFixtures();

describe("Setup and the first task", () => {
it("starts a fresh install on first run, keeps where it got to, and finishes it once the first task is saved", async () => {
    const data = fresh("data");
    const repo = await makeGitHubClone(fresh("shop"));
    let engine = new Engine(data, { agentCommand: agents({}) });
    try {
      expect(engine.getState().setup).toMatchObject({ done: false });
      engine.setSetupStep("tools");
      engine.setSetupStep("product");
      engine.setSetupStep("welcome");
      expect(engine.getState().setup?.step).toBe("product");
      const productId = await engine.addProduct(repo);
      await engine.shutdown();
      // Closed partway: it reopens where it got to.
      engine = new Engine(data, { agentCommand: agents({}) });
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
      await engine.shutdown();
      engine = new Engine(data, { agentCommand: agents({}) });
      expect(engine.getState().setup).toMatchObject({ done: true, firstTaskId: id, tipDismissed: true });
      expect(engine.getState().tasks).toHaveLength(2);
    } finally {
      await engine.shutdown();
    }
  });
it("never shows first run to an install that already has products or tasks, and Skip setup is for good", async () => {
    const existing = fresh("data");
    mkdirSync(existing, { recursive: true });
    const store = new Store(join(existing, "petrina.db"));
    const blank = new Engine(fresh("data"));
    const before = structuredClone(blank.getState());
    await blank.shutdown();
    store.save({ ...before, setup: undefined, products: [{ id: "shop", name: "Shop", repo: "acme/shop", tone: "blue" }] } as unknown as State);
    store.close();
    const updated = new Engine(existing);
    expect(updated.getState().setup?.done).toBe(true);
    await updated.shutdown();

    const data = fresh("data");
    let engine = new Engine(data);
    expect(engine.getState().setup?.done).toBe(false);
    engine.skipSetup();
    await engine.shutdown();
    engine = new Engine(data);
    expect(engine.getState().setup?.done).toBe(true);
    await engine.shutdown();
  });
it("opens only its own guides", async () => {
    const engine = new Engine(fresh("data"));
    try {
      expect(() => engine.openGuide("https://example.com/")).toThrow("only opens the guides");
    } finally {
      await engine.shutdown();
    }
  });
});
