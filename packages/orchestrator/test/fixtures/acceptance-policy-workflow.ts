import { applyAcceptanceVersions, beginPetrinaStep, builderFindings, finishTaskStep, journeyView, nextLine, WorkflowObserver, type WorkflowEventDraft } from "@petrina/core";
import { AcceptanceStep } from "../../src/acceptance-step.js";
import { AcceptanceResults } from "../../src/acceptance-results.js";
import { WorkCompletion } from "../../src/work-completion.js";
import { executionFor, taskView } from "../../src/repository-context.js";
import type { AcceptanceReply } from "../../src/ports/acceptance-results.js";
import type { RuntimeTask } from "../../src/model.js";
import { checkPolicyWorkflow } from "./check-policy-workflow.js";
import { ScriptedAgents, scriptedResult } from "./scripted-agents.js";
import { ReleaseEvents } from "./release-events.js";
import { deferred } from "./tool-checks.js";
import { GREETING } from "./acceptance-repair.js";

export { GREETING };
export const REPAIR_CHECK = "Checking the builder's repair of the failed acceptance checks; the planned reviews follow";
export const STILL_FAILS = "Acceptance still fails: the builder returns are unavailable or used up. The remaining reviews run first, then the decision goes to you at your delivery check";

/** Actual workflow/check/review owners; only repository observations and provider replies are declared. */
export async function acceptancePolicyWorkflow(options: { exhausted?: boolean; gate?: boolean; holdCheck?: boolean } = {}) {
  let f!: Awaited<ReturnType<typeof checkPolicyWorkflow>>;
  let tests = 0, heldOnce = false;
  const releases = new ReleaseEvents(), held = deferred<void>();
  const agents = new ScriptedAgents(prompt => {
    if (prompt.result === "build") return scriptedResult({ summary: "Repaired the greeting.", changes: [], learnings: [],
      answers: JSON.parse(prompt.text).map((id: string) => ({ id, fixed: true, text: "Fixed it." })) });
    if (prompt.result === "checks") return scriptedResult({ summary: "Tried the greeting.", proofAnswers: [], learnings: [], checks: [{ text: GREETING,
      result: options.exhausted || tests++ === 0 ? "fail" : "pass", productIds: [f.evidence[0]!.scope.work.productId], evidence: "Declared current acceptance observation" }] });
    if (prompt.result === "findings") return scriptedResult({ verdict: "pass", findings: prompt.roleId === "code-reviewer"
      ? [{ text: `Consider a friendlier greeting (${prompt.profileId}).`, severity: "nit", productIds: [f.evidence[0]!.scope.work.productId], evidence: "Declared review observation" }] : [], confirms: [], disputes: [], resolves: [], confirmationEvidence: {} });
    throw new Error(`Unexpected acceptance policy participant ${prompt.result}`);
  });
  f = await checkPolicyWorkflow({ sequence: options.holdCheck ? "PPFP" : "P", tester: true, shared: true, agents,
    onExecute: async (scope, signal) => {
      if (options.holdCheck && !heldOnce && scope.task.repairCheck && scope.work === f.evidence[0]!.scope.work) {
        heldOnce = true;
        beginPetrinaStep(scope.task, "checks", f.tick(), scope.work);
        held.resolve();
        await releases.wait("check", signal);
      }
    },
  });
  const { task, state, phases } = f;
  task.title = "Show the greeting"; task.approveDelivery = options.gate !== false;
  task.brief = { summary: task.title, forUsers: [], areas: [], risks: [], acceptance: [{ text: GREETING }] };
  state.products.forEach((product, index) => { product.name = `Product ${index + 1}`; });
  task.plan = { rationale: "Acceptance repair before every owed review", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
    { id: "test", title: "Acceptance", kind: "do", roleId: "tester", profileIds: ["opus-high"] },
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"], maxRounds: 2 },
    { id: "security", title: "Security review", kind: "review-chain", roleId: "security-reviewer", profileIds: ["opus-high"], maxRounds: 2 },
    ...(options.gate === false ? [] : [{ id: "gate", title: "Your delivery check", kind: "gate" as const, gate: "delivery" as const, roleId: "release-manager", profileIds: [] }]),
    { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["opus-high"] },
  ] };
  const observer = new WorkflowObserver(), events: WorkflowEventDraft[] = [];
  const context = () => ({ roles: state.roles, profiles: state.profiles, products: state.products, inbox: state.inbox, now: f.clock.now() });
  observer.baseline(task, context());
  const observe = () => { events.push(...observer.observe(task, context())); };
  const note = (text: string, tone: "warn" | "done" | "you" | "milestone" = "milestone") => { task.timeline.push({ id: `acceptance-note-${f.tick()}`, at: f.tick(), tone, text }); observe(); };
  const changed = f.host.changed;
  f.host.changed = () => { changed(); observe(); };
  f.host.checkpoint = f.host.changed;
  f.groupHost.changed = f.host.changed; f.groupHost.checkpoint = f.host.changed;
  f.roundHost.changed = f.host.changed; f.roundHost.commitNow = f.host.changed;
  const routing = { role: f.catalog.role, finishStep: (scope: ReturnType<typeof executionFor>) => { finishTaskStep(scope.task, scope.work, f.tick()); observe(); },
    note: (_scope: ReturnType<typeof executionFor>, tone: "warn" | "milestone", text: string) => note(text, tone), commit: observe, commitNow: observe,
    openDeliveryDecision: (current: RuntimeTask) => { if (current !== task) throw new Error("Foreign acceptance decision"); f.host.gate(task, "delivery"); } };
  const results = new AcceptanceResults({ now: f.tick, id: () => `acceptance-finding-${f.tick()}`, note: (_scope, tone, text) => note(text, tone),
    noteLearnings: async (_scope, lessons) => { if (lessons.length) throw new Error("No acceptance learning declared"); }, acceptancePatch: async () => f.patch() });
  const step = new AcceptanceStep({ now: f.tick, checkpoint: observe }, {
    committedCode: async current => { if (current !== task) throw new Error("Foreign acceptance observation"); return { versions: f.versions(), changes: f.versions() }; },
    versions: async () => f.versions(), saveEdits: async () => {},
    turn: async (scope, input, signal) => {
      const role = f.catalog.role(input.roleId, task)!;
      const profileId = task.agent!.profileId;
      const reply = await f.perform(scope, role, signal, JSON.stringify(builderFindings(task, scope.work.productId).map(finding => finding.id)));
      input.used(profileId);
      if (!reply.summary || !reply.checks) throw new Error("Acceptance reply is incomplete");
      const value: AcceptanceReply = { summary: reply.summary, checks: reply.checks, proofAnswers: reply.proofAnswers ?? [], learnings: reply.learnings ?? [] };
      const invalid = input.check(value);
      if (invalid) throw new Error(invalid);
      return value;
    },
  }, results, routing);
  const completion = new WorkCompletion({ finishStep: routing.finishStep, endStage() {}, rerun: () => false,
    invalidateAcceptance: async (_scope, versions) => { applyAcceptanceVersions(task, versions ?? f.versions()); }, checkpoint: observe, changed: observe });
  const doStage = phases.doStage;
  phases.doStage = async (scope, stage, signal) => {
    const role = f.catalog.role(stage.roleId, task)!;
    if (role.result !== "checks") { const next = await doStage(scope, stage, signal); observe(); return next; }
    const result = await step.run(scope, { roleId: role.id, profileId: stage.profileIds[0]!, canEdit: () => !!role.canEdit }, signal);
    observe();
    if (result.next) return result.next;
    const next = await completion.complete(scope, { stageId: stage.id, canEdit: !!role.canEdit, testedVersions: result.testedVersions });
    observe(); return next;
  };
  const publicationRequests: string[] = [];
  // The actual driver reaches its publication effect. Native anchors own landing and main refs.
  phases.delivery = async current => { publicationRequests.push(current.id); return "stop"; };
  let stopAt: ((current: RuntimeTask) => boolean) | undefined;
  const admission = f.host.admissionsClosed;
  f.host.admissionsClosed = current => admission(current) || !!stopAt?.(current);
  return { ...f, task, agents, events, publicationRequests,
    async drive(stop?: (current: RuntimeTask) => boolean) { stopAt = stop; try { await f.drive(); observe(); } finally { stopAt = undefined; } },
    held: held.promise, releaseCheck: () => releases.release("check"),
    async close() { releases.release("check"); await f.close(); },
    runs: (roleId: string) => task.journey?.filter(entry => entry.kind === "agent" && entry.roleId === roleId && entry.endedAt !== undefined) ?? [],
    order: () => task.journey?.flatMap(entry => entry.kind === "agent" && entry.roleId !== "verifier" ? [entry.builderReturn ? `build:${f.evidence.findIndex(e => e.scope.work.productId === entry.builderReturn!.productId) + 1}` : entry.stageId!]
      : entry.kind === "you" && entry.waitsFor === "delivery" ? ["decision"] : []) ?? [],
    seats: () => task.journey?.filter(entry => entry.kind === "agent" && ["review", "security"].includes(entry.stageId ?? ""))
      .flatMap(entry => (entry.agentResults ?? []).filter(result => ["code-reviewer", "security-reviewer"].includes(result.roleId)).map(result => `${entry.stageId}:${entry.round}:${result.roleId}:${result.profileId}`)).sort() ?? [],
    heldFailure: () => task.findings.filter(finding => finding.text === `Failed acceptance check: ${GREETING}`),
    reviewReports: () => events.filter(event => event.kind === "review.finished"),
    view: () => {
      const shown = taskView(task), display = { ...state, tasks: state.tasks.map(taskView) };
      return [nextLine(display, shown), journeyView(shown, display).nodes.filter(node => ["now", "next", "ahead"].includes(node.state)).map(node => `${node.name}: ${node.state}`)];
    },
  };
}
