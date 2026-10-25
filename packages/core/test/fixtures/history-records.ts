import { BUILT_IN_ROLES, createTaskState, type Finding, type State, type Task } from "../../src/index.js";

export function historyTask(number: number, changes: Partial<Task> = {}): Task {
  const catalog = historyState([]);
  const initial = createTaskState({ productId: number % 2 ? "one" : "two", title: `Finished change ${number}`, description: "The complete request stays in the detail, never in a history card.", kind: "feature", backlog: true }, catalog.products,
    { id: `task-${String(number).padStart(5, "0")}`, timelineId: "created", now: number, priority: number });
  const { selectedProducts: _selection, explicitStart: _explicit, workChoice: _choice, ...record } = initial;
  return { ...record, area: "work", state: "done", column: "done", approvePlan: false, delivery: "local", approveDelivery: false,
    stageIndex: 1, statusLine: "Delivered", finishedAt: 100 + Math.floor(number / 3), timeline: [],
    session: [{ id: `line-${number}`, at: number, from: "agent", text: "A large conversation is only read on demand." }], ...changes };

}

export const historyState = (tasks: readonly Task[]): State => ({ now: 1_000, seq: 10_000, products: [{ id: "one", name: "First", repo: "first/one", tone: "blue" }, { id: "two", name: "Second", repo: "second/two", tone: "green" }], roles: BUILT_IN_ROLES, tools: [], profiles: [], tasks, inbox: [], pool: { limit: 1, paused: true, toolCaps: {} } });

export function reviewedHistoryTask(number: number, changes: Partial<Task> = {}): Task {
  const finding: Finding = {
    id: `finding-${number}`, text: "Checked behaviour", severity: "blocking", status: number % 2 ? "fixed" : "dismissed",
    raisedBy: "sol", confirmedBy: ["opus"], roleId: "security-reviewer",
    votes: [{ by: "sol", toolId: "codex", verdict: "real", reason: "Reproduced" }],
    verification: { by: "sol", verdict: "real", reason: "Confirmed", at: number },
  };
  return historyTask(number, {
    productId: "one", clientId: `request-${number}`, state: number % 7 === 0 ? "cancelled" : "done",
    plan: { stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "security-reviewer", profileIds: ["sol"] }], rationale: "Review", plannerProfileId: "sol" },
    rounds: { review: number % 4 + 1 }, findings: [finding], sentBack: number % 3,
    steps: [{ roleId: "builder", repeat: false, worked: number + 60_000, at: number }], ...changes,
  });
}
