import { completeAll, type InboxKind } from "@petrina/core";
import type { Engine, EngineOptions } from "../engine.js";
import { Coordination } from "../../src/coordination.js";
import { engineCaseFixtures, type EngineCaseOwner } from "./engine-cases.js";

type Request = { prefix?: string; title?: string };
interface OwnedEngine { e: Engine; engine: Engine; home: string; owner: EngineCaseOwner }

/** The actual app/SQLite facade, with no repository, agent, demo or running workflow. */
export function coordinatorApiFixtures(options: Request = {}) {
  const owners = engineCaseFixtures();
  const useEngine = <T>(body: (fixture: OwnedEngine) => Promise<T>, request: { prefix: string; options: EngineOptions }): Promise<T> =>
    owners.use(request.prefix, owner => {
      const e = owner.open(owner.root, request.options);
      return body({ e, engine: e, home: owner.root, owner });
    });
  const use = <T>(body: (fixture: OwnedEngine & {
    c: Coordination; coordination: Coordination; taskId: string; task: NonNullable<ReturnType<Engine["task"]>>;
    offer(kind: InboxKind, body?: string): string;
    inspect(itemId: string): ReturnType<Coordination["call"]>;
  }) => Promise<T>, request: Request = {}): Promise<T> => useEngine(async fixture => {
    const { e, owner } = fixture;
    e.setPoolPaused(true);
    // This facade applies scheduling preferences without admitting unrelated provider turns.
    e.schedule = () => {};
    await e.waitUntilReady(); owner.check();
    await completeAll([...e.backgroundWork]); owner.check();
    e.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
    const taskId = e.addTask({ productId: "product", title: request.title ?? options.title ?? "First task" });
    const task = e.task(taskId)!, c = new Coordination(e);
    const offer = (kind: InboxKind, body = "Full request") => {
      const id = e.id("inbox");
      e.s.inbox.push({ id, kind, taskId, title: `A ${kind} request`, body, at: Date.now(), blocking: kind === "question" || kind === "permission" });
      return id;
    };
    return body({ ...fixture, c, coordination: c, taskId, task, offer, inspect: itemId => c.call("inbox.inspect", { itemId }) });
  }, { prefix: request.prefix ?? options.prefix ?? "petrina-coordinate-", options: { agentCommand: () => undefined } });
  return { use, useEngine, close: owners.close };
}
