import type { Finding, Task } from "../../src/model.js";
import { stateFixture, taskFixture } from "./state.js";

/** One completed review, independent of the scripted portfolio's tasks and plans. */
export function reviewed(id: string, rounds: number, findings: Finding[], extra: Partial<Task> = {}): Task {
  const state = stateFixture();
  return taskFixture(state, { id, state: "done", stageIndex: 1,
    plan: { rationale: "Review statistics", plannerProfileId: "opus-high", stages: [
      { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"] },
    ] }, rounds: { review: rounds }, findings, ...extra });
}

export const finding = (id: string, raisedBy: string, extra: Partial<Finding> = {}): Finding =>
  ({ id, text: `Finding ${id}`, severity: "blocking", raisedBy, confirmedBy: [], status: "open", ...extra });
