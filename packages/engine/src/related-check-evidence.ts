// Small navigation leads from recorded check/build facts. No report, prompt or reviewer text crosses tasks.
import { existsSync } from "node:fs";
import type { CheckAttemptEvidence, CheckRepairEvidence, JourneyProductCheck, JourneyStep, RepositoryState, Task, TaskState } from "@petrina/core";
import type { Section } from "./context.js";
import type { Kernel } from "./kernel.js";
import type { RepositoryContext } from "./repository-context.js";
import { checksFor, commandText } from "./checks.js";
import * as git from "./git.js";

export const EVIDENCE_TASK_LIMIT = 24;
export const EVIDENCE_STEP_LIMIT = 64;
const EVIDENCE_ENTRY_LIMIT = 3;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fullSha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const short = (value: string, limit = 600) => value.replace(/\s+/g, " ").trim().slice(0, limit);

/** Only runner-marked, suite-qualified names; assertion prose and generic errors never identify a bug. */
export function namedCheckFailures(output: string): { name: string; file?: string }[] {
  const found: { name: string; file?: string }[] = [];
  let file: string | undefined;
  let size = 0;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/^@[^|]+\|\s*/, "").trim();
    // Bun's final summary repeats failures after unrelated files have run.
    if (/^\d+ tests? (?:failed|skipped):$/.test(line)) { file = undefined; continue; }
    const path = line.match(/^((?:[\w@. -]+\/)*[\w. -]+\.(?:test|spec)\.[\w.]+):?$/);
    if (path) { file = path[1]!.replace(/^\.\//, ""); continue; }
    const match = line.match(/^\(fail\)\s+(.+)$/i) ?? line.match(/^FAIL\s+(.+)$/);
    if (!match) continue;
    let name = match[1]!.replace(/(?:\s*\[[\d.]+\s*(?:ms|s)\]|\s*\([\d.]+\s*(?:ms|s)\)|\s{2,}[\d.]+\s*(?:ms|s))\s*$/, "").trim();
    let namedFile = file;
    const vitest = name.match(/^(\S+\.(?:test|spec)\.[\w.]+)\s*>\s*(.+)$/);
    if (vitest) { namedFile = vitest[1]!.replace(/^\.\//, ""); name = vitest[2]!; }
    name = name.replace(/\s*>\s*/g, " > ").replace(/\s+/g, " ");
    if (!/^.+ > .+$/.test(name) || name.length > 800 || (namedFile?.length ?? 0) > 200) continue;
    // A fileless summary must not duplicate or weaken known inline file identities.
    if (found.some((entry) => entry.name === name && (!namedFile || entry.file === namedFile))) continue;
    size += name.length + (namedFile?.length ?? 0);
    if (size > 1000 || found.length === 6) break;
    found.push({ name, ...(namedFile ? { file: namedFile } : {}) });
  }
  return found;
}

function recordedNames(check: JourneyProductCheck): readonly { name: string; file?: string }[] {
  if (check.namedFailures) return check.namedFailures;
  const detail = check.detail ?? "";
  // Older diagnostics were sliced at 1,000 characters. Their last line may be only part of a name.
  return namedCheckFailures(detail.length >= 1000 ? detail.slice(0, Math.max(0, detail.lastIndexOf("\n"))) : detail);
}

type EvidenceStep = Pick<JourneyStep, "id" | "kind" | "startedAt" | "endedAt" | "end" | "productChecks" | "checkAttempts" | "checkRepairs" | "checkReviews" | "buildVersions" | "buildProductId">;
export interface CheckEvidenceTask {
  id: string;
  state: Task["state"];
  held?: boolean;
  journey: readonly EvidenceStep[];
  delivery?: RepositoryState["confirmedDelivery"];
}

/** The same restricted shape is used for live state and archived storage. */
export function projectCheckEvidence(task: TaskState, productId: string): CheckEvidenceTask | undefined {
  const work = (task.repositories ?? (task.repository ? [task.repository] : [])).find((work) => work.productId === productId);
  if (!work) return;
  return { id: task.id, state: task.state, held: task.held, delivery: work.confirmedDelivery,
    journey: (task.journey ?? []).slice(-EVIDENCE_STEP_LIMIT).map(({ id, kind, startedAt, endedAt, end, productChecks, checkAttempts, checkRepairs, checkReviews, buildVersions, buildProductId }) => ({ id, kind, startedAt, endedAt, end,
      productChecks: productChecks?.filter((entry) => entry.productId === productId).slice(-32),
      checkAttempts: checkAttempts?.filter((entry) => entry.productId === productId).slice(-8),
      checkRepairs: checkRepairs?.filter((entry) => entry.productId === productId).slice(-8),
      checkReviews: checkReviews?.filter((entry) => entry.productId === productId).slice(-8),
      ...(buildVersions?.[productId] ? { buildVersions: { [productId]: buildVersions[productId] } } : {}),
      ...(buildProductId === productId ? { buildProductId } : {}),
    })) };
}

export interface CheckFailureReference {
  nodeId: string;
  check: JourneyProductCheck & { run: NonNullable<JourneyProductCheck["run"]> };
  attempt: CheckAttemptEvidence;
}

function failures(journey: readonly EvidenceStep[], productId: string): CheckFailureReference[] {
  return journey.flatMap((step) => (step.productChecks ?? []).slice(-32).flatMap((check) => {
    const attempt = step.checkAttempts?.slice(-8).find((attempt) => attempt.id === check.attemptId && attempt.productId === productId);
    if (!attempt?.tree || !attempt.sha || !fullSha(attempt.tree) || !fullSha(attempt.sha) || check.productId !== productId || !check.id || !/(?:^|:)check-\d+$/.test(check.id) || !check.findingId || check.result !== "fail" || !check.run || check.run.ok || check.run.interrupted || check.run.timedOut || check.run.cleanupIncomplete || !attempt.commands.includes(check.run.command)) return [];
    return [{ nodeId: step.id, check: { ...check, run: check.run }, attempt }];
  }));
}

export function assignedCheckFailures(scope: RepositoryContext): CheckFailureReference[] {
  const { task, work } = scope;
  const ref = work.checks?.provenance;
  if (!task.fixing || !ref) return [];
  return failures((task.journey ?? []).slice(-EVIDENCE_STEP_LIMIT), work.productId).filter((failure) => failure.nodeId === ref.nodeId && failure.attempt.id === ref.attemptId
    && task.findings.some((finding) => finding.id === failure.check.findingId && finding.raisedBy === "petrina" && finding.status === "open" && (!task.repositories || finding.productIds?.includes(work.productId))));
}

export interface RelatedCheckCandidate {
  taskId: string;
  nodeId: string;
  at: number;
  failure: CheckFailureReference;
  repair: CheckRepairEvidence;
  names: string[];
  status: "claimed" | "checked" | "reviewed";
  delivery?: NonNullable<RepositoryState["confirmedDelivery"]>;
  active: boolean;
}

/** Deterministic overlap, not a claim that equal test names have equal causes. */
export function relatedCheckCandidates(own: readonly CheckFailureReference[], peers: readonly CheckEvidenceTask[], productId: string): RelatedCheckCandidate[] {
  const candidates: RelatedCheckCandidate[] = [];
  for (const peer of peers.slice(0, EVIDENCE_TASK_LIMIT * 2)) {
    const steps = peer.journey.slice(-EVIDENCE_STEP_LIMIT);
    const peerFailures = failures(steps, productId);
    const latestBuild = steps.findLast((step) => step.buildProductId === productId || step.buildVersions?.[productId]);
    const active = !peer.held && ["running", "waiting", "needs-you", "queued", "pr-open"].includes(peer.state);
    const latestRepair = steps.findLast((step) => step.end === "done" && step.checkRepairs?.some((repair) => repair.productId === productId));
    for (const step of steps) {
      if (step.end !== "done" || step.endedAt === undefined) continue;
      for (const repair of (step.checkRepairs ?? []).slice(-8)) {
        if (repair.productId !== productId || !fullSha(repair.sha) || !fullSha(repair.tree) || !repair.answer.text.trim()) continue;
        const failure = peerFailures.find((failure) => failure.nodeId === repair.failureNode && failure.check.id === repair.checkId && failure.attempt.id === repair.attemptId && failure.check.findingId === repair.findingId);
        if (!failure) continue;
        if (steps.indexOf(step) <= steps.findIndex((entry) => entry.id === failure.nodeId)) continue;
        const names = new Set<string>();
        for (const target of own) {
          if (target.check.run.command !== failure.check.run.command || !same(target.attempt.commands, failure.attempt.commands)) continue;
          const targetNames = recordedNames(target.check);
          const peerNames = recordedNames(failure.check);
          for (const name of targetNames) if (peerNames.some((other) => other.name === name.name && (!name.file || !other.file || name.file === other.file))) names.add(name.name);
        }
        if (!names.size) continue;
        const supersededFailure = peerFailures.some((other) => other.check.run.command === failure.check.run.command && steps.findIndex((entry) => entry.id === other.nodeId) > steps.findIndex((entry) => entry.id === failure.nodeId));
        const delivery = peer.delivery;
        if (latestRepair !== step || supersededFailure) continue;
        const current = active && !delivery && (!latestBuild || latestBuild.end === "done" && latestBuild.buildVersions?.[productId] === repair.tree);
        if (!current && !delivery) continue;
        const checked = steps.some((entry) => entry.end === "done" && entry.endedAt !== undefined && entry.checkAttempts?.some((attempt) => attempt.productId === productId && attempt.tree === repair.tree && attempt.definition === repair.definition && attempt.passed && same(attempt.commands, repair.commands)));
        const reviewed = steps.some((entry) => entry.end === "done" && entry.endedAt !== undefined && entry.checkReviews?.some((review) => review.productId === productId && review.tree === repair.tree));
        candidates.push({ taskId: peer.id, nodeId: step.id, at: step.endedAt, failure, repair, names: [...names].slice(0, 2), status: reviewed ? "reviewed" : checked ? "checked" : "claimed", ...(delivery ? { delivery } : {}), active: current });
      }
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  // Bound delivery probes separately: included deliveries must not crowd out active repairs.
  return [...candidates.filter((candidate) => candidate.delivery).slice(0, 8),
    ...candidates.filter((candidate) => candidate.active).slice(0, EVIDENCE_ENTRY_LIMIT)];
}

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
