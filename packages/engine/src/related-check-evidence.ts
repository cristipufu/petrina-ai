// Small navigation leads from recorded check/build facts. No report, prompt or reviewer text crosses tasks.
import { existsSync } from "node:fs";
import { EVIDENCE_TASK_LIMIT } from "@petrina/core";
import type { Section } from "./context.js";
import type { Kernel } from "./kernel.js";
import type { RepositoryContext } from "@petrina/orchestrator";
import { checksFor, commandText } from "./checks.js";
import * as git from "@petrina/repositories/git";

const EVIDENCE_ENTRY_LIMIT = 3;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const short = (value: string, limit = 600) => value.replace(/\s+/g, " ").trim().slice(0, limit);
import { assignedCheckFailures, projectCheckEvidence, relatedCheckCandidates } from "@petrina/core";
export { namedCheckFailures, projectCheckEvidence, assignedCheckFailures, relatedCheckCandidates, type CheckFailureReference, type RelatedCheckCandidate } from "@petrina/core";

import { deliveryMissing } from "@petrina/repositories/check-evidence";
export { deliveryMissing } from "@petrina/repositories/check-evidence";

export async function relatedCheckEvidence(k: Kernel, scope: RepositoryContext): Promise<Section[]> {
  const own = assignedCheckFailures(scope);
  const product = k.productOf(scope);
  if (!own.length || !product || !scope.work.worktree) return [];
  const commands = checksFor(product, scope.work.worktree).filter((check) => check.argv.length).map((check) => commandText(check.argv));
  const relevant = own.filter((failure) => same(commands, failure.attempt.commands));
  if (!relevant.length) return [];
  const ids = new Set(k.s.tasks.map((task) => task.id));
  const live = k.s.tasks.filter((task) => task.id !== scope.task.id && (task.repositories ?? (task.repository ? [task.repository] : [])).some((work) => work.productId === scope.work.productId))
    .sort((a, b) => (b.journey?.at(-1)?.startedAt ?? 0) - (a.journey?.at(-1)?.startedAt ?? 0)).slice(0, EVIDENCE_TASK_LIMIT);
  const peers = live.flatMap((task) => projectCheckEvidence(task, scope.work.productId) ?? []);
  peers.push(...k.store.history.checkEvidence(scope.work.productId).filter((task) => !ids.has(task.id) && task.id !== scope.task.id));
  const entries: string[] = [];
  for (const candidate of relatedCheckCandidates(relevant, peers, scope.work.productId)) {
    const delivery = candidate.delivery && await deliveryMissing(scope.work.worktree, product.repo, candidate.delivery) ? candidate.delivery : undefined;
    if (!delivery && !candidate.active) continue;
    const { failure, repair } = candidate;
    const log = failure.check.run.logPath;
    const inspect = (tree: string) => git.run(["git", "cat-file", "-e", `${tree}^{tree}`], scope.work.worktree!, undefined, { timeoutMs: 1000 });
    const [snapshot, failingSnapshot] = await Promise.all([inspect(repair.tree), inspect(failure.attempt.tree!)]);
    entries.push([
      `- Shared named failure: ${candidate.names.map((name) => JSON.stringify(name)).join(", ")}`,
      `  Task ${candidate.taskId}; failure node ${failure.nodeId}; check ${failure.check.id} (${short(failure.check.run.name, 100)}); attempt ${failure.attempt.id}; command ${short(failure.check.run.command, 300)}.`,
      `  Saved check log: ${log ? JSON.stringify(log) + (!existsSync(log) ? " (unavailable)" : failure.check.run.logError || failure.check.run.logComplete === false ? " (incomplete)" : "") : "not recorded"}.`,
      `  Failing code: commit ${failure.attempt.sha}, tree ${failure.attempt.tree}${failingSnapshot.code !== 0 ? " (snapshot unavailable)" : ""}.`,
      `  Repair node ${candidate.nodeId}; ${new Date(candidate.at).toISOString()}; ${candidate.status} for commit ${repair.sha}, tree ${repair.tree}${snapshot.code !== 0 ? " (snapshot unavailable)" : ""}.`,
      `  Builder's check-specific answer (${repair.answer.fixed ? "candidate repair" : "diagnosis"}): ${JSON.stringify(short(repair.answer.text))}`,
      ...(delivery ? [`  Separately confirmed landed contents: ${delivery.repo} · ${short(delivery.branch, 150)}, commit ${delivery.sha}, tree ${delivery.tree}; ${new Date(delivery.at).toISOString()}. This delivery is absent from the current prepared history; delivery does not prove the earlier diagnosis or candidate.`] : []),
    ].join("\n"));
    if (entries.length === EVIDENCE_ENTRY_LIMIT) break;
  }
  return entries.length ? [{ title: "Related check evidence", body: `Navigation leads only: a shared test name does not establish a shared cause, or a pre-existing or flaky failure. Inspect applicability to your current code and prove your own repair with normal checks and independent review. Do not copy an unreviewed repair automatically or wait for another task. Status belongs only to the named snapshot.\n${entries.join("\n")}` }] : [];
}
