import { BUILT_IN_ROLES, createTaskState, roleForTask, type Product, type WorkChoice } from "@petrina/core";
import { executionFor, resolveSource, SourceSelections, type RuntimeTask, type SourceQueries, type SourceSelectionEffects, type SourceSelectionHost } from "../../src/index.js";

export const sourceProducts: readonly Product[] = [
  { id: "shop", name: "Shop", repo: "acme/shop", remote: "https://github.com/acme/shop.git", defaultBranch: "main", tone: "blue" },
  { id: "api", name: "API", repo: "acme/api", defaultBranch: "trunk", tone: "green", approveDelivery: false },
];

export const sourceChoice = (productId = "shop", branch?: string): WorkChoice => ({ productId, startFrom: branch ? { kind: "branch", name: branch } : { kind: "default" }, delivery: "local" });

export function sourceTask(productId = "shop"): RuntimeTask {
  const task = createTaskState({ productId, title: "Choose an approved source", backlog: true }, sourceProducts,
    { id: "source-task", timelineId: "created", now: 100, priority: 0 });
  task.repository = { productId, delivery: task.delivery };
  task.plan = { rationale: "Approved coverage", plannerProfileId: "planner", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["builder"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["reviewer"] },
    { id: "deliver", kind: "do", title: "Deliver", roleId: "release-manager", profileIds: ["release"] },
  ] };
  return task;
}

/** Private scripted queries. Unexpected effects fail instead of consulting the machine. */
export function sourceFixture() {
  const products = structuredClone(sourceProducts) as Product[];
  const scripts: Partial<SourceQueries & Pick<SourceSelectionEffects, "repository" | "isAbsoluteFolder" | "folderPath" | "folderOccupied">> = {};
  let nextProduct = 0;
  const calls: string[] = [], checkpoints: RuntimeTask[] = [], notes: string[] = [];
  const item = { body: "The plan to approve" };
  const profiles = new Set(["builder", "reviewer", "release", "alternate"]);
  const queries: SourceQueries = {
    validBranch(name) { calls.push(`valid:${name}`); if (!scripts.validBranch) throw new Error(`Unexpected branch validation: ${name}`); return scripts.validBranch(name); },
    requireBranch(repo, branch) { calls.push(`exists:${repo}:${branch}`); if (!scripts.requireBranch) throw new Error(`Unexpected branch lookup: ${repo}:${branch}`); return scripts.requireBranch(repo, branch); },
    pullRequest(repo, number) { calls.push(`pr:${repo}:${number}`); if (!scripts.pullRequest) throw new Error(`Unexpected PR lookup: ${repo}:${number}`); return scripts.pullRequest(repo, number); },
  };
  const effects: SourceSelectionEffects = {
    resolve: (task, choice, candidate) => resolveSource(executionFor(task), choice, products, queries, candidate),
    repository(repo) { calls.push(`repo:${repo}`); if (!scripts.repository) throw new Error(`Unexpected repository lookup: ${repo}`); return scripts.repository(repo); },
    folderPath(path) { calls.push(`path:${path}`); if (!scripts.folderPath) throw new Error(`Unexpected folder path: ${path}`); return scripts.folderPath(path); },
    folderOccupied(path) { calls.push(`occupied:${path}`); if (!scripts.folderOccupied) throw new Error(`Unexpected folder observation: ${path}`); return scripts.folderOccupied(path); },
    isAbsoluteFolder(path) { calls.push(`folder:${path}`); if (!scripts.isAbsoluteFolder) throw new Error(`Unexpected folder validation: ${path}`); return scripts.isAbsoluteFolder(path); },
  };
  const host: SourceSelectionHost = {
    products: () => products,
    role: (id, task) => roleForTask(BUILT_IN_ROLES, id, task),
    profileExists: id => profiles.has(id),
    productId: () => { const id = `source-product-${++nextProduct}`; calls.push(`id:${id}`); return id; },
    additionChanged: task => { checkpoints.push(structuredClone(task)); },
    planCheck: () => item,
    commitNow: task => { checkpoints.push(structuredClone(task)); },
    recordChoice: (_task, text) => { notes.push(text); },
  };
  const selections = new SourceSelections(host, effects);
  return { products, scripts, calls, checkpoints, notes, item, queries, effects, host, selections };
}

export function pending<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
