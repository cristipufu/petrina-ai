import { completeAll } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import type { Engine } from "../engine.js";
import { coordinatorOwnedFixtures, type CoordinatorOwner } from "./coordinator-owned.js";

type Options = { prefix?: string; title?: string; productPath?: boolean; repo?: string; paused?: boolean };

/** Real private records and command composition, without repository or provider prerequisites. */
export function coordinatorRecordFixtures(options: Options = {}) {
  const owners = coordinatorOwnedFixtures();
  const use = <T>(body: (fixture: { engine: Engine; task: NonNullable<ReturnType<Engine["task"]>>; root: string;
    scope: ReturnType<typeof executionFor>; owner: CoordinatorOwner }) => Promise<T>, request: Options = {}): Promise<T> => {
    const input = { ...options, ...request };
    return owners.use(input.prefix ?? "petrina-coordinator-records-", async owner => {
      const root = owner.root, engine = owner.open({ admissionsClosed: true, agentCommand: () => undefined });
      await engine.waitUntilReady(); owner.check();
      await completeAll([...engine.backgroundWork]); owner.check();
      // Admission-refusal contracts retain the constructor's pool state; never resume a draining owner.
      if (input.paused ?? true) engine.setPoolPaused(true);
      engine.s.products.push({ id: "p", name: "Product", repo: input.repo ?? "local/p", tone: "blue", ...(input.productPath ? { path: root } : {}) });
      const task = engine.task(engine.addTask({ productId: "p", title: input.title ?? "A task", backlog: true }))!;
      return body({ engine, task, root, scope: executionFor(task), owner });
    });
  };
  return { use, useRoot: owners.use, close: owners.close };
}
