import { acceptanceGapLines, finishTaskStep, afterChangesAsked, applyAcceptanceVersions, approveAcceptanceGap, builderFindings, endYouStep, gateStatus, gateTitle, recordAcceptanceGap, shipsUnasked, type WorkflowEventDraft, WorkflowObserver } from "@petrina/core";
import { AcceptanceStep } from "../../src/acceptance-step.js";
import { AcceptanceResults } from "../../src/acceptance-results.js";
import { WorkCompletion } from "../../src/work-completion.js";
import type { DeliveryCheckpointEffects } from "../../src/ports/delivery-checkpoint.js";
import { DeliveryCheckpoint } from "../../src/delivery-checkpoint.js";
import { prepareDeliveryReturn } from "../../src/delivery-return.js";
import { scopesFor, taskView } from "../../src/repository-context.js";
import type { AcceptanceReply } from "../../src/ports/acceptance-results.js";
import type { AcceptanceRoutingHost } from "../../src/ports/acceptance.js";
import { checkPolicyWorkflow } from "./check-policy-workflow.js";
import { deliveryWorkflowFixture } from "./delivery-workflow.js";
import { ScriptedAgents, scriptedResult } from "./scripted-agents.js";

export const REQUIRED = "People see the greeting on the welcome page";
export const SECOND = "The greeting reads well on a phone";
export const UNAVAILABLE = "The hosted preview account is unavailable, so the welcome page could not be opened.";
export const TRIED = "Tried to sign in to the hosted preview twice; both attempts were refused before the page loaded.";
export const blocked = (text = REQUIRED, productIds?: string[]) => ({ text, result: "blocked" as const, reason: UNAVAILABLE, evidence: TRIED, ...(productIds ? { productIds } : {}) });
export const passed = (text = REQUIRED, productIds?: string[]) => ({ text, result: "pass" as const, evidence: `Opened the welcome page and saw: ${text}`, ...(productIds ? { productIds } : {}) });
export const failing = (text = REQUIRED, productIds?: string[]) => ({ text, result: "fail" as const, evidence: "Opened the welcome page: no greeting appears; expected it at the top.", ...(productIds ? { productIds } : {}) });

/** Actual acceptance, check, review and delivery owners; repository and publication effects are declared, never native receipts. */
export async function requiredAcceptanceFixture(checklist: readonly string[] = [REQUIRED], options: { shared?: boolean; role?: "built-in" | "custom" | "task-owned" } = {}) {
  let checks: AcceptanceReply["checks"] = [blocked()], fixedChecks: AcceptanceReply["checks"] | undefined;
  let proofAnswers: AcceptanceReply["proofAnswers"] = [], sequence = 0, repairs = 0;
  const agents = new ScriptedAgents(prompt => {
    switch (prompt.result) {
      case "checks": return scriptedResult({ summary: "Tried every acceptance item.", checks: repairs && fixedChecks ? fixedChecks : checks, proofAnswers, learnings: [] });
      case "build": repairs++; return scriptedResult({ summary: "Added the greeting.", answers: JSON.parse(prompt.text).map((id: string) => ({ id, fixed: true, text: "Fixed it." })) });
      case "findings": return scriptedResult({ verdict: "pass", findings: [], confirms: [], disputes: [], resolves: [], confirmationEvidence: {} });
      case "votes": return scriptedResult({ verdicts: JSON.parse(prompt.text).map((id: string) => ({ id, verdict: "real", reason: "The scripted welcome-page observation reproduces the missing greeting." })) });
      default: throw new Error(`Unexpected required-acceptance participant: ${prompt.result}`);
    }
  });
  const f = await checkPolicyWorkflow({ sequence: "P", tester: true, shared: options.shared, agents }), { task, scope, state, catalog, phases, host, tick, versions, patch } = f;
  const product = state.products.find(product => product.id === scope.work.productId)!;
  const products = scopesFor(task).map(bound => state.products.find(product => product.id === bound.work.productId)!);
  products.forEach((product, index) => { product.name = `Product ${index + 1}`; product.approveDelivery = false; });
  const acceptanceStarts: { retest: boolean; stage: number }[] = [];
  task.title = "Show the greeting"; task.approveDelivery = false; task.stageIndex = 1;
  task.brief = { summary: task.title, areas: [], forUsers: [], risks: [], acceptance: checklist.map(text => ({ text })) };
  const build = { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
  const tester = { id: "test", title: "Acceptance", kind: "do" as const, roleId: "tester", profileIds: ["opus-high"] };
  const review = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 };
  const ship = { id: "ship", title: "Ship", kind: "do" as const, roleId: "release-manager", profileIds: ["opus-high"] };
  if (options.role && options.role !== "built-in") {
    const role = { ...catalog.role("tester", task)!, id: "quality-partner", name: "Quality partner" };
    if (options.role === "custom") state.roles.push(role);
    else task.maintenance = { routineId: "routine", routineName: "Weekly check", scheduledAt: 1, queuedAt: 1, zone: "UTC", focus: "Try the greeting", input: "Try the greeting", role, profile: catalog.profile("opus-high")!, product };
    tester.roleId = role.id;
  }
  task.plan = { rationale: "Focused acceptance workflow", plannerProfileId: "sol-high", stages: [build, tester, review, ship] };
  const observer = new WorkflowObserver(), events: WorkflowEventDraft[] = [];
  const context = () => ({ roles: state.roles, profiles: state.profiles, products: state.products, inbox: state.inbox, now: f.clock.now() });
  observer.baseline(task, context());
  const observe = () => { events.push(...observer.observe(task, context())); };
  const changed = host.changed; host.changed = () => { changed(); observe(); }; host.checkpoint = host.changed;
  f.groupHost.changed = host.changed; f.groupHost.checkpoint = host.changed;
  f.roundHost.changed = host.changed; f.roundHost.commitNow = host.changed;
  const note = (text: string, tone: "milestone" | "warn" | "done") => { task.timeline.push({ id: `gap-note-${++sequence}`, at: tick(), tone, text }); observe(); };
  host.note = (_task, tone, text) => note(text, tone); f.roundHost.note = (_task, tone, text) => note(text, tone);
  const gate = host.gate;
  host.gate = (current, kind) => {
    gate(current, kind);
    const decision = current.journey!.findLast(step => step.kind === "you" && step.waitsFor === kind)!;
    const gap = recordAcceptanceGap(taskView(current), decision, state.roles);
    const item = state.inbox.findLast(item => item.taskId === current.id && item.kind === kind)!;
    item.title = gateTitle(taskView(current), kind); current.statusLine = gateStatus(taskView(current), kind);
    if (gap) item.body = acceptanceGapLines(taskView(current), gap, id => state.products.find(product => product.id === id)?.name ?? id);
    observe();
  };
  const routing: AcceptanceRoutingHost = { role: catalog.role, finishStep: bound => { finishTaskStep(bound.task, bound.work, tick()); observe(); },
    note: (_scope, tone, text) => note(text, tone), commit: observe, commitNow: observe, openDeliveryDecision: current => host.gate(current, "delivery") };
  const results = new AcceptanceResults({ id: () => `gap-finding-${++sequence}`, now: tick, note: (_scope, tone, text) => note(text, tone),
    noteLearnings: async (_scope, lessons) => { if (lessons.length) throw new Error("Unexpected learning input"); }, acceptancePatch: async () => patch() });
  const completion = new WorkCompletion({ finishStep: routing.finishStep, endStage() {}, rerun: () => false,
    invalidateAcceptance: async bound => { applyAcceptanceVersions(bound.task, versions()); }, checkpoint: observe, changed: observe });
  const step = new AcceptanceStep({ now: tick, checkpoint: observe }, {
    committedCode: async () => ({ versions: versions(), changes: versions() }), versions: async () => versions(), saveEdits: async () => {},
    turn: async (bound, input, signal) => {
      const role = catalog.role(input.roleId, task)!, profileId = task.agent!.profileId;
      acceptanceStarts.push({ retest: !!task.retest, stage: task.stageIndex });
      const reply = await f.perform(bound, role, signal, JSON.stringify(builderFindings(task, bound.work.productId).map(finding => finding.id)));
      input.used(profileId);
      if (!reply.summary || !reply.checks) throw new Error("No explicit acceptance observation");
      const value = { summary: reply.summary, checks: reply.checks, proofAnswers: reply.proofAnswers ?? [], learnings: reply.learnings ?? [] };
      const invalid = input.check(value); if (invalid) throw new Error(invalid);
      return value;
    },
  }, results, routing);
  const doStage = phases.doStage;
  phases.doStage = async (bound, stage, signal) => {
    const role = catalog.role(stage.roleId, task)!;
    if (role.result !== "checks") return doStage(bound, stage, signal);
    const result = await step.run(bound, { roleId: role.id, profileId: stage.profileIds[0]!, canEdit: () => !!role.canEdit }, signal);
    if (result.next) return result.next;
    return completion.complete(bound, { stageId: stage.id, canEdit: !!role.canEdit, testedVersions: result.testedVersions });
  };
  const modeledChecks = async () => { for (const bound of scopesFor(task)) await f.verify(bound, new AbortController().signal); observe(); };
  const delivery = deliveryWorkflowFixture(); delivery.register(task);
  delivery.host.log = (_task, tone, text) => note(text, tone); delivery.host.now = tick;
  delivery.hooks.returnForDecision = (current, why) => delivery.workflow.returnForDecision(current, why);
  const checkpointEffects: DeliveryCheckpointEffects = {
    writeGuide: async () => {}, writeLearnings: async () => {}, upToDate: async () => "current",
    checksBeforeDelivery: async (bound, signal) => f.delivery.beforeDelivery(bound, signal, async () => true),
    offerLearnings: async () => {}, previewRelease: async () => { throw new Error("Unexpected release"); },
    head: async bound => f.evidence.find(e => e.scope.work === bound.work)!.state.sha!, patch: async () => patch(),
    committedCode: async () => ({ versions: versions(), changes: versions() }), invalidateAcceptance: async () => { applyAcceptanceVersions(task, versions()); return versions(); },
    versions: async () => versions(), acceptanceVersion: async () => patch(),
  };
  const checkpoint = new DeliveryCheckpoint({ admissionsClosed: host.admissionsClosed, admissionWait: host.admissionWait, column: host.column, role: catalog.role,
    blocked: () => { throw new Error("Declared product checks must complete"); }, note: host.note, checkpoint: observe, gate: current => host.gate(current, "delivery"),
    shipsUnasked: current => shipsUnasked(current, { products: state.products, product, ...scope.work, checks: scope.work.checks }), destination: () => "scripted:main" }, checkpointEffects);
  phases.deliveryCheckpoint = (bound, signal) => checkpoint.run(bound, signal);
  phases.delivery = (current, stage, signal) => delivery.workflow.deliver(current, stage, signal);
  async function drive() { await f.drive(); observe(); }
  return { ...f, task, scope, product, products, build, tester, review, ship, delivery, checkpoint, routing, results, completion, versions, modeledChecks, checkpointEffects, events,
    configure(next: { checks: AcceptanceReply["checks"]; fixedChecks?: AcceptanceReply["checks"]; proofAnswers?: AcceptanceReply["proofAnswers"]; changeOnRepair?: boolean }) {
      checks = next.checks; fixedChecks = next.fixedChecks; proofAnswers = next.proofAnswers ?? []; f.unchanged(next.changeOnRepair === false);
    },
    acceptanceStarts,
    async report() { const phase = phases.doStage; phases.doStage = async (...args) => { await phase(...args); return "stop"; }; try { await drive(); } finally { phases.doStage = phase; } }, drive,
    decisions: () => state.inbox.filter(item => item.taskId === task.id && item.kind === "delivery"),
    runs: (roleId = tester.roleId) => task.journey!.filter(step => step.kind === "agent" && step.roleId === roleId),
    approve() {
      approveAcceptanceGap(task);
      if (task.proofRequests?.length) task.approvedProofDecision = structuredClone(task.checkedProofDecision);
      for (const { work } of scopesFor(task)) { work.approvedSha = work.checkedSha; work.approvedPatch = work.checkedPatch; work.approvedFor = { by: "coordinator", mode: "local", destination: "scripted:main" }; }
      state.inbox = state.inbox.filter(item => item.taskId !== task.id); endYouStep(task, { outcome: "Approved", reason: "Supplied coordinator approval" }, tick());
      if (task.plan!.stages[task.stageIndex]?.kind === "gate") task.stageIndex++;
    },
    requestChanges(note: string) {
      const fromCheck = task.stageIndex; state.inbox = state.inbox.filter(item => item.taskId !== task.id);
      afterChangesAsked(task, "delivery", note, tick(), state.roles); prepareDeliveryReturn(routing, scope, { note, fromCheck, now: tick() });
    },
  };
}
