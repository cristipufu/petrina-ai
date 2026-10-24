import { BUILT_IN_ROLES, roleForTask, type DeepMutable, type JourneyStep, type Role } from "@petrina/core";
import { acceptanceTask } from "./acceptance.js";
import type { ReviewProofHost } from "../../src/index.js";

export function reviewProofFixture(shared = false, catalog: readonly Role[] = BUILT_IN_ROLES) {
  const task = acceptanceTask(shared);
  const review = task.plan!.stages.find(stage => stage.id === "review")!;
  const versions = Object.fromEntries((task.repositories ?? [task.repository!]).map(work => [work.productId, `tree-${work.productId}`]));
  task.brief = { summary: "Try recovery", forUsers: [], areas: [], risks: [], acceptance: [{ text: "Linux recovery works" }] };
  task.hunt = { stageId: review.id, round: 1, reported: {}, findings: 0, input: { file: "unused", digest: "unused", heads: {}, trees: versions } };
  let sequence = 0;
  const lookups: { id: string; task: typeof task }[] = [];
  const host: ReviewProofHost = {
    role(id, current) { lookups.push({ id, task: current }); return roleForTask(catalog, id, current); },
    id(prefix) { return `${prefix}-${++sequence}`; },
  };
  const item = { text: "Run Linux recovery", reason: "Final Linux proof is required", productIds: [task.productId], checklistText: "Linux recovery works" };
  const passed = () => {
    const step: DeepMutable<JourneyStep> = { id: "saved-test", kind: "agent", stageId: "test", roleId: "tester", profileId: "opus-high", round: 1, sub: 0,
      startedAt: 10, endedAt: 20, end: "done", acceptanceChecks: [{ text: item.checklistText, result: "pass", evidence: "Recovery passed" }],
      agentResults: [{ roleId: "tester", profileId: "opus-high", at: 20, value: {}, versions: { ...versions } }] };
    task.journey = [structuredClone(step)];
  };
  return { task, review, versions, host, item, passed, lookups, identities: () => sequence };
}
