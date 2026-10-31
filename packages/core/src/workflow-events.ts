// Compact workflow facts and the events their changes produce. The engine compares a task's facts on
// every recorded change, before a batched save or retirement can hide a transition. The facts are small
// projections of the journey, inbox and delivery records that already exist, never another account of
// workflow state: routine tool actions, streamed text, progress wording and clocks are left out, so an
// unchanged save produces nothing.

import type { Id, TaskState } from "./model.js";
import { publishingResult, publishingWords, type PublishingFacts, type PublishingResult } from "./publishing-result.js";
export { publishingResult, publishingWords, type PublishingFacts, type PublishingResult };
import { copyNoLongerNeeded } from "./cleanup.js";
import { displayTask } from "./repositories.js";
import {
  claimsUnderTest, eventInvolvesProduct, previousParticipant, resultSeatOf, reviewClaimIds, reviewEnd, reviewRoundSteps,
  same, seatOf, workflowFacts, EVENT_FINDING_IDS, EVENT_MANIFEST_ENTRIES, WORKFLOW_EVENT_KINDS,
  type FindingFacts, type InboxFacts, type NodeFacts, type WaitKind,
  type WorkflowContext, type WorkflowEvent, type WorkflowEventDraft, type WorkflowEventKind, type WorkflowFacts,
} from "./workflow-facts.js";
import { checkBasisFor, emitNodeChecksAndEnd, LEGACY_KINDS, type FindingBaseline } from "./workflow-node-checks.js";
export type { FindingBaseline };
export {
  eventInvolvesProduct, resultSeatOf, reviewClaimIds, reviewRoundSteps, seatOf, workflowFacts,
  EVENT_FINDING_IDS, EVENT_MANIFEST_ENTRIES, WORKFLOW_EVENT_KINDS,
  type WaitKind, type WorkflowContext, type WorkflowEvent, type WorkflowEventDraft, type WorkflowEventKind, type WorkflowFacts,
};

// ── Events from changed facts ──────────────────────────────────────────

/**
 * Why the work went back to the Builder. An explicit shared repair names its own kind; otherwise the step that ended
 * last sent it back. A checks run, or the handoff of an unchanged tree's saved failure, is a check repair. A handoff
 * with no recorded failure sends nothing back, and with no step at all the kind is unknown: neither is guessed.
 */
function repairKind(repair: WorkflowFacts["repair"], cause: NodeFacts | undefined, roles: WorkflowContext["roles"]): string | undefined {
  if (repair) return repair.kind;
  if (!cause) return undefined;
  if (cause.kind === "petrina" && cause.work === "check-reuse") return cause.reusedFailed ? "checks" : undefined;
  if (cause.kind === "petrina" && cause.work === "checks") return "checks";
  if (cause.kind === "agent" && roles.find((role) => role.id === cause.roleId)?.result === "checks") return "acceptance";
  return cause.kind === "you" ? "changes" : "review";
}

/**
 * A request can leave the inbox one change before its answer or decision is recorded on the journey. Such a
 * removal is carried to the next observation of the task, where the recorded decision names it; a removal
 * that nothing records by then is reported as handled.
 */
export type DeferredRemovals = Map<Id, InboxFacts>;

export function workflowEvents(prev: WorkflowFacts | undefined, next: WorkflowFacts, ctx: WorkflowContext, baselines: Map<Id, FindingBaseline>, deferred: DeferredRemovals = new Map()): WorkflowEventDraft[] {
  const drafts: WorkflowEventDraft[] = [];
  const carried = [...deferred.values()];
  deferred.clear();
  const settledItems = new Set<Id>();
  const base = { taskId: next.id, productIds: next.productIds };
  const push = (draft: Omit<WorkflowEventDraft, "taskId" | "productIds">) => drafts.push({ ...base, ...draft } as WorkflowEventDraft);
  const roleName = (id: Id | undefined) => (id ? ctx.roles.find((role) => role.id === id)?.name ?? id : "Agent");
  const before: WorkflowFacts = prev ?? {
    ...next,
    state: next.state,
    nodes: [],
    inbox: [],
    works: [],
    findings: [],
    capacityRetries: [],
    agents: [],
    waitKind: undefined
  };
  if (!prev) push({
    at: ctx.now,
    kind: "task.created",
    summary: `Task created: “${next.title}” (${next.state})`,
    state: next.state,
    title: next.title,
    ...(next.combinedFrom ? { combinedFrom: next.combinedFrom } : {})
  });

  // Task state and waits.
  if (prev && prev.state !== next.state) {
    const terminal = next.state === "done" || next.state === "cancelled";
    push({
      at: ctx.now,
      kind: "task.state",
      summary: `${prev.state} → ${next.state}: ${next.statusLine}`,
      from: prev.state,
      to: next.state,
      column: next.column,
      reason: next.statusLine,
      ...(next.waitKind ? { wait: next.waitKind } : {}),
      ...(next.error ? { error: next.error } : {}),
      ...(terminal ? { terminal: true } : {})
    });
  } else if (prev && next.state === "waiting" && prev.waitKind !== next.waitKind && next.waitKind) {
    push({ at: ctx.now, kind: "task.waiting", summary: `Waiting (${next.waitKind}): ${next.statusLine}`, wait: next.waitKind, reason: next.statusLine });
  }
  if (next.state === "waiting" && next.runtimeWait?.held && (prev?.state !== "waiting" || !same(prev.runtimeWait, next.runtimeWait))) {
    // The kind comes from the saved prerequisite facts, never a classifier over the coordinator's words.
    const alreadyReported = drafts.some((event) => event.kind === "task.waiting");
    const detail = {
      wait: next.waitKind,
      reason: next.runtimeWait.reason,
      prerequisites: next.runtimeWait.prerequisites,
      phase: next.runtimeWait.phase,
      decisionNeeded: next.runtimeWait.decisionNeeded
    };
    if (alreadyReported) Object.assign(drafts.find((event) => event.kind === "task.waiting")!, detail);
    else push({ at: ctx.now, kind: "task.waiting", summary: next.statusLine, ...detail });
  }
  // Entering the check line, becoming held and keeping a place through a pause each say so once, in the card's words.
  if (next.checkWait && prev?.checkWait?.phase !== next.checkWait.phase) {
    const { line, ...activity } = next.checkWait;
    const detail = { wait: "checks" as const, checkActivity: activity };
    const drafted = drafts.find((event) => event.kind === "task.state" || event.kind === "task.waiting");
    if (drafted) Object.assign(drafted, detail);
    else push({ at: ctx.now, kind: "task.waiting", summary: line, reason: line, ...detail });
  }
  for (const retry of next.capacityRetries) {
    const earlier = before.capacityRetries.find((entry) => entry.key === retry.key)?.tried ?? 0;
    if (retry.tried > earlier) push({
      at: ctx.now,
      kind: "retry",
      summary: `Same-conversation retry ${retry.tried} after the selected model was at capacity (${retry.key.split("|")[1]})`,
      retryKind: "capacity",
      profileId: retry.key.split("|")[1],
      tried: retry.tried
    });
  }
  if (prev && (!prev.fixing && next.fixing || (next.repair && !same(prev.repair, next.repair) && next.repair.index === 0))) {
    const cause = [...next.nodes].reverse().find((node) => node.endedAt !== undefined);
    const work = next.works.find((entry) => entry.productId === (next.repair?.products[0] ?? next.productIds[0]));
    const kind = repairKind(next.repair, cause, ctx.roles);
    push({
      at: ctx.now,
      kind: "repair.returned",
      summary: `Back to the builder${kind ? ` (${kind})` : ""}: ${cause?.reason ?? cause?.outcome ?? next.statusLine}`,
      ...(kind ? { repairKind: kind } : {}),
      ...(cause ? { cause: {
      nodeId: cause.id,
      reason: cause.reason ?? cause.outcome,
      kind: cause.kind === "petrina" ? cause.work : cause.roleId ?? cause.waitsFor
    } } : {}),
      allowance: {
      checkReturns: work?.checkReturns ?? 0,
      acceptanceReturns: work?.acceptanceReturns ?? 0,
      limit: 2
    },
      ...(next.repair ? { products: next.repair.products } : {})
    });
  }

  // Journey nodes: starts, seats, checks, asks and ends.
  for (const node of next.nodes) {
    const old = before.nodes[node.index];
    const fresh = !old || old.id !== node.id;
    const isNew = fresh && !node.legacy;
    const role = node.roleId ? ctx.roles.find((entry) => entry.id === node.roleId) : undefined;
    const at = { nodeId: node.id, ...(node.stageId ? { stageId: node.stageId } : {}) };
    if (isNew) {
      if (!baselines.has(node.id)) baselines.set(
        node.id,
        baselines.get(node.reviewSteps?.[0] ?? node.id) ?? {
        findings: next.findings.map((finding) => ({ ...finding })),
        since: "node-start",
        claims: claimsUnderTest(
        next,
        node,
        ctx.roles
      )
      }
      );
      const checkBasis = node.kind === "agent" && (role?.result === "checks" || role?.result === "findings" || role?.result === "votes") ? checkBasisFor(
        next,
        node
      ) : undefined;
      // A check run's recorded reason explains it better than the step that happened to end before it.
      const why = node.checkReasons?.[0];
      push({
        at: node.startedAt,
        kind: "node.started",
        summary: `${node.name} started${why ? `: ${why.words}` : node.trigger?.reason ? `: ${node.trigger.reason}` : ""}`,
        ...(why ? { checkReason: why } : {}),
        ...at,
        nodeKind: node.kind,
        ...(node.roleId ? { roleId: node.roleId } : {}),
        ...(node.profileId ? { profileId: node.profileId } : {}),
        ...(node.team ? { team: node.team } : {}),
        ...(node.seats ? { seats: node.seats } : {}),
        round: node.round,
        ...(node.fixing ? {
        fixing: true,
        ...(node.findingIds ? {
        findingIds: node.findingIds,
        findingCount: node.findingIds.length
      } : {})
      } : {}),
        ...(node.update ? { update: true } : {}),
        ...(node.port ? { port: true } : {}),
        ...(node.call ? { call: true } : {}),
        ...(node.work ? { work: node.work } : {}),
        ...(node.waitsFor ? { waitsFor: node.waitsFor } : {}),
        ...(node.waitsOn ? { waitsOn: node.waitsOn } : {}),
        ...(node.trigger ? { cause: {
        ...(node.trigger.after ? { nodeId: node.trigger.after } : {}),
        reason: node.trigger.reason
      } } : {}),
        ...(checkBasis ? { checks: checkBasis } : {}),
        refs: {
        node: {
        taskId: next.id,
        nodeId: node.id
      },
        ...(node.reviewInput ? { reviewInput: {
        taskId: next.id,
        nodeId: node.id
      } } : {})
      }
      });
    }
    for (const input of node.inputs) {
      const known = !fresh && old!.inputs[input.index];
      if (known) continue;
      const previous = previousParticipant(node, input, next.nodes);
      const replaced = previous && previous.input.profileId !== input.profileId ? previous.input : undefined;
      const limit = replaced ? ctx.limited?.find((entry) => {
        const profile = ctx.profiles.find((candidate) => candidate.id === replaced.profileId);
        return !!profile && entry.toolId === profile.toolId && (!entry.model || profile.model.toLowerCase().includes(entry.model.toLowerCase()));
      }) : undefined;
      // The read selects the seat and its attempt, oldest first, independent of the node's other seats.
      const seatRef = { taskId: next.id, nodeId: node.id, seat: input.seat, index: input.attempt - 1 };
      push({
        at: input.at ?? node.startedAt, kind: "seat.started", ...at, seat: input.seat, attempt: input.attempt,
        summary: `${roleName(input.roleId)} (${input.seat}) started on ${input.profileId}${input.requestedProfileId && input.requestedProfileId !== input.profileId ? ` instead of ${input.requestedProfileId}` : ""}: ${input.mode === "resumed" ? "resumed its interrupted conversation" : input.mode === "continued" ? "continued its conversation" : input.freshReason ? `fresh conversation (${input.freshReason})` : "fresh conversation"}${input.readiness ? `; readiness recheck ${input.readiness.check}, ${input.readiness.outcome === "no answer" ? "no answer in time" : input.readiness.outcome}` : ""}${node.trigger?.reason ? `; after: ${node.trigger.reason}` : ""}`,
        roleId: input.roleId, profileId: input.profileId, ...(input.requestedProfileId ? { requestedProfileId: input.requestedProfileId } : {}), ...(input.selectionReason ? { selectionReason: input.selectionReason } : {}),
        mode: input.mode, ...(input.freshReason ? { freshReason: input.freshReason } : {}), ...(input.readiness ? { readiness: input.readiness } : {}), ...(input.sessionId ? { conversation: input.sessionId } : {}), ...(input.confirmedSettings ? { confirmedSettings: input.confirmedSettings } : {}),
        ...(node.builderConversation ? { builderConversation: node.builderConversation } : {}),
        ...(input.productId ? { productId: input.productId } : {}),
        ...(input.stepAttempts !== undefined ? { stepAttempts: input.stepAttempts } : {}),
        ...(node.trigger ? { cause: { ...(node.trigger.after ? { nodeId: node.trigger.after } : {}), reason: node.trigger.reason } } : {}),
        ...(input.exact ? { exact: input.exact } : { exact: null }),
        ...(input.manifest ? {
          manifest: input.manifest,
          manifestTotal: input.manifestTotal,
          ...(input.manifestTotal! > input.manifest.length ? { manifestShortened: true } : {})
        } : { manifest: null }),
        taskDescriptionIncluded: input.taskDescription,
        versions: input.versions ?? null,
        ...(input.reviewInput ? { reviewInput: input.reviewInput } : {}),
        ...(replaced ? { replaced: {
          nodeId: previous!.nodeId,
          seat: input.seat,
          attempt: replaced.attempt,
          previousProfileId: replaced.profileId,
          ...(replaced.sessionId ? { conversation: replaced.sessionId } : {}),
          ...(limit ? { reason: limit.reason } : input.selectionReason ? { reason: input.selectionReason } : {})
        } } : {}),
        refs: {
          ...(input.reviewInput ? { reviewInput: {
          taskId: next.id,
          nodeId: node.id
        } } : {}),
          input: seatRef,
          manifest: {
          ...seatRef,
          section: "manifest"
        },
          conversation: {
          taskId: next.id,
          nodeId: node.id
        }
        },
      });
      if (replaced) push({
        at: input.at ?? node.startedAt,
        kind: "profile.replaced",
        ...at,
        seat: input.seat,
        attempt: input.attempt,
        summary: `${roleName(input.roleId)} (${input.seat}): ${replaced.profileId} replaced by ${input.profileId}${limit ? ` (${limit.reason})` : input.selectionReason ? ` (${input.selectionReason})` : ""}`,
        previousNodeId: previous!.nodeId,
        previousAttempt: replaced.attempt,
        ...(replaced.sessionId ? { previousConversation: replaced.sessionId } : {}),
        previousProfileId: replaced.profileId,
        profileId: input.profileId,
        ...(limit ? {
        reason: limit.reason,
        limitUntil: limit.until
      } : input.selectionReason ? { reason: input.selectionReason } : {}),
        refs: {
        input: seatRef,
        previousInput: {
        taskId: next.id,
        nodeId: previous!.nodeId,
        seat: replaced.seat,
        index: replaced.attempt - 1
      }
      }
      });
    }
    for (const result of node.results) {
      if (!fresh && old!.results[result.index]) continue;
      const seatInput = result.inputIndex !== undefined ? node.inputs[result.inputIndex] : node.inputs.findLast((input) => input.seat === result.seat && (input.at ?? 0) <= result.at);
      push({
        at: result.at,
        kind: "seat.finished",
        ...at,
        seat: result.seat,
        ...(seatInput ? { attempt: seatInput.attempt } : {}),
        summary: `${roleName(result.roleId)} (${result.seat}) handed back: ${result.summary}${role?.result === "build" ? " (automated checks are a separate step)" : ""}`,
        roleId: result.roleId,
        profileId: result.profileId,
        ...(result.productId ? { productId: result.productId } : {}),
        ...(result.versions ? { versions: result.versions } : {}),
        ...(result.findingCopies !== undefined ? { findingCopies: result.findingCopies } : {}),
        ...(result.images ? { images: result.images } : {}),
        refs: {
        result: {
        taskId: next.id,
        nodeId: node.id,
        index: result.index
      },
        ...(result.findingCopies ? { findings: {
        taskId: next.id,
        nodeId: node.id,
        result: result.index
      } } : {})
      }
      });
    }
    emitNodeChecksAndEnd({
      node,
      fresh,
      old,
      role,
      at,
      before,
      next,
      ctx,
      baselines,
      carried,
      settledItems,
      push,
    });
  }

  // Coordinator requests, including kinds with no journey step of their own.
  for (const item of next.inbox) {
    if (before.inbox.some((entry) => entry.id === item.id)) continue;
    const node = [...next.nodes].reverse().find((entry) => entry.asks.some((ask) => ask.id === item.id)) ?? [...next.nodes].reverse().find((entry) => entry.endedAt === undefined);
    push({
      at: item.at,
      kind: "coordinator.request",
      ...(node ? { nodeId: node.id } : {}),
      summary: `Needs you (${item.kind}): ${item.title}`,
      requestKind: item.kind,
      itemId: item.id,
      title: item.title,
      blocking: item.blocking,
      ...(item.roleId ? { roleId: item.roleId } : {}),
      ...(item.profileId ? { profileId: item.profileId } : {}),
      ...(item.reviewKey ? { seat: item.reviewKey } : {}),
      ...(item.productId ? { productId: item.productId } : {}),
      ...(node?.trigger || node?.reason ? { cause: {
      nodeId: node.id,
      reason: node.reason ?? node.trigger?.reason
    } } : {}),
      refs: { request: { itemId: item.id } }
    });
  }
  const handled = (item: InboxFacts) => push({
    at: ctx.now,
    kind: "coordinator.decision",
    summary: `${item.kind} request handled: ${item.title}`,
    requestKind: item.kind,
    itemId: item.id,
    how: next.state === "cancelled" ? "cancelled" : next.state === "paused" ? "withdrawn" : "handled",
    title: item.title
  });
  for (const item of before.inbox) {
    if (next.inbox.some((entry) => entry.id === item.id) || settledItems.has(item.id)) continue;
    // Its answer or decision may be recorded in the very next change: wait for that one observation.
    const askOpen = (item.kind === "question" || item.kind === "permission") && next.nodes.some((node) => node.asks.some((ask) => ask.id === item.id && ask.endedAt === undefined));
    const gateOpen = LEGACY_KINDS[item.kind] !== undefined && next.nodes.some((node) => node.kind === "you" && node.waitsFor === LEGACY_KINDS[item.kind] && node.endedAt === undefined);
    if ((askOpen || gateOpen) && next.state !== "cancelled" && next.state !== "done") deferred.set(item.id, item);
    else handled(item);
  }
  for (const item of carried) if (!settledItems.has(item.id) && !next.inbox.some((entry) => entry.id === item.id)) handled(item);

  // Publishing results, per product, through the existing delivery rules.
  for (const work of next.works) {
    const earlier = before.works.find((entry) => entry.productId === work.productId);
    if (earlier && same(earlier.result, work.result)) continue;
    if (!earlier && work.result.kind === "pending") continue;
    push({
      at: ctx.now,
      kind: "publishing.result",
      productId: work.productId,
      summary: `${work.productName}: ${publishingWords(work.result)}`,
      result: work.result,
      delivery: work.delivery,
      landing: next.landing,
      ...(next.shared ? { shared: next.shared } : {}),
      ...(next.state === "cancelled" ? { cancelled: true } : {}),
      products: next.works.map((entry) => ({
      productId: entry.productId,
      result: entry.result
    }))
    });
  }

  // Terminal events keep the final delivery list readable after archival.
  const terminalNow = (next.state === "done" || next.state === "cancelled") && (!prev || (prev.state !== "done" && prev.state !== "cancelled"));
  if (terminalNow) {
    const results = next.works.map((work) => ({ productId: work.productId, productName: work.productName, result: work.result }));
    const published = results.filter((entry) => ["released", "merged", "committed", "pull-request-open", "pull-request-closed"].includes(entry.result.kind));
    push({
      at: ctx.now,
      kind: "task.finished",
      ...(next.finishedAt !== undefined ? { finishedAt: next.finishedAt } : {}),
      summary: next.state === "cancelled" ? `Cancelled${next.combinedInto ? `: combined into ${next.combinedInto}` : published.length ? `; already out: ${published.map((entry) => `${entry.productName} ${publishingWords(entry.result)}`).join("; ")}` : ""}` : `Finished: ${next.history ?? next.landing}${results.length ? ` (${results.map((entry) => `${entry.productName}: ${publishingWords(entry.result)}`).join("; ")})` : ""}`,
      state: next.state,
      landing: next.landing,
      ...(next.shared ? { shared: next.shared } : {}),
      ...(next.history ? { history: next.history } : {}),
      ...(next.combinedInto ? { combinedInto: next.combinedInto } : {}),
      products: results
    });
  }
  const order = {
    "task.created": 0,
    "node.started": 1,
    "seat.started": 2,
    "profile.replaced": 3,
    "extra.queued": 4,
    "extra.started": 5,
    "extra.stopping": 6,
    "extra.held": 6,
    "extra.finished": 6,
    "check.queued": 4,
    "check.started": 5,
    "check.finished": 6,
    "check.reused": 6,
    "seat.finished": 7,
    "node.finished": 8,
    "review.finished": 9,
    "coordinator.decision": 10,
    "coordinator.request": 11,
    "repair.returned": 12,
    "retry": 13,
    "publishing.result": 14,
    "task.waiting": 15,
    "task.state": 15,
    "task.finished": 16
  } as const;
  return drafts.map((
    draft,
    index
  ) => ({
    draft,
    index
  })).sort((
    a,
    b
  ) => a.draft.at - b.draft.at || order[a.draft.kind] - order[b.draft.kind] || a.index - b.index).map(({ draft }) => draft);
}

// ── The observer ───────────────────────────────────────────────────────

/** Keeps each task's last recorded facts and turns changes into events. Finished tasks keep their facts for a while, so later archive edits still compare. */
export class WorkflowObserver {
  private readonly facts = new Map<Id, WorkflowFacts>();
  private readonly baselines = new Map<Id, Map<Id, FindingBaseline>>();
  private readonly deferred = new Map<Id, DeferredRemovals>();
  private readonly finished: Id[] = [];
  constructor(private readonly retainFinished = 200) {}

  /** Record a task's facts without events: the engine's starting state, or an archived task opened for a read. */
  baseline(task: TaskState, ctx: WorkflowContext): void {
    const facts = workflowFacts(task, ctx);
    this.facts.set(task.id, facts);
    // A step already under way keeps the findings it was first observed with, labelled as such.
    this.baselines.set(
      task.id,
      new Map(facts.nodes.filter((node) => node.endedAt === undefined).map((node) => [
      node.id,
      {
      findings: facts.findings.map((finding) => ({ ...finding })),
      since: "engine-start" as const,
      claims: claimsUnderTest(
      facts,
      node,
      ctx.roles
    )
    }
    ]))
    );
    this.retire(task);
  }

  known(taskId: Id): boolean { return this.facts.has(taskId); }

  /** Compare a task with its last recorded facts. A task never seen before is new only while it is unfinished. */
  observe(task: TaskState, ctx: WorkflowContext): WorkflowEventDraft[] {
    const prev = this.facts.get(task.id);
    const finishedTask = task.state === "done" || task.state === "cancelled";
    if (!prev && finishedTask) {
      this.baseline(task, ctx);
      return [];
    }
    const next = workflowFacts(task, ctx);
    const baselines = this.baselines.get(task.id) ?? new Map<Id, FindingBaseline>();
    this.baselines.set(task.id, baselines);
    const deferred = this.deferred.get(task.id) ?? new Map<Id, InboxFacts>();
    this.deferred.set(task.id, deferred);
    const events = workflowEvents(prev, next, ctx, baselines, deferred);
    this.facts.set(task.id, next);
    for (const node of next.nodes) if (node.endedAt !== undefined) {
      if (node.reviewSteps && !reviewEnd(node).examined) continue;
      baselines.delete(node.id);
      for (const id of node.reviewSteps ?? []) baselines.delete(id);
    }
    this.retire(task);
    return events;
  }

  forget(taskId: Id): void {
    this.facts.delete(taskId);
    this.baselines.delete(taskId);
    this.deferred.delete(taskId);
  }

  private retire(task: TaskState): void {
    const queued = this.finished.indexOf(task.id);
    const keep = () => { if (queued >= 0) this.finished.splice(queued, 1); };
    if (task.state !== "done" && task.state !== "cancelled") {
      keep();
      return;
    }
    // The existing cleanup rule retains work that can still change delivery. Its later merge, close or
    // lookup must compare with the facts already observed, regardless of how many settled tasks finish.
    const view = displayTask(task);
    if (!copyNoLongerNeeded(view) || (task.repositories ?? (task.repository ? [task.repository] : [])).some((work) => work.shipping?.step || work.shipping?.carriedOver || work.localUpdate?.pushed === false)) {
      keep();
      return;
    }
    if (!this.finished.includes(task.id)) this.finished.push(task.id);
    while (this.finished.length > this.retainFinished) this.forget(this.finished.shift()!);
  }
}

export type { FindingFacts as WorkflowFindingFacts, PublishingFacts as WorkflowPublishingFacts };
