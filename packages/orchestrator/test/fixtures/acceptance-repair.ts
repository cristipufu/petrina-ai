import { applyAcceptanceVersions, beginAgentStep, BUILT_IN_ROLES, finishTaskStep, roleForTask } from "@petrina/core";
import { AcceptanceResults } from "../../src/acceptance-results.js";
import { routeAcceptance } from "../../src/acceptance-routing.js";
import { WorkCompletion } from "../../src/work-completion.js";
import { executionFor } from "../../src/repository-context.js";
import type { AcceptanceReply } from "../../src/ports/acceptance-results.js";
import type { AcceptanceRoutingHost } from "../../src/ports/acceptance.js";
import { acceptanceTask } from "./acceptance.js";

export const GREETING = "People see the greeting on the welcome page", PHONE = "The greeting reads well on a phone";
export const UNAVAILABLE = "The phone simulator is unavailable, so the page could not be opened on a phone.";
export const acceptanceObservation = (result: "pass" | "fail" | "blocked", productIds: string[], text = result === "blocked" ? PHONE : GREETING) => ({
  text, result, productIds, evidence: result === "blocked" ? "Tried to start the phone simulator twice; it never opened." : result === "fail" ? "Opened the welcome page: no greeting appears; expected it at the top." : `Opened the welcome page and saw: ${text}`,
  ...(result === "blocked" ? { reason: UNAVAILABLE } : {}),
});

/** Accepted normalized reports and explicit observed identities. Every transition is the actual owning controller. */
export function acceptanceRepairFixture(checklist: readonly string[] = [GREETING]) {
  const task = acceptanceTask(true, true), scope = executionFor(task);
  task.title = "Show the greeting"; task.state = "running"; task.stageIndex = 1;
  task.brief = { summary: task.title, areas: [], forUsers: [], risks: [], acceptance: checklist.map(text => ({ text })) };
  const notes: string[] = [], effects: string[] = [];
  let now = 1_000, sequence = 0;
  let versions = { a: "a-initial-controller-observation", b: "b-initial-controller-observation" };
  const host: AcceptanceRoutingHost = {
    role: (id, current) => roleForTask(BUILT_IN_ROLES, id, current),
    finishStep(bound) { finishTaskStep(bound.task, bound.work, now++); effects.push("finish"); },
    note(_bound, _tone, text) { notes.push(text); },
    commitNow(current) { if (current !== task) throw new Error("Unexpected checkpoint owner"); effects.push("checkpoint"); },
    commit(current) { if (current !== task) throw new Error("Unexpected change owner"); effects.push("changed"); },
    openDeliveryDecision() { throw new Error("This route must reach the planned gate before a native decision opens"); },
  };
  const results = new AcceptanceResults({
    id(current) { if (current !== task) throw new Error("Unexpected finding owner"); return `finding-${++sequence}`; }, now: () => now++,
    note(_bound, _tone, text) { notes.push(text); },
    async noteLearnings(_bound, lessons) { if (lessons.length) throw new Error("Unexpected learning work"); },
    async acceptancePatch(bound, tested) { if (bound !== scope || tested !== versions) throw new Error("Unexpected acceptance observation"); return JSON.stringify(tested); },
  });
  const completion = new WorkCompletion({
    finishStep: bound => host.finishStep(bound), endStage() { effects.push("end-stage"); },
    rerun(current) { if (current.rereview) throw new Error("Unexpected coordinator rerun"); return false; },
    async invalidateAcceptance(bound, tested) {
      if (bound !== scope || tested !== versions) throw new Error("The fixture supplies the accepted operation's exact observations");
      applyAcceptanceVersions(bound.task, tested);
    },
    checkpoint: () => host.commitNow(task), changed: () => host.commit(task),
  });
  async function report(checks: AcceptanceReply["checks"]) {
    const stage = task.plan!.stages[task.stageIndex]!;
    if (stage.roleId !== "tester") throw new Error("Acceptance was not the next selected stage");
    const reply: AcceptanceReply = { summary: "Tried every acceptance item.", checks, proofAnswers: [], learnings: [] };
    const step = beginAgentStep(task, stage.roleId, "opus-high", now++, BUILT_IN_ROLES, undefined, scope.work);
    step.agentResults = [{ roleId: stage.roleId, profileId: "opus-high", at: now++, value: reply }];
    const run = { versions, changes: { a: "a-task-change", b: "b-task-change" }, requestIds: [] }; task.acceptanceRun = run;
    const recorded = await results.record(scope, { roleId: stage.roleId, profileId: "opus-high", report: reply, run, testedVersions: versions, currentVersions: versions });
    const next = routeAcceptance(host, scope, recorded);
    if (next === undefined) await completion.complete(scope, { stageId: stage.id, canEdit: false });
    return { recorded, next, step };
  }
  async function returned() {
    if (task.plan!.stages[task.stageIndex]!.roleId !== "builder" || !task.repair) throw new Error("No Builder repair was assigned");
    // A consumed Builder report is input here. Native writing/answer application is retained in the journeys.
    versions = { ...versions, a: "a-repaired-controller-observation" };
    await completion.complete(scope, { stageId: "build", canEdit: true, testedVersions: versions });
  }
  return { task, scope, get versions() { return versions; }, notes, effects, report, returned, completion };
}
