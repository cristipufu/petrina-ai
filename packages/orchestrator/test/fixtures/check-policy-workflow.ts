import { recordAgentResult, afterChangesAsked, applyAcceptanceVersions, assignedCheckFailures, builderFindings, beginAgentStep, beginYouStep, endYouStep, finishTaskStep, gateStatus, gateTitle, endAgentStep, findingCount, openStep, JOURNEY_WORDS as W, checkSetupOutcome, type DeepMutable, type State } from "@petrina/core";
import { releaseAgentForDecision } from "../../src/agent-step-state.js";
import { CheckDecision, assertCheckApproval } from "../../src/check-decision.js";
import { CheckDelivery } from "../../src/check-delivery.js";
import { AcceptancePreflight } from "../../src/acceptance-preflight.js";
import { AcceptanceResults } from "../../src/acceptance-results.js";
import { routeAcceptance } from "../../src/acceptance-routing.js";
import { BuildCompletion } from "../../src/build-completion.js";
import { WorkCompletion } from "../../src/work-completion.js";
import { DeliveryCheckpoint } from "../../src/delivery-checkpoint.js";
import { prepareDeliveryReturn } from "../../src/delivery-return.js";
import { ReviewWorkflow } from "../../src/review-workflow.js";
import { VerifierBallots } from "../../src/verifier-ballots.js";
import { ReviewReports } from "../../src/review-reports.js";
import { ReviewRoundCompletion } from "../../src/review-round-completion.js";
import { pendingReviewPlaces } from "../../src/review-members.js";
import { ParallelAdmissionGroup } from "../../src/parallel-admission-group.js";
import { executionFor, scopesFor, taskView } from "../../src/repository-context.js";
import type { RuntimeTask } from "../../src/model.js";
import type { CheckVerification } from "../../src/ports/check-evidence.js";
import type { ReviewReport } from "../../src/ports/review-reports.js";
import { admissionFixture } from "./agent-workflow.js";
import { ScriptedAgents, scriptedResult } from "./scripted-agents.js";
import { checkEvidence } from "./check-evidence.js";
import { fixture as checkSetup } from "./check-setup.js";

/** Actual policy owners consume declared adapters. No native input, session, settings or execution is asserted. */
export async function checkPolicyWorkflow(options: { sequence?: string; tester?: boolean; shared?: boolean; important?: boolean; maxRounds?: number; pair?: boolean; agents?: ScriptedAgents; onExecute?(scope: ReturnType<typeof executionFor>, signal: AbortSignal): Promise<void> } = {}) {
  let serial = 0, builds = 0, changedBuilds = true, configured = options.sequence ?? "F", declaration = 1, checkIndex = 0;
  let importantRaised = false;
  const agents = options.agents ?? new ScriptedAgents(prompt => {
    if (prompt.result === "build") return scriptedResult({ summary: "Added a greeting.", changes: [], learnings: [], answers: JSON.parse(prompt.text).map((id: string) => ({ id, fixed: true, text: "Fixed it." })) });
    if (prompt.result === "checks") return scriptedResult({ summary: "Accepted greeting observation", checks: [{ text: "A greeting file exists", result: "pass", evidence: "Declared acceptance input" }], proofAnswers: [], learnings: [] });
    if (prompt.result === "findings") {
      const important = options.important && !importantRaised;
      importantRaised = true;
      return scriptedResult({ verdict: important ? "fail" : "pass", findings: important ? [{ text: "The greeting needs a correction", severity: "important" }, { text: "Polish the greeting", severity: "nit" }] : [], confirms: [],
        disputes: task.findings.filter(finding => finding.raisedBy !== "petrina" && finding.answer?.fixed).map(finding => ({ id: finding.id, reason: "The declared reviewer observed the accepted fix" })), resolves: [], confirmationEvidence: {} });
    }
    if (prompt.result === "votes") return scriptedResult({ verdicts: JSON.parse(prompt.text).map((id: string) => ({ id, verdict: "real", reason: "Declared current reproduction" })) });
    throw new Error(`Unexpected check policy participant ${prompt.result}`);
  });
  const f = admissionFixture(3, 3, 1, agents, { onResult(step, metadata, reply) { recordAgentResult(step, { ...metadata, value: reply }); f.host.changed(); } }), task = f.task(f.ids[0]!)!, { clock, catalog, host, state, phases } = f;
  const tick = () => ++clock.at;
  const perform = f.perform;
  host.now = tick; f.groupHost.now = tick; f.roundHost.now = tick; f.selection.host.now = tick;
  host.schedule = () => {};
  state.pool.paused = false;
  task.title = "Add a greeting"; task.approveDelivery = true; task.stageIndex = 1;
  task.brief = { summary: task.title, forUsers: [], areas: [], risks: [], acceptance: [{ text: "A greeting file exists" }] };
  task.plan = { rationale: "A declared built candidate at the actual check boundary", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
    ...(options.tester ? [{ id: "test", kind: "do" as const, title: "Final acceptance testing", roleId: "tester", profileIds: ["opus-high"] }] : []),
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: options.pair || options.tester ? ["opus-high", "sol-high"] : ["opus-high"], maxRounds: options.maxRounds ?? (options.pair || options.tester ? 2 : 1) },
    { id: "decision", kind: "gate", gate: "delivery", title: "Your delivery check", roleId: "coordinator", profileIds: [] },
  ] };
  if (options.shared) {
    if (state.products.length < 2) state.products.push({ id: "peer", name: "API", repo: "local/api", tone: "green" });
    task.repositories = state.products.slice(0, 2).map(product => ({ productId: product.id, delivery: "local", completedStages: ["build"] }));
    task.leadProductId = task.activeProductId = task.repositories[0]!.productId;
    delete task.repository;
  }
  const note = (text: string, tone: "warn" | "done" | "you" | "milestone") => { task.timeline.push({ id: `note-${++serial}`, at: tick(), tone, text }); };
  const evidence = await Promise.all(scopesFor(task).map(async scope => {
    const e = await checkEvidence(task, tick, scope.work.productId);
    scope.work.baseSha = "0".repeat(40); scope.work.base = "main";
    const product = state.products.find(p => p.id === scope.work.productId)!;
    scope.work.source = { product, start: { kind: "default", branch: "main" }, destination: { kind: "branch", mode: "local", repo: product.repo, branch: "main" }, confirmed: true };
    e.host.log = (_bound, tone, text) => note(text, tone);
    e.repairs["host"].log = (_bound, _tone, text) => note(text, "warn");
    return e;
  }));
  const scope = executionFor(task);
  const own = (current: typeof scope) => evidence.find(e => e.scope.task === current.task && e.scope.work === current.work) ?? (() => { throw new Error("Foreign check policy owner"); })();
  const versions = () => Object.fromEntries(evidence.map(e => [e.scope.work.productId, e.state.tree!]));
  const patch = () => JSON.stringify(versions());
  const gate = (current: RuntimeTask, problem?: { title: string; body: string }) => {
    if (current !== task) throw new Error("Foreign decision owner");
    releaseAgentForDecision(task); beginYouStep(task, "delivery", tick()); task.state = "needs-you";
    task.statusLine = gateStatus(taskView(task), "delivery");
    state.inbox.push({ id: `decision-${++serial}`, taskId: task.id, kind: "delivery", title: problem?.title ?? gateTitle(taskView(task), "delivery"), ...(problem ? { body: problem.body } : {}), at: tick(), blocking: false });
  };
  const decision = new CheckDecision({ state: () => state as unknown as State, role: catalog.role, productName: current => state.products.find(p => p.id === current.work.productId)!.name,
    now: tick, id: () => `rerun-${++serial}`, log: (_current, tone, text) => note(text, tone), gate });
  host.gate = (current, kind) => { if (kind !== "delivery") throw new Error("Unexpected checkpoint"); gate(current); };
  const executions: { productId: string; command: string; passed: boolean }[] = [];
  const verify = (current: typeof scope, signal: AbortSignal, purpose: "review" | "acceptance" | "delivery-check" | "publishing" = "review"): Promise<CheckVerification> => {
    const e = own(current);
    const observe = async (position: "before-checks" | "after-checks") => {
      const setup = checkSetup();
      setup.request.id = `setup-${++serial}`; setup.request.productId = current.work.productId; setup.request.position = position;
      setup.request.input = { ...e.state };
      const attempt = await setup.controller.observe(setup.request, signal);
      current.work.checkSetup = structuredClone(attempt) as DeepMutable<typeof attempt>;
      return { attempt, outcome: checkSetupOutcome(attempt), valid: () => !signal.aborted, forceFresh: false };
    };
    return e.controller.verify(current, { check: () => signal.throwIfAborted(), currentChecks: () => e.declaration,
      verify: () => e.controller.attempt(current, signal, purpose, {
        capture: async () => ({ ...e.state }), setupContract: () => e.state.contract, setupRequired: () => false,
        applies: async captured => e.controller.applies(current, captured, e.declaration), observe: () => observe("before-checks"),
        execute: async () => {
          await options.onExecute?.(current, signal);
          const passed = configured[Math.min(checkIndex++, configured.length - 1)] === "P";
          const command = e.declaration.commands[0]!;
          executions.push({ productId: current.work.productId, command, passed });
          const before = await observe("before-checks"), after = await observe("after-checks");
          return e.record([{ ...e.run(passed ? 0 : 1, "Welcome", command), output: passed ? "The welcome page works" : "The welcome page is missing (captured failure)" }], batch => { batch.live = before; batch.after = after; current.work.checkSetup = structuredClone(after.attempt) as DeepMutable<typeof after.attempt>; });
        },
      }),
    }, e.declaration);
  };
  const delivery = new CheckDelivery({ failing: (current, signal, purpose) => verify(current, signal, purpose), preparationChanged: () => false,
    backToBuilder: (current, when, products) => own(current).repairs.backToBuilder(current, when, products), blocked: current => decision.blocked(current) });
  const updates: string[] = [], testerStarts: number[] = [], testerPreparations: string[][] = [];
  const preflight = new AcceptancePreflight({ role: catalog.role, blocked: current => decision.blocked(current), backToBuilder: (current, products) => own(current).repairs.backToBuilder(current, "before acceptance testing", products) }, {
    upToDate: async current => { own(current); updates.push(current.work.productId); return "current"; },
    ensureChecks: async current => [{ name: "Welcome", argv: [...own(current).declaration.commands] }], failing: (current, signal) => verify(current, signal, "acceptance"), preparationChanged: () => false,
  });
  phases.prepareAcceptance = (current, signal) => preflight.run(current, signal);
  const routing = { role: catalog.role, finishStep: (current: typeof scope) => finishTaskStep(task, current.work, tick()), note: (_current: typeof scope, tone: "warn" | "milestone", text: string) => note(text, tone),
    commit: () => {}, commitNow: () => {}, openDeliveryDecision: (current: RuntimeTask) => gate(current) };
  const completion = new WorkCompletion({ finishStep: routing.finishStep, endStage() {}, rerun: () => false,
    invalidateAcceptance: async () => { applyAcceptanceVersions(task, versions()); }, checkpoint: () => {}, changed: () => {} });
  const buildsOwner = new BuildCompletion({ now: tick, checkpoint: () => {}, note: (_current, tone, text) => note(text, tone), noteLearnings: async (_current, lessons) => { if (lessons.length) throw new Error("No learning declared"); } }, {
    saveChanges: async () => {}, fold: async () => undefined, tree: async current => own(current).state.tree,
    finishPort: async () => {}, versions: async () => versions(), repairVersion: async current => ({ ...own(current).state, commands: [...own(current).declaration.commands] }),
  });
  const acceptance = new AcceptanceResults({ now: tick, id: () => `acceptance-${++serial}`, note: (_current, tone, text) => note(text, tone),
    noteLearnings: async (_current, lessons) => { if (lessons.length) throw new Error("No learning declared"); }, acceptancePatch: async () => patch() });
  phases.doStage = async (current, stage, signal) => {
    const role = catalog.role(stage.roleId, task)!;
    const given = builderFindings(task, current.work.productId);
    const e = own(current), startingTree = e.state.tree;
    const reply = await perform(current, role, signal, JSON.stringify(given.map(finding => finding.id)));
    if (role.result === "build") {
      builds++;
      if (changedBuilds) { e.state.tree = (builds + 4).toString(16).padStart(40, "0"); e.state.sha = (builds + 104).toString(16).padStart(40, "0"); }
      await buildsOwner.complete(current, { stageId: stage.id, roleId: role.id, plannedProfileId: stage.profileIds[0]!, actualProfileId: task.agent!.profileId, sourceName: "main", startingTree, given, checkFailures: assignedCheckFailures(current), maintenance: false,
        result: { summary: reply.summary!, changes: [], learnings: [], answers: (reply.answers ?? []).flatMap(answer => "fixed" in answer ? [answer] : []) } });
    } else if (role.result === "checks") {
      testerStarts.push(task.stageIndex); testerPreparations.push([...updates]);
      const run = { versions: versions(), changes: versions(), requestIds: [] };
      task.acceptanceRun = run;
      if (!reply.checks) throw new Error("No supplied acceptance reply");
      const result = await acceptance.record(current, { roleId: role.id, profileId: task.agent!.profileId, report: { summary: reply.summary!, checks: reply.checks, proofAnswers: [], learnings: [] }, run, testedVersions: versions(), currentVersions: versions() });
      const next = routeAcceptance(routing, current, result); if (next) return next;
    } else throw new Error("Unexpected stage");
    return completion.complete(current, { stageId: stage.id, canEdit: !!role.canEdit });
  };
  f.roundHost.anchor = async current => ({ head: own(current).state.sha, tree: own(current).state.tree });
  f.roundHost.ownChanges = async () => versions(); f.roundHost.note = (_current, tone, text) => note(text, tone);
  f.roundHost.openDeliveryDecision = current => gate(current);
  const rounds = new ReviewRoundCompletion(f.roundHost);
  const reports = new ReviewReports({ roles: () => state.roles, hasPendingReviewers: (current, stage) => pendingReviewPlaces(current, stage, f.reviewCatalog).length > 0,
    id: () => `finding-${++serial}`, now: tick, verdict: () => {}, note: (_current, tone, text) => note(text, tone) });
  const ballots = new VerifierBallots({ profile: catalog.profile, profileName: id => id, toolName: id => id, roleResult: (id, current) => catalog.role(id, current)?.result }, {
    candidates: () => ["sol-high", "opus-high"], admissionsClosed: host.admissionsClosed,
    resolve: (current, id) => { const selected = f.selection.selection.choose(id, current, "verifier"); return selected && selected.kind !== "none" ? { kind: "selected", profile: selected.profile } : undefined; },
  }, { checkpoint() {}, changed() {}, note: (_current, tone, text) => note(text, tone), now: tick });
  f.reviewCatalog.pendingVoter = (current, stage) => ballots.next(current, stage)?.voters[0];
  const review = new ReviewWorkflow({ now: tick, id: () => `review-${++serial}`, checkpoint: () => {}, changed: () => {}, finishStep: current => finishTaskStep(current, executionFor(current).work, tick()), clearStep: () => {}, rerun: () => {} }, {
    prepareChecks: async current => { own(current); return true; }, checks: (current, signal) => verify(current, signal), preparationChanged: () => false,
    backToBuilder: (current, products) => own(current).repairs.backToBuilder(current, "before the review", products), blocked: current => decision.blocked(current), versions: async () => versions(),
    input: async () => ({ file: "declared:review-input", digest: "declared:review-digest", heads: versions(), trees: versions() }),
    pendingReviewers: (current, stage) => pendingReviewPlaces(current, stage, f.reviewCatalog),
    hunt: async (current, stage, reviewers, signal) => {
      beginAgentStep(current, stage.roleId, current.agent!.profileId, tick(), state.roles, stage.profileIds);
      const group = new ParallelAdmissionGroup(f.groupHost, { ownership: f.ownership, catalog, readiness: f.readiness, errors: f.errors });
      await group.run({ scope: executionFor(current), signal, status: () => "Reviewers working", members: reviewers.map(({ key, profileId }) => ({ key: `review-${key}`, reviewKey: `reviewer:${key}`, roleId: stage.roleId, profileId, reviewerKey: key,
        work: async (_copy, _room, seat, used, _agent, _continuing, signal) => {
          const result = await perform(executionFor(current), catalog.role(stage.roleId, current)!, signal, "Accepted review reply", { key, seat, used });
          reports.apply(current, stage, { ...result, verdict: result.verdict!, findings: result.findings ?? [], confirms: [], disputes: (result as unknown as ReviewReport).disputes, resolves: [], confirmationEvidence: {} } satisfies ReviewReport, seat, stage.roleId, key);
          f.ownership.groups.get(task.id)!.finished(`review-${key}`); current.hunt!.reported[key] = true;
        } })), workspaces: { reference: member => `declared:review-copy:${member}`, prepare: async () => ({ activate() {}, finish() {} }), stopHelpers() {}, closeTaskRun() {}, releasedStops: async () => {}, finish: async () => {} } });
      reports.settle(current, stage);
    },
    pendingVote: (current, stage) => ballots.next(current, stage),
    vote: async (current, pending, signal) => {
      const prior = openStep(current);
      if (prior?.roleId && catalog.role(prior.roleId, current)?.result === "findings") endAgentStep(current, { outcome: findingCount(prior.result?.findings ?? []), reason: W.toCheck(pending.findings.length) }, tick());
      beginAgentStep(current, "verifier", pending.voters[0]!, tick(), state.roles, pending.voters, executionFor(current).work);
      const group = new ParallelAdmissionGroup(f.groupHost, { ownership: f.ownership, catalog, readiness: f.readiness, errors: f.errors });
      await group.run({ scope: executionFor(current), signal, status: () => "Verifiers working", members: pending.seats.map(place => ({ key: `vote-${place.key}`, reviewKey: `verifier:${place.key}`, roleId: "verifier", profileId: place.profileId,
        work: async (_copy, _room, seat, used, _agent, _continuing, signal) => {
          const reply = await perform(executionFor(current), catalog.role("verifier", current)!, signal, JSON.stringify(place.findingIds), { key: place.key, seat, used });
          if (!reply.verdicts) throw new Error("No declared verifier reply");
          ballots.recordAnswers(current, { place, profileId: seat, plannedProfileId: place.profileId, findingIds: place.findingIds }, reply.verdicts);
          f.ownership.groups.get(current.id)!.finished(`vote-${place.key}`);
        } })), workspaces: { reference: member => `declared:ballot:${member}`, prepare: async () => ({ activate() {}, finish() {} }), stopHelpers() {}, closeTaskRun() {}, releasedStops: async () => {}, finish: async () => {} } });
      finishTaskStep(current, executionFor(current).work, tick());
    },
    finishBallot: (current, pending) => ballots.finish(current, pending), closeRound: (current, stage, round, outcome, trees) => rounds.finish(current, stage, round, outcome, trees),
  });
  phases.review = (current, stage, signal) => review.run(current, stage, signal);
  const checkpoint = new DeliveryCheckpoint({ admissionsClosed: () => state.pool.paused, admissionWait: () => "Waiting for the pool to resume", column: host.column, role: catalog.role,
    blocked: current => decision.blocked(current), note: (_current, tone, text) => note(text, tone), checkpoint() {}, gate: current => gate(current), shipsUnasked: () => false, destination: () => "declared:main" }, {
    writeGuide: async () => {}, writeLearnings: async () => {}, upToDate: async () => "current", checksBeforeDelivery: (current, signal, prepare) => delivery.beforeDelivery(current, signal, prepare),
    offerLearnings: async () => {}, previewRelease: async () => { throw new Error("No release declared"); }, head: async current => own(current).state.sha!, patch: async () => patch(), committedCode: async () => ({ versions: versions(), changes: versions() }),
    invalidateAcceptance: async () => { applyAcceptanceVersions(task, versions()); return versions(); }, versions: async () => versions(), acceptanceVersion: async () => patch(),
  });
  phases.deliveryCheckpoint = (current, signal) => checkpoint.run(current, signal);
  const consumeDecision = () => { state.inbox = state.inbox.filter(item => item.taskId !== task.id); task.state = "waiting"; };
  return { ...f, perform, verify, tick, versions, patch, task, scope, evidence, decision, delivery, executions, updates, testerStarts, testerPreparations,
    async drive() {
      task.state = "running";
      f.workflow.startDriver(task.id);
      const running = f.ownership.settling.get(task.id);
      if (!running) throw new Error("Check policy operation was not admitted by its actual driver owner");
      await running;
      if (f.failures.length) throw f.failures[0];
    },
    setChecks(sequence: string, changed = true) {
      configured = sequence; checkIndex = 0;
      if (changed) for (const e of evidence) { const command = `test-product-${++declaration}`; e.declaration.commands.splice(0, e.declaration.commands.length, command); e.state.definition = declaration.toString(16).padStart(64, "0"); e.definition(e.state.definition); }
    },
    unchanged(value = true) { changedBuilds = !value; },
    approve() { assertCheckApproval(task); for (const { work } of scopesFor(task)) { work.approvedSha = work.checkedSha; work.approvedPatch = work.checkedPatch; } consumeDecision(); endYouStep(task, { outcome: "Approved", reason: "Supplied coordinator approval" }, tick()); },
    rerun() { decision.rerun(task); consumeDecision(); },
    requestChanges(text = "Fix the failed welcome check") { const fromCheck = task.stageIndex; endYouStep(task, { outcome: W.changes, reason: W.changesAsked, tone: "back" }, tick()); consumeDecision(); afterChangesAsked(task, "delivery", text, tick(), state.roles); prepareDeliveryReturn(routing, executionFor(task), { note: text, fromCheck, now: tick() }); },
    decisions: () => state.inbox.filter(item => item.taskId === task.id && item.kind === "delivery"),
    starts: (roleId: string) => agents.received().filter(prompt => prompt.roleId === roleId),
    checkSteps: () => task.journey?.filter(step => step.work === "checks") ?? [],
  };
}
