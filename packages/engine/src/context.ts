// What each role is shown besides its instructions: the coordinator's notes, the brief, objections,
// findings, Petrina's own checks and the review guide.

import { dueAnswers, followingCall, type Id, type StepNote, type Task } from "@petrina/core";
import { formatFindings, formatObjections } from "./prompts.js";
import { commandText } from "./checks.js";
import { GUIDE_FILE } from "./guide.js";
import { Kernel, type MTask } from "./kernel.js";
import type { GuideKeeper } from "./guide-keeper.js";

export class Context {
  constructor(private readonly k: Kernel, private readonly guide: GuideKeeper) {}

  sectionsFor(task: MTask, roleId: Id): { title: string; body: string }[] {
    const sections: { title: string; body: string }[] = [];
    const brief = task.brief;
    // The opening instructions hold every note, so nothing waits in line behind them.
    task.queued.splice(0);
    // Every agent on the task sees all of the coordinator's notes, reviewers included.
    // A step started again hears what was said in its earlier attempt in that section of its own,
    // so those notes are left out here: nothing is heard twice.
    const fromEarlier = (task.stepAttempts ?? 0) > 1 ? ((task.stepNotes ?? []) as StepNote[]) : [];
    const notes = (task.notes ?? []).filter((note) => !fromEarlier.some((said) => (note.id !== undefined && note.id === said.id) || note.text === said.text)).map((note) => `- ${note.text}`);
    if (notes.length) sections.push({ title: "The coordinator's notes on this task (follow them; where they conflict with the brief or each other, the latest wins)", body: notes.join("\n\n") });
    if (brief && roleId !== "planner") {
      sections.push({
        title: "Design brief",
        body: [brief.summary, brief.forUsers.length ? `What changes for users:\n${brief.forUsers.map((line) => `- ${line}`).join("\n")}` : "", `Acceptance checklist:\n${brief.acceptance.map((item) => `- ${item.text}`).join("\n")}`, brief.risks.length ? `Risks:\n${brief.risks.map((line) => `- ${line}`).join("\n")}` : ""].filter(Boolean).join("\n\n"),
      });
    }
    const call = roleId === "architect" ? followingCall(task as unknown as Task) : undefined;
    if (call) {
      const due = dueAnswers(task.objections as Task["objections"], call);
      const open = due.filter((objection) => objection.status === "open");
      const settled = due.filter((objection) => objection.status !== "open");
      const earlier = task.objections.filter((objection) => !due.some((entry) => entry.id === objection.id));
      sections.push({ title: "The coordinator's call (final, exact words)", body: call.text });
      if (open.length || !settled.length) sections.push({ title: "Objections still open (answer every one by id)", body: open.length ? formatObjections(open) : "None. Every objection already has an answer." });
      // After changes asked for at the check, the architect answers these again, so it can correct a decision or a note.
      if (settled.length) sections.push({ title: "Objections answered after the call (answer every one again by id)", body: formatObjections(settled) });
      if (earlier.length) sections.push({ title: "Objections answered before the call", body: formatObjections(earlier as Task["objections"]) });
    } else if ((roleId === "architect" || roleId === "design-reviewer") && task.objections.length) {
      sections.push({ title: "Objections so far", body: formatObjections(task.objections as Task["objections"]) });
    }
    const checks = this.k.productOf(task)?.checks;
    if (roleId === "builder" && checks?.length) {
      sections.push({ title: "The product's checks (run every one in full before you finish)", body: checks.map((check) => `- ${check.name}: ${commandText(check.argv)}`).join("\n") });
    }
    if (roleId === "builder" && task.fixing) {
      const open = task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing");
      if (open.length) sections.push({ title: "Review findings (answer every one by id; fix every Important one)", body: formatFindings(open as Task["findings"]) });
    }
    const reviewer = roleId === "code-reviewer" || roleId === "security-reviewer";
    const guide = reviewer || roleId === "verifier" || roleId === "builder" ? this.guide.reviewGuide(task) : "";
    if (guide) {
      const how = roleId === "builder" ? "reviewers check every point" : "check the change against every point. It never excuses a problem, and a change to it in this branch is part of what you review";
      sections.push({ title: `The product's review guide (${GUIDE_FILE} on ${task.base ?? "the base branch"}, and points the coordinator accepted): ${how}`, body: guide });
    }
    if ((reviewer || roleId === "verifier" || roleId === "shipper" || roleId === "tester") && task.report) {
      sections.push({ title: "What the builder reports", body: [task.report.summary, ...task.report.changes.map((change) => `- ${change}`), task.report.tests ? `Tests: ${task.report.tests}` : ""].filter(Boolean).join("\n") });
    }
    if ((reviewer || roleId === "verifier" || roleId === "tester" || roleId === "shipper") && task.checks?.results.length) {
      const lines = task.checks.results.map((run) => `- ${run.name}: ${run.ok ? "passed" : run.timedOut ? "did not finish" : "failed"} in ${Math.max(1, Math.round(run.ms / 1000))}s (${run.command})`);
      sections.push({ title: "The product's checks, run by Petrina itself on this commit (evidence, not an agent's word)", body: lines.join("\n") });
    }
    if (reviewer && task.findings.length) sections.push({ title: "Findings so far (confirm or dispute by id)", body: formatFindings(task.findings as Task["findings"]) });
    if (roleId === "shipper") {
      const reviews = task.findings.filter((finding) => finding.status !== "dismissed");
      sections.push({ title: "Review summary (list pre-existing findings as follow-ups in what you deliver)", body: reviews.length ? formatFindings(reviews as Task["findings"]) : "Nothing to fix: every reviewer passed it." });
      if (task.shipping?.found) {
        sections.push({
          title: "An earlier attempt to ship this was interrupted",
          body: `What Petrina found: ${task.shipping.found}\nFinish that attempt instead of starting over. Reuse what it already did (a pushed branch, a version change, a tag). Do not choose a new version if one is already pushed, and never open a second pull request or publish a second release for this work.`,
        });
      }
    }
    return sections;
  }
}
