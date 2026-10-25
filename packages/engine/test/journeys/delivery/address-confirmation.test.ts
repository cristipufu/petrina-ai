import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { State } from "@petrina/core";
import { Engine } from "../../engine.js";
import { ADDRESS, coordinator, finish, git, itemOf, remoteRef, taskOf, until } from "../../support.js";
import { securityWorlds } from "../../fixtures/security.js";

const { world, forget, close } = securityWorlds();
afterAll(close);
describe.concurrent("Products added before Petrina kept their GitHub address", () => {
it("shows the current address once, keeps the answer, and then fetches and publishes there", async () => {
    const w = await world("confirm");
    let engine = w.start();
    const productId = await engine.addProduct(w.clone);
    engine.setProductDelivery(productId, "pull-request", false);
    await engine.shutdown();
    forget(w);
    engine = w.start();
    try {
      expect(engine.getState().products[0]!.remote).toBeUndefined();
      engine.setPoolPaused(true);
      const first = engine.addTask({ productId, title: "First", description: "A greeting file. [quick]" });
      const second = engine.addTask({ productId, title: "Second", description: "A greeting file. [quick]" });
      const addressQuestions = new Set<string>();
      engine.subscribe(() => { for (const item of engine.getState().inbox) if (item.title.startsWith(`Is ${ADDRESS} the GitHub address`)) addressQuestions.add(item.id); });
      engine.setPoolPaused(false);
      const asked = (state: State) => state.inbox.filter((item) => item.kind === "question" && item.title.startsWith(`Is ${ADDRESS} the GitHub address`));
      let state = await until(engine, (current) => asked(current).length > 0, coordinator([]));
      await Bun.sleep(300);
      state = engine.getState();
      expect(asked(state)).toHaveLength(1);
      expect(asked(state)[0]!.options?.[0]).toBe("Yes, use this address");
      engine.answer(asked(state)[0]!.id, "Yes, use this address");
      await until(engine, (current) => current.products[0]!.remote === ADDRESS, coordinator([]));
      const done = taskOf(await finish(engine, first), first);
      expect(done.state).toBe("pr-open");
      await finish(engine, second);
      expect(addressQuestions.size).toBe(1);
      expect(engine.getState().inbox.some((item) => item.title.startsWith("Is "))).toBe(false);
    } finally {
      await engine.shutdown();
    }
  });

it("stops credentialed work after a No, and still delivers locally", async () => {
    const w = await world("refuse");
    let engine = w.start();
    const productId = await engine.addProduct(w.clone);
    engine.setProductDelivery(productId, "pull-request", false);
    await engine.shutdown();
    forget(w);
    engine = w.start();
    try {
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const refuse = (current: Engine, state: State) => {
        for (const item of state.inbox) if (item.kind === "question" && item.title.startsWith("Is ")) current.answer(item.id, "No, it is not");
        coordinator()(current, state);
      };
      let task = taskOf(await finish(engine, taskId, refuse), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain(`you said ${ADDRESS} is not Clone's GitHub address`);
      expect(engine.getState().products[0]!.remoteRefused).toBe(ADDRESS);
      expect(w.github().calls).toEqual([]);
      expect(await remoteRef(w.remote, `refs/heads/${task.branch}`)).toBeUndefined();

      const local = engine.addTask({ productId, title: "Add a local greeting", description: "A greeting file. [quick]", delivery: "local", approveDelivery: false });
      task = taskOf(await finish(engine, local), local);
      expect(task.state).toBe("done");
      expect(await git(w.clone, "rev-parse", "main")).toBe(await git(w.clone, "rev-parse", task.branch!));
    } finally {
      await engine.shutdown();
    }
  });

it("publishes nothing when the saved address is not the product's repository", async () => {
    const w = await world("mismatch");
    let engine = w.start();
    const productId = await engine.addProduct(w.clone);
    engine.setProductDelivery(productId, "pull-request", false);
    await engine.shutdown();
    w.editSaved((state) => ((state.products[0] as { remote?: string }).remote = "git@github.com:evil/demo.git"));
    engine = w.start();
    try {
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toContain("Clone's address git@github.com:evil/demo.git is not acme/demo on GitHub");
      expect(w.github().calls).toEqual([]);
      expect(existsSync(join(w.remote, "refs", "heads", task.branch!))).toBe(false);
      expect(itemOf(engine.getState(), taskId, "stuck")).toBeDefined();
    } finally {
      await engine.shutdown();
    }
  });

});
