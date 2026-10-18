// How reviews are going, from what every task already records: how many rounds work takes to pass,
// what became of each finding, and how each reviewer profile's findings held up.

import type { Finding, Id, Task, Vote } from "./model.js";

/** The latest vote per proven actual tool. Older nominal attributions remain history, never guessed identities. */
export function independentVotes(votes: readonly Vote[] = []): Vote[] {
  return [...new Map(votes.filter((vote) => vote.toolId).map((vote) => [vote.toolId, vote])).values()];
}

export interface ReviewStats {
  /** Tasks whose review is over: passed, or handed to the coordinator with rounds used up. */
  reviewed: number;
  /** Of those, how many passed, and in which round. */
  passed: { total: number; first: number; second: number; third: number; later: number };
  /** Mean rounds to pass, over the tasks that passed. */
  meanRounds?: number;
  /** Deliveries the coordinator sent back after every reviewer had passed them. */
  sentBack: number;
  /** What became of the reviewers' findings (Petrina's own checks aside). */
  findings: { total: number; fixed: number; notABug: number; downgraded: number; kept: number; open: number };
  /** Per reviewer profile, most findings first. */
  profiles: ProfileStats[];
}

export interface ProfileStats {
  profileId: Id;
  raised: number;
  important: number;
  /** Important findings that held up: fixed, confirmed by another reviewer, or checked as real. */
  heldUp: number;
  notABug: number;
}

/** The round a task passed review in, or undefined while its review is not over. */
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

export function reviewStats(tasks: readonly Task[]): ReviewStats {
  const outcomes = tasks.map(reviewOutcome).filter((outcome) => outcome !== undefined);
  const passed = outcomes.filter((outcome) => outcome.passed);
  const inRound = (round: number) => passed.filter((outcome) => outcome.rounds === round).length;
  const findings = tasks.filter((task) => task.state !== "cancelled").flatMap((task) => task.findings.filter((finding) => finding.raisedBy !== "petrina"));
  const byProfile = new Map<Id, ProfileStats>();
  for (const finding of findings) {
    const entry = byProfile.get(finding.raisedBy) ?? { profileId: finding.raisedBy, raised: 0, important: 0, heldUp: 0, notABug: 0 };
    entry.raised += 1;
    if (raisedImportant(finding)) {
      entry.important += 1;
      if (heldUp(finding)) entry.heldUp += 1;
    }
    if (finding.status === "dismissed") entry.notABug += 1;
    byProfile.set(finding.raisedBy, entry);
  }
  const downgraded = (finding: Finding) => finding.verification?.verdict === "nit" || finding.verification?.verdict === "pre-existing";
  return {
    reviewed: outcomes.length,
    passed: { total: passed.length, first: inRound(1), second: inRound(2), third: inRound(3), later: passed.filter((outcome) => outcome.rounds > 3).length },
    ...(passed.length ? { meanRounds: passed.reduce((sum, outcome) => sum + outcome.rounds, 0) / passed.length } : {}),
    sentBack: tasks.reduce((sum, task) => sum + (task.sentBack ?? 0), 0),
    findings: {
      total: findings.length,
      fixed: findings.filter((finding) => finding.status === "fixed").length,
      notABug: findings.filter((finding) => finding.status === "dismissed").length,
      downgraded: findings.filter((finding) => finding.status === "open" && downgraded(finding)).length,
      kept: findings.filter((finding) => finding.status === "open" && !downgraded(finding) && finding.answer?.fixed === false).length,
      open: findings.filter((finding) => finding.status === "open" && !downgraded(finding) && finding.answer?.fixed !== false).length,
    },
    profiles: [...byProfile.values()].sort((a, b) => b.raised - a.raised || a.profileId.localeCompare(b.profileId)),
  };
}
