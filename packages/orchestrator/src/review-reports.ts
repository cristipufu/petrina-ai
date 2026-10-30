import {
  addEvidence,
  assignedProducts,
  closedFinding,
  findingCount,
  noteReproduction,
  noteReviewTag,
  openStep,
  recordDisputes,
  recordStepResult,
  reopenFinding,
  reopensUnresolved,
  reviewClaimIds,
  reviewRoundSteps,
  type DeepMutable,
  type Finding,
  type Id,
  type JourneyStep,
  type Stage
} from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import type { ReviewReport, ReviewReportHost } from "./ports/review-reports.js";

const SEVERITY = { important: "blocking", nit: "suggestion", "pre-existing": "pre-existing" } as const;

/** Recover older accepted reports before new hand-backs make the round's transitions explicit. */
function recordedReopenings(group: readonly JourneyStep[]): { id: Id; evidence: boolean }[] {
  const reopened = new Map<Id, { id: Id; evidence: boolean }>();
  for (const step of group) {
    const recorded = step.result?.findingChanges?.reopened;
    if (recorded) for (const finding of recorded) reopened.set(finding.id, finding);
    // Only saved participant copies can recover older transitions, never today's live findings.
    else for (const result of step.agentResults ?? []) for (const finding of result.findings ?? []) {
      if (finding.reopenedAt !== undefined && finding.reopenedAt >= group[0]!.startedAt && finding.reopenedAt >= result.at) reopened.set(
        finding.id,
        {
        id: finding.id,
        evidence: !!finding.evidence
      }
      );
    }
  }
  return [...reopened.values()];
}

/** Apply normalized reports and settle their group; actual sessions and persistence stay outside this controller. */
export class ReviewReports {
  constructor(private readonly host: ReviewReportHost) {}

  apply(task: RuntimeTask, stage: Stage, result: ReviewReport, profileId: Id, roleId: Id, reviewerKey: string): void {
    const reopenings = new Set<Id>();
    for (const id of result.confirms) {
      const finding = task.findings.find((entry) => entry.id === id);
      // Fresh proof can challenge a claimed fix or dismissal without creating another finding, and on changed code starts
      // a fresh ballot for one a vote left unresolved. Native check findings remain governed by the actual check results.
      const evidence = result.confirmationEvidence[id];
      if (finding && finding.raisedBy !== "petrina" && (closedFinding(finding) || reopensUnresolved(finding, task.hunt, evidence))) {
        reopenFinding(finding, this.host.now(), evidence);
        reopenings.add(id);
      } else if (finding) addEvidence(finding, evidence);
      if (finding && evidence?.trim()) noteReproduction(task, finding, this.host.now());
      if (finding && !finding.confirmedBy.includes(profileId)) finding.confirmedBy.push(profileId);
    }
    if (task.hunt) for (const report of [
      ...result.confirms.map(id => ({
      id,
      resolved: false,
      evidence: result.confirmationEvidence[id]
    })),
      ...result.resolves.map(entry => ({
      ...entry,
      resolved: true
    }))
    ]) {
      task.hunt.findingChecks = {
        ...task.hunt.findingChecks,
        [report.id]: {
        ...task.hunt.findingChecks?.[report.id],
        [reviewerKey]: {
        by: profileId,
        resolved: report.resolved,
        ...(report.evidence ? { evidence: report.evidence } : {})
      }
      }
      };
    }
    recordDisputes(
      task.findings.filter((finding) => !task.repositories || assignedProducts(
      task,
      finding.productIds
    ).length > 0),
      result.disputes,
      profileId,
      this.host.now()
    );
    if (task.repositories && task.hunt) for (const finding of task.findings) {
      const owners = assignedProducts(task, finding.productIds);
      if (owners.length < 2 || finding.raisedBy === "petrina" || finding.text.startsWith("Failed acceptance check:") || !owners.every((id) => finding.answers?.[id]?.fixed)) continue;
      const passed = result.verdict === "pass" && !result.confirms.includes(finding.id);
      task.hunt.fixReviews = { ...task.hunt.fixReviews, [finding.id]: { ...task.hunt.fixReviews?.[finding.id], [reviewerKey]: passed } };
    }
    // New reports keep their own identities. Only explicit confirmations by id back an earlier finding.
    const shown = task.shownFollowUps?.[`review-${reviewerKey}`] ?? task.shownFollowUps?.[reviewerKey];
    const picked = (value: string | undefined): Finding["sameBug"] | undefined => {
      const choice = value?.trim();
      if (!choice || !shown?.length || (choice !== "none" && !shown.includes(choice))) return undefined;
      return choice === "none" ? "none" : choice;
    };
    const raised: DeepMutable<Finding>[] = [];
    for (const finding of result.findings) {
      const choice = picked(finding.sameBug);
      const tagged = noteReviewTag(undefined, SEVERITY[finding.severity], profileId, this.host.now());
      const relevant = tagged.judgments.some((entry) => entry.severity === "pre-existing");
      const created: DeepMutable<Finding> = {
        id: this.host.id(task), text: finding.text,
        ...(task.repositories ? { productIds: assignedProducts(task, finding.productIds) } : {}),
        ...(finding.where ? { where: finding.where } : {}),
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
        ...(finding.steps?.trim() ? { steps: finding.steps.trim() } : {}),
        ...(shown?.length ? { cardsShown: [...shown] } : {}),
        ...(choice ? { sameBug: choice } : {}),
        ...(relevant ? { judgments: tagged.judgments } : {}),
        severity: tagged.severity, raisedBy: profileId, roleId, confirmedBy: [], status: "open",
      };
      task.findings.push(created);
      raised.push(created);
    }
    const important = raised.some((finding) => finding.severity === "blocking");
    // A confirmed existing finding asks for fixes just as a newly raised one does. Count each once.
    const created = new Set(raised.map((finding) => finding.id));
    const step = openStep(task);
    const seen = new Set([
      ...(step?.result?.findings ?? []).map((finding) => finding.id),
      ...result.confirms,
      ...result.disputes.map((finding) => finding.id),
      ...result.resolves.map(finding => finding.id)
    ]);
    const priorChanges = step?.result?.findingChanges;
    const priorReopened = recordedReopenings(step ? reviewRoundSteps(task, step.id, this.host.roles()) : []);
    const reopened = task.findings.filter(finding => reopenings.has(finding.id)).map(finding => ({ id: finding.id, evidence: !!finding.evidence }));
    recordStepResult(task, {
      findings: task.findings.filter((finding) => seen.has(finding.id) || created.has(finding.id)),
      findingChanges: {
        raised: [
        ...(priorChanges?.raised ?? []),
        ...created
      ],
        fixed: priorChanges?.fixed ?? [],
        dismissed: priorChanges?.dismissed ?? [],
        reopened: [
        ...priorReopened,
        ...reopened
      ]
      },
    });
    // This seat's own copy of the records it touched: later peers and rounds never rewrite it.
    const own = step?.agentResults?.findLast((entry) => entry.roleId === roleId && entry.profileId === profileId && (entry.inputIndex === undefined || step.agentInputs?.[entry.inputIndex]?.reviewerKey === reviewerKey));
    if (own) own.findings = structuredClone(task.findings.filter((finding) => result.confirms.includes(finding.id) || result.disputes.some((dispute) => dispute.id === finding.id) || result.resolves.some(entry => entry.id === finding.id) || created.has(finding.id)));
    const supported = task.findings.filter((finding) => finding.status === "open" && (result.confirms.includes(finding.id) || created.has(finding.id)));
    this.host.verdict(
      task,
      roleId,
      profileId,
      task.rounds[stage.id] ?? 1,
      result.verdict,
      supported.length,
      supported.filter((finding) => finding.severity === "blocking").length
    );
    const confirmed = result.confirms.length;
    const also = [confirmed ? `confirmed ${confirmed}` : "", result.disputes.length ? `disputed ${result.disputes.length}` : ""].filter(Boolean).join(", ");
    this.host.note(task, important ? "warn" : "done", `${findingCount(raised)}${also ? `; ${also}` : ""}`, roleId, profileId);
  }

  settle(task: RuntimeTask, stage: Stage): void {
    if (!task.hunt || task.hunt.stageId !== stage.id || task.hunt.round !== (task.rounds[stage.id] ?? 1) || this.host.hasPendingReviewers(task, stage)) return;
    const reviewers = Object.keys(task.hunt.reported);
    const before = new Map(task.findings.map(finding => [finding.id, finding.status]));
    for (const finding of task.findings) {
      if (finding.status !== "open" || finding.severity !== "pre-existing" || finding.raisedBy === "petrina") continue;
      const checks = Object.values(task.hunt.findingChecks?.[finding.id] ?? {});
      const repaired = checks.find(check => check.resolved && check.evidence);
      const versions = task.hunt.input?.heads;
      // Omission and a passing review are not repair evidence. Any current confirmation
      // keeps the bug open; resolving reports stay on their immutable journey results.
      if (!repaired?.evidence || checks.some(check => !check.resolved) || !versions || !Object.keys(versions).length) continue;
      finding.resolution = { by: repaired.by, evidence: repaired.evidence, at: this.host.now(), versions: { ...versions } };
      finding.status = "fixed";
      addEvidence(finding, `Verified repaired: ${repaired.evidence}`);
    }
    for (const finding of task.findings) {
      if (finding.status !== "open" || finding.raisedBy === "petrina" || finding.text.startsWith("Failed acceptance check:")) continue;
      if (task.repositories && !assignedProducts(task, finding.productIds).length) continue;
      if (finding.disputes?.length && !finding.confirmedBy.length) finding.status = "dismissed";
      if (!task.repositories) continue;
      const owners = assignedProducts(task, finding.productIds);
      const reviews = task.hunt.fixReviews?.[finding.id];
      if (owners.length > 1 && finding.status === "open" && !finding.confirmedBy.length && owners.every((id) => finding.answers?.[id]?.fixed) && reviewers.length && reviewers.every((key) => reviews?.[key] === true)) finding.status = "fixed";
    }
    // The round's decision includes unmentioned fixes and claims, not just ids touched by a
    // reviewer. Never rewrite a closed step, the pre-vote copy, or any participant's hand-back.
    const step = openStep(task);
    if (step?.stageId === stage.id && step.round === task.hunt.round && step.roleId && this.host.roles().find(role => role.id === step.roleId)?.result === "findings" && !step.result?.findingsSettled) {
      const group = reviewRoundSteps(task, step.id, this.host.roles());
      const raised = task.findings.slice(task.hunt.findings ?? task.findings.length).map(finding => finding.id);
      const claims = new Set(reviewClaimIds(task, group[0]!.id, this.host.roles()));
      const changed = task.findings.filter(finding => before.get(finding.id) !== finding.status);
      const seen = new Set([
        ...group.flatMap(entry => [
        ...(entry.result?.findings ?? []),
        ...(entry.agentResults ?? []).flatMap(result => result.findings ?? [])
      ]).map(finding => finding.id),
        ...raised,
        ...claims,
        ...changed.map(finding => finding.id)
      ]);
      const findingChanges = {
        raised,
        fixed: task.findings.filter(finding => finding.status === "fixed" && (before.get(finding.id) !== "fixed" || claims.has(finding.id))).map(finding => finding.id),
        dismissed: changed.filter(finding => finding.status === "dismissed").map(finding => finding.id),
        reopened: recordedReopenings(group),
        claimedFixed: [...claims],
      };
      recordStepResult(task, { findings: task.findings.filter(finding => seen.has(finding.id)), findingsSettled: true, findingChanges });
    }
  }
}
