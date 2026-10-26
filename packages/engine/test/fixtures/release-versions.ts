import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { directDrivers, closeDirectDrivers } from "./direct-drivers.js";
import { queuePreparedDelivery } from "./queued-delivery.js";
import { legacyDeliveryAgents } from "./legacy-delivery-agents.js";
import { finish, git, gitWith, makeWorld, taskOf, tempDir, type World } from "../support.js";
import type { Engine } from "../engine.js";
import type { Task } from "@petrina/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const release = async (w: World, tag: string, at: string) => {
  await gitWith({}, "--git-dir", w.remote, "update-ref", `refs/tags/${tag}`, at);
  w.setGitHub((github) => github.releases.push({ tagName: tag, url: `https://github.com/acme/demo/releases/tag/${tag}`, publishedAt: new Date().toISOString(), isDraft: false, name: tag, body: "" }));
};

export const pkg = (version: string) => `${JSON.stringify({ name: "demo", version }, null, 2)}\n`;

/** Files committed on main and pushed to the stand-in GitHub. */
export const commitFiles = async (w: World, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(w.clone, file)), { recursive: true });
    writeFileSync(join(w.clone, file), text);
  }
  await git(w.clone, "add", ".");
  await git(w.clone, "commit", "-q", "-m", "Version files");
  await git(w.clone, "push", "-q", w.remote, "main");
};

type WorldOptions = Pick<NonNullable<Parameters<typeof makeWorld>[1]>, "version" | "address" | "objectFormat">;

interface ReleaseVersionWorld {
  world: World;
  /** An actual Engine generation; direct calls and readiness belong to its lifetime before invocation. */
  engine<T>(body: (engine: Engine) => Promise<T>): Promise<T>;
  /** The full Planner/Builder/review/delivery journey, for native cross-phase regressions. */
  deliver(mode: "release" | "local" | "pull-request", count?: number): Promise<Task[]>;
  /** Actual release checks and publication, given an already built/reviewed private change. */
  preparedRelease(): Promise<Task[]>;
}

/** Case-owned Git/GitHub worlds; failed or incomplete work is never disposed by a blind folder sweep. */
export function releaseVersionFixtures() {
  const owners = new Set<ReturnType<typeof directDrivers>>();
  let closing = false;
  const close = async () => { closing = true; await closeDirectDrivers(owners); owners.clear(); };

  async function world<T>(name: string, options: WorldOptions, body: (fixture: ReleaseVersionWorld) => Promise<T>): Promise<T> {
    if (closing) throw new Error("Release version fixtures are closing; no new world may start");
    const root = tempDir(`petrina-release-${name}-`), lifetime = directDrivers(root);
    owners.add(lifetime);
    const dispose = async () => { await lifetime.close(); owners.delete(lifetime); };
    const result = await setupWithCleanup(async () => {
      const made = await lifetime.prepare(() => makeWorld(name, { ...options, owner: { root, open: (data, merged) => lifetime.open(data, merged) } }));
      const engine = async <V>(run: (engine: Engine) => Promise<V>): Promise<V> => {
        const current = made.start(legacyDeliveryAgents(made));
        // Cleanup remains outside generation.run: stopping a generation cannot await its own close.
        const value = await setupWithCleanup(() => lifetime.run(current, async () => {
          await current.waitUntilReady();
          return run(current);
        }), () => lifetime.stop(current));
        await lifetime.stop(current);
        return value;
      };
      const deliver: ReleaseVersionWorld["deliver"] = (mode, count = 1) => engine(async current => {
        const productId = await current.addProduct(made.clone);
        current.setProductDelivery(productId, mode, false);
        const tasks: Task[] = [];
        for (let index = 0; index < count; index += 1) {
          const taskId = current.addTask({ productId, title: `Add greeting ${index + 1}`, description: "A greeting file. [quick]" });
          tasks.push(taskOf(await finish(current, taskId), taskId));
        }
        return tasks;
      });
      const preparedRelease = () => engine(async current => {
        const productId = await current.addProduct(made.clone);
        current.setProductDelivery(productId, "release", false);
        const id = await queuePreparedDelivery(current, { productId, title: "Add greeting 1", description: "A greeting file. [quick]" });
        const task = taskOf(await finish(current, id), id);
        if (task.journey?.some(step => step.kind === "agent" && current.role(step.roleId!, current.task(id))?.result !== "delivery"))
          throw new Error("An approved release-version boundary started an unrelated workflow participant");
        return [task];
      });
      return lifetime.prepare(() => body({ world: made, engine, deliver, preparedRelease }));
    }, dispose);
    await dispose();
    return result;
  }

  return { world, close };
}
