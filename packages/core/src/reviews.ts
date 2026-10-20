// How reviews are going, from what every task already records: how many rounds work takes to pass,
// what became of each finding, and how each reviewer profile's findings held up.

import type { Finding, Id, Task, Vote } from "./model.js";

/** The latest vote per proven actual tool. Older nominal attributions remain history, never guessed identities. */
export function independentVotes(votes: readonly Vote[] = []): Vote[] {
  return [...new Map(votes.filter((vote) => vote.toolId).map((vote) => [vote.toolId, vote])).values()];
}

/** A not-a-bug vote on a reopened finding rejects the new confirmation, not the earlier verified bug. */
export function isRejectedReopenOfVerifiedFix(finding: Pick<Finding, "reopenedAt" | "verification" | "earlierReviews">): boolean {
  return finding.reopenedAt !== undefined && finding.verification?.verdict === "not-a-bug" &&
    (finding.earlierReviews ?? []).some((round) => round.verification?.verdict === "real" && round.answer?.fixed === true);
}

export interface ReviewStats {
  /** Tasks whose review is over: passed, or handed to the coordinator with rounds used up. */
  reviewed: number;
  /** Passed tasks, bucketed by their highest numbered round across all review stages. */
  passed: { total: number; first: number; second: number; third: number; later: number };
  /** Mean highest numbered round for passed tasks; repeated visits at one round do not increase it. */
  meanRounds?: number;
  /** Deliveries the coordinator sent back after every reviewer had passed them. */
  sentBack: number;
  /** What became of the reviewers' findings (Petrina's own checks aside). */
  findings: FindingStats;
  /** Findings attributed to their recorded review role; older records mean Code reviewer. */
  roles: { roleId: Id; important: number; findings: FindingStats }[];
  /** Per reviewer profile, most findings first. */
  profiles: ProfileStats[];
  verifiers: VerifierStats;
}

export interface FindingStats { total: number; fixed: number; notABug: number; unverified: number; downgraded: number; kept: number; open: number }

export interface VerificationOutcomes { completed: number; real: number; notABug: number; nit: number; preExisting: number; unfinished: number }
export interface VerifierProfileStats {
  profileId: Id;
  toolId: Id;
  votes: number;
  real: number;
  notABug: number;
  nit: number;
  preExisting: number;
  matched: number;
  decided: number;
}
export interface VerifierStats extends VerificationOutcomes {
  /** Earlier nominal votes without a proven tool cannot enter an independent-tool comparison. */
  unattributedVotes: number;
  roles: (VerificationOutcomes & { roleId: Id })[];
  profiles: VerifierProfileStats[];
}

const verdictKey = { real: "real", "not-a-bug": "notABug", nit: "nit", "pre-existing": "preExisting" } as const;
const noVerifications = (): VerificationOutcomes => ({ completed: 0, real: 0, notABug: 0, nit: 0, preExisting: 0, unfinished: 0 });

/** A fresh check on changed code is another decision. Corrections within it count only once per tool. */
function verifierStats(findings: readonly Finding[]): VerifierStats {
  const total = noVerifications();
  const roles = new Map<Id, VerificationOutcomes & { roleId: Id }>();
  const profiles = new Map<string, VerifierProfileStats>();
  let unattributedVotes = 0;
  for (const finding of findings) for (const round of [...(finding.earlierReviews ?? []), finding]) {
    if (!round.verification && !round.votes?.length) continue;
    const roleId = finding.roleId ?? "code-reviewer";
    const role = roles.get(roleId) ?? { roleId, ...noVerifications() };
    roles.set(roleId, role);
    for (const entry of [total, role]) {
      if (round.verification) { entry.completed += 1; entry[verdictKey[round.verification.verdict]] += 1; }
      else entry.unfinished += 1;
    }
    unattributedVotes += round.votes?.filter((vote) => !vote.toolId).length ?? 0;
    for (const vote of independentVotes(round.votes)) {
      const toolId = vote.toolId!;
      const key = JSON.stringify([vote.by, toolId]);
      const entry = profiles.get(key) ?? { profileId: vote.by, toolId, votes: 0, real: 0, notABug: 0, nit: 0, preExisting: 0, matched: 0, decided: 0 };
      entry.votes += 1;
      entry[verdictKey[vote.verdict]] += 1;
      if (round.verification) {
        entry.decided += 1;
        if (vote.verdict === round.verification.verdict) entry.matched += 1;
      }
      profiles.set(key, entry);
    }
  }
  return { ...total, unattributedVotes, roles: [...roles.values()].sort((a, b) => b.completed - a.completed || a.roleId.localeCompare(b.roleId)), profiles: [...profiles.values()].sort((a, b) => b.votes - a.votes || a.profileId.localeCompare(b.profileId) || a.toolId.localeCompare(b.toolId)) };
}

export interface ProfileStats {
  profileId: Id;
  raised: number;
  important: number;
  /** Important findings that held up: fixed, confirmed by another reviewer, or checked as real. */
  heldUp: number;
  notABug: number;
}

/** Highest convergence counter for a completed review, not a count of journey attempts. */
function reviewOutcome(task: Task): { rounds: number; passed: boolean } | undefined {
  const stages = task.plan?.stages ?? [];
  const chains = stages.map((stage, index) => ({ stage, index })).filter(({ stage }) => stage.kind === "review-chain");
  if (!chains.length || task.state === "cancelled") return undefined;
  const over = task.state === "done" || task.state === "pr-open" || chains.every(({ index }) => index < task.stageIndex);
  if (!over) return undefined;
  const rounds = Math.max(...chains.map(({ stage }) => task.rounds[stage.id] ?? 1));
  const passed = !task.findings.some((finding) => finding.status === "open" && finding.severity === "blocking");
  return { rounds, passed };
}

/** Was the finding Important when it was raised? The checker may have downgraded it since. */
const raisedImportant = (finding: Finding) => finding.severity === "blocking" || finding.verification !== undefined;

const heldUp = (finding: Finding) => finding.status === "fixed" || finding.confirmedBy.length > 0 || finding.verification?.verdict === "real";

function findingStats(findings: readonly Finding[]): FindingStats {
  const downgraded = (finding: Finding) => finding.verification?.verdict === "nit" || finding.verification?.verdict === "pre-existing";
  return {
    total: findings.length,
    fixed: findings.filter((finding) => finding.status === "fixed").length,
    notABug: findings.filter((finding) => finding.status === "dismissed").length,
    unverified: findings.filter((finding) => finding.status === "unverified").length,
    downgraded: findings.filter((finding) => finding.status === "open" && downgraded(finding)).length,
    kept: findings.filter((finding) => finding.status === "open" && !downgraded(finding) && finding.answer?.fixed === false).length,
    open: findings.filter((finding) => finding.status === "open" && !downgraded(finding) && finding.answer?.fixed !== false).length,
  };
}

export function reviewStats(tasks: readonly Task[]): ReviewStats {
  const outcomes = tasks.map(reviewOutcome).filter((outcome) => outcome !== undefined);
  const passed = outcomes.filter((outcome) => outcome.passed);
  const inRound = (round: number) => passed.filter((outcome) => outcome.rounds === round).length;
  const findings = tasks.filter((task) => task.state !== "cancelled").flatMap((task) => task.findings.filter((finding) => finding.raisedBy !== "petrina"));
  const byProfile = new Map<Id, ProfileStats>();
  const byRole = new Map<Id, Finding[]>();
  for (const finding of findings) {
    const roleId = finding.roleId ?? "code-reviewer";
    const group = byRole.get(roleId) ?? [];
    group.push(finding);
    byRole.set(roleId, group);
    const entry = byProfile.get(finding.raisedBy) ?? { profileId: finding.raisedBy, raised: 0, important: 0, heldUp: 0, notABug: 0 };
    entry.raised += 1;
    if (raisedImportant(finding)) {
      entry.important += 1;
      if (heldUp(finding)) entry.heldUp += 1;
    }
    if (finding.status === "dismissed") entry.notABug += 1;
    byProfile.set(finding.raisedBy, entry);
  }
  return {
    reviewed: outcomes.length,
    passed: { total: passed.length, first: inRound(1), second: inRound(2), third: inRound(3), later: passed.filter((outcome) => outcome.rounds > 3).length },
    ...(passed.length ? { meanRounds: passed.reduce((sum, outcome) => sum + outcome.rounds, 0) / passed.length } : {}),
    sentBack: tasks.reduce((sum, task) => sum + (task.sentBack ?? 0), 0),
    findings: findingStats(findings),
    roles: [...byRole].map(([roleId, group]) => ({ roleId, important: group.filter(raisedImportant).length, findings: findingStats(group) })).sort((a, b) => b.findings.total - a.findings.total || a.roleId.localeCompare(b.roleId)),
    profiles: [...byProfile.values()].sort((a, b) => b.raised - a.raised || a.profileId.localeCompare(b.profileId)),
    verifiers: verifierStats(findings),
  };
}

/** Add the compact records of finished work without reading its task bodies again. */
export function combineReviewStats(...records: readonly ReviewStats[]): ReviewStats {
  return records.reduce((total, record) => reviewArithmetic(total, record, 1), reviewStats([]));
}

/** Updating a finished task replaces its earlier contribution instead of counting it twice. */
export function subtractReviewStats(total: ReviewStats, old: ReviewStats): ReviewStats {
  return reviewArithmetic(total, old, -1);
}

function reviewArithmetic(a: ReviewStats, b: ReviewStats, sign: 1 | -1): ReviewStats {
  const tally = <T extends object>(left: T, right: T): T => Object.fromEntries(Object.entries(left).map(([key, value]) => [key, typeof value === "number" ? value + sign * Number(right[key as keyof T] ?? 0) : value])) as T;
  const rows = <T extends object>(left: readonly T[], right: readonly T[], key: (row: T) => string, merge: (left: T, right: T) => T, weight: (row: T) => number): T[] => {
    const map = new Map(left.map((row) => [key(row), { ...row }]));
    for (const row of right) {
      const id = key(row);
      const old = map.get(id);
      if (old) map.set(id, merge(old, row));
      else if (sign > 0) map.set(id, { ...row });
      else throw new Error("Review totals cannot remove a record that is missing.");
    }
    return [...map.values()].filter((row) => weight(row) !== 0);
  };
  const passed = tally(a.passed, b.passed);
  const rounds = Math.round((a.meanRounds ?? 0) * a.passed.total) + sign * Math.round((b.meanRounds ?? 0) * b.passed.total);
  const verifiers = tally(a.verifiers, b.verifiers);
  verifiers.roles = rows(a.verifiers.roles, b.verifiers.roles, (row) => row.roleId, tally, (row) => row.completed + row.unfinished).sort((x, y) => y.completed - x.completed || x.roleId.localeCompare(y.roleId));
  verifiers.profiles = rows(a.verifiers.profiles, b.verifiers.profiles, (row) => JSON.stringify([row.profileId, row.toolId]), tally, (row) => row.votes).sort((x, y) => y.votes - x.votes || x.profileId.localeCompare(y.profileId) || x.toolId.localeCompare(y.toolId));
  return {
    reviewed: a.reviewed + sign * b.reviewed,
    passed,
    ...(passed.total ? { meanRounds: rounds / passed.total } : {}),
    sentBack: a.sentBack + sign * b.sentBack,
    findings: tally(a.findings, b.findings),
    roles: rows(a.roles, b.roles, (row) => row.roleId, (x, y) => ({ roleId: x.roleId, important: x.important + sign * y.important, findings: tally(x.findings, y.findings) }), (row) => row.findings.total).sort((x, y) => y.findings.total - x.findings.total || x.roleId.localeCompare(y.roleId)),
    profiles: rows(a.profiles, b.profiles, (row) => row.profileId, tally, (row) => row.raised).sort((x, y) => y.raised - x.raised || x.profileId.localeCompare(y.profileId)),
    verifiers,
  };
}
