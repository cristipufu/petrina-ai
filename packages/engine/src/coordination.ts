import { messageRemovalText } from "@petrina/core";
import { checkProblem, displayTask, originalCheck, reviewDecisionPending } from "@petrina/core";
import { executionFor } from "./repository-context.js";
import { finishedTask, involvesProduct, journeyView, mainLine, nextSteps, taskLanding, taskProductIds, timeLeft, workedSoFar, resultSeatOf, type Landing, type Task, type InboxItem, type HistoryQuery } from "@petrina/core";
import type { Engine } from "./engine.js";
import { operation } from "./operations.js";
import { offeredLessons } from "./learnings.js";
import { cursor, fingerprint, paginate, readText } from "./evidence-read.js";
import { checkLogRevision, readCheckLog } from "./check-log-read.js";
import { readConversation } from "./conversation-read.js";
import { readExactInput } from "./exact-input.js";
import { readReviewInput } from "./review-context.js";
import { readAnalytics } from "./analytics-read.js";
import { checkpointView } from "./checkpoint-read.js";

export type Outcome =
  | "completed"
  | "pending"
  | "invalid"
  | "missing"
  | "conflict"
  | "changed"
  | "handled"
  | "timed-out"
  | "failed"
  | "disconnected"
  | "continuity-lost"
  | "superseded"
  | "unavailable";
export interface Result {
  outcome: Outcome;
  message?: string;
  [key: string]: unknown;
}
// Arguments have already passed the named operation's strict schema at the boundary.
type Args = Record<string, any>;
const clone = <T>(value: T): T => structuredClone(value);
const queues = new WeakMap<Engine, Promise<unknown>>();
/** App actions and new decisions share this queue: inspecting a revision and applying it cannot race an edit. */
export function serial<T>(engine: Engine, run: () => T | Promise<T>): Promise<T> {
  const next = (queues.get(engine) ?? Promise.resolve()).then(run);
  queues.set(
    engine,
    next.catch(() => undefined),
  );
  return next;
}

/** Awaiting merge confirms a delivery; only landing proves it landed. */
const deliveryConfirmed = (landing: Landing): boolean => landing === "landed" || landing === "awaiting-merge";

export function taskSummary(engine: Engine, task: Task) {
  // Delivery describes the whole task, whichever product is displayed.
  const landing = taskLanding(task);
  task = displayTask(task);
  const state = engine.activeState();
  return {
    id: task.id,
    productId: task.productId,
    title: task.title,
    state: task.state,
    held: task.held,
    priority: task.priority,
    after: task.after ?? [],
    summary: mainLine(task),
    activity: task.toolActivity ?? null,
    workers: [task.agent, ...(task.helpers ?? [])].filter(Boolean).map(worker => ({ ...worker, activity: worker?.reviewKey ? task.hunt?.work?.[worker.reviewKey]?.toolActivity ?? null : task.toolActivity ?? null })),
    next: nextSteps(state, task) ?? null,
    waitingReason: ["backlog", "waiting", "needs-you", "paused", "queued", "failed"].includes(task.state) ? task.statusLine : null,
    inbox: state.inbox.filter((item) => item.taskId === task.id).map(({ id, kind }) => ({ id, kind })),
    landing,
    delivery: task.delivery,
    deliveryConfirmed: deliveryConfirmed(landing),
    error: task.error?.slice(0, 1000) ?? null,
    errorShortened: (task.error?.length ?? 0) > 1000,
  };
}
export function drainStatus(engine: Engine) {
  const state = engine.activeState();
  const active = state.tasks.filter((task) => engine.settling.has(task.id) || engine.drivers.has(task.id) || task.holdsSlot);
  const blockers = state.inbox
    .filter((item) => active.some((task) => task.id === item.taskId) && (item.blocking || item.kind === "screen"))
    .map(({ id, taskId, kind, title }) => ({ id, taskId, kind, title }));
  // A yielded screen conversation has released its admission. It is saved work waiting to
  // start again, distinct from a screen request still keeping an admitted group open.
  return {
    drained: engine.inFlight() === 0 && blockers.length === 0,
    active: active.slice(0, 100).map((task) => taskSummary(engine, task)),
    activeCount: active.length,
    blockers: blockers.slice(0, 100),
    blockerCount: blockers.length,
    screenWaiting: state.tasks
      .filter((task) => task.screen && !active.some((entry) => entry.id === task.id))
      .slice(0, 100)
      .map((task) => ({ taskId: task.id, reason: task.screen!.reason })),
    queued: state.tasks.filter((task) => task.state === "queued").length,
    waiting: state.tasks.filter((task) => task.state === "waiting").length,
    checkpoints: state.inbox.filter((item) => !item.blocking && ["plan", "design", "delivery", "disagreement"].includes(item.kind)).length,
    pendingParticipants: state.tasks
      .flatMap((task) => {
        const stage = task.plan?.stages[task.stageIndex];
        return stage?.kind === "review-chain" && task.hunt
          ? [
              {
                taskId: task.id,
                stageId: stage.id,
                finishedReviewers: Object.keys(task.hunt.reported),
                waitingReviewers: stage.profileIds.flatMap((profileId, index) => (task.hunt!.reported[String(index)] ? [] : [{ index, profileId }])),
                finishedVoters: Object.keys(task.hunt.voted ?? {}),
                requiredVoters: task.hunt.voterProfiles ?? [],
                waitingVoters: (task.hunt.voterProfiles ?? []).filter(
                  (id) => !Object.keys(task.hunt!.voted ?? {}).some((used) => engine.profile(used)?.toolId === engine.profile(id)?.toolId),
                ),
              },
            ]
          : [];
      })
      .slice(0, 100),
  };
}
export function requestRevision(engine: Engine, item: InboxItem): string {
  const task = engine.taskDetails(item.taskId);
  // Include exactly what a checkpoint confirms, excluding clocks, unrelated activity and conversations.
  return fingerprint({
    item,
    ...(item.kind === "screen" ? { screen: task?.screen } : {}),
    ...(item.kind === "shipping" ? { shipping: task?.shipping, source: task?.source, delivery: task?.delivery } : {}),
    ...(task && ["plan", "design", "delivery", "disagreement"].includes(item.kind)
      ? {
          productId: task.productId,
          title: task.title,
          description: task.description,
          selectedProducts: task.selectedProducts,
          workRows: task.workRows,
          workValidating: task.workValidating,
          approvalExplanation: task.approvalExplanation,
          leadProductId: task.leadProductId,
          acceptance: { passed: task.acceptancePassed, blocked: task.acceptanceBlocked, unverified: task.acceptanceUnverified, testedPatch: task.testedPatch, testedVersions: task.testedVersions },
          diagnostics: checkLogRevision(engine.dataDir, task.id, (task.repositories ?? [task]).flatMap((work) => work.checks?.results.flatMap((run) => [run.logPath, originalCheck(task, run)?.check.run?.logPath]) ?? [])),
          evidence: task.journey?.map(({ id, kind, roleId, endedAt, productChecks, checkAttempts, reuses, reviewInput, agentInputs, agentResults, result, seats }) => ({ id, kind, roleId, endedAt, productChecks, checkAttempts, reuses, reviewInput, agentInputs, agentResults, result, seats })),
          plan: task.plan,
          source: task.source,
          proposedSource: task.proposedSource,
          workChoice: task.workChoice,
          workProposal: task.workProposal,
          workProduct: task.workProduct,
          workError: task.workError,
          confirmWork: task.confirmWork,
          delivery: task.delivery,
          approveDelivery: task.approveDelivery,
          brief: task.brief,
          objections: task.objections,
          call: task.call,
          findings: task.findings,
          reviewDecision: task.reviewDecision,
          repositories: task.repositories?.map((work) => ({ productId: work.productId, source: work.source, workChoice: work.workChoice, delivery: work.delivery, checkedSha: work.checkedSha, checkedPatch: work.checkedPatch, checks: work.checks })),
          checkedSha: task.checkedSha,
          checkedPatch: task.checkedPatch,
          checks: task.checks,

          stageIndex: task.stageIndex,
        }
      : {}),
  });
}
const decisions = (kind: string, task?: Pick<Task, "repositories" | "checks" | "reviewDecision">) =>
  kind === "question"
    ? ["inbox.answer"]
    : kind === "permission"
      ? ["inbox.allow", "inbox.deny"]
      : kind === "stuck"
        ? ["inbox.retry"]
        : kind === "shipping"
          ? ["inbox.recovery"]
          : kind === "screen"
            ? ["screen.allow"]
            : kind === "learnings"
              ? ["learning.accept", "learning.decline"]
              : kind === "guide"
                ? ["review-guide.accept", "review-guide.decline"]
                : kind === "delivery" && task && !reviewDecisionPending(task) && checkProblem(task)
                  ? ["inbox.rerun-checks", "inbox.changes"]
                : ["plan", "design", "delivery", "disagreement"].includes(kind)
                  ? ["inbox.approve", "inbox.changes"]
                  : [];

export interface LifecycleControl {
  status(): Result | Promise<Result>;
  request(name: string, args: Args): Result | Promise<Result>;
  receipt?(id: string): Result | undefined;
}
export class Coordination {
  constructor(
    readonly engine: Engine,
    readonly lifecycle?: LifecycleControl,
  ) {
    engine.store.database.run("CREATE TABLE IF NOT EXISTS coordination_receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)");
  }
  /** `signal`: the caller went away or cancelled; a wait releases its subscription and timer at once. */
  async call(name: string, raw: unknown, signal?: AbortSignal): Promise<Result> {
    const spec = operation(name);
    if (!spec) return { outcome: "invalid", message: "Unknown coordination operation. Use help or tools/list." };
    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success) return { outcome: "invalid", message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
    const a: Args = parsed.data;
    if (name === "watch.wait") return this.watch(a, signal);
    if (name === "watch.events") {
      if (a.taskIds && a.productId) return { outcome: "invalid", message: "Choose selected tasks or a product, not both." };
      if (a.productId && !this.engine.s.products.some((product) => product.id === a.productId)) return { outcome: "missing", message: "That product does not exist." };
      // Existence only: a quiet renewal over many archived tasks must never read their complete bodies.
      for (const id of a.taskIds ?? []) if (!this.engine.taskKnown(id)) return { outcome: "missing", message: `Task ${id} does not exist.` };
      return this.engine.events.wait(a, signal);
    }
    if (name.startsWith("engine.")) {
      if (this.lifecycle) return name === "engine.status" ? this.lifecycle.status() : this.lifecycle.request(name.slice(7), a);
      if (name === "engine.status")
        return {
          outcome: "completed",
          status: this.engine.draining ? "draining" : this.engine.s.pool.paused ? "paused" : "running",
          scheduling: this.engine.s.pool.paused ? "paused" : "running",
          boot: this.engine.boot,
          ...drainStatus(this.engine),
        };
    }
    return serial(this.engine, async () => {
      if (!spec.changes) return this.query(name, a);
      if (this.lifecycle?.receipt?.(a.requestId))
        return { outcome: "conflict", requestId: a.requestId, message: "That reference belongs to a lifecycle request." };
      const db = this.engine.store.database;
      const hash = fingerprint([name, a]);
      const old = db
        .query<{ fingerprint: string; result: string }, [string]>("SELECT fingerprint, result FROM coordination_receipts WHERE id = ?")
        .get(a.requestId);
      if (old)
        return old.fingerprint === hash
          ? (JSON.parse(old.result) as Result)
          : { outcome: "conflict", requestId: a.requestId, message: "That request reference was used with different arguments." };
      // Sync decisions and their receipts commit with the state in one database transaction. Async
      // validations are serialized too; the existing commands keep their own saved request identities.
      let result: Result;
      const save = (result: Result) => {
        if (a.itemId && ["completed", "pending"].includes(result.outcome) && !this.engine.s.inbox.some((item) => item.id === a.itemId))
          this.engine.store.noteHandled([a.itemId]);
        this.engine.save();
        db.query("INSERT INTO coordination_receipts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET result=excluded.result").run(
          a.requestId,
          hash,
          JSON.stringify(result),
        );
      };
      const errorResult = (error: unknown): Result => ({
        outcome: "invalid",
        requestId: a.requestId,
        message: error instanceof Error ? error.message : "The operation could not be applied.",
      });
      if (["task.source", "inbox.retry"].includes(name)) {
        // Save submission before asynchronous validation, so a crash never blindly repeats it.
        save({
          outcome: "pending",
          requestId: a.requestId,
          message: "Submitted. Inspect the task before making a new request if the engine stops before its outcome is recorded.",
        });
        try {
          result = { ...(await this.mutate(name, a)), requestId: a.requestId };
        } catch (error) {
          result = errorResult(error);
        }
        db.transaction(() => save(result))();
      } else {
        result = db.transaction(() => {
          let result: Result;
          try {
            result = { ...(this.mutate(name, a) as Result), requestId: a.requestId };
          } catch (error) {
            result = errorResult(error);
          }
          save(result);
          return result;
        })();
      }
      // Task creation and its retry receipt are durable before the first admission pass.
      if (name === "task.add" && result.outcome === "completed") this.engine.schedule();
      return clone(result);
    });
  }
  private async query(name: string, a: Args): Promise<Result> {
    const e = this.engine,
      s = e.activeState();
    if (name === "watch.event") return e.events.log.read(a.eventId, a);
    // Before the shared checks: a continuation reports its read's time even when the task or product is gone.
    if (name === "analytics.inspect") return readAnalytics(e, a as Parameters<typeof readAnalytics>[1]);
    const needsTask = a.taskId && name !== "task.list" && name !== "task.history" && name !== "inbox.list";
    const task = needsTask ? e.taskDetails(a.taskId) : undefined;
    if (needsTask && !task) return { outcome: "missing", message: "That task does not exist." };
    if (name === "inbox.list" && a.taskId && !s.tasks.some((task) => task.id === a.taskId) && !e.store.history.item(a.taskId))
      return { outcome: "missing", message: "That task does not exist." };
    const product = s.products.find((product) => product.id === a.productId);
    if (a.productId && !product && name !== "journey.check") return { outcome: "missing", message: "That product does not exist." };
    if (name === "task.history" || (name === "task.list" && a.states?.some((state: string) => state === "done" || state === "cancelled"))) {
      if (a.states?.some((state: string) => state !== "done" && state !== "cancelled"))
        return { outcome: "invalid", message: "Read current work and finished history separately. Use task.history for done and cancelled tasks." };
      return this.history(a);
    }
    if (name === "task.list")
      return paginate(
        s.tasks
          .filter(
            (t) =>
              !finishedTask(t) &&
              (!a.productId || involvesProduct(t, a.productId)) &&
              (!a.taskId || t.id === a.taskId) &&
              (!a.states || a.states.includes(t.state)) &&
              (a.held === undefined || t.held === a.held) &&
              (!a.search || t.title.toLowerCase().includes(a.search.toLowerCase())),
          )
          .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .map((t) => taskSummary(e, t)),
        a,
        name,
      );
    if (name === "task.inspect") return { outcome: "completed", task: taskSummary(e, task!) };
    if (name === "task.activity") {
      const node = a.nodeId ? task!.journey?.find(node => node.id === a.nodeId) : [...(task!.journey ?? [])].reverse().find(node => node.kind === "agent");
      if (!node) return { outcome: "unavailable", message: "No tool activity was recorded for this step." };
      const records = (node.toolInvocations ?? []).filter(record => !a.seat || record.seat === a.seat);
      const workers = Object.fromEntries(Object.entries(node.toolActivity ?? {}).filter(([seat]) => !a.seat || seat === a.seat));
      return { ...paginate(records, a, [name, a.taskId, node.id, a.seat]), nodeId: node.id, workers,
        actionCount: Object.values(workers).reduce((total, activity) => total + activity.actionCount, 0),
        evidence: node.toolActivity ? "recorded" : "unavailable" };
    }
    if (name === "task.conversation") return readConversation(task!, a);
    if (name === "task.read") {
      if (a.findingId && a.section !== "findings") return { outcome: "invalid", message: "A finding ID selects the findings section only." };
      if (a.findingId && !task!.findings.some((finding) => finding.id === a.findingId)) return { outcome: "missing", message: "That current finding does not exist." };
      return readText(
        (
          {
            request: { title: task!.title, description: task!.description },
            conversation: task!.session,
            timeline: task!.timeline,
            findings: a.findingId ? task!.findings.find((finding) => finding.id === a.findingId) : task!.findings,
            design: task!.brief || task!.objections.length || task!.call ? { brief: task!.brief ?? null, objections: task!.objections, call: task!.call ?? null } : undefined,
            messages: task!.queued,
            source: { source: task!.source, choice: task!.workChoice, proposed: task!.proposedSource, selectedProducts: task!.selectedProducts, rows: task!.workRows },
            error: task!.error,
          } as Record<string, unknown>
        )[a.section],
        a,
        [name, a.taskId, a.section, a.findingId],
      );
    }
    if (name === "plan.inspect") return readText(task!.plan, a, [name, a.taskId], { evidence: task!.plan ? "planned" : "unavailable" });
    if (name === "journey.list" || name === "journey.node") {
      const view = journeyView(task!, s);
      if (name === "journey.list")
        return paginate(
          view.nodes.map((node) => ({
            id: node.id,
            name: node.name,
            kind: node.kind,
            state: node.state,
            evidence: task!.journey?.find((step) => step.id === node.id)?.legacy
              ? "reconstructed"
              : task!.journey?.some((step) => step.id === node.id)
                ? "recorded"
                : "planned",
          })),
          a,
          [name, a.taskId],
        );
      const node = task!.journey?.find((node) => node.id === a.nodeId);
      const planned = view.nodes.find((node) => node.id === a.nodeId);
      if (!node && !planned) return { outcome: "missing", message: "That journey node does not exist." };
      return readText(node ?? planned, a, [name, a.taskId, a.nodeId], {
        evidence: node ? (node.legacy ? "reconstructed" : "recorded") : "planned",
        input: node?.agentInputs ? "recorded" : "unavailable",
        result: node?.agentResults || node?.result ? "recorded" : "unavailable",
        trigger: node?.trigger ?? null,
        triggerEvidence: node?.trigger ? "recorded" : "unavailable",
        reviewInput: node?.reviewInput ? { digest: node.reviewInput.digest, read: { taskId: task!.id, nodeId: node.id } } : null,
      });
    }
    if (name === "journey.check") return readCheckLog(e.dataDir, task!, { nodeId: a.nodeId, productId: a.productId, index: a.index, section: a.section, cursor: a.cursor, limit: a.limit, ifRevision: a.ifRevision });
    if (name === "journey.review-input") {
      const node = task!.journey?.find((step) => step.id === a.nodeId);
      if (!node) return { outcome: "missing", message: "That journey node does not exist." };
      const ref = node.reviewInput;
      if (!ref) return { outcome: "unavailable", message: "This node recorded no blind-review snapshot reference." };
      return readReviewInput(ref).then((input) => readText(a.section === "findings" ? input.findings : a.section === "versions" ? ref.heads : input, a, [name, task!.id, node.id, ref.digest, a.section], { evidence: "recorded", digest: ref.digest }), (error) => ({ outcome: /changed/.test(String(error)) ? "changed" : "unavailable", message: "The saved blind-review evidence is missing or changed. No newer evidence is substituted." }));
    }
    if (name === "journey.input") return readExactInput(task!, s.roles, a as Parameters<typeof readExactInput>[2]);
    if (name === "journey.result" || name === "journey.finding") {
      const node = task!.journey?.find((node) => node.id === a.nodeId);
      if (!node) return { outcome: "missing", message: "That journey node does not exist." };
      const results = (node.agentResults ?? []).map((result, index) => ({ result, index, seat: resultSeatOf(node, result, s.roles, task!) }));
      if (name === "journey.result") {
        const chosen = a.index !== undefined ? results[a.index] : [...results].reverse().find((entry) => !a.seat || entry.seat === a.seat);
        if (!chosen || (a.seat && chosen.seat !== a.seat)) return { outcome: "unavailable", message: "No accepted result is recorded for that seat on this node." };
        const { value, images, findings: _findings, ...rest } = chosen.result;
        return readText(value, a, [name, a.taskId, a.nodeId, chosen.index], { seat: chosen.seat, index: chosen.index, ...rest, images: images?.map(({ id, caption }) => ({ id, caption })) ?? [], findingCopies: chosen.result.findings?.length ?? 0, evidence: "recorded" });
      }
      const copy = a.result !== undefined ? results[a.result]?.result.findings : node.result?.findings;
      if (a.result !== undefined && !results[a.result]) return { outcome: "missing", message: "That result does not exist on this node." };
      if (!copy) return { outcome: "unavailable", message: a.result !== undefined ? "That result saved no finding copies." : "This node recorded no finding copies." };
      const finding = copy.find((entry) => entry.id === a.findingId);
      if (!finding) return { outcome: "missing", message: "That finding is not in this recorded copy. A newer record is never substituted." };
      return readText(finding, a, [name, a.taskId, a.nodeId, a.result, a.findingId], { findingId: a.findingId, copy: a.result !== undefined ? { kind: "seat-result", result: a.result, seat: results[a.result]!.seat } : { kind: "node" }, evidence: "recorded" });
    }
    if (name === "task.health") return this.health(task!);
    if (name === "inbox.list")
      return paginate(
        this.inbox(a).map(({ id, taskId, kind, title, blocking, at }) => ({ id, taskId, kind, title, blocking, at })),
        a,
        name,
      );
    if (["inbox.inspect", "learning.inspect", "review-guide.inspect"].includes(name)) {
      const item = s.inbox.find((item) => item.id === a.itemId);
      if (!item) return { outcome: "missing", message: "That request is no longer in the inbox." };
      const expected = name === "learning.inspect" ? "learnings" : name === "review-guide.inspect" ? "guide" : item.kind;
      if (item.kind !== expected) return { outcome: "invalid", message: `That is a ${item.kind} request.` };
      const revision = requestRevision(e, item);
      const t = e.taskDetails(item.taskId);
      return readText(
        t && ["plan", "design", "delivery", "disagreement"].includes(item.kind) ? JSON.stringify(await checkpointView(e, t, item), null, 1) : {
          request: item,
          ...(item.kind === "learnings"
            ? {
                lessons: offeredLessons(item.body).map((text, position) => ({ position, text })),
              }
            : {}),
        },
        a,
        [name, item.id, revision],
        { itemId: item.id, kind: item.kind, revision, decisions: decisions(item.kind, t), recommendation: item.options?.[0] ?? null, choices: item.options ?? [] },
      );
    }
    if (name === "product.list")
      return paginate(
        s.products
          .map(({ id, name, repo, delivery, approveDelivery }) => ({ id, name, repo, delivery, approveDelivery }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        a,
        name,
      );
    if (name === "product.inspect") return readText(product, a, [name, a.productId]);
    if (name === "pool.inspect") return { outcome: "completed", pool: s.pool, ...drainStatus(e) };
    if (name === "tools.inspect")
      return readText({ tools: s.tools, checks: s.setup?.checks, profiles: s.profiles, caps: s.pool.toolCaps, usage: s.pool.usage }, a, name);
    if (name === "screen.inspect")
      return {
        allowance: s.pool.screen ?? { mode: "off" },
        ...paginate(
          s.tasks.filter((t) => t.screen).map((t) => ({ taskId: t.id, screen: t.screen, allowed: t.screenAllowed })),
          a,
          [name, s.pool.screen],
        ),
      };
    return { outcome: "invalid", message: "This read is not available." };
  }
  private history(a: Args): Result {
    const e = this.engine;
    const request: HistoryQuery = { productId: a.productId, taskId: a.taskId, states: a.states, held: a.held, query: a.search, limit: a.limit };
    // The engine flushes newly finished work before this indexed, lightweight read.
    let page = e.historyPage(request);
    const key = fingerprint(["task.history", request.productId, request.taskId, request.states, request.held, request.query, e.store.history.info().revision]);
    if (a.cursor) {
      let after: string;
      try {
        const saved = JSON.parse(Buffer.from(a.cursor, "base64url").toString());
        if (saved.key !== key || typeof saved.after !== "string") throw new Error();
        after = saved.after;
        page = e.historyPage({ ...request, cursor: after });
      } catch {
        return { outcome: "changed", message: "This history page changed or expired. Read finished history again from the beginning." };
      }
    }
    return {
      outcome: "completed",
      items: page.items.map((item) => { const landing = taskLanding(item); return { ...item, summary: item.statusLine, landing, deliveryConfirmed: deliveryConfirmed(landing) }; }),
      total: page.total,
      ...(page.nextCursor ? { next: cursor({ key, after: page.nextCursor }) } : {}),
    };
  }
  private inbox(a: Args) {
    const state = this.engine.activeState();
    return state.inbox
      .filter((item) => {
        if (a.productId) {
          const task = state.tasks.find((task) => task.id === item.taskId);
          const archived = task ? undefined : this.engine.store.history.item(item.taskId);
          const products = task ? taskProductIds(task) : archived?.productIds ?? (archived ? [archived.productId] : []);
          if (!products.includes(a.productId)) return false;
        }
        return (
          (!a.taskId || item.taskId === a.taskId) &&
          (!a.kinds || a.kinds.includes(item.kind)) &&
          (a.blocking === undefined || item.blocking === a.blocking) &&
          (!a.search || item.title.toLowerCase().includes(a.search.toLowerCase()))
        );
      })
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }
  private mutate(name: string, a: Args): Result | Promise<Result> {
    const e = this.engine;
    if (a.productId && !e.s.products.some((product) => product.id === a.productId)) return { outcome: "missing", message: "That product does not exist." };
    const t = a.taskId ? e.task(a.taskId) : undefined;
    if (a.taskId && !t) return { outcome: "missing", message: "That task does not exist." };
    const done = (more: Record<string, unknown> = {}): Result => ({ outcome: "completed", ...more });
    const unavailable = (message: string): Result => ({ outcome: "invalid", message });
    if (a.itemId) {
      const item = e.s.inbox.find((item) => item.id === a.itemId);
      if (!item)
        return {
          outcome: e.store.handled(a.itemId) ? "handled" : "missing",
          message: e.store.handled(a.itemId) ? "That request was already handled." : "That request does not exist.",
        };
      const itemTask = e.task(item.taskId);
      if (!itemTask || (["learnings", "guide"].includes(item.kind) && !e.productOf(itemTask)))
        return { outcome: "missing", message: "This request's task or product is no longer available." };
      if (requestRevision(e, item as InboxItem) !== a.revision)
        return { outcome: "changed", message: "The request changed. Inspect it again before deciding." };
      if (!decisions(item.kind, { repositories: itemTask.repositories, checks: executionFor(itemTask).work.checks, reviewDecision: itemTask.reviewDecision }).includes(name)) return unavailable(`That is a ${item.kind} request. Use its available decisions.`);
      switch (name) {
        case "inbox.answer":
          e.answer(a.itemId, a.answer, { clientId: a.requestId });
          break;
        case "inbox.allow":
          e.allow(a.itemId, "once");
          break;
        case "inbox.deny":
          e.deny(a.itemId, a.note, { clientId: a.requestId });
          break;
        case "inbox.approve":
          e.approve(a.itemId);
          break;
        case "inbox.changes":
          e.requestChanges(a.itemId, a.note);
          break;
        case "inbox.rerun-checks":
          e.rerunChecks(a.itemId);
          break;
        case "inbox.retry":
          return e
            .retry(a.itemId)
            .then(() =>
              e.s.inbox.some((item) => item.id === a.itemId) ? { outcome: "pending", message: "Retry checked the tool; the request is still open." } : done(),
            );
        case "inbox.recovery":
          if (a.decision === "check" && executionFor(itemTask).work.shipping?.carriedOver)
            return unavailable("Petrina cannot automatically check this older delivery. Inspect GitHub, then choose ship again or mark done.");
          if (a.decision === "check") e.checkShipping(a.itemId);
          else if (a.decision === "ship-again") e.shipAgain(a.itemId);
          else e.markDone(a.itemId);
          return {
            outcome: "pending",
            message: a.decision === "mark-done" ? "Marked done; delivery remains unconfirmed." : "Recovery decision accepted; inspect the task for its result.",
          };
        case "learning.accept": {
          const count = offeredLessons(item.body).length;
          if (!a.positions.length || a.positions.some((p: number) => p >= count) || new Set(a.positions).size !== a.positions.length)
            return unavailable("Select one or more valid zero-based lesson positions from this offer.");
          e.addLessons(a.itemId, a.positions);
          break;
        }
        case "learning.decline":
        case "review-guide.decline":
          e.decline(a.itemId);
          break;
        case "review-guide.accept":
          if (!item.body?.trim()) return unavailable("This proposal has no point to accept.");
          e.approve(a.itemId);
          break;
        case "screen.allow":
          if (!itemTask.screen || itemTask.screen.allowed || itemTask.screen.granted)
            return unavailable("This task has no screen request still needing permission.");
          e.allowScreen(item.taskId);
          return { outcome: "pending", message: "Screen request allowed; existing screen and pool rules still apply." };
      }
      return done({ itemId: a.itemId });
    }
    switch (name) {
      case "engine.pause":
        e.setPoolPaused(true);
        return done({ ...drainStatus(e) });
      case "engine.resume":
        e.setPoolPaused(false);
        return done();
      case "task.add": {
        const { requestId, ...input } = a;
        const taskId = e.addTask({ ...input, clientId: requestId } as Parameters<Engine["addTask"]>[0], false);
        return done({ taskId });
      }
      case "task.queue":
        if (t!.state !== "backlog") return unavailable("Only backlog requests can be queued for work.");
        e.queueTask(a.taskId);
        break;
      case "task.backlog":
        if (t!.state !== "queued" || t!.startedAt !== undefined) return unavailable("Only queued tasks that have never started can return to backlog.");
        e.moveToBacklog(a.taskId);
        break;
      case "task.update-backlog":
        if (t!.state !== "backlog") return unavailable("Only backlog requests can be edited before work starts.");
        e.updateBacklog(a.taskId, { title: a.title, description: a.description });
        break;
      case "task.hold":
      case "task.unhold":
        if (t!.state !== "queued") return unavailable("Only queued tasks can be held or released.");
        e.setHeld(a.taskId, name === "task.hold");
        break;
      case "task.pause":
        if (!["running", "needs-you", "waiting"].includes(t!.state)) return unavailable("This task cannot be paused in its current state.");
        e.pause(a.taskId);
        break;
      case "task.resume":
        if (t!.state !== "paused") return unavailable("This task is not paused.");
        e.resume(a.taskId);
        break;
      case "task.cancel":
        if (["done", "cancelled"].includes(t!.state)) return unavailable("This task has already finished or been cancelled.");
        e.cancel(a.taskId);
        break;
      case "task.dependencies":
        e.setAfter(a.taskId, a.after);
        break;
      case "task.reorder":
        if (t!.state !== "queued") return unavailable("Only queued tasks can be reordered.");
        if (a.anchorId && a.side) {
          if (e.placeInQueue(a.taskId, a.anchorId, a.side) < 0) return unavailable("Choose a different queued task as the reorder anchor.");
        } else if (a.position !== undefined) e.moveInQueue(a.taskId, a.position);
        else return unavailable("Supply a position, or an anchor and side.");
        break;
      case "task.source":
        return e.setTaskStart(a.taskId, a.choice).then(() => t!.workError ? { ...unavailable(t!.workError), taskId: a.taskId } : done({ taskId: a.taskId }));
      case "task.message": {
        if (["done", "cancelled"].includes(t!.state)) return unavailable("This task has finished.");
        const messageId = e.sendMessage(a.taskId, a.text, a.mode, a.requestId);
        if (!messageId) return unavailable("The message was not queued. Supply text and a new request reference.");
        return done({ taskId: a.taskId, messageId });
      }
      case "task.remove-message": {
        const queued = t!.queued.find((m) => m.id === a.messageId);
        if (!queued) return unavailable("That message is no longer queued.");
        const kept = messageRemovalText(queued);
        if (kept) return unavailable(kept);
        e.removeQueued(a.taskId, a.messageId);
        break;
      }
      case "plan.assign":
      case "plan.add-reviewer": {
        const at = t!.plan?.stages.findIndex((s) => s.id === a.stageId) ?? -1,
          stage = t!.plan?.stages[at];
        if (!stage || at <= t!.stageIndex || !e.profile(a.profileId)) return unavailable("Choose a valid profile and a future stage.");
        if (name === "plan.assign") {
          const ids = stage[a.list as "profileIds" | "reviewerProfileIds"];
          if (!ids || a.index >= ids.length) return unavailable("That assignment does not exist.");
          e.setStageProfile(a.taskId, a.stageId, a.list, a.index, a.profileId);
        } else {
          if (stage.kind !== "review-chain") return unavailable("This stage does not accept extra reviewers.");
          e.addReviewer(a.taskId, a.stageId, a.profileId);
        }
        break;
      }
      case "product.settings": {
        const { productId, requestId, ...settings } = a;
        e.updateProduct(productId, settings as Parameters<Engine["updateProduct"]>[1]);
        break;
      }
      case "product.checks":
        e.setProductChecks(a.productId, a.checks);
        break;
      case "pool.limit":
        e.setPoolLimit(a.limit);
        break;
      case "tools.cap":
        e.setToolCap(a.toolId, a.cap);
        break;
      case "tools.check":
        void e.checkTools();
        return { outcome: "pending", message: "Readiness checks started." };
      case "screen.set":
        e.setScreenUse(a.mode);
        break;
      case "screen.task":
        e.setTaskScreen(a.taskId, a.allowed);
        break;
      default:
        return unavailable("This operation requires the running engine's lifecycle host.");
    }
    return done(a.taskId ? { taskId: a.taskId } : {});
  }
  /** A bounded health read: recorded facts about the current step, with no verdict and no action. */
  private health(task: Task): Result {
    const state = this.engine.activeState();
    const now = Date.now();
    const node = [...(task.journey ?? [])].reverse().find((step) => step.endedAt === undefined) ?? task.journey?.at(-1);
    const lines = task.session.filter((line) => line.step === node?.id && (line.from === "agent" || line.from === "activity"));
    const status = task.timeline.filter((entry) => entry.step === node?.id && entry.tone === "status");
    const seatOfKey = (key: string) => [task.agent, ...(task.helpers ?? [])].find((agent) => agent?.reviewKey === key);
    const seats = Object.entries(task.hunt?.work ?? {}).map(([key, work]) => ({
      seat: key, roleId: seatOfKey(key)?.roleId ?? null, profileId: seatOfKey(key)?.profileId ?? null,
      workedMs: work.clock ? workedSoFar(work.clock, now) : null, working: work.clock?.since !== undefined,
      todo: work.todo ?? null, lastActivity: work.toolActivity?.lastActivity ?? null, runningTool: work.toolActivity?.runningTool ? { description: work.toolActivity.runningTool.description, startedAt: work.toolActivity.runningTool.startedAt } : null,
      actionCount: work.toolActivity?.actionCount ?? null, waiting: work.waiting ?? null, attempts: work.attempts,
    }));
    const estimate = timeLeft({ tasks: state.tasks, now, history: state.history }, task);
    const lastObserved = Math.max(0, ...lines.map((line) => line.at), ...status.map((entry) => entry.at), task.toolActivity?.runningTool?.startedAt ?? 0, ...Object.values(node?.toolActivity ?? {}).map((activity) => activity.runningTool?.startedAt ?? 0));
    return {
      outcome: "completed",
      observedAt: now,
      state: task.state,
      ...(node ? { node: { id: node.id, kind: node.kind, roleId: node.roleId ?? null, profileId: node.profileId ?? null, startedAt: node.startedAt, elapsedMs: now - node.startedAt, ended: node.endedAt !== undefined } } : { node: null }),
      workedMs: task.stepClock ? workedSoFar(task.stepClock, now) : null,
      working: task.stepClock?.since !== undefined,
      attempts: task.stepAttempts ?? null,
      lastObservedAt: lastObserved || null,
      todo: task.todo ?? null,
      lastActivity: task.toolActivity?.lastActivity ?? null,
      runningTool: task.toolActivity?.runningTool ? { description: task.toolActivity.runningTool.description, startedAt: task.toolActivity.runningTool.startedAt } : null,
      actionCount: task.toolActivity?.actionCount ?? null,
      waitingReason: ["waiting", "needs-you", "paused", "queued", "failed", "backlog"].includes(task.state) ? task.statusLine : null,
      seats,
      estimate: estimate ? { text: estimate, basis: "The median of the last ten finished steps with the same role and first-or-repeat pass, with at least three samples. An estimate, never a threshold." } : null,
      note: "Recorded facts only. A quiet step is not a stuck step, and this read never retries, cancels or replaces work.",
    };
  }

  private async watch(a: Args, signal?: AbortSignal): Promise<Result> {
    const e = this.engine,
      deadline = Date.now() + a.timeoutMs;
    let selected: ReturnType<typeof taskSummary>[] | undefined;
    const snapshot = async (): Promise<Result> => {
      if (a.target === "engine") return this.lifecycle?.status() ?? this.call("engine.status", {});
      if (a.target === "pool") return { outcome: "completed", pool: e.s.pool, ...drainStatus(e) };
      if (a.target === "inbox") return this.query("inbox.list", a);
      const ids: string[] = a.taskIds ?? (a.taskId ? [a.taskId] : []);
      if (!ids.length) return { outcome: "invalid", message: "Choose taskId or taskIds for a focused task wait." };
      const tasks = ids.flatMap((id: string) => { const task = e.taskDetails(id); return task ? [task] : []; });
      if (tasks.length !== ids.length) return { outcome: "missing", message: "A selected task does not exist." };
      selected = tasks.map((t) => taskSummary(e, t));
      return paginate(
        a.condition === "decision" ? selected.filter((task) => task.inbox.length > 0) : selected,
        a,
        ["watch", ids],
      );
    };
    // Subscribe before the first read. No change between setup and snapshot can be lost.
    let wake: (() => void) | undefined;
    let dirty = false;
    const off = e.subscribe(() => {
      dirty = true;
      wake?.();
    });
    try {
      let baseline = a.marker;
      for (;;) {
        dirty = false;
        const current = await snapshot();
        if (current.outcome !== "completed") return current;
        const marker = `${e.boot}.${fingerprint([current, selected])}`;
        if (baseline && !baseline.startsWith(`${e.boot}.`))
          return { outcome: "continuity-lost", marker, result: current, message: "The engine restarted. Inspect this focused result and begin a new watch." };
        baseline ??= marker;
        // Pagination bounds the reply, never the set whose condition the caller selected.
        const items = selected ?? current.items as ReturnType<typeof taskSummary>[] | undefined;
        const matches =
          a.condition === "change"
            ? marker !== baseline
            : a.condition === "drained"
              ? current.drained === true
              : a.condition === "decision"
                ? a.target === "inbox"
                  ? !!items?.length
                  : items?.some((t) => t.inbox.length > 0)
                : a.condition === "state"
                  ? !!items?.length && items.every((t) => a.states?.includes(t.state))
                  : a.condition === "landed"
                    ? !!items?.length && items.every((t) => t.landing === "landed")
                    : !!items?.length && items.every((t) => t.deliveryConfirmed);
        if (matches) return { outcome: "completed", marker, result: current };
        if (e.stopped) return { outcome: "disconnected", marker, result: current };
        if (signal?.aborted) return { outcome: "disconnected", marker, result: current, message: "The wait was cancelled." };
        if (Date.now() >= deadline) return { outcome: "timed-out", marker, result: current, message: "The deadline ended this wait. Work continues." };
        if (dirty) continue;
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            wake = undefined;
            resolve();
          };
          wake = done;
          signal?.addEventListener("abort", done, { once: true });
          timer = setTimeout(done, Math.min(1000, Math.max(0, deadline - Date.now())));
        });
      }
    } finally {
      off();
    }
  }
}
