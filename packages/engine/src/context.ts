// What each role is shown besides its instructions. Each part of the context is built here once; a role's
// contract (roles.ts) says which parts it reads, and they always appear in the same order.

import { dueAnswers, followingCall, openFollowUpCards, productsOn, workSummary, type Id, type StepNote, type Task } from "@petrina/core";
import { formatFindings, formatObjections } from "./prompts.js";
import { checksFor, commandText } from "./checks.js";
import { CLEANUP_INCOMPLETE } from "./process-tree.js";
import { CONTEXT_PARTS, contractFor, type ContextPart } from "./roles.js";
import type { Kernel, MTask } from "./kernel.js";
import type { GuideKeeper } from "./guide-keeper.js";
import { takeMessages } from "./messages.js";

export interface Section {
  title: string;
  body: string;
}

export class Context {
  private readonly parts: Record<ContextPart, (task: MTask, roleId: Id, points: readonly string[], currentChecks: boolean) => Section[]> = {
    notes: (task) => this.notes(task),
    brief: (task) => this.brief(task),
    objections: (task, roleId) => this.objections(task, roleId),
    checks: (task) => this.checks(task),
    "findings-to-answer": (task) => this.findingsToAnswer(task),
    // Task context, like the notes: points accepted during this task, before the delivery that writes them to REVIEW.md.
    "guide-points": (task, _roleId, points) => {
      return points.length ? [{ title: `Points the coordinator accepted for the review guide, not in REVIEW.md on ${task.base ?? "the base branch"} yet (check them too)`, body: points.map((point) => `- ${point}`).join("\n") }] : [];
    },
    report: (task, roleId) => this.report(task, roleId),
    "check-results": (task, _roleId, _points, currentChecks) => this.checkResults(task, currentChecks),
    findings: (task) => (task.findings.length ? [{ title: "Findings so far (confirm or dispute by id)", body: formatFindings(task.findings as Task["findings"]) }] : []),
  };

  constructor(
    private readonly k: Kernel,
    private readonly guide: GuideKeeper,
    private readonly currentChecks: (task: MTask) => Promise<boolean> = async () => false,
  ) {}

  async sectionsFor(task: MTask, roleId: Id, member?: string, copies?: Readonly<Record<string, string>>, shownKey?: string): Promise<Section[]> {
    const role = this.k.role(roleId);
    const reads: readonly ContextPart[] = role ? contractFor(role).reads : ["notes", "brief"];
    const points = reads.includes("guide-points") ? await this.guide.pendingPoints(task) : [];
    const currentChecks = reads.includes("check-results") && !!task.checks?.results.length ? await this.currentChecks(task) : false;
    // Gather notes after the read, so notes received while Git worked are included before their queue is cleared.
    takeMessages(task, member, Infinity);
    const source = task.source ? [{ title: "Approved starting point and delivery", body: workSummary({ ...task.source, product: { ...task.source.product, name: this.k.productOf(task)?.name ?? task.source.product.name } }) }] : [];
    const map = task.repositories ? [{ title: "Complete approved product map and responsibility", body: task.repositories.map((work) => [
      work.source ? workSummary(work.source) : work.productId,
      `Product id: ${work.productId}; copy: ${copies?.[work.productId] ?? work.worktree ?? "preparing"}; base version: ${work.baseSha ?? "not prepared"}; last completed review: ${work.reviewedSha ?? "none; inspect the full change"}`,
      `Builder report: ${work.report?.summary ?? "not yet built"}. Checks: ${work.checks?.results.map((run) => `${run.name}: ${run.ok ? "passed" : "failed"}`).join(", ") || "Not run"}`,
      `Review guide: use this product’s REVIEW.md at its saved base version.`,
    ].join("\n")).join("\n\n") + `\n\n${role?.canEdit ? `You own only product ${task.productId}. Read the other copies when needed; change only your own product. Return your own title, report and PR description.` : "Inspect every repository and the behaviour across them together."}\nFor every acceptance result and finding, explicitly return productIds naming every affected product. Unassigned items stay under Together for the coordinator. Passing separate suites cannot prove shared acceptance. For each lesson, return {productId, text} naming its product; unassigned lessons stay under Together and are never added to a repository automatically. Shared repairs require a separate answer from every affected builder and combined verification.` }] : [];
    const sections = [...map, ...source, ...CONTEXT_PARTS.filter((part) => reads.includes(part)).flatMap((part) => this.parts[part](task, roleId, points, currentChecks))];
    if (role?.result === "findings") {
      const cards = openFollowUpCards(this.k.s.tasks as Task[], productsOn(task as Task));
      // shownKey records which cards this reviewer was shown. It is not a message seat:
      // using it as one leaves the coordinator's note queued and sends it as a second turn.
      const key = shownKey ?? member ?? roleId;
      const shown = { ...(task.shownFollowUps ?? {}) };
      if (cards.length) shown[key] = cards.map((card) => card.id);
      else delete shown[key];
      task.shownFollowUps = shown;
      if (cards.length) sections.push({ title: "Open follow-up cards", body: `${cards.map((card) => `- ${card.id}: ${card.title}\n  ${card.problem}`).join("\n")}\nIf this is the same bug as one of these cards, set "sameBug" to that card's id. If it is none of them, set "sameBug" to "none".` });
    }
    if (task.handedBack?.length) sections.push({ title: "What earlier agents on this task handed back", body: task.handedBack.map((entry) => `${entry.roleName ?? this.k.role(entry.roleId)?.name ?? "An earlier role"}${entry.productId ? ` · ${task.repositories?.find((work) => work.productId === entry.productId)?.source?.product.name ?? entry.productId}` : ""}, in “${entry.title ?? task.plan?.stages.find((stage) => stage.id === entry.stageId)?.title ?? "an earlier step"}”: ${entry.summary}\n${entry.notes.map((note) => `- ${note}`).join("\n")}`).join("\n\n") });
    return sections;
  }

  /**
   * Every agent on the task sees all of the coordinator's notes, reviewers included. A step started again
   * hears what was said in its earlier attempt in a section of its own, so those are left out here.
   */
  private notes(task: MTask): Section[] {
    const fromEarlier = (task.stepAttempts ?? 0) > 1 ? ((task.stepNotes ?? []) as StepNote[]) : [];
    const notes = (task.notes ?? []).filter((note) => !fromEarlier.some((said) => (note.id !== undefined && note.id === said.id) || note.text === said.text)).map((note) => `- ${note.text}`);
    return notes.length ? [{ title: "The coordinator's notes on this task (follow them; where they conflict with the brief or each other, the latest wins)", body: notes.join("\n\n") }] : [];
  }

  private brief(task: MTask): Section[] {
    const brief = task.brief;
    if (!brief) return [];
    return [
      {
        title: "Design brief",
        body: [brief.summary, brief.forUsers.length ? `What changes for users:\n${brief.forUsers.map((line) => `- ${line}`).join("\n")}` : "", `Acceptance checklist:\n${brief.acceptance.map((item) => `- ${item.text}`).join("\n")}`, brief.risks.length ? `Risks:\n${brief.risks.map((line) => `- ${line}`).join("\n")}` : ""].filter(Boolean).join("\n\n"),
      },
    ];
  }

  /** The design's objections; for the architect following the coordinator's call, the call and what it must answer. */
  private objections(task: MTask, roleId: Id): Section[] {
    const call = roleId === "architect" ? followingCall(task as unknown as Task) : undefined;
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

  private checks(task: MTask): Section[] {
    const product = this.k.productOf(task);
    const lines = (product && task.worktree ? checksFor(product, task.worktree) : (product?.checks ?? [])).map((check) => `- ${check.name}: ${commandText(check.argv)}`);
    // The repository's own commit hooks: Petrina runs them on the whole change, as git would when committing it.
    if (product?.hooks?.includes("pre-commit")) lines.push("- Pre-commit hook: the repository's own, which Petrina runs on your whole change as if committing it. Run it yourself with `git add -A`, then `git hook run pre-commit`.");
    if (product?.hooks?.includes("commit-msg")) lines.push(`- Commit message hook: the repository's own, which Petrina runs on the task's commit message (your "title" and summary).`);
    return lines.length ? [{ title: "Product checks", body: lines.join("\n") }] : [];
  }

  private findingsToAnswer(task: MTask): Section[] {
    if (!task.fixing) return [];
    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing" && (!task.repositories || finding.productIds?.includes(task.productId)));
    const logs = task.checks?.results.filter((run) => !run.ok).flatMap((run) => {
      const saved = run.logPath ? `- ${run.name}: ${JSON.stringify(run.logPath)}${run.logError ? " (incomplete)" : ""}` : "";
      const error = run.logError ? `- ${run.name}: Could not save the complete output: ${run.logError}` : "";
      return [saved, error, !run.logPath && !run.logError ? `- ${run.name}: This older run has only the saved output excerpt; no complete log was saved.` : ""].filter(Boolean);
    }) ?? [];
    return open.length ? [
      { title: "Review findings (answer every one by id; fix every Important one)", body: formatFindings(open as Task["findings"]) },
      ...(logs.length ? [{ title: "Saved failed-check output (search these exact files for the failure; do not rerun just to recover the error)", body: logs.join("\n") }] : []),
    ] : [];
  }

  private report(task: MTask, roleId: Id): Section[] {
    if (!task.report) return [];
    const sections = [{ title: "What the builder reports", body: [task.report.summary, ...task.report.changes.map((change) => `- ${change}`), task.report.tests ? `Tests: ${task.report.tests}` : ""].filter(Boolean).join("\n") }];
    // The builder keeps what goes out with the work current: what it wrote last time, to hand back as it should read now.
    if (roleId === "builder" && task.delivery === "pull-request" && task.report.description) sections.push({ title: "The pull request description you wrote last time", body: task.report.description });
    return sections;
  }

  private checkResults(task: MTask, current: boolean): Section[] {
    if (!task.checks?.results.length) return [];
    const lines = task.checks.results.map((run) => `- ${run.name}: ${run.ok ? "passed" : run.timedOut ? "did not finish" : "failed"} in ${Math.max(1, Math.round(run.ms / 1000))}s (${run.command})${run.cleanupIncomplete ? ` — ${CLEANUP_INCOMPLETE}` : ""}`);
    const guidance = current
      ? task.checks.results.every((run) => run.ok)
        ? "These complete passing results still match the code, commands and hooks. Use them for automated acceptance; do not rerun the full checks just to confirm them. Exercise every user acceptance item, with focused tests or a build needed to try the product."
        : "These results match the current work, but some checks failed or did not finish. They are not passing acceptance evidence."
      : "Historical results: these have not been established to cover the current code, required commands and hooks. Do not use an older pass as proof that this version passes.";
    return [{ title: current ? "Current product checks, run by Petrina itself" : "Historical product checks, run by Petrina itself", body: [guidance, ...lines].join("\n") }];
  }
}
