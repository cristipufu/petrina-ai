import type { CheckEvidenceTask } from "@petrina/core";
import * as git from "./git.js";
const fullSha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

/** An absent object, invalid identity or inconclusive Git result cannot establish a missing delivery. */
export async function deliveryMissing(path: string, repo: string, delivery: NonNullable<CheckEvidenceTask["delivery"]>): Promise<boolean> {
  if (delivery.repo !== repo || !fullSha(delivery.sha) || !fullSha(delivery.tree)) return false;
  const run = (args: string[]) => git.run(["git", ...args], path, undefined, { timeoutMs: 1000 });
  const head = await run(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.code !== 0 || !fullSha(head.stdout)) return false;
  const clean = await run(["status", "--porcelain", "--untracked-files=no"]);
  if (clean.code !== 0 || clean.stdout) return false;
  const tree = await run(["rev-parse", "--verify", `${delivery.sha}^{tree}`]);
  if (tree.code !== 0 || tree.stdout !== delivery.tree) return false;
  const currentTree = await run(["rev-parse", "--verify", `${head.stdout}^{tree}`]);
  if (currentTree.code !== 0 || currentTree.stdout === delivery.tree) return false;
  // HEAD includes the prepared base after normal updates. The task's original starting commit is irrelevant.
  const included = await run(["merge-base", "--is-ancestor", delivery.sha, head.stdout]);
  if (included.code !== 1) return false;
  const base = await run(["merge-base", delivery.sha, head.stdout]);
  return base.code === 0 && fullSha(base.stdout);
}
