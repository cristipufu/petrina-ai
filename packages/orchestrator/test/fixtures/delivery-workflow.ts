import { BUILT_IN_ROLES, roleForTask, type RuntimeWaitTask } from "@petrina/core";
import { DeliveryWorkflow } from "../../src/delivery-workflow.js";
import type { DeliveryFailures, DeliveryPhaseEffects, DeliveryRecording } from "../../src/ports/delivery-workflow.js";
import { executionFor, scopesFor, type RepositoryContext, type RepositoryWork } from "../../src/repository-context.js";
import type { RuntimeTask } from "../../src/model.js";
import { deliveryAdmissionFixture } from "./delivery-admission.js";

export class DeliveryObservationFailure extends Error {
  constructor(readonly kind: "waiting" | "refresh" | "decision" | "source-moved" | "aborted", message: string = kind) { super(message); }
}

/** Scripted phase observations, never native Git/check/publication evidence; policy stays in the actual controllers. */
export function deliveryWorkflowFixture() {
  const live = deliveryAdmissionFixture();
  const events: string[] = [], checkpoints: RuntimeTask[][] = [];
  const decisions: { taskId: string; kind: "stuck" | "shipping"; title: string; productId?: string }[] = [];
  const published: { task: string; product: string; candidate: string }[] = [];
  const observations = new WeakMap<RepositoryWork, { head: string; candidate: string }>();
  const hooks: Partial<DeliveryPhaseEffects> = {};
  const counts = { delivered: 0, done: 0, scheduled: 0, companions: 0 };
  let clock = 200, sequence = 0;
  const phase = (name: string, scope: RepositoryContext) => { events.push(`${name}:${scope.task.id}:${scope.work.productId}`); };
  const observed = (work: RepositoryWork) => {
    const value = observations.get(work);
    if (!value) throw new Error("Unexpected phase without explicit fixture observations");
    return value;
  };
  const prepareObservation = (scope: RepositoryContext) => {
    scope.work.shipping = { ...scope.work.shipping, start: observed(scope.work).head,
      moves: scope.work.shipping?.moves ?? 0, failures: scope.work.shipping?.failures ?? 0,
      prepared: { tested: observed(scope.work).candidate, summary: "Recorded preparation observation", body: "Recorded body" } };
  };
  const effects: DeliveryPhaseEffects = {
    restoredChecks(scope, signal) { phase("restored-checks", scope); return hooks.restoredChecks?.(scope, signal) ?? Promise.resolve({ kind: "passed" }); },
    closedPullRequest(scope) { phase("closed", scope); return hooks.closedPullRequest?.(scope) ?? Promise.resolve(scope.work.pr?.state); },
    needGitHub(task) { events.push(`login:${task.id}`); return hooks.needGitHub?.(task) ?? Promise.resolve(); },
    readyToShip(scope, signal) { phase("ready", scope); return hooks.readyToShip?.(scope, signal) ?? Promise.resolve("ready"); },
    head(scope) { phase("head", scope); return hooks.head?.(scope) ?? Promise.resolve(observed(scope.work).head); },
    patch(scope, ref) { phase("patch", scope); return hooks.patch?.(scope, ref) ?? Promise.resolve(observed(scope.work).candidate); },
    upToDate(scope, signal) { phase("update", scope); return hooks.upToDate?.(scope, signal) ?? Promise.resolve("current"); },
    checkOrder(taskId) { return hooks.checkOrder ? hooks.checkOrder(taskId) : live.orders.get(taskId); },
    checksBeforeShipping(scope, signal, preparation) { phase("checks", scope); return hooks.checksBeforeShipping?.(scope, signal, preparation) ?? Promise.resolve("passed"); },
    async prepare(scope, stage, signal) {
      phase("prepare", scope);
      if (hooks.prepare) return hooks.prepare(scope, stage, signal);
      prepareObservation(scope);
      return "ready";
    },
    checkDelivery(scope, signal) { phase("lookup", scope); return hooks.checkDelivery?.(scope, signal) ?? Promise.resolve("continue"); },
    proofApprovalCurrent(task, signal, prepared) { events.push(`proof:${task.id}`); return hooks.proofApprovalCurrent?.(task, signal, prepared) ?? Promise.resolve(true); },
    returnForDecision(task, why) { events.push(`decision:${task.id}:${why}`); return hooks.returnForDecision?.(task, why) ?? Promise.resolve(); },
    backToWork(scope) { phase("back-to-work", scope); return hooks.backToWork?.(scope) ?? Promise.resolve(); },
    async publish(scope, signal) {
      phase("publish", scope);
      if (hooks.publish) return hooks.publish(scope, signal);
      const candidate = scope.work.shipping?.prepared?.tested;
      if (!candidate) throw new Error("Publication needs a supplied preparation observation");
      published.push({ task: scope.task.id, product: scope.work.productId, candidate });
      if (scope.work.delivery === "pull-request") scope.work.pr = { number: 1, url: "https://example.invalid/pr", state: "open", openedAt: clock };
      else if (scope.work.delivery === "release") scope.work.release = { tag: "observed-tag", url: "https://example.invalid/release" };
      else scope.work.landed = { branch: scope.work.source!.destination.branch!, sha: candidate };
      return "done";
    },
    prepareAgain(scope, why) { phase("again", scope); return hooks.prepareAgain?.(scope, why) ?? Promise.resolve("again"); },
    clearUnpublishedVersion(scope) { phase("clear", scope); return hooks.clearUnpublishedVersion?.(scope) ?? Promise.resolve(); },
    async finishCompanions(task) {
      events.push(`companions:${task.id}`); counts.companions++;
      if (hooks.finishCompanions) return hooks.finishCompanions(task);
      for (const { work } of scopesFor(task)) if (work.companion) work.companion.state = "done";
      return true;
    },
  };
  const host: DeliveryRecording = {
    clearStep: scope => { events.push(`clear-step:${scope.task.id}:${scope.work.productId}`); },
    checksBlocked: task => { events.push(`checks-blocked:${task.id}`); task.state = "needs-you"; },
    productName: scope => scope.work.source!.product.name,
    defaultBranch: scope => scope.work.source?.product.defaultBranch,
    findingId: () => `finding-${++sequence}`,
    gate: (task, problem) => { task.state = "needs-you"; events.push(`gate:${task.id}:${problem}`); },
    fail: (id, error) => { const task = live.tasks.get(id)!; task.state = "failed"; task.error = error.message; events.push(`failed:${id}`); },
    changed: () => { events.push("changed"); },
    noteScope: (scope, tone, text) => { events.push(`log:${scope.task.id}:${scope.work.productId}:${tone}:${text}`); },
    destination: scope => live.host.destination(scope),
    sourceName: scope => scope.work.source?.start.kind === "pull-request" ? `PR #${scope.work.source.start.number}` : scope.work.source?.start.branch ?? "main",
    stopped: () => live.state.stopped, now: () => clock, role: (id, task) => roleForTask(BUILT_IN_ROLES, id, task),
    taskDetails: id => live.tasks.get(id) as RuntimeWaitTask | undefined,
    hasDecision: (id, kinds) => decisions.some(item => item.taskId === id && kinds.includes(item.kind)),
    raise: (target, kind, title) => { const scope = "task" in target ? target : undefined;
      decisions.push({ taskId: scope?.task.id ?? (target as RuntimeTask).id, kind, title, ...(scope ? { productId: scope.work.productId } : {}) }); },
    log: (task, tone, text) => { events.push(`log:${task.id}:${tone}:${text}`); },
    delivered: task => { events.push(`delivered:${task.id}`); counts.delivered++; },
    done: task => { events.push(`done:${task.id}`); counts.done++; },
    checkpoint: () => { events.push("checkpoint"); checkpoints.push([...live.tasks.values()].map(task => structuredClone(task))); },
    schedule: () => { events.push("schedule"); counts.scheduled++; },
  };
  const failures: DeliveryFailures = {
    aborted: () => new DeliveryObservationFailure("aborted"),
    waiting: reason => new DeliveryObservationFailure("waiting", reason),
    prerequisiteRefresh: () => new DeliveryObservationFailure("refresh"),
    classify: error => error instanceof DeliveryObservationFailure && ["decision", "refresh"].includes(error.kind)
      ? { kind: error.kind as "decision" | "refresh" } : error instanceof DeliveryObservationFailure && error.kind === "source-moved"
        ? { kind: "source-moved", message: error.message } : { kind: "other" },
  };
  const workflow = new DeliveryWorkflow(live.admission, effects, host, failures);
  const add = (id: string, products = ["a"], mode: "local" | "pull-request" | "release" = "local") => {
    const task = live.add(id, products); task.state = "running";
    for (const { work } of scopesFor(task)) {
      work.delivery = mode; work.source!.destination.mode = mode;
      work.source!.destination.kind = mode === "local" ? "branch" : mode === "release" ? "release" : "new-pr";
      work.baseSha = `supplied-base-${++sequence}`;
      observations.set(work, { head: `supplied-head-${sequence}`, candidate: `supplied-candidate-${sequence}` });
    }
    return task;
  };
  const register = (task: RuntimeTask) => {
    live.tasks.set(task.id, task);
    live.host.destination = scope => `${scope.work.productId}#main`;
    live.host.branch = () => "main";
    for (const { work } of scopesFor(task)) observations.set(work, { head: "scripted:head", candidate: "scripted:candidate" });
  };
  return { ...live, admissionHost: live.host, register, workflow, effects, host, failures, hooks, events, checkpoints, decisions, published, observations, counts, add, prepareObservation,
    now: () => clock, advance: (ms: number) => { clock += ms; },
    run: (task: RuntimeTask, signal = new AbortController().signal) => workflow.deliver(task, task.plan!.stages[task.stageIndex]!, signal),
    stage: (task: RuntimeTask) => task.plan!.stages[task.stageIndex]!, scope: executionFor,
  };
}
