import { clearTaskStep, type DeepMutable, type InboxItem, type RuntimeWaitTask } from "@petrina/core";
import { DeliveryRecovery } from "../../src/delivery-recovery.js";
import { DeliveryMonitor } from "../../src/delivery-monitor.js";
import { executionFor, type RepositoryContext } from "../../src/repository-context.js";
import type { RuntimeTask } from "../../src/model.js";
import type { DeliveryLookup, DeliveryRecoveryEffects, DeliveryRecoveryHost } from "../../src/ports/delivery-recovery.js";
import type { DeliveryMonitorEffects, DeliveryMonitorHost } from "../../src/ports/delivery-monitor.js";
import { deliveryWorkflowFixture } from "./delivery-workflow.js";

class Unavailable extends Error {}

/** Consumed observations fail on an unexpected extra native request; no inferred evidence or retry loop. */
export function observations<T>() {
  const pending: (() => Promise<T>)[] = [];
  return {
    pending,
    add(value: T) { pending.push(async () => value); },
    effect(effect: () => Promise<T>) { pending.push(effect); },
    read(): Promise<T> {
      const next = pending.shift();
      if (!next) throw new Error("Unexpected delivery observation");
      return next();
    },
  };
}

/** Compose the actual workflow, recovery and monitor around canonical task state. */
export function deliveryRecoveryFixture(products = ["a"], mode: "pull-request" | "release" | "local" = "pull-request") {
  const f = deliveryWorkflowFixture(), task = f.add("delivery", products, mode), scope = executionFor(task);
  const state = { tasks: [task], inbox: [] as DeepMutable<InboxItem>[] };
  const lookup = observations<DeliveryLookup>();
  const prStates = observations<Awaited<ReturnType<DeliveryMonitorEffects["prState"]>>>();
  const refs = observations<Awaited<ReturnType<DeliveryMonitorEffects["releaseRefs"]>>>();
  const listed = observations<Awaited<ReturnType<DeliveryMonitorEffects["pullRequests"]>>>();
  const matched = observations<boolean>();
  const events: string[] = [], notes: string[] = [];
  const snapshots: typeof state[] = [];
  const background = new Set<Promise<void>>();
  let boot = "current-boot", sequence = 0;
  const targetTask = (target: RuntimeTask | RepositoryContext) => "task" in target ? target.task : target;
  const log: DeliveryRecoveryHost["log"] = (_target, _tone, text) => { notes.push(text); };
  const checkpoint = () => { snapshots.push(structuredClone(state)); events.push("checkpoint"); };
  const host: DeliveryRecoveryHost = {
    state, get boot() { return boot; }, now: f.now, task: id => f.tasks.get(id),
    repository: target => ("task" in target ? target : executionFor(target)).work.source?.product,
    taskDetails: id => f.tasks.get(id) as RuntimeWaitTask | undefined, log,
    raise: (target, kind, title, blocking, extra) => {
      const current = targetTask(target);
      state.inbox.push({ id: `choice-${++sequence}`, taskId: current.id, kind, title, blocking, at: f.now(), ...extra });
      current.state = "needs-you";
    },
    commit: () => { events.push("changed"); }, commitNow: checkpoint,
    delivered: target => { events.push(`delivered:${targetTask(target).id}`); },
    done: current => { events.push(`done:${current.id}`); },
    takeItem: id => { const at = state.inbox.findIndex(item => item.id === id); return at < 0 ? undefined : state.inbox.splice(at, 1)[0]; },
    toWaiting: current => { current.state = "waiting"; current.holdsSlot = false; delete current.agent; },
    clearStep: current => { clearTaskStep(current, executionFor(current).work); }, schedule: () => { events.push("schedule"); }, tidy: id => { events.push(`tidy:${id}`); },
  };
  const effects: DeliveryRecoveryEffects = {
    lookForDelivery: async bound => { events.push(`lookup:${bound.work.productId}`); return lookup.read(); },
    noteCancelledLocal: async () => { throw new Error("Unexpected local recovery effect"); },
    landLocal: async () => { throw new Error("Unexpected local publication effect"); },
    rememberDelivery: async (bound, sha, branch) => { events.push(`remember:${bound.work.productId}:${sha}:${branch}`); },
    clearApproval: bound => f.workflow.clearApproval(bound), finishMany: current => f.workflow.finishMany(current),
    checkUnrecordedPullRequest: bound => monitor.checkUnrecordedPullRequest(bound),
  };
  const recovery = new DeliveryRecovery(host, effects, { aborted: () => new Error("Aborted"), unreachable: text => new Unavailable(text) });
  const monitorHost: DeliveryMonitorHost = {
    task: host.task, tasks: () => state.tasks, stopped: () => f.state.stopped, hasDriver: id => f.drivers.has(id), hasSettling: id => f.settling.has(id), now: f.now,
    log, commitNow: checkpoint, commit: host.commit, tidy: host.tidy, repository: target => ("task" in target ? target : executionFor(target)).work.source?.product,
    trackWork: operation => { background.add(operation); void operation.finally(() => background.delete(operation)); return operation; },
    done: host.done, prSettled: (current, settled) => { events.push(`settled:${current.id}:${settled}`); }, schedule: host.schedule,
  };
  const monitorEffects: DeliveryMonitorEffects = {
    lookForDelivery: effects.lookForDelivery, releaseRefs: () => refs.read(),
    matchesPullRequest: () => matched.read(), pullRequests: () => listed.read(), prState: () => prStates.read(), unreachable: error => error instanceof Unavailable,
  };
  const monitor = new DeliveryMonitor(monitorHost, monitorEffects, { recordDelivery: (bound, evidence, signal) => recovery.recordDelivery(bound, evidence, signal), finishMany: effects.finishMany });
  f.hooks.checkDelivery = (bound, signal) => recovery.checkDelivery(bound, signal);
  f.host.log = (_current, _tone, text) => { notes.push(text); };
  f.host.raise = (target, kind, title, details) => {
    if (kind !== "shipping") throw new Error("Unexpected non-shipping choice");
    host.raise(target, kind, title, false, { body: details?.body ?? "" });
  };
  const prepared = () => {
    f.prepareObservation(scope);
    Object.assign(scope.work.shipping!, { boot, step: mode === "release" ? "release" : mode === "local" ? "update" : "open", ...(mode === "release" ? { tag: "v0.1.0", version: "0.1.0" } : {}) });
    scope.work.branch = "petrina/task";
    return scope.work.shipping!;
  };
  return { ...f, task, scope, recovery, monitor, recoveryHost: host, recoveryEffects: effects, monitorHost, monitorEffects,
    state, observations: { lookup, prStates, refs, listed, matched }, notes, recoveryEvents: events, snapshots, background, prepared,
    restart: () => { boot = "next-boot"; }, signal: new AbortController().signal,
  };
}
