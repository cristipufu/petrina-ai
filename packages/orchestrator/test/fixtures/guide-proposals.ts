import { beginAgentStep, BUILT_IN_ROLES, type DeepMutable, type InboxItem, type Product } from "@petrina/core";
import { GuideProposals, prepareDeliveryReturn, type GuideProposalResult, type GuideProposalsEffects, type GuideProposalsHost, type RepositoryContext, type RuntimeTask } from "../../src/index.js";
import { deliveryReturnTask } from "./delivery.js";
import { repairHost } from "./tasks.js";

export const GUIDE_POINT = "Every greeting also shows on the welcome page.";

/** Actual send-back and side-step owners, with explicit file observations and validated replies. */
export function guideProposalsFixture() {
  const delivery = deliveryReturnTask(false), { task, scope } = delivery;
  scope.work.worktree = "private supplied copy";
  const product: DeepMutable<Product> = { id: "a", name: "Shop", repo: "local/shop", tone: "blue" };
  const state: { inbox: DeepMutable<InboxItem>[]; products: DeepMutable<Product>[] } = { inbox: [], products: [product] };
  const logs: string[] = [], offers: DeepMutable<InboxItem>[] = [], checkpoints: RuntimeTask[] = [];
  const failures: { error: unknown; profileId: string }[] = [], released: string[] = [];
  const reads: string[] = [], turns: { note: string; guide: string; profileId: string }[] = [];
  const interrupted = new Set<unknown>(), deferred = new Set<unknown>();
  let guide = "", reply: GuideProposalResult = { missed: true, line: GUIDE_POINT, why: "The reviewers checked the greeting only where it was added." };
  let respond: () => Promise<GuideProposalResult> = async () => structuredClone(reply);
  const owned = (current: RuntimeTask | RepositoryContext) => {
    if ("task" in current ? current.task !== task || current.work !== scope.work : current !== task)
      throw new Error("The Guide fixture received a different task or repository owner");
  };
  const host: GuideProposalsHost = {
    current: () => state, task: id => id === task.id ? task : undefined,
    productOf: target => { owned(target); return product; },
    takeItem(id) { const item = state.inbox.find(item => item.id === id); state.inbox = state.inbox.filter(item => item.id !== id); return item; },
    profile: () => "opus-high", now: () => 300,
    checkpointNow() { checkpoints.push(structuredClone(task)); }, checkpoint(current) { if (current) owned(current); checkpoints.push(structuredClone(task)); },
    releaseScreen(current) { owned(current); released.push(current.id); delete current.screen; },
    offer(current, title, details) {
      owned(current);
      const item: DeepMutable<InboxItem> = { id: `guide-${offers.length}`, taskId: current.task.id, kind: "guide", title, ...details, blocking: false, at: 300 };
      state.inbox.push(item); offers.push(item); current.task.state = "needs-you";
    },
    log: (target, _kind, text) => { owned(target); logs.push(text); },
    failed: (current, error, profileId) => { owned(current); failures.push({ error, profileId }); },
  };
  const effects: GuideProposalsEffects = {
    async guide(current) { owned(current); reads.push(current.work.productId); return guide; },
    async turn(current, input, profileId, _signal, used) {
      owned(current);
      turns.push({ ...input, profileId });
      beginAgentStep(current.task, "guide-keeper", profileId, 250, BUILT_IN_ROLES, undefined, current.work);
      used("sol-high");
      return respond();
    },
    interrupted: error => interrupted.has(error), deferred: error => deferred.has(error),
  };
  const controller = new GuideProposals(host, effects), signal = new AbortController();
  return { task, scope, product, state, logs, offers, checkpoints, failures, released, reads, turns, interrupted, deferred, controller, host, effects, signal,
    sendBack() { delivery.transition(); return prepareDeliveryReturn(repairHost().host, scope, delivery.input); },
    propose: () => controller.propose(scope, signal.signal),
    guide(text: string) { guide = text; }, reply(value: GuideProposalResult) { reply = value; },
    respond(effect: typeof respond) { respond = effect; },
  };
}
