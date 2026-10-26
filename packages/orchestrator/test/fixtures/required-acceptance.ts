import { acceptanceGap, afterChangesAsked, applyAcceptanceVersions, beginAgentStep, beginYouStep, beginPetrinaStep, endAgentStep, endPetrinaStep, endYouStep, finishTaskStep, gateTitle, openProofs, openStep, recordBuilderFindingAnswers, shipsUnasked, type DeepMutable, type AcceptanceGap } from "@petrina/core";
import { AcceptanceResults } from "../../src/acceptance-results.js";
import { routeAcceptance } from "../../src/acceptance-routing.js";
import { WorkCompletion } from "../../src/work-completion.js";
import type { DeliveryCheckpointEffects } from "../../src/ports/delivery-checkpoint.js";
import { DeliveryCheckpoint } from "../../src/delivery-checkpoint.js";
import { prepareDeliveryReturn } from "../../src/delivery-return.js";
import { ParallelAdmissionGroup } from "../../src/parallel-admission-group.js";
import { VerifierBallots } from "../../src/verifier-ballots.js";
import { releaseAgentForDecision } from "../../src/agent-step-state.js";
import { executionFor } from "../../src/repository-context.js";
import type { AcceptanceReply } from "../../src/ports/acceptance-results.js";
import type { AcceptanceRoutingHost } from "../../src/ports/acceptance.js";
import { fixture as checkSetupFixture, reply as checkReply } from "./check-setup.js";
import { admissionFixture } from "./agent-workflow.js";
import { deliveryWorkflowFixture } from "./delivery-workflow.js";
import { ScriptedAgents, scriptedResult } from "./scripted-agents.js";

export const REQUIRED = "People see the greeting on the welcome page";
export const SECOND = "The greeting reads well on a phone";
export const UNAVAILABLE = "The hosted preview account is unavailable, so the welcome page could not be opened.";
export const TRIED = "Tried to sign in to the hosted preview twice; both attempts were refused before the page loaded.";
export const blocked = (text = REQUIRED) => ({ text, result: "blocked" as const, reason: UNAVAILABLE, evidence: TRIED });
export const passed = (text = REQUIRED) => ({ text, result: "pass" as const, evidence: `Opened the welcome page and saw: ${text}` });
export const failing = (text = REQUIRED) => ({ text, result: "fail" as const, evidence: "Opened the welcome page: no greeting appears; expected it at the top." });

/** Actual stage/selection/review/ballot/acceptance/delivery owners, with explicitly modeled external effects. */
export function requiredAcceptanceFixture(checklist: readonly string[] = [REQUIRED]) {
  let checks: AcceptanceReply["checks"] = [blocked()], fixedChecks: AcceptanceReply["checks"] | undefined;
  let proofAnswers: AcceptanceReply["proofAnswers"] = [], sequence = 0, repairs = 0;
  const agents = new ScriptedAgents(prompt => {
    switch (prompt.result) {
      case "checks": return scriptedResult({ summary: "Tried every acceptance item.", checks: repairs && fixedChecks ? fixedChecks : checks, proofAnswers, learnings: [] });
      case "build": return scriptedResult({ summary: "Added the greeting.", answers: JSON.parse(prompt.text).map((id: string) => ({ id, fixed: true, text: "Fixed it." })) });
      case "findings": return scriptedResult({ verdict: "pass", findings: [] });
      case "votes": return scriptedResult({ verdicts: JSON.parse(prompt.text).map((id: string) => ({ id, verdict: "real", reason: "The scripted welcome-page observation reproduces the missing greeting." })) });
      default: throw new Error(`Unexpected required-acceptance participant: ${prompt.result}`);
    }
  });
  const f = admissionFixture(3, 3, 1, agents), { state, catalog, clock, phases, host } = f;
  const acceptanceStarts: { retest: boolean; stage: number }[] = [];
  const task = f.task(f.ids[0]!)!, scope = executionFor(task), product = state.products[0]!;
  f.roundHost.ownChanges = async () => ({ [product.id]: "controller:change" });
  state.pool.paused = false; host.schedule = () => {};
  task.title = "Show the greeting"; task.approveDelivery = false; task.state = "running"; task.stageIndex = 1;
  task.brief = { summary: task.title, areas: [], forUsers: [], risks: [], acceptance: checklist.map(text => ({ text })) };
  const build = { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
  const tester = { id: "test", title: "Acceptance", kind: "do" as const, roleId: "tester", profileIds: ["opus-high"] };
  const review = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 };
  const ship = { id: "ship", title: "Ship", kind: "do" as const, roleId: "release-manager", profileIds: ["opus-high"] };
  task.plan = { rationale: "Focused acceptance workflow", plannerProfileId: "sol-high", stages: [build, tester, review, ship] };
  product.approveDelivery = false;
  scope.work.delivery = "local"; scope.work.worktree = "scripted:required-acceptance";
  const versions = () => ({ [product.id]: `controller:contents-${repairs}` });
  const patch = () => JSON.stringify(versions());
  scope.work.baseSha = "scripted:base";
  scope.work.source = { product, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true };
  const note = (text: string, tone: "milestone" | "warn" | "done") => { task.timeline.push({ id: `note-${++sequence}`, at: clock.now(), tone, text }); };
  host.note = (_task, tone, text) => note(text, tone);
  f.roundHost.note = (_task, tone, text) => note(text, tone);
  host.gate = (current, kind) => {
    if (current !== task || kind !== "delivery") throw new Error("Unexpected decision owner");
    releaseAgentForDecision(task); beginYouStep(task, kind, clock.now());
    task.state = "needs-you"; task.column = "ready";
    state.inbox.push({ id: `decision-${++sequence}`, taskId: task.id, kind, title: gateTitle({ ...task, ...scope.work }, kind), at: clock.now(), blocking: false });
  };
  const routing: AcceptanceRoutingHost = {
    role: catalog.role, finishStep: bound => finishTaskStep(bound.task, bound.work, clock.now()), note: (_scope, tone, text) => note(text, tone),
    commit: () => {}, commitNow: () => {}, openDeliveryDecision: current => host.gate(current, "delivery"),
  };
  const results = new AcceptanceResults({ id: () => `finding-${++sequence}`, now: clock.now,
    note: (_scope, tone, text) => note(text, tone), noteLearnings: async (_scope, lessons) => { if (lessons.length) throw new Error("Unexpected learning input"); },
    acceptancePatch: async () => patch(),
  });
  const completion = new WorkCompletion({ finishStep: routing.finishStep, endStage() {}, rerun: () => false,
    invalidateAcceptance: async bound => { applyAcceptanceVersions(bound.task, versions()); }, checkpoint() {}, changed() {},
  });
  /** Real CheckSetup over canonical scripted facts; these modeled command results claim no native observation. */
  async function modeledChecks() {
    beginPetrinaStep(task, "checks", clock.now(), scope.work);
    const step = openStep(task)!, setup = checkSetupFixture();
    const input = { ...setup.request.input };
    const before = await setup.controller.observe({ ...setup.request, id: `setup-${++sequence}`, productId: product.id, input }, new AbortController().signal);
    const after = await setup.controller.observe({ ...setup.request, id: `setup-${++sequence}`, productId: product.id, input, position: "after-checks" }, new AbortController().signal);
    step.checkSetups = [before, after] as DeepMutable<typeof step.checkSetups>; scope.work.checkSetup = after as DeepMutable<typeof after>;
    const execution = checkReply({ id: "modeled-test", name: "Modeled product checks", argv: ["scripted-check"] });
    if (execution.kind !== "recorded") throw new Error("No modeled command result");
    const run = { ...execution.run,
      startedAt: clock.now(), endedAt: clock.now(), source: { stepId: step.id, attemptId: "run-0", checkId: "check-0" } };
    step.productChecks = [{ id: run.source.checkId, attemptId: "run-0", productId: product.id, name: run.name, result: "pass", startedAt: run.startedAt, endedAt: run.endedAt, run }];
    if (!after.identity) throw new Error("Modeled setup did not complete");
    scope.work.checks = { at: clock.now(), tree: input.tree, definition: input.definition,
      environment: { ...after.identity, setupAttempts: { before: before.id, after: after.id } }, current: true, results: [run] };
    endPetrinaStep(task, { outcome: "Modeled checks passed", reason: "Scripted command completion" }, clock.now());
  }
  const delivery = deliveryWorkflowFixture();
  delivery.register(task);
  delivery.host.log = (_task, tone, text) => note(text, tone); delivery.host.now = clock.now;
  delivery.hooks.returnForDecision = (current, why) => delivery.workflow.returnForDecision(current, why);
  const checkpointEffects: DeliveryCheckpointEffects = {
    writeGuide: async () => {}, writeLearnings: async () => {}, upToDate: async () => "current", checksBeforeDelivery: async () => { await modeledChecks(); return "passed"; },
    offerLearnings: async () => {}, previewRelease: async () => { throw new Error("Unexpected release"); }, head: async () => "scripted:head", patch: async () => patch(),
    committedCode: async () => ({ versions: versions(), changes: { [product.id]: "scripted:change" } }), invalidateAcceptance: async () => undefined,
    versions: async () => versions(), acceptanceVersion: async () => patch(),
  };
  const checkpoint = new DeliveryCheckpoint({
    admissionsClosed: host.admissionsClosed, admissionWait: host.admissionWait, column: host.column, role: catalog.role,
    blocked: () => { throw new Error("Modeled product checks must complete"); }, note: host.note, checkpoint() {}, gate: current => host.gate(current, "delivery"),
    shipsUnasked: current => shipsUnasked(current, { products: state.products, product, ...scope.work, checks: scope.work.checks }), destination: () => "scripted:main",
  }, checkpointEffects);
  phases.prepareAcceptance = async () => { await modeledChecks(); return { kind: "prepared" }; };
  phases.deliveryCheckpoint = (bound, signal) => checkpoint.run(bound, signal);
  phases.doStage = async (bound, stage, signal) => {
    const role = catalog.role(stage.roleId, task)!;
    const run = { versions: versions(), changes: { [product.id]: "scripted:change" }, requestIds: openProofs(task).map(request => request.id) };
    if (role.result === "checks") { task.acceptanceRun = run; acceptanceStarts.push({ retest: !!task.retest, stage: task.stageIndex }); }
    const given = task.findings.filter(finding => finding.status === "open");
    const reply = await f.perform(bound, role, signal, role.result === "build" ? JSON.stringify(given.map(finding => finding.id)) : "Complete this accepted stage");
    openStep(task)!.agentResults = [{ roleId: role.id, profileId: task.agent!.profileId, at: clock.now(), value: reply }];
    if (role.result === "checks") {
      if (!reply.checks) throw new Error("No explicit acceptance observation");
      const recorded = await results.record(bound, { roleId: role.id, profileId: task.agent!.profileId, report: { summary: reply.summary!, checks: reply.checks, proofAnswers: reply.proofAnswers ?? [], learnings: [] }, run, testedVersions: run.versions, currentVersions: versions() });
      const next = routeAcceptance(routing, bound, recorded);
      if (next) return next;
    } else if (role.result === "build") {
      repairs++;
      const step = openStep(task)!; step.buildVersions = versions();
      // Accepted Builder answers pass through the same core owner; no fixture marks a finding fixed.
      recordBuilderFindingAnswers(task, given, (reply.answers ?? []).flatMap(answer => "fixed" in answer ? [answer] : []), { productId: product.id, shared: false, at: clock.now() });
      endAgentStep(task, { outcome: "Built", reason: "Consumed modeled Builder report" }, clock.now());
    } else throw new Error("Unexpected do-stage result");
    return completion.complete(bound, { stageId: stage.id, canEdit: !!role.canEdit });
  };
  phases.delivery = (current, stage, signal) => delivery.workflow.deliver(current, stage, signal);
  const ballots = new VerifierBallots({ profile: catalog.profile, profileName: id => id, toolName: id => id, roleResult: (id, current) => catalog.role(id, current)?.result }, {
    candidates: () => ["sol-high", "opus-high"], admissionsClosed: host.admissionsClosed,
    resolve: (current, id) => { const choice = f.selection.selection.choose(id, current, "verifier"); return choice && choice.kind !== "none" ? { kind: "selected", profile: choice.profile } : undefined; },
  }, { checkpoint() {}, changed() {}, note: (_task, tone, text) => note(text, tone), now: clock.now });
  f.reviewCatalog.pendingVoter = (current, stage) => ballots.next(current, stage)?.voters[0];
  const reviewPhase = phases.review;
  phases.review = async (current, stage, signal) => {
    const pending = current.hunt && !Object.values(current.hunt.reported).some(done => !done) && Object.keys(current.hunt.reported).length ? ballots.next(current, stage) : undefined;
    if (!pending) return reviewPhase(current, stage, signal);
    if (pending.voters.length) {
      beginAgentStep(task, "verifier", pending.voters[0]!, clock.now(), state.roles, pending.voters, scope.work);
      const group = new ParallelAdmissionGroup(f.groupHost, { ownership: f.ownership, catalog, readiness: f.readiness, errors: f.errors });
      await group.run({ scope, signal, status: () => "Verifiers working", members: pending.seats.map(place => ({ key: `vote-${place.key}`, reviewKey: `verifier:${place.key}`, roleId: "verifier", profileId: place.profileId,
        work: async (_copy, _room, seat, used, _agent, _continuing, signal) => {
          const reply = await f.perform(scope, catalog.role("verifier", task)!, signal, JSON.stringify(place.findingIds), { key: place.key, seat, used });
          if (!reply.verdicts) throw new Error("No supplied verifier answers");
          ballots.recordAnswers(task, { place, profileId: seat, plannedProfileId: place.profileId, findingIds: place.findingIds }, reply.verdicts);
          f.ownership.groups.get(task.id)!.finished(`vote-${place.key}`);
        } })), workspaces: { reference: member => `scripted:ballot:${member}`, prepare: async () => ({ activate() {}, finish() {} }), stopHelpers() {}, closeTaskRun() {}, releasedStops: async () => {}, finish: async () => {} } });
      finishTaskStep(task, scope.work, clock.now());
    }
    const settled = ballots.next(task, stage);
    if (settled?.voters.length) return "continue";
    if (settled) ballots.finish(task, settled);
    return reviewPhase(current, stage, signal);
  };
  async function drive() { task.state = "running"; await f.workflow["drive"](task.id); if (f.failures.length) throw f.failures[0]; }
  return { ...f, task, scope, product, build, tester, review, ship, delivery, checkpoint, routing, results, completion, ballots, versions, modeledChecks, checkpointEffects,
    configure(next: { checks: AcceptanceReply["checks"]; fixedChecks?: AcceptanceReply["checks"]; proofAnswers?: AcceptanceReply["proofAnswers"] }) { checks = next.checks; fixedChecks = next.fixedChecks; proofAnswers = next.proofAnswers ?? []; },
    acceptanceStarts,
    async report() {
      const phase = phases.doStage;
      phases.doStage = async (...args) => { await phase(...args); return "stop"; };
      try { await drive(); } finally { phases.doStage = phase; }
    }, drive,
    decisions: () => state.inbox.filter(item => item.taskId === task.id && item.kind === "delivery"),
    runs: (roleId = "tester") => task.journey!.filter(step => step.kind === "agent" && step.roleId === roleId),
    approve() {
      const gap = acceptanceGap(task); if (gap) task.approvedAcceptanceGap = structuredClone(gap) as DeepMutable<AcceptanceGap>;
      if (task.proofRequests?.length) task.approvedProofDecision = structuredClone(task.checkedProofDecision);
      scope.work.approvedSha = scope.work.checkedSha; scope.work.approvedPatch = scope.work.checkedPatch; scope.work.approvedFor = { by: "coordinator", mode: "local", destination: "scripted:main" };
      state.inbox = state.inbox.filter(item => item.taskId !== task.id); endYouStep(task, { outcome: "Approved", reason: "Supplied coordinator approval" }, clock.now());
      if (task.plan!.stages[task.stageIndex]?.kind === "gate") task.stageIndex++;
    },
    requestChanges(note: string) {
      const fromCheck = task.stageIndex; state.inbox = state.inbox.filter(item => item.taskId !== task.id);
      afterChangesAsked(task, "delivery", note, clock.now(), state.roles); prepareDeliveryReturn(routing, scope, { note, fromCheck, now: clock.now() });
    },
  };
}
