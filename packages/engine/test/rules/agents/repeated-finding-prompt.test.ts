import { expect, it } from "bun:test";
import { beginAgentStep, builderFindings, checkReviewEvidence, createTaskState, endAgentStep, recordBuilderFindingAnswers, type Finding } from "@petrina/core";
import { ReviewReports, taskView, type RuntimeTask } from "@petrina/orchestrator";
import { buildPrompt, formatFindings, parseResult } from "../../../src/prompts.js";
import { ReviewResult } from "../../../src/roles.js";
import { promptContext } from "../../fixtures/prompt-context.js";
import { BUILT_IN_ROLES } from "@petrina/core";

/** Real serialized result decoding and actual finding owners; no session, Engine, Git or native evidence. */
function repeatedReports() {
  const builder = BUILT_IN_ROLES.find(role => role.result === "build")!, context = promptContext(builder);
  const task: RuntimeTask = createTaskState({ productId: context.product.id, title: "Repair the greeting", backlog: true },
    [context.product], { id: "repeated", timelineId: "created", now: 1, priority: 0 });
  task.repository = { productId: context.product.id, delivery: "local" };
  const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 3 };
  task.plan = { rationale: "Prompt after accepted repeated reports", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: builder.id, profileIds: ["sol-high"] }, stage,
  ] };
  task.stageIndex = 1;
  let sequence = 0, at = 10;
  const reports = new ReviewReports({ roles: () => context.roles, hasPendingReviewers: () => false,
    id: () => `prompt-finding-${++sequence}`, now: () => ++at, verdict() {}, note() {},
  });
  const decode = (value: unknown) => {
    const parsed = parseResult("```petrina\n" + JSON.stringify(value) + "\n```", ReviewResult);
    if (parsed.ok !== true) throw new Error("The actual review schema rejected the supplied report");
    return parsed.value;
  };
  const original = decode({ verdict: "fail", findings: [{ text: "The greeting is missing on the welcome page.", severity: "important", evidence: "Opened the welcome page" }] });
  beginAgentStep(task, stage.roleId, stage.profileIds[0]!, ++at, context.roles, stage.profileIds, task.repository);
  task.hunt = { stageId: stage.id, round: 1, reported: { "0": true, "1": true }, findings: 0 };
  for (const [index, profileId] of stage.profileIds.entries()) reports.apply(task, stage, original, profileId, stage.roleId, String(index));
  reports.settle(task, stage);
  endAgentStep(task, { outcome: "Accepted reports", reason: "The prompt rule begins with their supplied Builder answers" }, ++at);
  // A known accepted-answer precondition, not a reimplementation of review routing.
  task.stageIndex = 0; task.fixing = true;
  const given = builderFindings(task, task.repository.productId);
  beginAgentStep(task, builder.id, "sol-high", ++at, context.roles, undefined, task.repository);
  recordBuilderFindingAnswers(task, given, given.map(finding => ({ id: finding.id, fixed: true, text: "The accepted Builder report claims the greeting is fixed." })),
    { productId: task.repository.productId, shared: false, at: ++at });
  endAgentStep(task, { outcome: "Accepted Builder answers", reason: "Prepare a later review result for formatting" }, ++at);
  task.stageIndex = 1; task.rounds[stage.id] = 2;
  const input: Finding[] = structuredClone(task.findings);
  const duplicate = decode({ verdict: "fail", findings: [{ text: "The GREETING is missing on the welcome page!", severity: "important" }], confirms: [], disputes: [] });
  beginAgentStep(task, stage.roleId, stage.profileIds[0]!, ++at, context.roles, stage.profileIds, task.repository);
  task.hunt = { stageId: stage.id, round: 2, reported: { "0": true, "1": true }, findings: task.findings.length };
  for (const [index, profileId] of stage.profileIds.entries()) reports.apply(task, stage, duplicate, profileId, stage.roleId, String(index));
  reports.settle(task, stage);
  return { context, task, input, duplicate, decode };
}

it("shows both new finding IDs and the one-fix instruction in the actual next Builder prompt", () => {
  const f = repeatedReports();
  expect(checkReviewEvidence(f.input, f.duplicate, f.task)).toBeUndefined();
  const given = builderFindings(f.task, f.task.repository!.productId);
  const prompt = buildPrompt({ ...f.context, task: { ...taskView(f.task), fixing: true }, sections: [
    { title: "Review findings (answer every one by id; fix every Important one)", body: formatFindings(given, { complete: true }) },
  ] });
  for (const finding of f.task.findings.slice(2, 4)) expect(prompt).toContain(`[${finding.id}]`);
  expect(prompt).toContain("fix it once");
  expect(given).toHaveLength(2);
});

it("requires current evidence when the actual decoded report instead confirms a closed finding ID", () => {
  const f = repeatedReports(), id = f.input[0]!.id;
  expect(f.input[0]!.status).toBe("fixed");
  expect(checkReviewEvidence(f.input, f.decode({ verdict: "fail", confirms: [id] }), f.task)).toContain("Current evidence is required");
  expect(checkReviewEvidence(f.input, f.decode({ verdict: "fail", confirms: [{ id, evidence: "On current code the guest page still has no greeting; the signed-in control passes." }] }), f.task)).toBeUndefined();
});
