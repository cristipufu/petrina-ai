import { scopesFor, type CommittedVersion, type RepositoryObservationQueries, type RepositoryVersionReader } from "../../src/index.js";
import { repositoryTask } from "./tasks.js";

/** Script observations, not Git or fingerprint algorithms. Unknown owners/inputs fail the case. */
export function observationFixture(shared = true) {
  const task = repositoryTask(shared);
  const versions = new Map<string, CommittedVersion | undefined>();
  const changes = new Map<string, string | undefined>();
  const readers = new Map<string, RepositoryVersionReader | undefined>();
  const calls: { kind: "bind" | "committed" | "change"; productId: string; base?: string; head?: string }[] = [];
  const key = (productId: string, base: string, head: string) => JSON.stringify([productId, base, head]);
  for (const { work } of scopesFor(task)) {
    const id = work.productId;
    work.baseSha = `base-${id}`;
    work.worktree = `workspace-${id}`;
    versions.set(id, { head: `head-${id}`, tree: `tree-${id}` });
    changes.set(key(id, work.baseSha, `head-${id}`), `change-${id}`);
    readers.set(id, {
      async committed() { calls.push({ kind: "committed", productId: id }); const value = versions.get(id); return value && { ...value }; },
      async change(base, head) {
        calls.push({ kind: "change", productId: id, base, head });
        const input = key(id, base, head);
        if (!changes.has(input)) throw new Error(`Unexpected fingerprint input: ${input}`);
        return changes.get(input);
      },
    });
  }
  const queries: RepositoryObservationQueries = { bind(scope) {
    const id = scope.work.productId; calls.push({ kind: "bind", productId: id });
    if (!readers.has(id)) throw new Error(`Unexpected repository owner: ${id}`);
    return readers.get(id);
  } };
  return { task, queries, calls, versions, changes, readers, key };
}
