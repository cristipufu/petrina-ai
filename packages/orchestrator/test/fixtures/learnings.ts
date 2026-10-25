import { BUILT_IN_ROLES, roleForTask, type DeepMutable, type InboxItem, type Product } from "@petrina/core";
import { LearningOffers, type LearningOffersHost } from "../../src/learnings.js";
import { executionFor, scopesFor, type RepositoryContext, type RepositoryWork } from "../../src/repository-context.js";
import type { RuntimeTask } from "../../src/model.js";
import { repositoryTask } from "./tasks.js";

/** Private records and named file observations; no writer, Git result, workflow or policy is simulated. */
export function learningOffersFixture(shared = false) {
  const task = repositoryTask(shared), tasks = new Map([[task.id, task]]);
  const state: { inbox: DeepMutable<InboxItem>[]; products: DeepMutable<Product>[] } = {
    inbox: [], products: [{ id: "a", name: "Shop", repo: "local/shop", tone: "blue" }, { id: "b", name: "API", repo: "local/api", tone: "green" }],
  };
  const files = new WeakMap<RepositoryWork, string | undefined>();
  for (const scope of scopesFor(task)) files.set(scope.work, "");
  const reads: RepositoryContext[] = [], requested: { scope: RepositoryContext; title: string; body: string; detail: string; by: { roleId: string; profileId: string } }[] = [];
  const removed: string[] = [], checkpoints: (RuntimeTask | undefined)[] = [], logs: string[] = [];
  const host: LearningOffersHost = {
    current: () => state, task: id => tasks.get(id),
    productOf: target => state.products.find(product => product.id === ("task" in target ? target.work.productId : target.productId)),
    role: id => roleForTask(BUILT_IN_ROLES, id),
    async authoritativeFile(scope) {
      reads.push(scope);
      if (!files.has(scope.work)) throw new Error("Unexpected authoritative instruction observation");
      return files.get(scope.work);
    },
    offer(scope, title, details, by) { requested.push({ scope, title, ...details, by }); scope.task.state = "needs-you"; },
    removeOffer(id) { removed.push(id); state.inbox = state.inbox.filter(item => item.id !== id); },
    log: (_target, _kind, text) => { logs.push(text); }, checkpoint: task => { checkpoints.push(task); }, now: () => 200,
  };
  const controller = new LearningOffers(host), scope = executionFor(task);
  const offer = (body: string, productId?: string, kind: InboxItem["kind"] = "learnings") => {
    const item: DeepMutable<InboxItem> = { id: `offer-${state.inbox.length}`, taskId: task.id, title: "An offer", at: 100, blocking: false, body, kind, ...(productId ? { productId } : {}) };
    state.inbox.push(item);
    return item;
  };
  return { task, tasks, scope, state, files, reads, requested, removed, checkpoints, logs, host, controller, offer };
}
