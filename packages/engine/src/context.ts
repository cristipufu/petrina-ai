import type { RecordedChecksApplicability } from "./product-checks.js";
import { checkSetupOutcome, checkSetupWords, recordedCheckBatch } from "@petrina/core";
import { checkOutcome, checkOutcomeLabel, finalDesignNotes } from "@petrina/core";
import { productRows, repositoryView, type RepositoryContext } from "@petrina/orchestrator";
// What each role is shown besides its instructions. Each part of the context is built here once; a role's
// contract (roles.ts) says which parts it reads, and they always appear in the same order.

import { builderFindings, dueAnswers, exhaustedAcceptanceFailure, followingCall, openFollowUpCards, workSummary, type Id, type StepNote, type Task } from "@petrina/core";
import { formatFindings, formatObjections } from "./prompts.js";
import { checksFor, commandText } from "./checks.js";
import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";
import { CONTEXT_PARTS, contractFor, type ContextPart } from "./roles.js";
import type { Role } from "@petrina/core";
import type { RuntimeTask } from "@petrina/orchestrator";
import type { RelatedCheckEvidenceHost } from "./related-check-evidence.js";
import type { GuideKeeper } from "./guide-keeper.js";
import { backgroundMessage } from "@petrina/core";
import { currentSourcePointers } from "@petrina/repositories/source-pointers";
import type { ReviewInput } from "./review-context.js";
import * as git from "@petrina/repositories/git";
import { verificationContext } from "./verification-context.js";
import { relatedCheckEvidence } from "./related-check-evidence.js";
import { compactCards, compactFindings, fullFollowUpCards, readReviewHistory, settledReviewFindings, type CompactReviewHistory } from "./review-history.js";
import { openProofs, proofContext, type ProofRequest } from "@petrina/core";

export interface Section {
  title: string;
  body: string;
  /** Complete background retained in the context packet, even when instructions travel separately. */
  background?: string;
  /** Internal reference carried only while an actual supplied section is shortened. */
  reviewHistory?: CompactReviewHistory;
  /** Recorded notes, in authoritative order; never inferred from their rendered prose. */
  coordinatorNotes?: readonly (NonNullable<Task["notes"]>[number] & { background: boolean; earlierCarried?: boolean })[];
  /** Still-current notes outside this seat's background (including live delivery). */
  deferredCoordinatorNoteIds?: readonly string[];
  ambiguousCoordinatorNotes?: boolean;
}

export const COORDINATOR_NOTES_RULE = "Product decisions and constraints remain authoritative; the latest wins where they conflict. An instruction about what to revise or check in an earlier step applies to that work, not a smaller scope for your current assignment. Implement the complete approved request and brief; keep later product decisions. Do not infer new requirements from an earlier agent's interpretation.";

export function coordinatorNoteStep(note: NonNullable<Task["notes"]>[number]): string {
  return note.origin ? `Recorded during “${note.origin.stageTitle}”${note.origin.roleName ? ` (${note.origin.roleName})` : ""}${note.origin.kind === "disagreement" ? ", at the coordinator's design call" : ""}` : "Earlier note (original step not recorded)";
}

export const renderCoordinatorNote = (note: NonNullable<Task["notes"]>[number]) => `- ${coordinatorNoteStep(note)}:\n${note.text}`;

/** Beside the reports exactly as they were handed back: evidence to check and proposals to weigh, never extra requirements. */
export const EARLIER_REPORTS_RULE = `These are the reports earlier agents saved, not their conversations. Check the facts and sources your work relies on yourself: they may be out of date or hold only for a particular version or platform. Proposals, such as suggested approaches or proposed screens and words, can guide your work but add no requirements: the task request, any approved brief and the coordinator's notes and decisions remain authoritative.`;

/** What reviewers confirm or dispute: never an acceptance failure held for the delivery decision, which no review settles. */
const reviewFindings = ({ task }: RepositoryContext) => task.findings.filter((finding) => (finding.raisedBy !== "petrina" || finding.status === "open") && !exhaustedAcceptanceFailure(task as Task, finding));

export interface ContextHost extends RelatedCheckEvidenceHost {
  readonly dataDir: string;
  readonly s: RelatedCheckEvidenceHost["s"] & { readonly roles: readonly Role[] };
  role(id: Id, task?: RuntimeTask): Role | undefined;
}
export class Context {
  private readonly parts: Record<ContextPart, (scope: RepositoryContext, roleId: Id, points: readonly string[], currentChecks: RecordedChecksApplicability | undefined, member?: string) => Section[]> = {
    notes: (scope, _role, _points, _checks, member) => coordinatorNotes(scope, member),
    brief: (scope) => this.brief(scope),
    "design-notes": (scope) => this.designNotes(scope),
    objections: (scope, roleId) => this.objections(scope, roleId),
    checks: (scope) => this.checks(scope),
    "findings-to-answer": (scope) => this.findingsToAnswer(scope),
    // Task context, like the notes: points accepted during this task, before the delivery that writes them to REVIEW.md.
    "guide-points": (scope, _roleId, points) => {
      return points.length ? [{ title: `Points the coordinator accepted for the review guide, not in REVIEW.md on ${scope.work.base ?? "the base branch"} yet (check them too)`, body: points.map((point) => `- ${point}`).join("\n") }] : [];
    },
    report: (scope, roleId) => this.report(scope, roleId),
    "check-results": (scope, _roleId, _points, currentChecks) => this.checkResults(scope, currentChecks),
    findings: (scope) => {
      const findings = reviewFindings(scope);
      return findings.length ? [{ title: "Findings so far (confirm or dispute by id)", body: formatFindings(findings, { complete: true }) }] : [];
    },
  };

  constructor(
    private readonly k: ContextHost,
    private readonly guide: Pick<GuideKeeper, "pendingPoints">,
    private readonly currentChecks: (scope: RepositoryContext) => Promise<RecordedChecksApplicability> = async scope => ({ inputs: { kind: "unknown", reason: "source" }, batch: recordedCheckBatch(scope.work) }),
  ) {}

  async sectionsFor(scope: RepositoryContext, roleId: Id, member?: string, copies?: Readonly<Record<string, string>>, shownKey?: string, review?: ReviewInput): Promise<Section[]> {
    const { task, work: repository } = scope;
    const role = this.k.role(roleId, task);
    // Check cached round files too. Retention waits until the actual supplied
    // sections are known, after any warm-conversation reduction.
    const compact = role?.result === "findings" && !!review?.history;
    if (compact) await readReviewHistory(review!.history!);
    const reads: readonly ContextPart[] = role ? contractFor(role).reads : ["notes", "brief"];
    const fromPlanning = task.plan?.stages.some((stage) => stage.kind === "converge") ? [] : task.sourcePointers ?? [];
    const references = role?.result === "brief" ? [...(task.brief?.sourcePointers ?? []), ...(task.sourcePointers ?? [])]
      : role?.result === "build" && !task.fixing ? task.brief?.sourcePointers ?? fromPlanning : [];
    const [points, currentChecks, pointers] = await Promise.all([
      !review && reads.includes("guide-points") ? this.guide.pendingPoints(scope) : [],
      !review && reads.includes("check-results") && !!(repository.checks || repository.checkSetup || repository.checkSetupInvalidated) ? this.currentChecks(scope) : undefined,
      currentSourcePointers(repositoryView(scope), references),
    ]);
    // Waiting instructions belong to the actual prompt handoff, not reusable background.
    const source = review ? review.source : this.approvedSource(scope);
    const rows = review ? review.products : this.productRows(scope);
    const map = rows ? [{ title: "Complete approved product map and responsibility", body: rows.map((row) => `${row.beforeCopy}${copies?.[row.productId] ?? row.copy}${row.afterCopy}`).join("\n\n") + `\n\n${role?.canEdit ? `You own only product ${repository.productId}. Read the other copies when needed; change only your own product. Return your own title, report and PR description.` : "Inspect every repository and the behaviour across them together."}\nFor every acceptance result and finding, explicitly return productIds naming every affected product. Unassigned items stay under Together for the coordinator. Passing separate suites cannot prove shared acceptance. For each lesson, return {productId, text} naming its product; unassigned lessons stay under Together and are never added to a repository automatically. Shared repairs require a separate answer from every affected builder and combined verification.` }] : [];
    const sections: Section[] = [...map, ...source, ...CONTEXT_PARTS.filter((part) => reads.includes(part)).flatMap((part) => review && part !== "notes" ? review.parts[part] ?? [] : this.parts[part](scope, roleId, points, currentChecks, member))];
    if (compact && review?.history && Object.keys(review.history.findings).length) {
      const index = sections.findIndex(section => section.title === "Findings so far (confirm or dispute by id)");
      if (index >= 0) sections[index] = { ...sections[index]!, background: sections[index]!.body, body: compactFindings(review), reviewHistory: review.history };
    }
    if (task.maintenance) sections.unshift({ title: "Saved scheduled maintenance request", body: task.maintenance.input });
    if (review?.material) sections.push(review.material);
    if (pointers.length) sections.push({ title: "Previously inspected source locations (verify independently)", body: `Navigation only: this incomplete selection can steer attention. It contains no recommendations or extra requirements. Verify the current code and inspect other areas as needed; the original request and approved brief remain authoritative.\n${pointers.map((pointer) => `- ${pointer.productId}: ${pointer.path} (source version ${pointer.revision})`).join("\n")}` });
    if (role?.result === "findings") {
      // A task is never offered for its own reports. A frozen list from before that rule loses only that card; nothing replaces it.
      const cards = review ? review.cards.filter((card) => card.id !== task.id) : openFollowUpCards(this.k.s.tasks as readonly Task[], task as Task);
      // shownKey records which cards this reviewer was shown. It is not a message seat:
      // using it as one leaves the coordinator's note queued and sends it as a second turn.
      const key = shownKey ?? member ?? roleId;
      const shown = { ...(task.shownFollowUps ?? {}) };
      if (cards.length) shown[key] = cards.map((card) => card.id);
      else delete shown[key];
      task.shownFollowUps = shown;
      // Shorten only cards still shown; a frozen entry for the task's own card is never pointed at.
      const shortened = compact && review!.history!.cards.some((id) => cards.some((card) => card.id === id));
      if (cards.length) sections.push({ title: "Open follow-up cards", body: shortened ? compactCards({ ...review!, cards }) : fullFollowUpCards(cards), ...(shortened ? { background: fullFollowUpCards(cards), reviewHistory: review!.history } : {}) });
    }
    if (role?.result === "findings") sections.push(...(review ? review.proofs ?? [] : this.reviewProofs(scope)));
    if (!review && task.proofRequests?.length && (role?.result === "checks" || role?.result === "build")) sections.push({ title: "Required proof on the final code", body: `${role.result === "build" ? "Final acceptance testing owns these requests. Fix code findings as usual; do not repeat this proof during Builder repairs." : "Answer every open request by its id in proofAnswers with pass, fail, or blocked and evidence. A missing platform is blocked, never a pass. The engine records the actual run versions."}\n${proofContext(role.result === "checks" ? openProofs(task) : task.proofRequests)}\nCurrent versions: ${JSON.stringify(Object.fromEntries((task.repositories ?? [repository]).map(work => [work.productId, work.checks?.current ? work.checks.tree : "unavailable"])))}${task.proofRetestReason ? `\nWhy now: ${task.proofRetestReason === "main-moved" ? "main moved since the proof was recorded" : task.proofRetestReason === "code-changed" ? "the task's code changed since acceptance testing" : "a reviewer asked for proof on the final code"}.` : ""}` });
    sections.push(...(review ? review.handedBack : this.handedBack(scope)));
    if (!review && reads.includes("report")) sections.push(...await verificationContext(this.k.dataDir, repositoryView(scope), role?.result === "checks" ? Object.fromEntries(await Promise.all((task.repositories ?? [repository]).map(async (work) => [work.productId, work.checks?.current && work.checks.tree ? work.checks.tree : work.worktree ? await git.treeOf(work.worktree) : undefined]))) : undefined));
    // Optional navigation must never prevent the task's ordinary repair handoff.
    if (!review && role?.result === "build" && task.fixing) sections.push(...await relatedCheckEvidence(this.k, scope).catch(() => []));
    return sections;
  }

  /** Capture common facts once; messages remain live and are delivered per member. */
  async captureReview(scope: RepositoryContext): Promise<ReviewInput> {
    const [points, currentChecks, evidence] = await Promise.all([
      this.guide.pendingPoints(scope),
      scope.work.checks || scope.work.checkSetup || scope.work.checkSetupInvalidated ? this.currentChecks(scope) : undefined,
      verificationContext(this.k.dataDir, repositoryView(scope)),
    ]);
    const parts: ReviewInput["parts"] = {};
    for (const part of ["brief", "guide-points", "report", "check-results", "findings"] as const) parts[part] = this.parts[part](scope, "code-reviewer", points, currentChecks);
    parts.report = [...(parts.report ?? []), ...evidence];
    const settled = settledReviewFindings(repositoryView(scope), this.k.s.roles);
    return structuredClone({ parts, proofs: this.reviewProofs(scope), source: this.approvedSource(scope), products: this.productRows(scope), handedBack: this.handedBack(scope), cards: openFollowUpCards(this.k.s.tasks as readonly Task[], scope.task as Task), findings: reviewFindings(scope), ...(Object.keys(settled).length ? { settled } : {}) });
  }

  private reviewProofs(scope: RepositoryContext): Section[] {
    const task = scope.task;
    if (!task.plan?.stages.some(stage => stage.kind === "do" && this.k.role(stage.roleId, task)?.result === "checks")) return [];
    return [{ title: "Proof requests for final acceptance testing", body: `Missing required proof on this version belongs in proofRequests, separate from defect findings: give text, productIds and reason, and optionally checklistText matching a saved item exactly. This option is available because the plan has acceptance testing. Do not raise, reopen or confirm a finding solely for missing validation; request proof or refer to an earlier request by id. Confirmations of reproduced code defects keep their usual effect. Proof requests do not waive any platform, final-version or configured-check requirement. Earlier rounds' requests (frozen before this round):\n${proofContext((task.proofRequests ?? []) as ProofRequest[]) || "None."}\nValid product ids: ${(task.repositories ?? [scope.work]).map(work => work.productId).join(", ")}.` }];
  }

  private approvedSource(scope: RepositoryContext): Section[] {
    return scope.work.source ? [{ title: "Approved starting point and delivery", body: workSummary({ ...scope.work.source, product: { ...scope.work.source.product, name: this.k.productOf(scope)?.name ?? scope.work.source.product.name } }) }] : [];
  }

  private productRows(scope: RepositoryContext): ReviewInput["products"] {
    return productRows(scope.task);
  }

  private handedBack(scope: RepositoryContext): Section[] {
    const { task } = scope;
    return task.handedBack?.length ? [{ title: "What earlier agents on this task handed back", body: [EARLIER_REPORTS_RULE, ...task.handedBack.map((entry) => `${entry.roleName ?? this.k.role(entry.roleId, task)?.name ?? "An earlier role"}${entry.productId ? ` · ${task.repositories?.find((work) => work.productId === entry.productId)?.source?.product.name ?? entry.productId}` : ""}, in “${entry.title ?? task.plan?.stages.find((stage) => stage.id === entry.stageId)?.title ?? "an earlier step"}”: ${entry.summary}\n${entry.notes.map((note) => `- ${note}`).join("\n")}`)].join("\n\n") }] : [];
  }


  private brief(scope: RepositoryContext): Section[] {
    const { task } = scope;
    const brief = task.brief;
    if (!brief) return [];
    return [
      {
        title: "Design brief",
        body: [brief.summary, brief.forUsers.length ? `What changes for users:\n${brief.forUsers.map((line) => `- ${line}`).join("\n")}` : "", brief.areas.length ? `Product behavior and affected areas:\n${brief.areas.map((line) => `- ${line}`).join("\n")}` : "", `Acceptance checklist:\n${brief.acceptance.map((item) => `- ${item.text}`).join("\n")}`, brief.risks.length ? `Risks:\n${brief.risks.map((line) => `- ${line}`).join("\n")}` : ""].filter(Boolean).join("\n\n"),
      },
    ];
  }

  /**
   * The final design review's non-blocking points, handed on as advice. They come from the latest design step only when
   * it is a review that settled the design: an author step after it (changes asked at the design check, or following the
   * coordinator's call) rewrote the brief, so earlier points are out of date. Only points that review raised and nobody
   * answered since count; records that cannot show this give none.
   */
  private designNotes(scope: RepositoryContext): Section[] {
    return finalDesignNotes(scope.task, this.k.s.roles);
  }

  /** The design's objections; for the architect following the coordinator's call, the call and what it must answer. */
  private objections(scope: RepositoryContext, roleId: Id): Section[] {
    const { task } = scope;
    const call = this.k.role(roleId, task)?.result === "brief" ? followingCall(task as unknown as Task) : undefined;
    if (!call) return task.objections.length ? [{ title: "Objections so far", body: formatObjections(task.objections as Task["objections"]) }] : [];
    const due = dueAnswers(task.objections as Task["objections"], call);
    const open = due.filter((objection) => objection.status === "open");
    const settled = due.filter((objection) => objection.status !== "open");
    const earlier = task.objections.filter((objection) => !due.some((entry) => entry.id === objection.id));
    const sections: Section[] = [{ title: "The coordinator's call (final, exact words)", body: call.text }];
    if (open.length || !settled.length) sections.push({ title: "Objections still open (answer every one by id)", body: open.length ? formatObjections(open) : "None. Every objection already has an answer." });
    // After changes asked for at the check, the architect answers these again, so it can correct a decision or a note.
    if (settled.length) sections.push({ title: "Objections answered after the call (answer every one again by id)", body: formatObjections(settled) });
    if (earlier.length) sections.push({ title: "Objections answered before the call", body: formatObjections(earlier as Task["objections"]) });
    return sections;
  }

  private checks(scope: RepositoryContext): Section[] {
    const { work: repository } = scope;
    const product = this.k.productOf(scope);
    const lines = (product && repository.worktree ? checksFor(product, repository.worktree) : (product?.checks ?? [])).map((check) => `- ${check.name}: ${commandText(check.argv)}`);
    // The repository's own commit hooks: Petrina runs them on the whole change, as git would when committing it.
    if (product?.hooks?.includes("pre-commit")) lines.push("- Pre-commit hook: the repository's own, which Petrina runs on your whole change as if committing it. Run it yourself with `git add -A`, then `git hook run pre-commit`.");
    if (product?.hooks?.includes("commit-msg")) lines.push(`- Commit message hook: the repository's own, which Petrina runs on the task's commit message (your "title" and summary).`);
    return lines.length ? [{ title: "Product checks", body: lines.join("\n") }] : [];
  }

  private findingsToAnswer(scope: RepositoryContext): Section[] {
    const { task, work: repository } = scope;
    if (!task.fixing) return [];
    // Acceptance failures whose returns are used up wait for the coordinator, even when this product fixes another finding.
    const open = builderFindings(task, repository.productId);
    const logs = repository.checks?.results.filter((run) => !run.ok).flatMap((run) => {
      const saved = run.logPath ? `- ${run.name}: ${JSON.stringify(run.logPath)}${run.logError ? " (incomplete)" : ""}` : "";
      const error = run.logError ? `- ${run.name}: Could not save the complete output: ${run.logError}` : "";
      return [saved, error, !run.logPath && !run.logError ? `- ${run.name}: This older run has only the saved output excerpt; no complete log was saved.` : ""].filter(Boolean);
    }) ?? [];
    return open.length ? [
      { title: "Review findings (answer every one by id; fix every Important one)", body: formatFindings(open as Task["findings"], { complete: true }) },
      ...(logs.length ? [{ title: "Saved failed-check output (search these exact files for the failure; do not rerun just to recover the error)", body: logs.join("\n") }] : []),
    ] : [];
  }

  private report(scope: RepositoryContext, roleId: Id): Section[] {
    const { work: repository } = scope;
    if (!repository.report) return [];
    const sections = [{ title: "What the builder reports", body: [repository.report.summary, ...repository.report.changes.map((change) => `- ${change}`), repository.report.tests ? `Tests: ${repository.report.tests}` : ""].filter(Boolean).join("\n") }];
    // The builder keeps what goes out with the work current: what it wrote last time, to hand back as it should read now.
    if (this.k.role(roleId, scope.task)?.result === "build" && repository.delivery === "pull-request" && repository.report.description) sections.push({ title: "The pull request description you wrote last time", body: repository.report.description });
    return sections;
  }

  private checkResults(scope: RepositoryContext, applicability?: RecordedChecksApplicability): Section[] {
    const work = scope.work;
    if (!work.checks && !work.checkSetup && !work.checkSetupInvalidated) return [];
    const setup = checkSetupOutcome(work.checkSetup, undefined, work.checkSetupInvalidated);
    const lines = (work.checks?.results ?? []).map(run => `- ${run.name}: ${checkOutcomeLabel(checkOutcome(run))} in ${Math.max(1, Math.round(run.ms / 1000))}s (${run.command})${run.cleanupIncomplete ? ` — ${CLEANUP_INCOMPLETE}` : ""}`);
    const matched = applicability?.inputs.kind === "matches";
    const guidance = matched ? "These recorded results match the observed code and definitions. The saved environment describes its last setup observation; this read did not revalidate the local environment. Petrina's verification gate owns live reuse. Use focused tests for acceptance rather than repeating full suites."
      : "Historical results: these have not been established to cover the current code, required commands and hooks. Do not use an older pass as proof that this version passes.";
    return [{ title: matched ? "Recorded product checks, run by Petrina itself" : "Historical product checks, run by Petrina itself", body: [guidance,
      `${checkSetupWords(setup)}${work.checkSetup?.endedAt ? ` at ${new Date(work.checkSetup.endedAt).toISOString()}` : ""}. Setup prerequisites are separate from product checks and never prove product acceptance.`,
      ...(applicability?.batch.kind === "blocked" ? [applicability.batch.reason] : []), ...lines].join("\n") }];
  }
}

/**
 * Every agent on the task sees all of the coordinator's notes, reviewers included. What was said in an
 * earlier attempt at this step is left out only when `earlierCarried`: the opening hears it in a section
 * of its own, or continues a conversation that already heard it. A fresh parallel opening has neither.
 */
export function coordinatorNotes(scope: RepositoryContext, member?: string, earlierCarried = false): Section[] {
  const { task, work: repository } = scope;
  const fromEarlier = earlierCarried && (repository.stepAttempts ?? 0) > 1 ? ((task.stepNotes ?? []) as StepNote[]) : [];
  const replaying = task.maintenance?.pendingReply && task.maintenance.settingsDecision?.choice === "keep";
  const available = (task.notes ?? []).filter(note => {
    const queued = task.queued.find(message => message.id === note.id);
    return backgroundMessage(task, note.id, member) || !replaying && queued &&
      (queued.recipients?.[member ?? "main"] === false || !queued.recipients && member === undefined) &&
      !["sending", "accepted", "unconfirmed"].includes(queued.deliveries?.[member ?? "main"]?.state ?? "");
  });
  const render = (notes: typeof available) => notes.length ? `${COORDINATOR_NOTES_RULE}\n\n${notes.map(renderCoordinatorNote).join("\n\n")}` : "";
  const notes = available.filter(note => backgroundMessage(task, note.id, member) && !fromEarlier.some(said => note.id !== undefined && note.id === said.id && note.text === said.text));
  const ids = (task.notes ?? []).map(note => note.id);
  // Keep an empty metadata carrier so a continuation can name the last withdrawn note.
  return [{ title: "The coordinator's notes on this task (preserve product decisions; read each instruction in its original step)", body: render(notes), background: render(available),
    coordinatorNotes: available.map(note => {
      const background = backgroundMessage(task, note.id, member);
      return { ...note, background, ...(background && !notes.includes(note) ? { earlierCarried: true } : {}) };
    }),
    deferredCoordinatorNoteIds: (task.notes ?? []).filter(note => !available.includes(note) && note.id !== undefined).map(note => note.id!),
    ambiguousCoordinatorNotes: ids.some(id => !id) || new Set(ids).size !== ids.length,
  }];
}
