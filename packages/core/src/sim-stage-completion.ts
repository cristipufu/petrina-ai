import { answerByCall, CALL_WORDS, dueAnswers } from "./call.js";
import { builderReturnWords } from "./check-evidence.js";
import { findingCount, findingKind } from "./findings.js";
import {
  coveredByDecision,
  designRoundEnd,
  noteRoundEnd,
  passedOpenWords,
  reviewDecisionFor,
  reviewRoundEnd,
  type DeepMutable,
} from "./flow.js";
import { endAgentStep, JOURNEY_WORDS, openStep, recordStepResult } from "./journey.js";
import { composePlan } from "./library.js";
import type { Stage, Task } from "./model.js";
import * as library from "./roles.js";
import { simGate, simGateDisagreement, simShip } from "./sim-delivery.js";
import {
  simDesignRound,
  simEndStage,
  simEndTurn,
  simFollowing,
  simId,
  simLog,
  simMoment,
  simReleaseScreen,
  simRound,
  simSay,
  simStage,
  type Draft,
  type DraftTask,
  type SimRuntime,
} from "./sim-runtime.js";
import {
  briefFor,
  callAnswers,
  capitalize,
  DEMO_RISK,
  laterObjections,
  simAcceptance,
  simVersions,
} from "./sim-script.js";
import { finishTaskStep } from "./task-transitions.js";
import { reviewClaimIds } from "./workflow-events.js";

export interface SimStageHooks {
  startAgent(rt: SimRuntime, d: Draft, task: DraftTask): void;
  advance(rt: SimRuntime, d: Draft, task: DraftTask): void;
}

/** The agent finished its step list: hand the result to the stage. */
export function simFinishStage(rt: SimRuntime, d: Draft, task: DraftTask, hooks: SimStageHooks): void {
  const agent = task.agent;
  if (!agent) return;
  simEndTurn(rt, d, task, "finished");
  simReleaseScreen(d, task);
  finishTaskStep(task, task, d.now);

  if (task.stageIndex < 0) {
    // With no coordinator selection, the demo planner proposes its saved demo product.
    if (task.workRows?.length === 0 && task.workChoice && task.source) {
      task.workRows = [
        {
          choice: {
            ...task.workChoice,
            reason: "The demo planner proposes this product for the change.",
          },
          source: task.source,
          change: "added",
        },
      ];
    }
    task.plan = composePlan(task, library.activeRoles(d.roles)) as DeepMutable<NonNullable<Task["plan"]>>;
    task.risk = DEMO_RISK[task.kind];
    const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
    simLog(d, task, "milestone", `Plan ready: ${count} stages. ${task.plan.rationale}`, agent.roleId, agent.profileId);
    simSay(d, task, "agent", task.plan.rationale, agent.roleId, agent.profileId);
    simEndStage(rt, d, task, "done");
    endAgentStep(task, { outcome: JOURNEY_WORDS.planned(count), reason: JOURNEY_WORDS.planReady }, d.now);
    if (task.approvePlan || task.confirmWork) simGate(rt, d, task, "plan");
    else hooks.advance(rt, d, task);
    return;
  }

  const stage = simStage(task);
  if (!stage) return;
  const round = simRound(task);
  const result = d.roles.find((role) => role.id === agent.roleId)?.result;

  if (stage.kind === "do" && result === "delivery") {
    simEndStage(rt, d, task, "delivered");
    simShip(rt, d, task);
    return;
  }

  if (stage.kind === "do" && task.maintenance?.role.id === agent.roleId) {
    const summary = "Investigated the selected area. Nothing actionable found in this demo run.";
    task.handedBack = [
      ...(task.handedBack ?? []),
      {
        at: d.now,
        roleId: agent.roleId,
        profileId: agent.profileId,
        stageId: stage.id,
        roleName: task.maintenance.role.name,
        title: stage.title,
        summary,
        notes: ["Completed without product changes."],
      },
    ];
    task.maintenance.noProductChanges = true;
    simLog(d, task, "done", summary, agent.roleId, agent.profileId);
    endAgentStep(task, { outcome: JOURNEY_WORDS.wroteNotes, reason: JOURNEY_WORDS.notesReady }, d.now);
    simEndStage(rt, d, task, "done");
    task.state = "done";
    task.column = "done";
    task.finishedAt = d.now;
    task.statusLine = "Completed · No product changes";
    task.holdsSlot = false;
    delete task.agent;
    return;
  }

  if (stage.kind === "do") {
    const recorded = openStep(task);
    if (result === "build" && recorded) {
      recorded.buildVersions = simVersions(task, recorded.id);
      for (const work of task.repositories ?? [task]) if (work.checks) work.checks.current = false;
    }
    if (result === "checks" && recorded) {
      const checks = simAcceptance(task);
      const versions = simVersions(task);
      recorded.acceptanceChecks = checks.map(({ text, result: outcome, evidence }) => ({
        text,
        result: outcome,
        evidence,
      }));
      recorded.agentResults = [
        { roleId: agent.roleId, profileId: agent.profileId, at: d.now, value: { checks }, versions },
      ];
      if (task.brief) {
        task.brief.acceptance = task.brief.acceptance.map((item) => {
          const check = checks.find((entry) => entry.text === item.text)!;
          return {
            ...item,
            met: true,
            verification: "passed",
            productIds: [...check.productIds],
            versions: Object.fromEntries(check.productIds.map((id) => [id, versions[id]!])),
          };
        });
      }
      task.acceptancePassed = true;
    }
    if (result === "build" && task.fixing) {
      let count = 0;
      for (const finding of task.findings) {
        if (finding.status !== "open" || finding.severity === "pre-existing") continue;
        const fixed = finding.severity === "blocking";
        finding.answer = {
          fixed,
          text: fixed
            ? "Fixed, with a test for addresses with a plus sign."
            : "Kept as is: the current message matches the rest of the product.",
          at: d.now,
        };
        if (fixed && findingKind(finding) !== "product-check") {
          finding.status = "fixed";
        }
        if (fixed) count += 1;
      }
      task.fixing = false;
      simLog(d, task, "done", "Fixed the blocking findings", agent.roleId, agent.profileId);
      const outcome = builderReturnWords(true, undefined, count);
      const returned = openStep(task);
      if (returned) returned.builderReturn = { productId: task.productId, changed: true, claimedFixes: count, outcome };
      endAgentStep(task, { outcome, reason: outcome }, d.now);
    } else {
      simLog(d, task, "done", `${stage.title} done`, agent.roleId, agent.profileId);
      endAgentStep(
        task,
        result === "build"
          ? { outcome: JOURNEY_WORDS.built, reason: JOURNEY_WORDS.readyForReview }
          : result === "checks"
            ? {
                outcome: JOURNEY_WORDS.checks(0, task.brief?.acceptance.length ?? 0),
                reason: JOURNEY_WORDS.checksPassed,
              }
            : { outcome: JOURNEY_WORDS.wroteNotes, reason: JOURNEY_WORDS.notesReady },
        d.now,
      );
    }
    if (task.repositories && d.roles.find((role) => role.id === agent.roleId)?.canEdit) {
      for (const work of task.repositories) {
        work.report = {
          summary: `Updated ${d.products.find((product) => product.id === work.productId)?.name ?? "the product"} for ${task.area}.`,
          changes: [`People can use ${task.area} across products.`],
        };
        work.completedStages = [...new Set([...work.completedStages, stage.id])];
      }
    }
    simEndStage(rt, d, task, "done");
    hooks.advance(rt, d, task);
    return;
  }

  if (stage.kind === "converge") {
    const call = simFollowing(task);
    if (call) {
      const revising = !task.objections.some((objection) => objection.status === "open");
      const note = revising ? task.notes?.at(-1)?.text : undefined;
      const answers = callAnswers(task.area, dueAnswers(task.objections as Task["objections"], call), call.text, note);
      task.objections = answerByCall(task.objections as Task["objections"], call, answers) as DraftTask["objections"];
      recordStepResult(task, {
        objections: task.objections.filter(
          (objection) => answers.some((answer) => answer.id === objection.id) || call.open.includes(objection.id),
        ),
      });
      task.brief = briefFor(task);
      simLog(d, task, "done", revising ? CALL_WORDS.revised : CALL_WORDS.updated, agent.roleId, agent.profileId);
      simLog(d, task, "done", CALL_WORDS.settled);
      simEndStage(rt, d, task, "settled");
      endAgentStep(task, { outcome: JOURNEY_WORDS.followed, reason: JOURNEY_WORDS.followsCall }, d.now);
      hooks.advance(rt, d, task);
      return;
    }
    if (task.sub === 0) {
      const due = task.objections.filter((objection) => objection.status === "open").map((objection) => objection.id);
      for (const objection of task.objections) {
        if (objection.status !== "open") continue;
        objection.status = objection.blocking ? "accepted" : "rejected";
        objection.answer = objection.blocking
          ? "Changed the design to cover it."
          : "Out of scope for this task. Added to risks.";
      }
      simLog(d, task, "done", round === 1 ? "Design brief ready" : "Answered every objection", agent.roleId, agent.profileId);
      recordStepResult(task, { objections: task.objections.filter((objection) => due.includes(objection.id)) });
      endAgentStep(
        task,
        round === 1
          ? { outcome: JOURNEY_WORDS.wroteBrief, reason: JOURNEY_WORDS.briefReady }
          : { outcome: JOURNEY_WORDS.answeredAll, reason: JOURNEY_WORDS.objectionsAnswered },
        d.now,
      );
      task.sub = 1;
      hooks.startAgent(rt, d, task);
      return;
    }
    let logged = false;
    if (round === 1 || rt.disagree.has(task.id)) {
      const raised =
        round === 1
          ? [
              {
                blocking: true,
                text: `What happens to ${task.area} for people who already have an account? The brief does not say.`,
              },
              { blocking: false, text: `Consider remembering the last choice in ${task.area} on this device.` },
            ]
          : laterObjections(task.area, round);
      const before = task.objections.length;
      for (const objection of raised) {
        task.objections.push({
          id: simId(d, task.id),
          round,
          raisedBy: agent.profileId,
          status: "open",
          ...objection,
        });
      }
      recordStepResult(task, { objections: task.objections.slice(before) });
      const blocking = raised.filter((objection) => objection.blocking).length;
      simLog(d, task, "warn", `Raised ${raised.length} objections, ${blocking} blocking`, agent.roleId, agent.profileId);
      simDesignRound(rt, d, task, stage, round, raised.length, blocking);
      logged = true;
      endAgentStep(
        task,
        blocking
          ? {
              outcome: JOURNEY_WORDS.objections(raised.length, blocking),
              reason: JOURNEY_WORDS.blocking(blocking),
              tone: "back",
            }
          : { outcome: JOURNEY_WORDS.objections(raised.length, 0), reason: JOURNEY_WORDS.noBlocking },
        d.now,
      );
      const end = designRoundEnd(blocking, round, stage as Stage);
      if (end === "disagreement") {
        simMoment(rt, d, task, {
          kind: "design-end",
          outcome: "to-you",
          rounds: round,
          roleId: stage.roleId,
          ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}),
        });
        simEndStage(rt, d, task, "to-you");
        simGateDisagreement(rt, d, task);
        return;
      }
      if (end === "next round") {
        task.rounds[stage.id] = round + 1;
        task.sub = 0;
        hooks.startAgent(rt, d, task);
        return;
      }
    }
    task.brief = briefFor(task);
    simLog(d, task, "done", "Design settled: no blocking objections", agent.roleId, agent.profileId);
    if (!logged) recordStepResult(task, { objections: [] });
    endAgentStep(task, { outcome: JOURNEY_WORDS.objections(0, 0), reason: JOURNEY_WORDS.noBlocking }, d.now);
    if (!logged) simDesignRound(rt, d, task, stage, round, 0, 0);
    simMoment(rt, d, task, {
      kind: "design-end",
      outcome: "settled",
      rounds: round,
      roleId: stage.roleId,
      ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}),
    });
    simEndStage(rt, d, task, "settled");
    hooks.advance(rt, d, task);
    return;
  }

  if (stage.kind === "review-chain") {
    const added = d.roles.find((role) => role.id === agent.roleId)?.added;
    if (added) {
      if (round === 1) {
        task.findings.push({
          kind: "review",
          id: simId(d, task.id),
          text: `Check ${task.area} with real data before the next release.`,
          severity: "suggestion",
          roleId: agent.roleId,
          raisedBy: agent.profileId,
          confirmedBy: [],
          status: "open",
        });
      }
      simLog(d, task, "done", "Nothing blocking", agent.roleId, agent.profileId);
    } else if (round === 1 && task.sub === 0) {
      task.findings.push({
        kind: "review",
        id: simId(d, task.id),
        text: `${capitalize(task.area)} fails when the email address contains a plus sign, and no test covers it.`,
        where: `${capitalize(task.area)} form`,
        severity: "blocking",
        raisedBy: agent.profileId,
        confirmedBy: [],
        status: "open",
      });
      simLog(d, task, "warn", "1 important", agent.roleId, agent.profileId);
      simMoment(rt, d, task, {
        kind: "verdict",
        verdict: "fail",
        roleId: agent.roleId,
        profileId: agent.profileId,
        count: 1,
        blocking: 1,
      });
    } else if (round === 1) {
      for (const finding of task.findings) if (finding.status === "open") finding.confirmedBy.push(agent.profileId);
      task.findings.push({
        kind: "review",
        id: simId(d, task.id),
        text: "Show a clearer message when the email is not valid.",
        severity: "suggestion",
        raisedBy: agent.profileId,
        confirmedBy: [],
        status: "open",
      });
      task.findings.push({
        kind: "review",
        id: simId(d, task.id),
        text: "The sign-in page has no limit on attempts. It was like this before the change.",
        severity: "pre-existing",
        raisedBy: agent.profileId,
        confirmedBy: [],
        status: "open",
      });
      simLog(d, task, "warn", "1 nit, 1 follow-up; confirmed 1", agent.roleId, agent.profileId);
      const blocking = task.findings.filter(
        (finding) =>
          finding.status === "open"
          && finding.severity === "blocking"
          && finding.confirmedBy.includes(agent.profileId),
      ).length;
      simMoment(rt, d, task, {
        kind: "verdict",
        verdict: blocking ? "fail" : "pass",
        roleId: agent.roleId,
        profileId: agent.profileId,
        count: 2 + blocking,
        blocking,
      });
    } else {
      simLog(d, task, "done", "Nothing to fix", agent.roleId, agent.profileId);
      simMoment(rt, d, task, {
        kind: "verdict",
        verdict: "pass",
        roleId: agent.roleId,
        profileId: agent.profileId,
        count: 0,
        blocking: 0,
      });
    }

    if (task.sub + 1 < stage.profileIds.length) {
      task.sub += 1;
      hooks.startAgent(rt, d, task);
      return;
    }

    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
    const covered = coveredByDecision(task, simVersions(task));
    const end = reviewRoundEnd(task, stage, round, d.roles, covered);
    noteRoundEnd(task, stage.id, open.length);
    const raised = task.findings.slice(task.hunt?.findings ?? 0);
    const claims = new Set(reviewClaimIds(task, openStep(task)!.id, d.roles));
    const seen = new Set([...raised.map((finding) => finding.id), ...claims]);
    recordStepResult(task, {
      findings: task.findings.filter((finding) => seen.has(finding.id)),
      findingsSettled: true,
      findingChanges: {
        raised: raised.map((finding) => finding.id),
        fixed: task.findings
          .filter((finding) => claims.has(finding.id) && finding.status === "fixed")
          .map((finding) => finding.id),
        dismissed: [],
      },
    });
    delete task.hunt;
    endAgentStep(
      task,
      {
        outcome: findingCount(raised),
        ...(end.kind === "send back"
          ? { reason: JOURNEY_WORDS.sentBack(end.open), tone: "back" }
          : end.kind === "used up"
            ? { reason: JOURNEY_WORDS.stillOpen(end.open), tone: "back" }
            : {
                reason: end.covered
                  ? `${JOURNEY_WORDS.reviewPassed}; ${JOURNEY_WORDS.coveredOpen(end.covered)}`
                  : JOURNEY_WORDS.reviewPassed,
              }),
      },
      d.now,
    );
    if (end.kind === "send back") {
      task.rounds[stage.id] = round + 1;
      task.stageIndex = end.builder;
      task.sub = 0;
      task.fixing = true;
      simLog(d, task, "warn", `Sent back to the builder: ${findingCount(open)}`);
      simMoment(rt, d, task, {
        kind: "review-end",
        outcome: "sent-back",
        stageId: stage.id,
        stageTitle: stage.title,
        stageKind: stage.kind,
        round,
      });
      simEndStage(rt, d, task, "sent-back", stage.id);
      hooks.startAgent(rt, d, task);
      return;
    }
    simLog(
      d,
      task,
      end.kind === "used up" ? "warn" : "done",
      end.kind === "used up"
        ? `Review rounds used up: ${findingCount(open)} still open`
        : `Review passed: ${passedOpenWords(task.findings, covered)}`,
    );
    simMoment(rt, d, task, { kind: "review-end", outcome: end.kind === "used up" ? "rounds-used" : "passed" });
    simEndStage(rt, d, task, end.kind === "used up" ? "rounds-used" : "passed");
    if (end.kind === "used up") {
      delete task.helpers;
      task.stageIndex += 1;
      task.sub = 0;
      task.reviewDecision = reviewDecisionFor(task, stage.id, round, d.now, simVersions(task));
      simGate(rt, d, task, "delivery");
      return;
    }
    hooks.advance(rt, d, task);
  }
}
