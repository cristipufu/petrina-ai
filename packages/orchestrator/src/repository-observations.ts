import type { RuntimeTask } from "./model.js";
import { scopesFor } from "./repository-context.js";
import type { CommittedCode, RepositoryObservationQueries } from "./ports/repository-observations.js";

/** Fresh committed identities for one operation, with each fingerprint pinned to its observed head. */
export async function observeCommittedCode(task: RuntimeTask, queries: RepositoryObservationQueries): Promise<CommittedCode> {
  const results = await Promise.allSettled(scopesFor(task).map(async scope => {
    const { productId, baseSha } = scope.work;
    const reader = queries.bind(scope);
    const version = await reader?.committed();
    if (!reader || !version) return { productId, tree: "unavailable", change: "unavailable" };
    const { head, tree } = version;
    const change = baseSha ? await reader.change(baseSha, head) : undefined;
    return { productId, tree, change: change ?? "unavailable" };
  }));
  // A failed owner cannot let recovery remove copies while a peer still reads them.
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const rows = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  return {
    versions: Object.fromEntries(rows.map(row => [row.productId, row.tree])),
    changes: Object.fromEntries(rows.map(row => [row.productId, row.change])),
  };
}
