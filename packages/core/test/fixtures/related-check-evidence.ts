import { createTaskState, type CheckEvidenceTask, type DeepMutable, type Task } from "../../src/index.js";
import { relatedCheckCandidates, type CheckFailureReference } from "../../src/related-check-evidence.js";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";

export const copyEvidence = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const failureName = "real grouped review summaries > credits a grouped review's replacement and excludes the handed-over step from timing history";
export const commands = ["bun run typecheck", "bun run test"];
export const sha = (letter: string) => letter.repeat(40);
const immutableTask = createTaskState({ productId: "p", title: "Private check evidence", backlog: true },
 [{ id: "p", name: "Product", repo: "acme/p", tone: "blue" }], { id: "evidence-task", timelineId: "created", now: 1_000_000, priority: 0 });
export function failure(nodeId = "j5", duration = "22.91ms"): DeepMutable<CheckFailureReference> {
  return { nodeId, attempt: { id: "run-0", productId: "p", sha: sha("a"), tree: sha("b"), definition: "failure-hooks", commands: [...commands] },
    check: { id: "check-1", attemptId: "run-0", productId: "p", findingId: "f1", name: "Tests", result: "fail", detail: `(fail) ${failureName} [${duration}]`,
      run: { name: "Tests", command: "bun run test", ok: false, execution: completeCheckExecution(7), ms: 25, output: "captured failure", logPath: "/missing-check.log" } } };
}
export function peer(id = "task-58913"): DeepMutable<CheckEvidenceTask> {
  const f = failure();
  return {
    id,
    state: "running",
    held: false,
    journey: [
      { id: "j5", kind: "petrina", startedAt: 1, endedAt: 2, end: "done", productChecks: [f.check], checkAttempts: [f.attempt] },
      {
        id: "j6",
        kind: "agent",
        startedAt: 3,
        endedAt: 4,
        end: "done",
        buildVersions: { p: sha("d") },
        checkRepairs: [{
          productId: "p",
          failureNode: "j5",
          checkId: "check-1",
          attemptId: "run-0",
          findingId: "f1",
          sha: sha("c"),
          tree: sha("d"),
          definition: "candidate-hooks",
          commands: [...commands],
          answer: { fixed: true, text: "Waited for replacement-owned progress before checking the summary." },
        }],
      },
    ],
  };
}
export const matches = (p: CheckEvidenceTask, own = failure("j3", "1099.27ms")) => relatedCheckCandidates([own], [p], "p");
export function bunSummary(lastFile: string, duration: string) {
  return [
    `test/first.test.ts:`,
    `(pass) another suite > first passing test [1ms]`,
    `${lastFile}:`,
    `(pass) another suite > last passing test [1ms]`,
    "1 tests failed:",
    `(fail) ${failureName} [${duration}]`,
    "2 pass",
    "1 fail",
  ].map((line) => `@petrina/engine:test  | ${line}`).join("\n");
}
export function archived(p: CheckEvidenceTask): Task {
  return {
    ...copyEvidence(immutableTask),
    id: p.id,
    productId: "p",
    state: "done",
    held: false,
    finishedAt: 10,
    repositories: undefined,
    repository: { productId: "p", delivery: "local", confirmedDelivery: p.delivery },
    description: "PRIVATE REQUEST",
    session: [{ id: "line", at: 1, from: "agent", text: "PRIVATE CONVERSATION" }],
    journey: p.journey.map((step) => ({
      ...step,
      round: 1,
      sub: 0,
      agentInputs: [{
        roleId: "builder",
        profileId: "profile",
        mode: "fresh",
        taskTitle: "PRIVATE TITLE",
        sections: [{ title: "PRIVATE PROMPT", body: "PRIVATE PLAN" }],
      }],
      agentResults: [{ roleId: "builder", profileId: "profile", at: 4, value: { summary: "PRIVATE FULL REPORT" } }],
      result: {
        findings: [{
          id: "secret",
          raisedBy: "reviewer",
          confirmedBy: [],
          status: "open",
          severity: "blocking",
          text: "PRIVATE REVIEW",
        }],
      },
    })),
  };
}
