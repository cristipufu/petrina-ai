// Small navigation leads from recorded check/build facts. No report, prompt or reviewer text crosses tasks.
import { existsSync } from "node:fs";
import { EVIDENCE_TASK_LIMIT } from "@petrina/core";
import type { Section } from "./context.js";
import type { RepositoryContext, RuntimeTask } from "@petrina/orchestrator";
import type { CheckEvidenceTask, Product } from "@petrina/core";
import { checksFor, commandText } from "./checks.js";
import * as git from "@petrina/repositories/git";

const EVIDENCE_ENTRY_LIMIT = 3;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const short = (value: string, limit = 600) => value.replace(/\s+/g, " ").trim().slice(0, limit);
import { assignedCheckFailures, projectCheckEvidence, relatedCheckCandidates } from "@petrina/core";
export {
  namedCheckFailures,
  projectCheckEvidence,
  assignedCheckFailures,
  relatedCheckCandidates,
  type CheckFailureReference,
  type RelatedCheckCandidate
} from "@petrina/core";

import { checkObjectTypes, deliveryMissing, type ObservedWorktreeHistory } from "@petrina/repositories/check-evidence";
export { deliveryMissing } from "@petrina/repositories/check-evidence";

const fullSha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

export interface RelatedCheckEvidenceHost {
  readonly s: { readonly tasks: readonly RuntimeTask[] };
  productOf(scope: RepositoryContext): Product | undefined;
  readonly store: { readonly history: { checkEvidence(productId: string): readonly CheckEvidenceTask[] } };
}
export async function relatedCheckEvidence(k: RelatedCheckEvidenceHost, scope: RepositoryContext): Promise<Section[]> {
  const own = assignedCheckFailures(scope);
  const product = k.productOf(scope);
  const worktree = scope.work.worktree;
  if (!own.length || !product || !worktree) return [];
  const commands = checksFor(product, worktree).filter((check) => check.argv.length).map((check) => commandText(check.argv));
  const relevant = own.filter((failure) => same(commands, failure.attempt.commands));
  if (!relevant.length) return [];
  const ids = new Set(k.s.tasks.map((task) => task.id));
  const live = k.s.tasks.filter((task) => task.id !== scope.task.id && (task.repositories ?? (task.repository ? [task.repository] : [])).some((work) => work.productId === scope.work.productId))
    .sort((a, b) => (b.journey?.at(-1)?.startedAt ?? 0) - (a.journey?.at(-1)?.startedAt ?? 0)).slice(0, EVIDENCE_TASK_LIMIT);
  const peers = live.flatMap((task) => projectCheckEvidence(task, scope.work.productId) ?? []);
  peers.push(...k.store.history.checkEvidence(scope.work.productId).filter((task) => !ids.has(task.id) && task.id !== scope.task.id));
  const candidates = relatedCheckCandidates(relevant, peers, scope.work.productId);
  if (!candidates.length) return [];

  let observed: ObservedWorktreeHistory | undefined;
  const deliveryCandidates = candidates.filter((candidate) => candidate.delivery?.repo === product.repo && fullSha(candidate.delivery.sha) && fullSha(candidate.delivery.tree));
  if (deliveryCandidates.length) {
    const fastStatus = git.readFastTrackedWorktreeHead(worktree);
    let head = fastStatus?.head ?? "";
    let clean = fastStatus ? fastStatus.clean && fullSha(head) : false;
    if (!fastStatus) {
      const status = await git.run(["git", "status", "--porcelain=v2", "--branch", "--untracked-files=no"], worktree, undefined, { timeoutMs: 1000 });
      const lines = status.code === 0 ? status.stdout.split("\n").filter(Boolean) : [];
      head = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13) ?? "";
      clean = status.code === 0 && fullSha(head) && !lines.some((line) => !line.startsWith("#"));
    }
    if (clean) {
      const specs = [
        `${head}^{tree}`,
        ...deliveryCandidates.flatMap((candidate) => [
        `${candidate.delivery!.sha}^{commit}`,
        `${candidate.delivery!.sha}^{tree}`
      ])
      ];
      const checked = await checkObjectTypes(worktree, specs);
      const currentTree = checked.get(`${head}^{tree}`);
      if (currentTree?.type === "tree") {
        const verifiedDeliveryTrees = new Map<string, string>();
        for (const candidate of deliveryCandidates) {
          const sha = candidate.delivery!.sha;
          const tree = checked.get(`${sha}^{tree}`);
          if (checked.get(`${sha}^{commit}`)?.type === "commit" && tree?.type === "tree") verifiedDeliveryTrees.set(sha, tree.oid);
        }
        observed = { head, currentTree: currentTree.oid, clean: true, verifiedDeliveryTrees, ancestryCache: new Map() };
      }
    } else {
      observed = { head: "", currentTree: "", clean: false };
    }
  }

  const selected: { candidate: (typeof candidates)[number]; delivery?: NonNullable<CheckEvidenceTask["delivery"]> }[] = [];
  for (const candidate of candidates) {
    const delivery = candidate.delivery && await deliveryMissing(worktree, product.repo, candidate.delivery, observed) ? candidate.delivery : undefined;
    if (!delivery && !candidate.active) continue;
    selected.push({ candidate, ...(delivery ? { delivery } : {}) });
    if (selected.length === EVIDENCE_ENTRY_LIMIT) break;
  }
  if (!selected.length) return [];

  const treeSpecs = selected.flatMap(({ candidate }) => [`${candidate.repair.tree}^{tree}`, `${candidate.failure.attempt.tree!}^{tree}`]);
  const snapshots = await checkObjectTypes(worktree, treeSpecs);
  const entries = selected.map(({ candidate, delivery }) => {
    const { failure, repair } = candidate;
    const log = failure.check.run.logPath;
    const snapshotOk = snapshots.get(`${repair.tree}^{tree}`)?.type === "tree";
    const failingSnapshotOk = snapshots.get(`${failure.attempt.tree!}^{tree}`)?.type === "tree";
    return [
      `- Shared named failure: ${candidate.names.map((name) => JSON.stringify(name)).join(", ")}`,
      `  Task ${candidate.taskId}; failure node ${failure.nodeId}; check ${failure.check.id} (${short(
        failure.check.run.name,
        100
      )}); attempt ${failure.attempt.id}; command ${short(
        failure.check.run.command,
        300
      )}.`,
      `  Saved check log: ${log ? JSON.stringify(log) + (!existsSync(log) ? " (unavailable)" : failure.check.run.logError || failure.check.run.logComplete === false ? " (incomplete)" : "") : "not recorded"}.`,
      `  Failing code: commit ${failure.attempt.sha}, tree ${failure.attempt.tree}${!failingSnapshotOk ? " (snapshot unavailable)" : ""}.`,
      `  Repair node ${candidate.nodeId}; ${new Date(candidate.at).toISOString()}; ${candidate.status} for commit ${repair.sha}, tree ${repair.tree}${!snapshotOk ? " (snapshot unavailable)" : ""}.`,
      `  Builder's check-specific answer (${repair.answer.fixed ? "candidate repair" : "diagnosis"}): ${JSON.stringify(short(repair.answer.text))}`,
      ...(delivery ? [`  Separately confirmed landed contents: ${delivery.repo} · ${short(
        delivery.branch,
        150
      )}, commit ${delivery.sha}, tree ${delivery.tree}; ${new Date(delivery.at).toISOString()}. This delivery is absent from the current prepared history; delivery does not prove the earlier diagnosis or candidate.`] : []),
    ].join("\n");
  });
  return [{
    title: "Related check evidence",
    body: `Navigation leads only: a shared test name does not establish a shared cause, or a pre-existing or flaky failure. Inspect applicability to your current code and prove your own repair with normal checks and independent review. Do not copy an unreviewed repair automatically or wait for another task. Status belongs only to the named snapshot.\n${entries.join("\n")}`
  }];
}
