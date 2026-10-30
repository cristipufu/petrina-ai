import { EVIDENCE_STEP_LIMIT, EVIDENCE_TASK_LIMIT, type CheckEvidenceTask, type CheckEvidenceStep } from "./related-check-contract.js";
import { checkOutcome } from "./check-outcome.js";
import type { CheckAttemptEvidence, CheckRepairEvidence, JourneyProductCheck, RepositoryState, TaskState } from "./model.js";

const EVIDENCE_ENTRY_LIMIT = 3;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fullSha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

/** Only runner-marked, suite-qualified names; assertion prose and generic errors never identify a bug. */
export function namedCheckFailures(output: string): { name: string; file?: string }[] {
  const found: { name: string; file?: string }[] = [];
  let file: string | undefined;
  let size = 0;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/^@[^|]+\|\s*/, "").trim();
    // Bun's final summary repeats failures after unrelated files have run.
    if (/^\d+ tests? (?:failed|skipped):$/.test(line)) {
      file = undefined;
      continue;
    }
    const path = line.match(/^((?:[\w@. -]+\/)*[\w. -]+\.(?:test|spec)\.[\w.]+):?$/);
    if (path) {
      file = path[1]!.replace(/^\.\//, "");
      continue;
    }
    const match = line.match(/^\(fail\)\s+(.+)$/i) ?? line.match(/^FAIL\s+(.+)$/);
    if (!match) continue;
    let name = match[1]!.replace(/(?:\s*\[[\d.]+\s*(?:ms|s)\]|\s*\([\d.]+\s*(?:ms|s)\)|\s{2,}[\d.]+\s*(?:ms|s))\s*$/, "").trim();
    let namedFile = file;
    const vitest = name.match(/^(\S+\.(?:test|spec)\.[\w.]+)\s*>\s*(.+)$/);
    if (vitest) {
      namedFile = vitest[1]!.replace(/^\.\//, "");
      name = vitest[2]!;
    }
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


/** The same restricted shape is used for live state and archived storage. */
export function projectCheckEvidence(task: TaskState, productId: string): CheckEvidenceTask | undefined {
  const work = (task.repositories ?? (task.repository ? [task.repository] : [])).find((work) => work.productId === productId);
  if (!work) return;
  return { id: task.id, state: task.state, held: task.held, delivery: work.confirmedDelivery,
    journey: (task.journey ?? []).slice(-EVIDENCE_STEP_LIMIT).map(({
      id,
      kind,
      startedAt,
      endedAt,
      end,
      productChecks,
      checkAttempts,
      checkRepairs,
      checkReviews,
      buildVersions,
      buildProductId
    }) => ({ id, kind, startedAt, endedAt, end,
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

function failures(journey: readonly CheckEvidenceStep[], productId: string): CheckFailureReference[] {
  return journey.flatMap((step) => (step.productChecks ?? []).slice(-32).flatMap((check) => {
    const attempt = step.checkAttempts?.slice(-8).find((attempt) => attempt.id === check.attemptId && attempt.productId === productId);
    if (!attempt?.tree || !attempt.sha || !fullSha(attempt.tree) || !fullSha(attempt.sha) || check.productId !== productId || !check.id || !/(?:^|:)check-\d+$/.test(check.id) || !check.findingId || check.result !== "fail" || !check.run || checkOutcome(check.run).kind !== "failed" || !attempt.commands.includes(check.run.command)) return [];
    return [{ nodeId: step.id, check: { ...check, run: check.run }, attempt }];
  }));
}

export function assignedCheckFailures(scope: { task: TaskState; work: RepositoryState }): CheckFailureReference[] {
  const { task, work } = scope;
  const ref = work.checks?.provenance;
  if (!task.fixing || !ref) return [];
  return failures(
    (task.journey ?? []).slice(-EVIDENCE_STEP_LIMIT),
    work.productId
  ).filter((failure) => failure.nodeId === ref.nodeId && failure.attempt.id === ref.attemptId
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
        const checked = steps.some((entry) => entry.end === "done" && entry.endedAt !== undefined && entry.checkAttempts?.some((attempt) => attempt.productId === productId && attempt.tree === repair.tree && attempt.definition === repair.definition && attempt.passed && same(
          attempt.commands,
          repair.commands
        )));
        const reviewed = steps.some((entry) => entry.end === "done" && entry.endedAt !== undefined && entry.checkReviews?.some((review) => review.productId === productId && review.tree === repair.tree));
        candidates.push({
          taskId: peer.id,
          nodeId: step.id,
          at: step.endedAt,
          failure,
          repair,
          names: [...names].slice(
          0,
          2
        ),
          status: reviewed ? "reviewed" : checked ? "checked" : "claimed",
          ...(delivery ? { delivery } : {}),
          active: current
        });
      }
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  // Bound delivery probes separately: included deliveries must not crowd out active repairs.
  return [...candidates.filter((candidate) => candidate.delivery).slice(0, 8),
    ...candidates.filter((candidate) => candidate.active).slice(0, EVIDENCE_ENTRY_LIMIT)];
}
