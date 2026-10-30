import type { CheckEvidenceTask } from "@petrina/core";
import * as git from "./git.js";
const fullSha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export interface ObservedWorktreeHistory {
  head: string;
  currentTree: string;
  clean: boolean;
  verifiedDeliveryTrees?: ReadonlyMap<string, string>;
  ancestryCache?: Map<string, Promise<boolean>>;
}

export async function checkObjectTypes(path: string, specs: readonly string[], timeoutMs = 1000): Promise<Map<string, { oid: string; type: string }>> {
  const unique = [...new Set(specs.filter((spec) => spec && !spec.startsWith("-") && !spec.includes("\n") && !spec.includes("\0")))];
  const resolved = new Map<string, { oid: string; type: string }>();
  if (!unique.length) return resolved;
  const fast = git.readLooseObjectTypes(path, unique);
  if (fast) return fast;
  const checked = await git.run(["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"], path, `${unique.join("\n")}\n`, { timeoutMs });
  if (checked.code !== 0) return resolved;
  const lines = checked.stdout.split("\n");
  for (let index = 0; index < unique.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (commit|tree|blob|tag)$/.exec(line);
    if (match) resolved.set(unique[index]!, { oid: match[1]!, type: match[2]! });
  }
  return resolved;
}

/** An absent object, invalid identity or inconclusive Git result cannot establish a missing delivery. */
export async function deliveryMissing(
  path: string,
  repo: string,
  delivery: NonNullable<CheckEvidenceTask["delivery"]>,
  observed?: ObservedWorktreeHistory,
): Promise<boolean> {
  if (delivery.repo !== repo || !fullSha(delivery.sha) || !fullSha(delivery.tree)) return false;
  const run = (args: string[]) => git.run(["git", ...args], path, undefined, { timeoutMs: 1000 });
  let head: string;
  let currentTree: string;
  let deliveryTree: string | undefined;
  if (observed) {
    if (!observed.clean || !fullSha(observed.head) || !fullSha(observed.currentTree)) return false;
    head = observed.head;
    currentTree = observed.currentTree;
    deliveryTree = observed.verifiedDeliveryTrees?.get(delivery.sha);
    if (deliveryTree === undefined && !observed.verifiedDeliveryTrees) {
      const checked = await checkObjectTypes(path, [`${delivery.sha}^{commit}`, `${delivery.sha}^{tree}`]);
      if (checked.get(`${delivery.sha}^{commit}`)?.type === "commit") deliveryTree = checked.get(`${delivery.sha}^{tree}`)?.oid;
    }
  } else {
    const fastStatus = git.readFastTrackedWorktreeHead(path);
    if (fastStatus) {
      if (!fastStatus.clean || !fullSha(fastStatus.head)) return false;
      head = fastStatus.head;
    } else {
      const status = await run(["status", "--porcelain=v2", "--branch", "--untracked-files=no"]);
      if (status.code !== 0) return false;
      const lines = status.stdout.split("\n").filter(Boolean);
      const branchHead = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13) ?? "";
      if (!fullSha(branchHead) || lines.some((line) => !line.startsWith("#"))) return false;
      head = branchHead;
    }
    const checked = await checkObjectTypes(path, [`${delivery.sha}^{commit}`, `${delivery.sha}^{tree}`, `${head}^{tree}`]);
    if (checked.get(`${delivery.sha}^{commit}`)?.type !== "commit") return false;
    deliveryTree = checked.get(`${delivery.sha}^{tree}`)?.oid;
    const resolvedCurrent = checked.get(`${head}^{tree}`);
    if (resolvedCurrent?.type !== "tree") return false;
    currentTree = resolvedCurrent.oid;
  }
  if (!deliveryTree || deliveryTree !== delivery.tree || currentTree === delivery.tree || delivery.sha === head) return false;
  // HEAD includes the prepared base after normal updates. The task's original starting commit is irrelevant.
  // `merge-base A B` exits 0 with stdout === A iff A is an ancestor of B, and stdout !== A iff they share history without A in B.
  const checkHistory = async () => {
    const fastBase = git.readFastLooseMergeBase(path, delivery.sha, head);
    if (fastBase) return Boolean(fastBase.oid && fullSha(fastBase.oid) && fastBase.oid !== delivery.sha);
    const base = await run(["merge-base", delivery.sha, head]);
    return base.code === 0 && fullSha(base.stdout) && base.stdout !== delivery.sha;
  };
  if (observed?.ancestryCache) {
    let pending = observed.ancestryCache.get(delivery.sha);
    if (!pending) {
      pending = checkHistory();
      observed.ancestryCache.set(delivery.sha, pending);
    }
    return pending;
  }
  return checkHistory();
}
