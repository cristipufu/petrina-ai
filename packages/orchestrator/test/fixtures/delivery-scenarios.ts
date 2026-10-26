import { BUILT_IN_ROLES, beginAgentStep, beginYouStep, companionPreview, changeRuntimeWait, runtimeWaitHolds, shipsUnasked, type DeepMutable, type Product } from "@petrina/core";
import { AcceptanceResults } from "../../src/acceptance-results.js";
import { DeliveryCheckpoint } from "../../src/delivery-checkpoint.js";
import { scopesFor } from "../../src/repository-context.js";
import { fixture as checkSetupFixture, reply as checkReply } from "./check-setup.js";
import { deliveryWorkflowFixture } from "./delivery-workflow.js";
import { needsReleaseManager } from "../../src/delivery-workflow.js";
import { admissionFixture } from "./agent-workflow.js";
import { WaitSourceRefresh, type WaitSourceRefreshEffects, type WaitSourceRefreshHost } from "../../src/wait-source-refresh.js";

/** Explicit external observations. All delivery decisions run in their production owners. */
export function deliveryScenario(products = ["shop"], mode: "local" | "pull-request" | "release" = "local") {
  const f = deliveryWorkflowFixture(), task = f.add("delivery", products, mode);
  task.productId = products[0]!;
  if (task.repositories) { task.activeProductId = products[0]; task.leadProductId = products[0]; }
  const scope = f.scope(task);
  const declarations: DeepMutable<Product>[] = products.map(id => ({ id, name: id, repo: `local/${id}`, tone: "blue", shipLowRisk: true }));
  const gates: { body: string }[] = [], notes: string[] = [], restores: string[] = [];
  f.admissionHost.taskAdmissionsClosed = current => f.state.paused || f.state.draining || f.state.stopped || f.state.extraRecovery || !!current.held || runtimeWaitHolds(current);
  f.admissionHost.taskAdmissionWait = current => runtimeWaitHolds(current) ? current.runtimeWait!.reason : current.held ? "This task is on hold" : "Waiting for the pool to resume";
  f.host.log = (_task, _tone, text) => { notes.push(text); };
  f.host.noteScope = (_scope, _tone, text) => { notes.push(text); };
  f.hooks.readyToShip = (bound, signal) => f.workflow.readyToShip(bound, signal);
  f.hooks.returnForDecision = (current, why) => f.workflow.returnForDecision(current, why);
  f.hooks.clearUnpublishedVersion = bound => f.workflow.clearUnpublishedVersion(bound);
  f.hooks.backToWork = async bound => { restores.push(bound.work.productId); };
  const checkpoint = new DeliveryCheckpoint({
    admissionsClosed: current => f.admissionHost.taskAdmissionsClosed(current),
    admissionWait: current => f.admissionHost.taskAdmissionWait(current), column: () => "ready", role: f.host.role,
    blocked: current => { current.state = "needs-you"; gates.push({ body: "Product checks need attention" }); },
    note: (_task, _tone, text) => { notes.push(text); }, checkpoint: f.host.checkpoint,
    gate: current => { beginYouStep(current, "delivery", f.now()); current.state = "needs-you"; gates.push({ body: companionPreview(current.repositories ?? []) }); },
    shipsUnasked: current => shipsUnasked(current, { products: declarations, product: declarations[0], ...scope.work, checks: scope.work.checks }),
    destination: bound => f.host.destination(bound),
  }, {
    writeGuide: async () => {}, writeLearnings: async () => {}, upToDate: async () => "current",
    checksBeforeDelivery: async bound => {
      const setup = checkSetupFixture(), input = { ...setup.request.input };
      const before = await setup.controller.observe({ ...setup.request, id: `${bound.work.productId}-before`, productId: bound.work.productId, input }, new AbortController().signal);
      const after = await setup.controller.observe({ ...setup.request, id: `${bound.work.productId}-after`, productId: bound.work.productId, input, position: "after-checks" }, new AbortController().signal);
      const execution = checkReply({ id: "modeled", name: "Modeled checks", argv: ["scripted-check"] });
      if (execution.kind !== "recorded" || !after.identity) throw new Error("Explicit check observations did not complete");
      bound.work.checkSetup = after as DeepMutable<typeof after>;
      bound.work.checks = { at: f.now(), tree: input.tree, definition: input.definition, current: true,
        environment: { ...after.identity, setupAttempts: { before: before.id, after: after.id } }, results: [execution.run] };
      return "passed";
    },
    offerLearnings: async () => {}, previewRelease: async () => {}, head: bound => f.effects.head(bound), patch: (bound, ref) => f.effects.patch(bound, ref),
    committedCode: async () => ({ versions: versions(), changes: versions() }), invalidateAcceptance: async () => undefined, versions: async () => versions(), acceptanceVersion: async () => "scripted:accepted",
  });
  const versions = () => Object.fromEntries(scopesFor(task).map(({ work }) => [work.productId, `scripted:contents:${work.productId}`]));
  for (const bound of scopesFor(task)) bound.work.worktree = `scripted:workspace:${bound.work.productId}`;
  const refreshHost: WaitSourceRefreshHost = {
    due: () => true, stepStarted: () => false, checkpoint: f.host.checkpoint,
    note: (_task, _tone, text) => { notes.push(text); }, aborted: f.failures.aborted,
  };
  const refreshEffects: WaitSourceRefreshEffects = {
    clean: async () => true, clearUnpublishedVersion: (bound, preserve) => f.workflow.clearUnpublishedVersion(bound, preserve),
    update: (bound, signal) => f.effects.upToDate(bound, signal),
  };
  const refresh = new WaitSourceRefresh(refreshHost, refreshEffects);
  const approve = () => {
    for (const bound of scopesFor(task)) {
      const observation = f.observations.get(bound.work)!;
      bound.work.approvedSha = observation.head; bound.work.approvedPatch = observation.patch;
      bound.work.approvedFor = { by: "coordinator", mode: bound.work.delivery, destination: f.host.destination(bound) };
    }
  };
  const hold = () => {
    task.runtimeWait = { after: ["prerequisite"], reason: "Waiting for the prerequisite", changes: [] };
    f.admission.syncDeliveryTurns();
  };
  const recordAcceptance = async () => {
    const text = "The shared greeting works";
    task.brief = { summary: task.title, forUsers: [], areas: [], risks: [], acceptance: [{ text }] };
    beginAgentStep(task, "tester", "opus-high", f.now(), BUILT_IN_ROLES);
    const results = new AcceptanceResults({ id: () => "unexpected-finding", now: f.now, note: () => {}, noteLearnings: async () => {}, acceptancePatch: async () => "scripted:accepted" });
    await results.record(scope, { roleId: "tester", profileId: "opus-high",
      run: { versions: versions(), changes: versions(), requestIds: [] }, testedVersions: versions(), currentVersions: versions(),
      report: { summary: "Observed the scripted greeting", checks: [{ text, result: "pass", evidence: "The scripted greeting appeared in both products", productIds: products }], proofAnswers: [], learnings: [] } });
  };
  return { ...f, task, scope, declarations, gates, notes, restores, checkpoint, versions, approve, hold,
    recordAcceptance, refresh, refreshHost, refreshEffects,
    release: () => changeRuntimeWait(task, { after: [], reason: "The prerequisite is available" }, f.now()),
    signal: new AbortController().signal,
  };
}

/** Compose the actual seat owner and delivery owner around the same live task records. */
export function scheduledDeliveryScenario(mode: "local" | "pull-request" | "release" = "local") {
  const f = deliveryScenario(["a"], mode), scheduler = admissionFixture(1, 3, 1);
  scheduler.state.pool.paused = false;
  const busy = scheduler.task(scheduler.ids[0]!)!;
  busy.plan = { rationale: "Keep a real scripted Builder in the sole seat", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
  ] };
  busy.stageIndex = 0; busy.state = "waiting";
  f.task.state = "needs-you";
  scheduler.state.tasks.push(f.task);
  scheduler.host.schedule = () => {};
  scheduler.phases.deliveryNeedsAgent = bound => needsReleaseManager(bound.work);
  scheduler.phases.delivery = (task, stage, signal) => f.workflow.deliver(task, stage, signal);
  scheduler.phases.deliveryCheckpoint = (bound, signal) => f.checkpoint.run(bound, signal);
  scheduler.host.waitingForDelivery = task => f.admission.waitingForTurn(task);
  scheduler.host.syncDeliveryTurns = () => f.admission.syncDeliveryTurns();
  f.admissionHost.hasDriver = id => scheduler.ownership.drivers.has(id);
  f.admissionHost.hasSettling = id => scheduler.ownership.settling.has(id);
  f.admissionHost.task = scheduler.task;
  f.admissionHost.taskAdmissionsClosed = task => scheduler.host.admissionsClosed(task) || !!task.held || runtimeWaitHolds(task);
  f.admissionHost.taskAdmissionWait = scheduler.host.admissionWait;
  f.admissionHost.admissionsClosed = () => scheduler.state.pool.paused;
  f.admissionHost.poolPaused = () => scheduler.state.pool.paused;
  return { ...f, scheduler, busy, close: () => scheduler.close(),
    async startBusy() {
      scheduler.workflow.schedule();
      await scheduler.waitFor(() => scheduler.agents.received().length === 1 && busy.agent?.roleId === "builder", "the scripted Builder to own its seat");
    },
    async drive() {
      f.task.state = "waiting"; scheduler.workflow.schedule();
      const operation = scheduler.ownership.settling.get(f.task.id);
      if (operation) await operation;
      if (scheduler.failures.length) throw scheduler.failures[0];
    },
  };
}
