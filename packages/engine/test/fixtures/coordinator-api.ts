import type { InboxKind } from "@petrina/core";
import { Engine } from "../engine.js";
import { Coordination } from "../../src/coordination.js";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

/** The actual app/SQLite facade, with no repository, agent, demo or running workflow. */
export function coordinatorApiFixtures(options: { prefix?: string; title?: string } = {}) {
  const roots: string[] = [], engines: Engine[] = [];
  return { roots, engines,
    async fixture(request: { prefix?: string; title?: string } = {}) {
      const home = tempDir(request.prefix ?? options.prefix ?? "petrina-coordinate-");
      roots.push(home);
      const e = new Engine(home, { agentCommand: () => undefined });
      engines.push(e);
      e.setPoolPaused(true);
      // This facade contract applies scheduling preferences without admitting unrelated provider turns.
      // Launch-time admissionsClosed is a real draining state and cannot stand in for this effect.
      e.schedule = () => {};
      await e.waitUntilReady();
      await Promise.all([...e.backgroundWork]);
      e.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
      const taskId = e.addTask({ productId: "product", title: request.title ?? options.title ?? "First task" });
      const task = e.task(taskId)!, c = new Coordination(e);
      const offer = (kind: InboxKind, body = "Full request") => {
        const id = e.id("inbox");
        e.s.inbox.push({ id, kind, taskId, title: `A ${kind} request`, body, at: Date.now(), blocking: kind === "question" || kind === "permission" });
        return id;
      };
      return { e, engine: e, c, coordination: c, home, taskId, task, offer, inspect: (itemId: string) => c.call("inbox.inspect", { itemId }) };
    },
    async close() {
      // A failed stop remains visible and prevents deleting evidence that may still be owned.
      await Promise.all(engines.splice(0).map(engine => engine.shutdown()));
      roots.splice(0).forEach(removeDir);
    },
  };
}
