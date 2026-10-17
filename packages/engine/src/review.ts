// Review chains: Petrina's tamper check and the product's checks first, then reviewers one after another,
// Important findings verified on another tool, and the round closing back to the builder or on to delivery.

import { findingCount, type AgentProfile, type Finding, type Id, type Task } from "@petrina/core";
import * as git from "./git.js";
import { VerifyResult, formatFindings, ReviewResult } from "./prompts.js";
import { Kernel, type DeepMutable, type MStage, type MTask, PLANNER_PROFILE, lastIndex } from "./kernel.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import type { ProductChecks } from "./product-checks.js";

/**
 * A later reviewer thinks findings are wrong: each dispute is kept with who and why. One reviewer's
 * dispute dismisses a finding nobody else backed; Petrina's own checks and confirmed findings stay open.
 */
export function recordDisputes(findings: DeepMutable<Finding>[], disputes: readonly { id: string; reason: string }[], by: Id, at: number): void {
  for (const dispute of disputes) {
    const finding = findings.find((entry) => entry.id === dispute.id);
    if (!finding || finding.status !== "open") continue;
    finding.disputes = [...(finding.disputes ?? []), { by, reason: dispute.reason, at }];
    if (finding.raisedBy !== "petrina" && finding.confirmedBy.length === 0) finding.status = "dismissed";
  }
}

/** What a reviewer's tag means for the finding. */
const SEVERITY = { important: "blocking", nit: "suggestion", "pre-existing": "pre-existing" } as const;

/** The same finding, however it is spaced or capitalised. */
function sameFinding(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export class Reviews {
  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context, private readonly checks: ProductChecks) {}

  async runReview(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const round = task.rounds[stage.id] ?? 1;
    // After the last reviewer, Important findings are checked on the other tool before the round closes.
    if (task.sub >= stage.profileIds.length) return this.runVerify(task, stage, round, signal);
    if (task.sub === 0) {
      // The chain starts again from its first reviewer: changes made by hand are in what it reviews.
      delete task.handChanges;
      const problems = await git.tamperCheck(task.worktree!, task.baseSha ?? task.base!);
      // Petrina's own findings settle on what it sees now, whatever anyone answered.
      for (const finding of task.findings) {
        if (finding.raisedBy === "petrina" && finding.status === "open" && !finding.text.startsWith("Check failed") && !problems.includes(finding.text)) finding.status = "fixed";
      }
      for (const problem of problems) {
        if (!task.findings.some((finding) => finding.text === problem && finding.status === "open")) {
          task.findings.push({ id: this.k.id(task.id), text: problem, severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
        }
      }
      this.k.log(task, problems.length ? "warn" : "done", problems.length ? `Tamper check: ${problems.length} problem${problems.length === 1 ? "" : "s"}` : "Tamper check passed: no tests removed or skipped");
      // The product's checks run before any reviewer spends time: an agent's word never counts as passing.
      // A later chain on the same commit (a security review) goes by the run that just passed.
      const head = await git.head(task.worktree!).catch(() => undefined);
      const passed = !!head && task.checks?.sha === head && task.checks.results.every((run) => run.ok);
      const checks = passed ? [] : await this.checks.ensureChecks(task, signal);
      if ((await this.checks.runProductChecks(task, checks, signal)) > 0) {
        this.k.log(task, "warn", "Reviewers wait until the checks pass");
        return this.closeReviewRound(task, stage, round, false);
      }
    }
    const profileId = stage.profileIds[task.sub] ?? stage.profileIds[0] ?? "sol-xhigh";
    const result = await this.turns.turn(task, stage.roleId, profileId, () => this.context.sectionsFor(task, stage.roleId), ReviewResult, signal);
    for (const id of result.confirms) {
      const finding = task.findings.find((entry) => entry.id === id);
      if (finding && !finding.confirmedBy.includes(profileId)) finding.confirmedBy.push(profileId);
    }
    recordDisputes(task.findings, result.disputes, profileId, Date.now());
    // A finding is raised once: a repeat of any earlier one, open or settled, is dropped.
    const known = new Set(task.findings.map((finding) => sameFinding(finding.text)));
    const raised = result.findings.filter((finding) => !known.has(sameFinding(finding.text)) && known.add(sameFinding(finding.text)));
    for (const finding of raised) {
      task.findings.push({
        id: this.k.id(task.id),
        text: finding.text,
        ...(finding.where ? { where: finding.where } : {}),
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
        severity: SEVERITY[finding.severity],
        raisedBy: profileId,
        confirmedBy: [],
        status: "open",
      });
    }
    await this.k.undoReadOnly(task, stage.roleId);
    this.k.finishStep(task);
    const important = raised.some((finding) => finding.severity === "important");
    const also = [result.confirms.length ? `confirmed ${result.confirms.length}` : "", result.disputes.length ? `disputed ${result.disputes.length}` : ""].filter(Boolean).join(", ");
    this.k.log(task, important ? "warn" : "done", `${findingCount(raised.map((finding) => ({ severity: SEVERITY[finding.severity] })))}${also ? `; ${also}` : ""}`, stage.roleId, profileId);
    if (this.k.rerun(task)) return "continue";

    if (task.sub + 1 < stage.profileIds.length) {
      task.sub += 1;
      this.k.commit();
      return "continue";
    }
    // Every reviewer has looked: on to checking Important findings, or the round closes.
    task.sub = stage.profileIds.length;
    this.k.commit();
    return "continue";
  }

  /**
   * An Important finding sends work back only once a fresh agent on another tool agrees. One turn
   * checks the findings raised on one tool; the step repeats until none is left unchecked.
   */
  private async runVerify(task: MTask, stage: MStage, round: number, signal: AbortSignal): Promise<"continue" | "stop"> {
    const next = this.nextVerification(task, stage);
    if (!next) return this.closeReviewRound(task, stage, round, true);
    const ids = new Set(next.findings.map((finding) => finding.id));
    const result = await this.turns.turn(
      task,
      "verifier",
      next.profileId,
      () => [...this.context.sectionsFor(task, "verifier"), { title: "Important findings to check (a verdict on every one, by id)", body: formatFindings(next.findings) }],
      VerifyResult,
      signal,
      {
        status: `Checking ${next.findings.length} important finding${next.findings.length === 1 ? "" : "s"} with fresh eyes`,
        check: (value) => {
          const missing = next.findings.filter((finding) => !value.verdicts.some((verdict) => verdict.id === finding.id));
          return missing.length ? `give a verdict on every finding by id, and these have none:\n${formatFindings(missing)}` : undefined;
        },
      },
    );
    const at = Date.now();
    for (const verdict of result.verdicts) {
      const finding = task.findings.find((entry) => entry.id === verdict.id && ids.has(entry.id));
      if (!finding) continue;
      finding.verification = { by: next.profileId, verdict: verdict.verdict, reason: verdict.reason, at };
      if (verdict.verdict === "not-a-bug") finding.status = "dismissed";
      else if (verdict.verdict === "nit") finding.severity = "suggestion";
      else if (verdict.verdict === "pre-existing") finding.severity = "pre-existing";
    }
    await this.k.undoReadOnly(task, "verifier");
    this.k.finishStep(task);
    const verdicts = result.verdicts.filter((verdict) => ids.has(verdict.id));
    const real = verdicts.filter((verdict) => verdict.verdict === "real").length;
    this.k.log(task, real ? "warn" : "done", `${verdicts.length} checked: ${real} real${verdicts.length > real ? `, ${verdicts.length - real} not holding the work back` : ""}`, "verifier", next.profileId);
    if (this.k.rerun(task)) return "continue";
    this.k.commit();
    return "continue";
  }

  /**
   * The next Important findings to check: those raised on one tool that nobody on another tool has
   * confirmed or checked yet. Petrina's own findings (checks, tamper check) are evidence already.
   */
  nextVerification(task: MTask, stage: MStage): { profileId: Id; findings: Task["findings"] } | undefined {
    const toolOf = (profileId: Id) => this.k.profile(profileId)?.toolId;
    const pending = task.findings.filter(
      (finding) =>
        finding.status === "open" &&
        finding.severity === "blocking" &&
        finding.raisedBy !== "petrina" &&
        !finding.verification &&
        !finding.confirmedBy.some((by) => toolOf(by) !== toolOf(finding.raisedBy)),
    );
    if (!pending.length) return undefined;
    const tool = toolOf(pending[0]!.raisedBy);
    const ready = (profile: AgentProfile) => this.k.s.tools.some((entry) => entry.id === profile.toolId && entry.status === "ready");
    const other = this.k.s.profiles.filter((profile) => profile.toolId !== tool && ready(profile as AgentProfile));
    // The stage's own reviewers on another tool first; with only one tool working, a fresh agent on the same tool.
    const profileId = stage.profileIds.find((id) => other.some((profile) => profile.id === id)) ?? other[0]?.id ?? stage.profileIds[0] ?? PLANNER_PROFILE;
    return { profileId, findings: pending.filter((finding) => toolOf(finding.raisedBy) === tool) as Task["findings"] };
  }

  /** The end of a review round: back to the builder with what is Important, or on towards delivery. */
  private async closeReviewRound(task: MTask, stage: MStage, round: number, reviewed: boolean): Promise<"continue" | "stop"> {
    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
    const builder = lastIndex(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.roleId === "builder");
    if (open.length > 0 && builder >= 0 && round < (stage.maxRounds ?? 2)) {
      // The next round reviews only what changed since what the reviewers looked at in this one.
      const sha = reviewed ? await git.head(task.worktree!).catch(() => undefined) : undefined;
      if (sha) task.reviewedSha = sha;
      task.rounds[stage.id] = round + 1;
      task.stageIndex = builder;
      task.sub = 0;
      task.fixing = true;
      this.k.log(task, "warn", `Sent back to the builder: ${findingCount(open)}`);
      this.k.commit();
      return "continue";
    }
    task.stageIndex += 1;
    task.sub = 0;
    if (open.length > 0) {
      this.k.log(task, "warn", `Review rounds used up: ${findingCount(open)} still open`);
      // With blocking findings left, the coordinator always looks before anything ships.
      const next = task.plan?.stages[task.stageIndex];
      if (next && next.kind !== "gate") {
        this.k.gate(task, "delivery");
        return "stop";
      }
    } else {
      this.k.log(task, "done", `Review passed: ${findingCount(task.findings.filter((finding) => finding.status === "open"))}`);
    }
    this.k.commit();
    return "continue";
  }
}
