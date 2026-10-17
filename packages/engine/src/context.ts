// What each role is shown besides its instructions. Each part of the context is built here once; a role's
// contract (roles.ts) says which parts it reads, and they always appear in the same order.

import { dueAnswers, followingCall, type Id, type StepNote, type Task } from "@petrina/core";
import { formatFindings, formatObjections } from "./prompts.js";
import { commandText } from "./checks.js";
import { GUIDE_FILE } from "./guide.js";
import { CONTEXT_PARTS, contractFor, type ContextPart } from "./roles.js";
import type { Kernel, MTask } from "./kernel.js";
import type { GuideKeeper } from "./guide-keeper.js";

export interface Section {
  title: string;
  body: string;
}

export class Context {
  private readonly parts: Record<ContextPart, (task: MTask, roleId: Id) => Section[]> = {
    notes: (task) => this.notes(task),
    brief: (task) => this.brief(task),
    objections: (task, roleId) => this.objections(task, roleId),
    checks: (task) => this.checks(task),
    "findings-to-answer": (task) => this.findingsToAnswer(task),
    "review-guide": (task, roleId) => this.reviewGuide(task, roleId),
    report: (task) => this.report(task),
    "check-results": (task) => this.checkResults(task),
    findings: (task) => (task.findings.length ? [{ title: "Findings so far (confirm or dispute by id)", body: formatFindings(task.findings as Task["findings"]) }] : []),
    "review-summary": (task) => this.reviewSummary(task),
    shipping: (task) => this.shipping(task),
  };

  constructor(
    private readonly k: Kernel,
    private readonly guide: GuideKeeper,
  ) {}

  sectionsFor(task: MTask, roleId: Id): Section[] {
    // The opening instructions hold every note, so nothing waits in line behind them.
    task.queued.splice(0);
    const role = this.k.role(roleId);
    const reads: readonly ContextPart[] = role ? contractFor(role).reads : ["notes", "brief"];
    return CONTEXT_PARTS.filter((part) => reads.includes(part)).flatMap((part) => this.parts[part](task, roleId));
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
    const lines = (product?.checks ?? []).map((check) => `- ${check.name}: ${commandText(check.argv)}`);
    // The repository's own commit hooks: Petrina runs them on the whole change, as git would when committing it.
    if (product?.hooks?.includes("pre-commit")) lines.push("- Pre-commit hook: the repository's own, which Petrina runs on your whole change as if committing it. Run it yourself with `git add -A`, then `git hook run pre-commit`.");
    if (product?.hooks?.includes("commit-msg")) lines.push(`- Commit message hook: the repository's own, which Petrina runs on the task's commit message (your "title" and summary).`);
    return lines.length ? [{ title: "The product's checks (run every one in full before you finish)", body: lines.join("\n") }] : [];
  }

  private findingsToAnswer(task: MTask): Section[] {
    if (!task.fixing) return [];
    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing");
    return open.length ? [{ title: "Review findings (answer every one by id; fix every Important one)", body: formatFindings(open as Task["findings"]) }] : [];
  }

  private reviewGuide(task: MTask, roleId: Id): Section[] {
    const guide = this.guide.reviewGuide(task);
    if (!guide) return [];
    const how = this.k.role(roleId)?.canEdit ? "reviewers check every point" : "check the change against every point. It never excuses a problem, and a change to it in this branch is part of what you review";
    return [{ title: `The product's review guide (${GUIDE_FILE} on ${task.base ?? "the base branch"}, and points the coordinator accepted): ${how}`, body: guide }];
  }

  private report(task: MTask): Section[] {
    if (!task.report) return [];
    return [{ title: "What the builder reports", body: [task.report.summary, ...task.report.changes.map((change) => `- ${change}`), task.report.tests ? `Tests: ${task.report.tests}` : ""].filter(Boolean).join("\n") }];
  }

  private checkResults(task: MTask): Section[] {
    if (!task.checks?.results.length) return [];
    const lines = task.checks.results.map((run) => `- ${run.name}: ${run.ok ? "passed" : run.timedOut ? "did not finish" : "failed"} in ${Math.max(1, Math.round(run.ms / 1000))}s (${run.command})`);
    return [{ title: "The product's checks, run by Petrina itself on this commit (evidence, not an agent's word)", body: lines.join("\n") }];
  }

  private reviewSummary(task: MTask): Section[] {
    const reviews = task.findings.filter((finding) => finding.status !== "dismissed");
    return [{ title: "Review summary (list pre-existing findings as follow-ups in what you deliver)", body: reviews.length ? formatFindings(reviews as Task["findings"]) : "Nothing to fix: every reviewer passed it." }];
  }

  private shipping(task: MTask): Section[] {
    if (!task.shipping?.found) return [];
    return [
      {
        title: "An earlier attempt to ship this was interrupted",
        body: `What Petrina found: ${task.shipping.found}\nFinish that attempt instead of starting over. Reuse what it already did (a pushed branch, a version change, a tag). Do not choose a new version if one is already pushed, and never open a second pull request or publish a second release for this work.`,
      },
    ];
  }
}
