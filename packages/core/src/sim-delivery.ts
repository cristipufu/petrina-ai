// Coordinator checkpoints, publishing, pull-request aging, and working-copy cleanup for Simulator.

import { CALL_WORDS, callCheckBody } from "./call.js";
import { decisionEvidence } from "./check-evidence.js";
import { gateStatus, gateTitle } from "./flow.js";
import { beginPetrinaStep, beginYouStep, endAgentStep, endPetrinaStep, JOURNEY_WORDS } from "./journey.js";
import type { GateKind } from "./model.js";
import { companionPreview } from "./repositories.js";
import { workSummary } from "./source.js";
import { simColumnFor, simLog, simMoment, simRaise, simRemoveCopy, simStage, type Draft, type DraftTask, type SimRuntime } from "./sim-runtime.js";

/** Pull requests and commits to main need no agent: Petrina publishes them itself, as the engine does. A release's notes come from the Release Manager first. */
export function simPetrinaDelivers(d: Draft, task: DraftTask): boolean {
  const stage = simStage(task);
  return task.delivery !== "release" && stage?.kind === "do" && d.roles.find(role => role.id === stage.roleId)?.result === "delivery";
}

export function simGate(rt: SimRuntime, d: Draft, task: DraftTask, gate: GateKind): void {
  delete task.agent;
  delete task.helpers;
  const decision = beginYouStep(task, gate, d.now);
  if (gate === "delivery" && task.reviewDecision?.accepted === false) decision.work = "review-decision";
  if (gate === "delivery") decision.productChecks = decisionEvidence(task);
  task.holdsSlot = false;
  task.statusLine = gateStatus(task, gate);
  let body = gate === "design" ? callCheckBody(task) : task.source && (gate === "plan" || gate === "delivery") ? workSummary(task.source) : undefined;
  if (gate === "delivery" && task.repositories) body = [
    ...task.repositories.map((work) => work.source ? workSummary(work.source) : work.productId),
    companionPreview(task.repositories)
  ].filter(Boolean).join("\n\n");
  simRaise(rt, d, task, gate, gateTitle(task, gate), false, body ? { body } : {});
  task.column = simColumnFor(d, task);
}

export function simGateDisagreement(rt: SimRuntime, d: Draft, task: DraftTask): void {
  delete task.agent;
  beginYouStep(task, "call", d.now);
  task.holdsSlot = false;
  task.statusLine = "The architects disagree. Your call";
  simRaise(rt, d, task, "disagreement", `The architects disagree on “${task.title}”`, false, { body: CALL_WORDS.disagreement });
}

export function simContinueAfterGate(rt: SimRuntime, d: Draft, task: DraftTask, advance = true): void {
  if (advance) task.stageIndex += 1;
  task.sub = 0;
  const stage = simStage(task);
  if (!stage) {
    simOpenPullRequest(rt, d, task);
    return;
  }
  if (stage.kind === "gate" && stage.gate) {
    simGate(rt, d, task, stage.gate);
    return;
  }
  if (simPetrinaDelivers(d, task)) {
    simShip(rt, d, task);
    return;
  }
  task.state = "waiting";
  task.statusLine = "Waiting for a free slot";
  task.column = simColumnFor(d, task);
}

export function simOpenPullRequest(rt: SimRuntime, d: Draft, task: DraftTask): void {
  beginPetrinaStep(task, "delivery", d.now);
  const product = d.products.find((entry) => entry.id === task.productId);
  const number = 100 + (d.seq % 900);
  task.pr = { number, url: `https://github.com/${product?.repo ?? "owner/repo"}/pull/${number}`, state: "open", openedAt: d.now };
  task.state = "pr-open";
  task.holdsSlot = false;
  delete task.agent;
  rt.pullRequestAges.set(task.id, 0);
  task.statusLine = `Pull request #${number} is open. Merge it on GitHub when you are happy`;
  task.column = "ready";
  simLog(d, task, "status", "Petrina pushed the branch");
  simLog(d, task, "done", `Petrina opened pull request #${number}, and checked it on GitHub`);
  simMoment(rt, d, task, { kind: "task-end", outcome: "delivered" });
  endPetrinaStep(task, { outcome: JOURNEY_WORDS.openedPr(number) }, d.now);
}

/** Petrina publishes it, the way the task asks: with the builder's text, or the Release Manager's notes. */
export function simShip(rt: SimRuntime, d: Draft, task: DraftTask): void {
  if (task.repositories) {
    for (const [index, work] of task.repositories.entries()) {
      const product = d.products.find((entry) => entry.id === work.productId)!;
      if (work.delivery === "pull-request" || work.source?.start.kind === "pull-request") {
        const number = work.source?.start.kind === "pull-request" ? work.source.start.number : 100 + d.seq + index;
        work.pr = { number, url: `https://github.com/${product.repo}/pull/${number}`, state: "open", openedAt: d.now };
      } else if (work.delivery === "release") work.release = { tag: "v1.2.0", url: `https://github.com/${product.repo}/releases/tag/v1.2.0` };
      else work.landed = { branch: work.source?.destination.branch ?? "main", sha: "1234567" };
      work.companion = { text: "Companion links confirmed", state: "done" };
    }
    task.pr = task.repositories.find((work) => work.pr)?.pr;
    task.state = task.pr ? "pr-open" : "done";
    task.column = task.pr ? "ready" : "done";
    task.statusLine = task.pr ? "Waiting for every pull request to merge" : "All products have landed";
    task.holdsSlot = false;
    delete task.agent;
    if (task.pr) rt.pullRequestAges.set(task.id, 0);
    if (!task.pr) task.finishedAt = d.now;
    simMoment(rt, d, task, { kind: "task-end", outcome: "delivered" });
    return;
  }
  if (task.agent) {
    simLog(d, task, "done", "Ready to publish", "release-manager", task.agent.profileId);
    endAgentStep(task, { outcome: JOURNEY_WORDS.notes, reason: JOURNEY_WORDS.releaseNotesReady }, d.now);
  }
  if (task.source?.start.kind === "pull-request") {
    const start = task.source.start;
    beginPetrinaStep(task, "delivery", d.now);
    task.pr = { number: start.number, url: start.url, state: "open", openedAt: d.now };
    delete task.agent;
    task.holdsSlot = false;
    task.state = "pr-open";
    task.column = "ready";
    rt.pullRequestAges.set(task.id, 0);
    task.statusLine = `Updated PR #${start.number}. Merge it on GitHub when you are happy`;
    simLog(d, task, "done", `Updated PR #${start.number} in ${start.headRepo} · ${start.branch}`);
    simMoment(rt, d, task, { kind: "task-end", outcome: "delivered" });
    endPetrinaStep(task, { outcome: `Updated pull request #${start.number}` }, d.now);
    return;
  }
  if (task.delivery === "pull-request") {
    simOpenPullRequest(rt, d, task);
    return;
  }
  const product = d.products.find((entry) => entry.id === task.productId);
  beginPetrinaStep(task, "delivery", d.now);
  delete task.agent;
  task.holdsSlot = false;
  task.state = "done";
  task.column = "done";
  task.finishedAt = d.now;
  simMoment(rt, d, task, { kind: "task-end", outcome: "delivered" });
  if (task.delivery === "release") {
    const tag = `v1.${(d.seq % 40) + 1}.0`;
    task.release = { tag, url: `https://github.com/${product?.repo ?? "owner/repo"}/releases/tag/${tag}` };
    task.statusLine = `Released ${tag}`;
    simLog(d, task, "status", `Petrina pushed main and the tag ${tag}`);
    simLog(d, task, "done", `Petrina published release ${tag}, and checked it on GitHub`);
    endPetrinaStep(task, { outcome: JOURNEY_WORDS.released(tag) }, d.now);
  } else {
    const sha = (d.seq * 2654435761).toString(16).slice(0, 7);
    task.landed = { branch: task.source?.destination.branch ?? product?.defaultBranch ?? "main", sha };
    task.statusLine = `Committed to ${task.landed.branch} (${sha})`;
    simLog(d, task, "done", `Petrina moved ${task.landed.branch} forward to it (${sha}), and checked the main copy`);
    endPetrinaStep(task, { outcome: JOURNEY_WORDS.movedMain(task.landed.branch) }, d.now);
  }
  simRemoveCopy(rt, d, task);
}

export function simAgePullRequest(rt: SimRuntime, d: Draft, task: DraftTask): void {
  const age = (rt.pullRequestAges.get(task.id) ?? 0) + 1;
  rt.pullRequestAges.set(task.id, age);
  if (!task.pr || age < rt.prMergeAfter) return;
  rt.pullRequestAges.delete(task.id);
  task.pr.state = "merged";
  if (task.repositories) for (const work of task.repositories) if (work.pr) work.pr.state = "merged";
  if (task.state !== "cancelled") {
    task.state = "done";
    task.column = "done";
    task.finishedAt = d.now;
    task.statusLine = `Merged #${task.pr.number} on GitHub`;
  }
  simLog(d, task, "done", `Merged on GitHub (#${task.pr.number})`);
  simMoment(rt, d, task, { kind: "task-end", outcome: "merged" });
  simRemoveCopy(rt, d, task);
}
