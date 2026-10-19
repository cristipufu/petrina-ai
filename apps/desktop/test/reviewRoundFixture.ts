import type { Finding, JourneyNode, JourneyStep } from "@petrina/core";

export const finding = (id: string, extra: Partial<Finding> = {}): Finding => ({ id, text: id, severity: "blocking", status: "open", raisedBy: "reviewer", confirmedBy: [], ...extra });
export const step = (id: string, extra: Partial<JourneyStep> = {}): JourneyStep => ({ id, kind: "agent", roleId: "code-reviewer", stageId: "review", round: 1, sub: 0, startedAt: 10, endedAt: 20, end: "done", ...extra });
export const node = (s: JourneyStep): JourneyNode => ({ ...s, state: "done", tone: s.tone ?? "on", name: "Code reviewers", asks: [] });

export function repairedReviewFixture() {
  const earlier = Array.from({ length: 7 }, (_, index) => finding("old-" + index));
  const previous = step("previous", { result: { findings: earlier } });
  const builder = step("fix", { roleId: "builder", stageId: "build", fixing: true, startedAt: 21, endedAt: 30, findingIds: earlier.map((f) => f.id), agentResults: [{ roleId: "builder", profileId: "codex-high", at: 30, value: { answers: earlier.map((f) => ({ id: f.id, fixed: true, text: "A focused repair for " + f.id })) } }] });
  const reopened = earlier.slice(0, 4).map((f) => ({ ...f, reopenedAt: 45, evidence: "A failing variant on the reviewed version" }));
  const review = step("current", { round: 2, startedAt: 40, endedAt: 50, outcome: "2 important", reason: "6 important findings to check", result: { findings: [...reopened, finding("new-1"), finding("new-2")] }, agentResults: [{ roleId: "code-reviewer", profileId: "codex-high", at: 50, value: { confirms: reopened.map((f) => f.id), findings: [{ text: "new-1" }, { text: "new-2" }] } }] });
  return { earlier, previous, builder, review, steps: [previous, builder, review] };
}
