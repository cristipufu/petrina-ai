import { beginAgentStep, BUILT_IN_ROLES } from "@petrina/core";
import { AcceptanceResults, executionFor, type AcceptanceReply, type AcceptanceResultHost, type RuntimeTask } from "../../src/index.js";
import { acceptanceTask } from "./acceptance.js";

/** Actual accepted-result owner; version observations and external effects are explicit values. */
export function acceptanceResultsFixture(shared = false, gate = true) {
  const task = acceptanceTask(shared, gate), scope = executionFor(task);
  task.plan!.stages = task.plan!.stages.filter(stage => stage.id !== "security");
  const versions = Object.fromEntries((task.repositories ?? [task.repository!]).map(work => [work.productId, `${work.productId}-tree`]));
  const changes = Object.fromEntries(Object.keys(versions).map(id => [id, `${id}-patch`]));
  task.state = "running";
  const run: NonNullable<RuntimeTask["acceptanceRun"]> = { versions, changes, requestIds: [] };
  task.acceptanceRun = run;
  const step = beginAgentStep(task, "tester", "opus-high", 100, BUILT_IN_ROLES, undefined, scope.work);
  const events: { kind: string; task: RuntimeTask }[] = [];
  let sequence = 0, now = 200;
  const host: AcceptanceResultHost = {
    id(current) { if (current !== task) throw new Error("Unexpected acceptance owner"); return `${task.id}-${++sequence}`; },
    now() { return now++; },
    note(current, _tone, _text, _roleId, _profileId) { if (current !== scope) throw new Error("Unexpected acceptance scope"); events.push({ kind: "note", task: structuredClone(task) }); },
    async noteLearnings(current, lessons) { if (current !== scope || lessons.length) throw new Error("Unexpected learning work"); events.push({ kind: "learnings", task: structuredClone(task) }); },
    async acceptancePatch(current, observed) { if (current !== scope || JSON.stringify(observed) !== JSON.stringify(versions)) throw new Error("Unexpected patch owner or versions"); events.push({ kind: "patch", task: structuredClone(task) }); return "tested-patch"; },
  };
  const owner = new AcceptanceResults(host);
  function record(report: AcceptanceReply, currentVersions = versions) {
    step.agentResults = [{ roleId: "tester", profileId: "opus-high", at: 150, value: report }];
    return owner.record(scope, { roleId: "tester", profileId: "opus-high", report, run, testedVersions: versions, currentVersions });
  }
  function request(id = "proof", productIds = Object.keys(versions), text = "Run required platform recovery") {
    task.proofRequests ??= [];
    const request = { id, text, reason: "Required on final code", productIds, source: `source-${id}`, requestedBy: { stageId: "review", round: 1, seat: "0", roleId: "code-reviewer", profileId: "sol-high" }, ownerStageId: "test", reviewedVersions: versions, status: "pending" as const };
    task.proofRequests.push(request); run.requestIds.push(id);
    return task.proofRequests.at(-1)!;
  }
  return { task, scope, versions, changes, run, step, host, events, owner, record, request };
}
