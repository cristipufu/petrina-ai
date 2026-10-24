import { createTaskState, findingsNeedingVotes, type DeepMutable, type Finding, type Product } from "../../src/index.js";

const products: readonly Product[] = [
  { id: "a", name: "A", repo: "local/a", tone: "blue" },
  { id: "b", name: "B", repo: "local/b", tone: "green" },
];

export function voteEligibility(shared = false) {
  const task = createTaskState({ productId: "a", title: "Check an Important finding", backlog: true }, products,
    { id: "task", timelineId: "created", now: 100, priority: 0 });
  if (shared) task.repositories = products.map(product => ({ productId: product.id, delivery: "local", completedStages: [] }));
  const finding: DeepMutable<Finding> = { id: "finding", text: "The greeting is missing.", raisedBy: "a-high", confirmedBy: [], severity: "blocking", status: "open", ...(shared ? { productIds: ["a"] } : {}) };
  task.findings.push(finding);
  const tools = new Map([["a-high", "a"], ["a-medium", "a"], ["b-high", "b"], ["c-high", "c"]]);
  return { task, finding, tools, eligible: () => findingsNeedingVotes(task, id => tools.get(id)) };
}
