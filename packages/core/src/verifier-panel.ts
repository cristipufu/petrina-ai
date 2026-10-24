// Bounded verifier panels: which tools check a round's Important findings, which answers count, when a third
// independent tool is asked, and who may take over a place. Decisions only; the engine admits and records them.

import type { Finding, Hunt, Id, Task, VerifierPanel, VerifierSeat, Vote } from "./model.js";
import { independentVotes } from "./reviews.js";
import { assignedProducts } from "./repositories.js";
import { exhaustedAcceptanceFailure } from "./acceptance.js";

/** Open Important reports that lack support from two independent tools. */
export function findingsNeedingVotes<F extends Finding>(task: Pick<Task, "productId" | "repositories" | "selectedProducts" | "workRows" | "acceptanceBlocked"> & { findings: readonly F[] }, toolOf: (profileId: Id) => Id | undefined): F[] {
  return task.findings.filter((finding) => {
    if (finding.status !== "open" || finding.severity !== "blocking" || finding.raisedBy === "petrina" || finding.verification || finding.unresolved || exhaustedAcceptanceFailure(task, finding)) return false;
    if (task.repositories && !assignedProducts(task, finding.productIds).length) return false;
    const judgments = finding.judgments ?? [];
    const clashed = judgments.some((entry) => entry.severity === "pre-existing") && judgments.some((entry) => entry.severity === "blocking");
    // A reviewer who says the bug is older is not a second tool agreeing that it is Important.
    const older = new Set(judgments.filter((entry) => entry.severity === "pre-existing").map((entry) => entry.by));
    const supporters = clashed
      ? [...judgments.filter((entry) => entry.severity === "blocking").map((entry) => entry.by), ...finding.confirmedBy.filter((id) => !older.has(id))]
      : [...((finding.reopenedAt !== undefined || finding.answer?.fixed) ? [] : [finding.raisedBy]), ...finding.confirmedBy];
    return new Set(supporters.map(toolOf).filter(Boolean)).size < 2;
  });
}

type Ballot = Pick<Hunt, "stageId" | "round" | "input">;

/** A tool that could take a place, with the profile that would start on it. */
export interface PanelCandidate {
  toolId: Id;
  profileId: Id;
  /** Its choice resolves now, without a usage or capacity wait. A full slot still counts as usable. */
  usableNow?: boolean;
}

const sameVersions = (a: Readonly<Record<Id, string>> = {}, b: Readonly<Record<Id, string>> = {}): boolean =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => a[key] === b[key]);

/** What a new answer records about the ballot it belongs to. */
export function ballotOf(hunt: Ballot, seat: string): NonNullable<Vote["ballot"]> {
  return { stageId: hunt.stageId, round: hunt.round, seat, ...(hunt.input?.heads ? { versions: { ...hunt.input.heads } } : {}) };
}

/** An answer to this stage, round and reviewed code. Earlier rounds' and versions' answers stay history. */
export function inBallot(vote: Vote, hunt: Ballot): boolean {
  const ballot = vote.ballot;
  return !!ballot && ballot.stageId === hunt.stageId && ballot.round === hunt.round && sameVersions(ballot.versions, hunt.input?.heads);
}

type ReviewedCode = Pick<NonNullable<Finding["unresolved"]>, "heads" | "trees">;

/** The code a round reviewed: its commits, and their trees where recorded. */
export function reviewedCode(hunt: Pick<Hunt, "input"> | undefined): ReviewedCode {
  const input = hunt?.input;
  return input ? { heads: { ...input.heads }, ...(input.trees ? { trees: { ...input.trees } } : {}) } : {};
}

/**
 * Whether the code changed between two reviews, comparing like with like for each product: trees where both recorded
 * one, so a new commit with the same tree is the same code, otherwise commits. A product only one review covered is a
 * change; a review that recorded no versions proves none.
 */
function codeChanged(before: ReviewedCode, now: ReviewedCode): boolean {
  const products = (code: ReviewedCode) => new Set(Object.keys({ ...code.heads, ...code.trees }));
  const earlier = products(before), later = products(now);
  if (!earlier.size || !later.size) return false;
  return [...new Set([...earlier, ...later])].some((id) => {
    const trees = [before.trees?.[id], now.trees?.[id]], heads = [before.heads?.[id], now.heads?.[id]];
    if (trees[0] && trees[1]) return trees[0] !== trees[1];
    if (heads[0] && heads[1]) return heads[0] !== heads[1];
    return !earlier.has(id) || !later.has(id);
  });
}

/**
 * A current reproduction on changed code reopens a finding a vote left unresolved. On the code it was left unresolved
 * on, a confirmation keeps that episode, so its finished ballot is never repeated; unknown versions prove no change.
 */
export function reopensUnresolved(finding: Pick<Finding, "unresolved">, hunt: Pick<Hunt, "input"> | undefined, evidence: string | undefined): boolean {
  return !!evidence?.trim() && !!finding.unresolved && codeChanged(finding.unresolved, reviewedCode(hunt));
}

/** The answers a panel counts on a finding, the latest per actual tool. An older majority panel counts every proven vote, as it did. */
export function panelAnswers(panel: VerifierPanel, finding: Pick<Finding, "votes">, hunt: Ballot): Vote[] {
  if (panel.rule === "majority") return independentVotes(finding.votes);
  const places = new Set(panel.seats.map((seat) => seat.key));
  return independentVotes((finding.votes ?? []).filter((vote) => vote.ballot && places.has(vote.ballot.seat) && inBallot(vote, hunt)));
}

/** Whether this place has handed back its answer on the finding. An older panel's place belonged to its tool. */
export function seatAnswered(panel: VerifierPanel, seat: VerifierSeat, finding: Pick<Finding, "votes">, hunt: Ballot): boolean {
  if (panel.rule === "majority") return (finding.votes ?? []).some((vote) => vote.toolId === seat.toolId);
  return (finding.votes ?? []).some((vote) => vote.toolId && vote.ballot?.seat === seat.key && inBallot(vote, hunt));
}

/** The assigned findings this place still owes an answer on. */
export function seatRemaining(panel: VerifierPanel, seat: VerifierSeat, findings: readonly Pick<Finding, "id" | "votes">[], hunt: Ballot): Id[] {
  return seat.findingIds.filter((id) => {
    const finding = findings.find((entry) => entry.id === id);
    return finding !== undefined && !seatAnswered(panel, seat, finding, hunt);
  });
}

/**
 * Whether a place may record this tool's answer on a finding: one the place was assigned and still owes, or a correction
 * of the place's own latest answer by the same tool. A takeover never replaces an answer its place already holds from
 * another tool, and one tool never answers a finding through two places. An older majority panel keeps its rule.
 */
export function acceptsAnswer(panel: VerifierPanel, seat: VerifierSeat, finding: Pick<Finding, "id" | "votes">, hunt: Ballot, toolId: Id): boolean {
  if (!seat.findingIds.includes(finding.id)) return false;
  if (panel.rule === "majority") return true;
  const places = new Set(panel.seats.map((entry) => entry.key));
  const counted = (finding.votes ?? []).filter((vote) => vote.toolId && vote.ballot && places.has(vote.ballot.seat) && inBallot(vote, hunt));
  if (counted.some((vote) => vote.toolId === toolId && vote.ballot!.seat !== seat.key)) return false;
  const own = counted.filter((vote) => vote.ballot!.seat === seat.key);
  return !own.length || own.at(-1)!.toolId === toolId;
}

/**
 * The tools that may not answer this finding again: those whose answer the panel already counts, and every other
 * place still owing it an answer. Profiles on one tool are one source.
 */
export function engagedTools(panel: VerifierPanel, finding: Pick<Finding, "id" | "votes">, hunt: Ballot, except?: VerifierSeat): Set<Id> {
  const tools = new Set(panelAnswers(panel, finding, hunt).map((vote) => vote.toolId!));
  for (const seat of panel.seats) if (seat !== except && seat.findingIds.includes(finding.id) && !seatAnswered(panel, seat, finding, hunt)) tools.add(seat.toolId);
  return tools;
}

/** The verdict most voters gave, the mildest first on a tie: a nit, then older than the change, then not a bug. */
export function mostCommon(votes: readonly Vote[]): Vote | undefined {
  const order: Vote["verdict"][] = ["nit", "pre-existing", "not-a-bug"];
  const count = (verdict: Vote["verdict"]) => votes.filter((vote) => vote.verdict === verdict).length;
  const best = [...order].sort((a, b) => count(b) - count(a) || order.indexOf(a) - order.indexOf(b))[0]!;
  return votes.find((vote) => vote.verdict === best);
}

export type PanelDecision =
  | { verdict: "real"; vote: Vote; disputed: readonly Vote[] }
  | { verdict: "third" }
  | { verdict: "not-a-bug" | "nit" | "pre-existing"; vote: Vote };

/**
 * What a finding's completed answers decide. Bounded: any real answer keeps it Important, the other answers recorded as
 * its dispute. Two answers that both say it does not block contradict the original Important report: a third independent
 * answer is required when the saved usable set had a third tool. Otherwise, and after that third answer, the most common
 * other verdict settles it; no fourth answer is asked. An older majority panel keeps its rule: at least half real.
 */
export function decide(panel: VerifierPanel, answers: readonly Vote[]): PanelDecision | undefined {
  if (!answers.length) return undefined;
  const real = answers.filter((vote) => vote.verdict === "real");
  const others = answers.filter((vote) => vote.verdict !== "real");
  if (panel.rule === "majority" ? real.length * 2 >= answers.length : real.length > 0) return { verdict: "real", vote: real[0] ?? answers[0]!, disputed: others };
  if (panel.rule === "bounded" && answers.length < 3 && panel.usable.length >= 3) return { verdict: "third" };
  const vote = mostCommon(others)!;
  return { verdict: vote.verdict as "not-a-bug" | "nit" | "pre-existing", vote };
}

/** The tool whose report a verifier should avoid repeating: the reviewer whose current reproduction reopened it, else its raiser. */
export function authorProfile(finding: Pick<Finding, "raisedBy" | "reopenedAt" | "confirmedBy">): Id | undefined {
  return finding.reopenedAt !== undefined ? finding.confirmedBy[0] : finding.raisedBy;
}

/** Currently usable tools first, then the fewest overlaps with these findings' author tools, then the order given. */
export function rankCandidates<T extends PanelCandidate>(candidates: readonly T[], authorTools: readonly (Id | undefined)[]): T[] {
  const overlaps = (toolId: Id) => authorTools.filter((tool) => tool === toolId).length;
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => Number(!!b.candidate.usableNow) - Number(!!a.candidate.usableNow) || overlaps(a.candidate.toolId) - overlaps(b.candidate.toolId) || a.index - b.index)
    .map(({ candidate }) => candidate);
}

const listWords = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * A new ballot's panel, from the tools whose choices resolve now (one per actual tool, in stable order). Answers this
 * ballot already proved keep their tools' places first; any larger evidenced panel stays. The rest of the initial pair
 * avoids the findings' author tools where another usable tool exists. Undefined when no tool is usable.
 */
export function choosePanel(input: { candidates: readonly PanelCandidate[]; recovered?: readonly PanelCandidate[]; findings: readonly { id: Id; author?: Id }[]; name: (toolId: Id) => string }): VerifierPanel | undefined {
  const recovered = [...new Map((input.recovered ?? []).map((entry) => [entry.toolId, entry])).values()];
  const usable = [...new Set([...input.candidates.map((entry) => entry.toolId), ...recovered.map((entry) => entry.toolId)])];
  if (!usable.length) return undefined;
  const ids = input.findings.map((finding) => finding.id);
  const authorTools = input.findings.map((finding) => finding.author);
  const fresh = rankCandidates(input.candidates.filter((entry) => !recovered.some((kept) => kept.toolId === entry.toolId)), authorTools).slice(0, Math.max(0, 2 - recovered.length));
  const avoided = [...new Set(authorTools.filter((tool): tool is Id => !!tool && usable.includes(tool) && !fresh.some((entry) => entry.toolId === tool)))];
  const usableWords = `usable at selection: ${listWords(usable.map(input.name))}`;
  const seats: VerifierSeat[] = [
    ...recovered.map((entry) => ({ key: entry.profileId, profileId: entry.profileId, toolId: entry.toolId, findingIds: ids, reason: `Kept the place ${input.name(entry.toolId)} already answered in this ballot (${usableWords}).` })),
    ...fresh.map((entry) => ({ key: entry.profileId, profileId: entry.profileId, toolId: entry.toolId, findingIds: ids, reason: `${usable.length === 1 ? "The only usable tool checks these findings alone" : "Chosen for the initial pair"} (${usableWords}${avoided.length ? `; avoided ${listWords(avoided.map(input.name))}, which reported ${authorTools.filter((tool) => tool && avoided.includes(tool)).length === 1 ? "a finding" : "findings"}` : ""}).` })),
  ];
  const authors = Object.fromEntries(input.findings.flatMap((finding) => (finding.author ? [[finding.id, finding.author]] : [])));
  return { rule: "bounded", usable, ...(Object.keys(authors).length ? { authors } : {}), seats };
}

/**
 * Targeted third answers for the findings whose completed initial answers both said they do not block. A tool may answer
 * a finding it has not answered yet, including one replaced before answering it or one that answered only other findings.
 * Compatible findings share one place; places split only when independence requires it, usable tools first. A finding
 * with no ready independent tool stays unresolved rather than settling on two answers.
 */
export function planThirdAnswers(input: { findings: readonly { id: Id; answered: readonly Id[]; author?: Id }[]; suppliers: readonly PanelCandidate[]; name: (toolId: Id) => string }): { seats: VerifierSeat[]; escalations: Record<Id, { reason: string; unresolved?: true }> } {
  const escalations: Record<Id, { reason: string; unresolved?: true }> = {};
  const open = (finding: (typeof input.findings)[number]) => input.suppliers.filter((supplier) => !finding.answered.includes(supplier.toolId));
  const seats: VerifierSeat[] = [];
  const cover = (findings: readonly (typeof input.findings)[number][], usableOnly: boolean) => {
    let remaining = [...findings];
    while (remaining.length) {
      const pool = rankCandidates(input.suppliers.filter((supplier) => !usableOnly || supplier.usableNow), remaining.map((finding) => finding.author));
      const covers = (supplier: PanelCandidate) => remaining.filter((finding) => open(finding).some((entry) => entry.toolId === supplier.toolId));
      const best = [...pool].sort((a, b) => covers(b).length - covers(a).length)[0];
      const covered = best ? covers(best) : [];
      if (!best || !covered.length) return remaining;
      seats.push({ key: `third:${best.profileId}`, profileId: best.profileId, toolId: best.toolId, findingIds: covered.map((finding) => finding.id), third: true, reason: `Third answer: both first verifiers said ${covered.length === 1 ? "this finding does" : "these findings do"} not block, and ${input.name(best.toolId)} has not answered ${covered.length === 1 ? "it" : "them"} yet.` });
      remaining = remaining.filter((finding) => !covered.includes(finding));
    }
    return remaining;
  };
  // Usable tools take what they can now; the rest wait for a limited tool, and a finding nobody can answer stays unresolved.
  const usableNow = input.findings.filter((finding) => open(finding).some((supplier) => supplier.usableNow));
  cover([...cover(usableNow, true), ...input.findings.filter((finding) => !usableNow.includes(finding))], false);
  for (const finding of input.findings) {
    const seat = seats.find((entry) => entry.findingIds.includes(finding.id));
    escalations[finding.id] = seat
      ? { reason: `Both first answers said it does not block; ${input.name(seat.toolId)} gives the third answer.` }
      : { reason: "Both first answers said it does not block, and no ready independent tool can give the required third answer: it stays Important, unresolved.", unresolved: true };
  }
  return { seats, escalations };
}

/**
 * Who can take over a place that cannot continue: a currently usable tool independent of every finding the place still
 * owes, preferring the fewest overlaps with those findings' authors.
 */
export function replacementFor(remaining: readonly Id[], engaged: (findingId: Id) => ReadonlySet<Id>, candidates: readonly PanelCandidate[], authorTools: readonly (Id | undefined)[]): PanelCandidate | undefined {
  return rankCandidates(candidates.filter((candidate) => remaining.every((id) => !engaged(id).has(candidate.toolId))), authorTools)[0];
}
