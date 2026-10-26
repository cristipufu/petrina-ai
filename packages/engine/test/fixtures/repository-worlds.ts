import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { completeAll } from "@petrina/core";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { SLOW } from "@petrina/test-support/slow";
import { makeWorld, tempDir, type World } from "../support.js";
import { removeFixtureRoot } from "./direct-drivers.js";

type Recipe = Pick<NonNullable<Parameters<typeof makeWorld>[1]>, "version" | "address" | "objectFormat">;
type PreparedWorld = Omit<World, "start" | "browsers">;
export interface RepositoryWorldScope {
  readonly root: string;
  readonly signal: AbortSignal;
  make(name: string, options?: Recipe): Promise<PreparedWorld>;
  run<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** Private repository fixtures without an Engine; canonical operations own setup and native peers. */
export function repositoryWorldFixtures() {
  const active = new Set<{ owner: FixtureOperations; accepting: boolean; close(): Promise<void> }>();
  const retained = new Set<string>();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void, failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    const batch = [...active];
    for (const entry of batch) entry.accepting = false;
    void completeAll(batch.map(entry => entry.close())).then(() => {
      closing = undefined; done();
    }, error => { closing = undefined; failed(error); });
    return closing;
  };
  return { close, retained,
    async use<T>(name: string, body: (scope: RepositoryWorldScope) => Promise<T>, resources?: { stopPeers(): void | Promise<void> }): Promise<T> {
      if (closing) throw new Error("Repository fixtures are closing; no new case may open");
      const root = tempDir("petrina-" + name + "-"), controller = new AbortController();
      const owner = new FixtureOperations({
        label: "Repository fixture at " + root,
        allowanceMs: CLEANUP_MS * SLOW,
        arm(expired, ms) { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); },
        stop() {
          const requests: Promise<void>[] = [];
          try { controller.abort(); } catch (error) { requests.push(Promise.reject(error)); }
          try { requests.push(Promise.resolve(resources?.stopPeers())); } catch (error) { requests.push(Promise.reject(error)); }
          return completeAll(requests).then(() => undefined);
        },
        dispose: () => removeFixtureRoot(root),
      });
      let observed = false;
      const entry = { owner, accepting: true, close: (): Promise<void> => {
        entry.accepting = false;
        const result = owner.close();
        if (!observed) {
          observed = true;
          void result.then(() => { active.delete(entry); }, () => { active.delete(entry); retained.add(root); });
        }
        return result;
      } };
      // The file's fallback can reach this owner before the first seed, Git call or peer starts.
      active.add(entry);
      const run = <V>(start: (signal: AbortSignal) => Promise<V>): Promise<V> => entry.accepting
        ? owner.run(() => start(controller.signal))
        : Promise.reject(new Error("Repository fixture is closing; no new operation may start"));
      const scope: RepositoryWorldScope = { root, signal: controller.signal, run,
        make: (label, options = {}) => run(async () => {
          const folder = join(root, label);
          mkdirSync(folder, { recursive: true });
          const made = await makeWorld(label, { ...options, owner: { root: folder,
            open() { throw new Error("Repository-only fixtures never open an Engine"); },
          } });
          const { start: _start, browsers: _browsers, ...prepared } = made;
          return prepared;
        }),
      };
      const result = await setupWithCleanup(() => run(() => body(scope)), () => entry.close());
      await entry.close();
      return result;
    },
  };
}
