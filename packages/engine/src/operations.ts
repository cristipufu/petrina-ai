// One discoverable catalogue for the local API, CLI help and MCP tools.
import { z } from "zod";
import { StartFromSchema, WorkChoiceSchema } from "./source-schema.js";

const id = z.string().min(1).max(200);
const text = z.string().min(1).max(8000);
const page = { limit: z.number().int().min(1).max(100).default(25), cursor: z.string().max(1000).optional() };
const evidence = { limit: z.number().int().min(1).max(32000).default(8000), cursor: z.string().max(1000).optional() };
const task = { taskId: id };
const decision = { itemId: id, revision: id.describe("Revision returned by inspecting this request. Changed requests must be inspected again.") };
const kind = z.enum(["plan", "design", "delivery", "disagreement", "question", "permission", "stuck", "shipping", "learnings", "guide", "screen", "driving"]);
const state = z.enum(["backlog", "queued", "running", "waiting", "needs-you", "paused", "failed", "done", "pr-open", "cancelled"]);
const delivery = z.enum(["pull-request", "release", "local"]);
const filter = { productId: id.optional(), taskId: id.optional(), search: z.string().max(200).optional() };
const wait = { wait: z.boolean().default(false), timeoutMs: z.number().int().min(0).max(3600000).default(30000) };
function op(name: string, description: string, fields: z.ZodRawShape, changes = false) {
  return {
    name,
    description,
    schema: z
      .object({
        ...fields,
        ...(changes
          ? {
              requestId: z
                .string()
                .regex(/^[A-Za-z0-9_-]{1,64}$/)
                .describe("Save this reference before sending. Retry identical arguments with it after a lost reply; different arguments conflict."),
            }
          : {}),
      })
      .strict(),
    changes,
  };
}
export const OPERATIONS = [
  op("engine.status", "Inspect engine health, saved scheduling preference, lifecycle progress, active work and drain blockers. Never starts an engine.", {}),
  ...["start", "pause", "resume", "stop", "restart"].map((name) =>
    op(
      `engine.${name}`,
      name === "pause"
        ? "Save paused scheduling and close every new admission. Current steps finish; --wait waits for agents, checks, delivery and cleanup. A later resume, stop or restart supersedes this drain wait. Task pause interrupts instead."
        : name === "resume"
          ? "Explicitly resume scheduling. Refused while stop or restart is unfinished."
          : `Explicitly ${name} the local engine through its launcher. Stop and restart drain without forcing work. Deadlines end only the caller's wait. Restart keeps saved scheduling, work and connection.`,
      wait,
      true,
    ),
  ),
  op(
    "task.add",
    "Create one task using existing product, source, delivery and approval choices. Safe to retry with its request reference.",
    {
      productId: z.string().max(200).default("").describe("Existing product ID, or leave empty to let the planner choose, as in the app."),
      title: z.string().min(1).max(200),
      description: z.string().max(8000).optional(),
      kind: z.enum(["new", "feature", "bug", "chore"]).optional(),
      position: z.enum(["top", "bottom"]).optional(),
      approvePlan: z.boolean().optional(),
      delivery: delivery.optional(),
      approveDelivery: z.boolean().optional(),
      startFrom: StartFromSchema.optional(),
      backlog: z.boolean().optional().describe("Save for coordinator review without starting agents. Queueing it later is a separate explicit action."),
    },
    true,
  ),
  op("task.list", "List current task summaries, including backlog; filter before pagination. Finished-only state filters use paged history instead. Read all finished work with task.history. Default 25, maximum 100.", {
    ...filter,
    states: z.array(state).optional(),
    held: z.boolean().optional(),
    ...page,
  }),
  op("task.history", "List finished and cancelled task summaries newest first without loading conversations. Search matches title word prefixes, as in the app. Filters apply before pagination; changed continuations require a fresh read. Default 25, maximum 100.", {
    ...filter,
    states: z.array(z.enum(["done", "cancelled"])).optional(),
    held: z.boolean().optional(),
    ...page,
  }),
  op("task.queue", "Queue a reviewed backlog request for work using the existing engine rules. Agents may start if scheduling allows.", task, true),
  op("task.backlog", "Move an unstarted queued task back to backlog for review. Does not interrupt admitted work.", task, true),
  op("task.update-backlog", "Edit the title and request of a backlog task before work starts. Does not queue it or edit product files.", { ...task, title: z.string().trim().min(1).max(200), description: z.string().max(8000) }, true),
  op(
    "task.inspect",
    "Inspect one task's current summary, workers, next step, waiting reason, delivery confirmation and inbox references. Read longer evidence separately.",
    task,
  ),
  op("task.activity", "Inspect reported tool activity and bounded recent invocations, including available command/file details. Defaults to the latest agent step; filter by node and worker seat. Missing status or command means unreported; turnEndedAt never means completion.", { ...task, nodeId: id.optional(), seat: id.optional(), ...page }),
  op(
    "task.conversation",
    "Read recent recorded messages, optionally for one Journey node or message. Activity is hidden by default. The character budget bounds message text; up to 100 messages. Items have stable IDs, text offsets, content revisions and mayChange (null if unknown). Poll with ifRevision to skip unchanged text; upsert by message ID and revision. activeMessages identifies each unfinished participant's latest bubble, even outside the page: read a changed one with messageId. Cursor reads older messages, survives appends, and rejects changes to unread text. Full original evidence remains available with task.read.",
    { ...task, nodeId: id.optional(), messageId: id.optional().describe("Read a specific message, for example an active peer whose text lies outside the recent page."), ...evidence, ifRevision: id.optional(), includeActivity: z.boolean().default(false) },
  ),
  op(
    "task.read",
    "Read recorded task detail, conversation, findings, design or queued messages in bounded text pages. Older missing evidence is unavailable.",
    { ...task, section: z.enum(["request", "conversation", "timeline", "findings", "design", "messages", "source", "error"]), ...evidence },
  ),
  ...["hold", "unhold", "pause", "resume", "cancel"].map((name) =>
    op(
      `task.${name}`,
      name === "pause"
        ? "Interrupt the task's current agents using existing task-pause semantics. Pool pause instead lets admitted steps finish."
        : `${name[0]!.toUpperCase()}${name.slice(1)} one task using the engine's existing rules.`,
      task,
      true,
    ),
  ),
  op(
    "task.reorder",
    "Place a queued task before or after another queued task, or at a zero-based queue position.",
    { ...task, anchorId: id.optional(), side: z.enum(["before", "after"]).optional(), position: z.number().int().min(0).optional() },
    true,
  ),
  op(
    "task.dependencies",
    "Set tasks that must land first, using existing dependency and cycle checks. An empty list removes dependencies.",
    { ...task, after: z.array(id).max(20) },
    true,
  ),
  op(
    "task.source",
    "Change an unstarted task's source and destination using existing source validation. Inspect its plan request again before approval.",
    { ...task, choice: WorkChoiceSchema },
    true,
  ),
  op(
    "task.message",
    "Send guidance into the active turn when supported. Queue waits for the turn to finish; interrupt explicitly stops it first. Returns the saved message reference.",
    { ...task, text, mode: z.enum(["now", "queue", "interrupt"]).default("now") },
    true,
  ),
  op("task.remove-message", "Remove a queued message only before an agent receives it.", { ...task, messageId: id }, true),
  op("plan.inspect", "Read the task's complete plan in bounded pages, including assigned profiles. Planned stages are distinct from recorded journey nodes.", {
    ...task,
    ...evidence,
  }),
  op(
    "plan.assign",
    "Change a profile on a future stage only; preserves the engine's plan-editing rules.",
    { ...task, stageId: id, list: z.enum(["profileIds", "reviewerProfileIds"]).default("profileIds"), index: z.number().int().min(0), profileId: id },
    true,
  ),
  op("plan.add-reviewer", "Add a reviewer to a future review stage using the engine's existing rules.", { ...task, stageId: id, profileId: id }, true),
  op("journey.list", "List recorded, reconstructed legacy and planned nodes separately, with stable bounded pagination.", { ...task, ...page }),
  op(
    "journey.node",
    "Read one node's recorded trigger, input, results, questions, acceptance checks, original automated-check links, per-seat tool activity and recent tool invocations. Never substitutes newer evidence.",
    { ...task, nodeId: id, ...evidence },
  ),
  op(
    "journey.check",
    "Read an original check's diagnostics from beginning to end, with a bounded savedResult including startup failures and other engine explanations. Use section=result and its cursor to continue the saved result separately. Reports command outcome, relevance and log completeness; missing logs never become passes.",
    { ...task, nodeId: id.optional(), index: z.number().int().min(0), section: z.enum(["diagnostics", "result"]).default("diagnostics"), ...evidence },
  ),
  op("inbox.list", "List compact inbox requests, filtered inside the engine before pagination.", {
    ...filter,
    kinds: z.array(kind).optional(),
    blocking: z.boolean().optional(),
    ...page,
  }),
  op(
    "inbox.inspect",
    "Inspect a full request, choices, recommendation, evidence, available decisions and revision. Continue text pages to read all evidence.",
    { itemId: id, ...evidence },
  ),
  op("inbox.answer", "Answer a question exactly once, tied to its inspected revision.", { ...decision, answer: text.max(4000) }, true),
  op("inbox.allow", "Allow this inspected tool permission request once only. Does not grant lasting permission.", decision, true),
  op("inbox.deny", "Deny this inspected tool permission request with an optional note.", { ...decision, note: z.string().max(4000).optional() }, true),
  op(
    "inbox.approve",
    "Approve only a plan, design, delivery or disagreement checkpoint at its inspected revision. All existing delivery gates remain authoritative. Petrina never merges.",
    decision,
    true,
  ),
  op(
    "inbox.changes",
    "Request changes at an inspected checkpoint, following the existing design and delivery behavior.",
    { ...decision, note: text.max(4000) },
    true,
  ),
  op("inbox.retry", "Retry the inspected stuck item, including existing tool-readiness checks. Cannot approve checkpoints.", decision, true),
  op(
    "inbox.recovery",
    "Make an existing delivery recovery decision. Mark done records an unconfirmed delivery, not successful publishing.",
    { ...decision, decision: z.enum(["check", "ship-again", "mark-done"]) },
    true,
  ),
  op("learning.inspect", "Inspect a learning offer. Lesson positions start at zero. Save its revision before accepting selected lessons.", {
    itemId: id,
    ...evidence,
  }),
  op(
    "learning.accept",
    "Accept a nonempty valid selection from the inspected offer. Unselected lessons are declined. Accepted lessons follow existing delivery timing.",
    { ...decision, positions: z.array(z.number().int().min(0)).min(1).max(50) },
    true,
  ),
  op("learning.decline", "Decline the whole inspected learning offer using existing behavior.", decision, true),
  op("review-guide.inspect", "Inspect a proposed review-guide point and its evidence, separately from checkpoint approvals.", { itemId: id, ...evidence }),
  op("review-guide.accept", "Accept the inspected review-guide proposal; it joins an existing delivery. No direct repository edits.", decision, true),
  op("review-guide.decline", "Decline the inspected review-guide proposal.", decision, true),
  op("product.list", "List saved products and delivery settings in bounded pages.", page),
  op("product.inspect", "Read existing product settings, checks and accepted learnings in bounded pages.", { productId: id, ...evidence }),
  op(
    "product.settings",
    "Update existing product name and delivery/approval settings.",
    { productId: id, name: z.string().min(1).max(200), delivery, approveDelivery: z.boolean(), shipLowRisk: z.boolean().optional() },
    true,
  ),
  op(
    "product.checks",
    "Set existing product check definitions, or null to return to Check finder. Adds no command runner; checks still run at existing engine gates.",
    {
      productId: id,
      checks: z
        .array(z.object({ name: z.string().min(1).max(40), command: z.string().min(1).max(500) }).strict())
        .max(12)
        .nullable(),
    },
    true,
  ),
  op("pool.inspect", "Inspect pool limits, scheduling preference, admitted work and drain blockers.", {}),
  op("pool.limit", "Set the existing total agent cap (1–12).", { limit: z.number().int().min(1).max(12) }, true),
  op("tools.inspect", "Inspect tool readiness, usage, profile choices and caps in bounded pages.", evidence),
  op("tools.check", "Ask the existing tool checks to refresh readiness. Results arrive independently.", {}, true),
  op("tools.cap", "Set an existing tool's agent cap (1–12).", { toolId: id, cap: z.number().int().min(1).max(12) }, true),
  op("screen.inspect", "Inspect the existing global allowance and pending task screen requests.", page),
  op("screen.set", "Set the existing global screen allowance. Does not itself open windows.", { mode: z.enum(["off", "hour", "on"]) }, true),
  op("screen.task", "Set the existing per-task screen allowance. Does not itself open windows.", { ...task, allowed: z.boolean() }, true),
  op("screen.allow", "Allow one inspected pending screen request through the existing screen scheduler.", decision, true),
  op("analytics.inspect", "Read existing task or product analytics in bounded pages.", {
    taskId: id.optional(),
    productId: id.optional(),
    period: z.enum(["today", "7d", "30d"]).default("7d"),
    ...evidence,
  }),
  op(
    "watch.wait",
    "Wait for focused engine, task or inbox changes, a drained pool, a decision, delivery, landing or selected states. Already satisfied conditions return immediately. A deadline ends only this wait; a boot change reports lost continuity.",
    {
      target: z.enum(["engine", "pool", "task", "inbox"]),
      condition: z.enum(["change", "drained", "decision", "delivered", "landed", "state"]).default("change"),
      ...filter,
      taskIds: z.array(id).max(100).optional(),
      states: z.array(state).optional(),
      kinds: z.array(kind).optional(),
      marker: id.optional(),
      timeoutMs: wait.timeoutMs,
      ...page,
    },
  ),
] as const;
export const operation = (name: string) => OPERATIONS.find((entry) => entry.name === name);
export type Operation = (typeof OPERATIONS)[number];
