// One discoverable catalogue for the local API, CLI help and MCP tools.
import { z } from "zod";
import { WORKFLOW_EVENT_KINDS } from "@petrina/core";
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
    "Create one task and its prerequisites together before it can start. Safe to retry with its request reference.",
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
      after: z.array(id).max(20).optional().describe("Tasks that must land first. Saved atomically with the request, independently of queue priority."),
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
  op("validation.run", "Queue a genuinely required extra full validation in an owned local Linux container on a Mac or Linux host. Tests only Petrina's last saved commit and tree; working edits are excluded. Extra evidence never satisfies delivery. No native, remote, detached execution or caller container options.", {
    ...task, productId: id.optional(), name: z.string().trim().min(1).max(80), reason: z.string().trim().min(1).max(2000),
    image: z.string().trim().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/+-]*$/),
    argv: z.array(z.string().max(8000).refine(word => !word.includes("\0"))).min(1).max(100).refine(words => !!words[0]?.trim() && words.join(" ").length <= 16000),
    ...wait,
  }, true),
  op("validation.inspect", "Read an extra run by its original request reference, including its exact saved version, state, image and outcome. Never product-check evidence.", { requestId: id }),
  op("validation.log", "Read the original extra-run diagnostic with the same file-identity checks as a product check.", { requestId: id, section: z.enum(["diagnostics", "result"]).default("diagnostics"), ...evidence }),
  op("task.activity", "Inspect reported tool activity and bounded recent invocations, including available command/file details. Defaults to the latest agent step; filter by node and worker seat. Missing status or command means unreported; turnEndedAt never means completion.", { ...task, nodeId: id.optional(), seat: id.optional(), ...page }),
  op(
    "task.conversation",
    "Read recent recorded messages, optionally for one Journey node or message. Activity is hidden by default. The character budget bounds message text; up to 100 messages. Items have stable IDs, text offsets, content revisions and mayChange (null if unknown). Poll with ifRevision to skip unchanged text; upsert by message ID and revision. activeMessages identifies each unfinished participant's latest bubble, even outside the page: read a changed one with messageId. Cursor reads older messages, survives appends, and rejects changes to unread text. Full original evidence remains available with task.read.",
    { ...task, nodeId: id.optional(), messageId: id.optional().describe("Read a specific message, for example an active peer whose text lies outside the recent page."), ...evidence, ifRevision: id.optional(), includeActivity: z.boolean().default(false) },
  ),
  op(
    "task.read",
    "Read recorded task detail, conversation, findings, design or queued messages in bounded text pages. findingId selects one current report in section=findings; its status may differ from a historical journey.finding copy. Older missing evidence is unavailable.",
    { ...task, section: z.enum(["request", "conversation", "timeline", "findings", "design", "messages", "source", "error"]), findingId: id.optional(), ...evidence },
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
    "Set prerequisites on Backlog or queued tasks that have never started, using existing dependency and cycle checks. An empty list removes dependencies.",
    { ...task, after: z.array(id).max(20) },
    true,
  ),
  op(
    "task.wait",
    "Let a started task wait for the complete prerequisite list to land, with a saved reason. Admitted work finishes; no new work starts. An empty list explicitly clears the wait. Never-started tasks use task.dependencies instead.",
    // Keep input shapes strict; the shared wait rules explain semantic limits in plain language.
    { ...task, after: z.array(id).describe("Complete list of up to 20 prerequisites. An empty list clears the wait."), reason: z.string().describe("Required reason between 1 and 1,000 characters.") },
    true,
  ),
  op(
    "task.track-finding",
    "Record that a complete confirmed older report left Not tracked is tracked in an existing bug task, including from History. Waits for automatic linking; never runs agents or creates a task.",
    { ...task, findingId: id, targetTaskId: id },
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
    "journey.review-input",
    "Read the immutable blind-review snapshot, supplied findings, code versions, or complete shortened history retained on the round's journey. Missing or changed files are never replaced by current evidence.",
    { ...task, nodeId: id, section: z.enum(["snapshot", "findings", "versions", "history"]).default("snapshot"), ...evidence },
  ),
  op(
    "journey.input",
    "Read one seat's exact saved input for a node: the complete opening message as sent (section=message), its bounded section manifest with names, sizes and content identities (section=manifest), or one later update such as an answer, repair or continuation (section=update with update index). Select the seat from a seat.started event; index picks an earlier attempt. Missing, changed or expired files report that condition and never substitute newer evidence.",
    { ...task, nodeId: id, seat: id.optional().describe("The seat named by the event, for example reviewer:1 or builder. Defaults to the node's latest input."), index: z.number().int().min(0).optional().describe("Which input on that seat, oldest first. Defaults to the latest."), section: z.enum(["message", "manifest", "update"]).default("message"), update: z.number().int().min(0).optional().describe("With section=update: which update, oldest first."), ...evidence },
  ),
  op(
    "journey.result",
    "Read one seat's accepted result for a node exactly as it was handed back, with its recorded versions and picture references. Select it from a seat.finished event's result reference.",
    { ...task, nodeId: id, seat: id.optional(), index: z.number().int().min(0).optional().describe("The result's position on the node, oldest first. Defaults to the latest for the seat."), ...evidence },
  ),
  op(
    "journey.finding",
    "Read the immutable copy of one finding saved with a node's recorded result: the node-level copy, or with result index the copy one seat's result left. Later peers and rounds cannot rewrite it. A finding absent from that copy reports missing rather than returning a newer record.",
    { ...task, nodeId: id, findingId: id, result: z.number().int().min(0).optional().describe("A seat's result position on the node, for the copy that seat's result left."), ...evidence },
  ),
  op(
    "task.health",
    "Inspect a long step without judging it: observation time, the recorded working duration, last observed activity or progress per seat, the waiting reason, and Petrina's existing estimate when its shared rule supports one. Silence alone proves nothing; this read never retries, cancels or replaces work.",
    task,
  ),
  op(
    "journey.check",
    "Read an original check's diagnostics from beginning to end, with a bounded savedResult including startup failures and other engine explanations. Use section=result and its cursor to continue the saved result separately. Reports command outcome, relevance and log completeness; missing logs never become passes.",
    { ...task, nodeId: id.optional(), productId: id.optional().describe("Select one product’s latest saved run when nodeId is absent."), ifRevision: id.optional().describe("Pin a latest-run reference supplied by checkpoint inspection; changed evidence returns changed."), index: z.number().int().min(0), section: z.enum(["diagnostics", "result"]).default("diagnostics"), ...evidence },
  ),
  op("inbox.list", "List compact inbox requests, filtered inside the engine before pagination.", {
    ...filter,
    kinds: z.array(kind).optional(),
    blocking: z.boolean().optional(),
    ...page,
  }),
  op(
    "inbox.inspect",
    "Inspect the recorded request, choices, recommendation, available decisions and revision, with compact product/check/report evidence. Successful output is explicitly omitted with original journey.check references. Failed, unknown and unfinished checks include bounded beginning and ending saved explanations; follow section=result for the full text. Unreported exits stay unknown. Continue any shortened inspection pages; relevant changes require fresh inspection. Accepting unresolved review continues final verification, never approves delivery.",
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
  op("inbox.rerun-checks", "Run failed or unverified product checks afresh at the inspected decision. Approves no delivery and grants no automatic repair returns. Reuse the request reference after a lost reply.", decision, true),
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
  op("analytics.inspect", "Read existing task or product analytics in bounded pages. Every page reports its read's asOf time; a product read's continuations expire ten minutes after its first page.", {
    taskId: id.optional(),
    productId: id.optional(),
    period: z.enum(["today", "7d", "30d"]).default("7d"),
    ...evidence,
  }),
  op(
    "watch.event",
    "Read one retained workflow event's complete compact details in bounded pages, including finding identities and product results omitted from its preview. The event identity pins the evidence; an expired event or earlier engine run reports unavailable.",
    { eventId: id, ...evidence },
  ),
  op(
    "watch.events",
    "Wait for compact workflow events: node and seat starts and finishes, checks, task states, coordinator requests and decisions, repairs, retries, replacements, review completion and publishing results. Review counts include all reports and split open Important findings, nits and pre-existing follow-ups; stillOpen is an Important-only compatibility list. Follow coordinator.request to inbox.inspect; review completion alone grants no delivery approval. Routine tool actions, streamed text and clocks are never events. Available events return at once; otherwise the request stays open until a batch, the deadline (default 30 seconds, up to an hour; 0 queries without waiting) or cancellation. Without a cursor, observation starts now; from=oldest replays this engine run's retained events. Return the cursor to continue; a restart or expired window reports lost continuity.",
    {
      taskIds: z.array(id).max(100).optional().describe("Selected tasks. Omit for a product or all current work."),
      productId: id.optional().describe("A product's current work, including newly admitted tasks."),
      kinds: z.array(z.enum(WORKFLOW_EVENT_KINDS)).min(1).optional().describe("A subset of event kinds. Omit for every kind."),
      cursor: z.string().max(1000).optional(),
      from: z.enum(["now", "oldest"]).default("now").describe("Without a cursor: start observing now, or replay the oldest retained events of this run."),
      limit: z.number().int().min(1).max(100).default(25),
      timeoutMs: wait.timeoutMs,
    },
  ),
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
