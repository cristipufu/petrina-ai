import { createHash } from "node:crypto";
import type { CoordinationResult as Result, ExtraValidation, Product, State, Task } from "@petrina/core";
import { finishedTask, involvesProduct, journeyView, offeredLessons, resultSeatOf } from "@petrina/core";
import { readAnalytics } from "./analytics-read.js";
import { readCheckLog } from "./check-log-read.js";
import { checkpointView } from "./checkpoint-read.js";
import { readConversation } from "./conversation-read.js";
import {
  decisionsForRequest,
  drainStatus,
  filteredInbox,
  readHistoryPage,
  requestRevision,
  taskHealthView,
  taskSummary,
  taskTimeline,
  type HistoryFilterArgs,
} from "./coordination-views.js";
import type { Engine } from "./engine.js";
import { paginate, readText } from "./evidence-read.js";
import { readExactInput } from "./exact-input.js";
import { ImmutableEvidenceChangedError } from "./immutable-file.js";
import type { OperationInput, QueryOperationName } from "./operations.js";
import { readReviewInput } from "./review-context.js";

export type DirectQueryName = "engine.status" | "engine.releases" | "watch.events" | "watch.wait";
export type DelegatedQueryName = Exclude<QueryOperationName, DirectQueryName>;
type PreCheckQueryName = "validation.inspect" | "validation.log" | "watch.event" | "analytics.inspect";
type StandardQueryName = Exclude<DelegatedQueryName, PreCheckQueryName>;

type TaskScopedQueryName = {
  [K in StandardQueryName]: OperationInput<K> extends { taskId: string } ? K : never;
}[StandardQueryName];

type GeneralQueryName = Exclude<StandardQueryName, TaskScopedQueryName>;

type PreCheckQueryHandler<K extends PreCheckQueryName> = (
  engine: Engine,
  args: OperationInput<K>,
) => Result | Promise<Result>;

interface TaskQueryContext<K extends TaskScopedQueryName> {
  readonly engine: Engine;
  readonly name: K;
  readonly state: State;
  readonly task: Task;
  readonly args: OperationInput<K>;
}

type TaskQueryHandler<K extends TaskScopedQueryName> = (
  context: TaskQueryContext<K>,
) => Result | Promise<Result>;

interface GeneralQueryContext<K extends GeneralQueryName> {
  readonly engine: Engine;
  readonly name: K;
  readonly state: State;
  readonly product: Product | undefined;
  readonly args: OperationInput<K>;
}

type GeneralQueryHandler<K extends GeneralQueryName> = (
  context: GeneralQueryContext<K>,
) => Result | Promise<Result>;

const PRE_CHECK_QUERY_HANDLERS: { readonly [K in PreCheckQueryName]: PreCheckQueryHandler<K> } = {
  "validation.inspect": (engine, args) => {
    const result = engine.extraValidations.get(args.requestId);
    if (!result) {
      return { outcome: "missing", message: "That extra validation reference does not exist." };
    }
    return result;
  },
  "validation.log": async (engine, args) => {
    const result = engine.extraValidations.get(args.requestId);
    if (!result) {
      return { outcome: "missing", message: "That extra validation reference does not exist." };
    }
    const record = result.validation as ExtraValidation | undefined;
    if (!record?.run) {
      return { outcome: "unavailable", message: "This extra validation has no command log yet." };
    }
    if (record.run.endedAt === undefined) {
      return {
        outcome: "pending",
        state: record.state,
        extraEvidence: true,
        message: "The original diagnostic will be available when this run and its cleanup settle.",
      };
    }
    const task = {
      id: record.taskId,
      checks: {
        at: record.endedAt ?? record.queuedAt,
        results: [record.run],
        sha: record.commit,
        tree: record.tree,
      },
    };
    const log = await readCheckLog(engine.dataDir, task, {
      index: 0,
      section: args.section,
      cursor: args.cursor,
      limit: args.limit,
    });
    return {
      ...log,
      extraEvidence: true,
      validationState: record.state,
      ...(record.run.exitSignal ? { commandOutcome: "unfinished" } : {}),
    };
  },
  "watch.event": (engine, args) => engine.events.log.read(args.eventId, args),
  // Before the shared checks: a continuation reports its read's time even when the task or product is gone.
  "analytics.inspect": (engine, args) => readAnalytics(engine, args),
};

const queryHistoryOrFinishedTasks = (engine: Engine, args: HistoryFilterArgs): Result => {
  if (args.states?.some((state) => state !== "done" && state !== "cancelled")) {
    return {
      outcome: "invalid",
      message: "Read current work and finished history separately. Use task.history for done and cancelled tasks.",
    };
  }
  return readHistoryPage(engine, args);
};

type InboxInspectName = "inbox.inspect" | "learning.inspect" | "review-guide.inspect";

const inspectInboxItem = async ({
  engine,
  name,
  state,
  args,
}: {
  readonly engine: Engine;
  readonly name: InboxInspectName;
  readonly state: State;
  readonly args: OperationInput<"inbox.inspect">;
}): Promise<Result> => {
  const item = state.inbox.find((candidate) => candidate.id === args.itemId);
  if (!item) {
    return { outcome: "missing", message: "That request is no longer in the inbox." };
  }
  const expected =
    name === "learning.inspect" ? "learnings" : name === "review-guide.inspect" ? "guide" : item.kind;
  if (item.kind !== expected) {
    return { outcome: "invalid", message: `That is a ${item.kind} request.` };
  }
  const revision = requestRevision(engine, item);
  const itemTask = engine.taskDetails(item.taskId);
  return readText(
    itemTask && ["plan", "design", "delivery", "disagreement"].includes(item.kind)
      ? JSON.stringify(await checkpointView(engine, itemTask, item), null, 1)
      : {
          request: item,
          ...(item.kind === "learnings"
            ? { lessons: offeredLessons(item.body).map((text, position) => ({ position, text })) }
            : {}),
        },
    args,
    [name, item.id, revision],
    {
      itemId: item.id,
      kind: item.kind,
      revision,
      decisions: decisionsForRequest(item.kind, itemTask),
      recommendation: item.options?.[0] ?? null,
      choices: item.options ?? [],
    },
  );
};

export const TASK_QUERY_HANDLERS: { readonly [K in TaskScopedQueryName]: TaskQueryHandler<K> } = {
  "task.inspect": ({ engine, task }) => ({ outcome: "completed", task: taskSummary(engine, task) }),
  "task.activity": ({ name, task, args }) => {
    const node = args.nodeId
      ? task.journey?.find((candidate) => candidate.id === args.nodeId)
      : [...(task.journey ?? [])].reverse().find((candidate) => candidate.kind === "agent");
    if (!node) {
      return { outcome: "unavailable", message: "No tool activity was recorded for this step." };
    }
    const records = (node.toolInvocations ?? []).filter((record) => !args.seat || record.seat === args.seat);
    const workers = Object.fromEntries(
      Object.entries(node.toolActivity ?? {}).filter(([seat]) => !args.seat || seat === args.seat),
    );
    return {
      ...paginate(records, args, [name, args.taskId, node.id, args.seat]),
      nodeId: node.id,
      workers,
      actionCount: Object.values(workers).reduce((total, activity) => total + activity.actionCount, 0),
      evidence: node.toolActivity ? "recorded" : "unavailable",
    };
  },
  "task.conversation": ({ task, args }) => readConversation(task, args),
  "task.read": ({ name, task, args }) => {
    if (args.findingId && args.section !== "findings") {
      return { outcome: "invalid", message: "A finding ID selects the findings section only." };
    }
    if (args.findingId && !task.findings.some((finding) => finding.id === args.findingId)) {
      return { outcome: "missing", message: "That current finding does not exist." };
    }
    const sections = {
      request: { title: task.title, description: task.description },
      conversation: task.session,
      timeline: taskTimeline(task),
      findings: args.findingId ? task.findings.find((finding) => finding.id === args.findingId) : task.findings,
      design:
        task.brief || task.objections.length || task.call
          ? { brief: task.brief ?? null, objections: task.objections, call: task.call ?? null }
          : undefined,
      messages: task.queued,
      "check-setup": {
        authority: "Recorded observations only; this read never verifies local setup",
        products: (task.repositories ?? [task]).map((work) => ({
          productId: work.productId,
          attempt: work.checkSetup ?? null,
          invalidation: work.checkSetupInvalidated ?? null,
        })),
        history:
          task.journey?.flatMap((step) =>
            (step.checkSetups ?? []).map((attempt) => ({ nodeId: step.id, attempt })),
          ) ?? [],
      },
      source: {
        source: task.source,
        choice: task.workChoice,
        proposed: task.proposedSource,
        selectedProducts: task.selectedProducts,
        rows: task.workRows,
      },
      error: task.error,
    } as const;
    return readText(sections[args.section], args, [name, args.taskId, args.section, args.findingId]);
  },
  "plan.inspect": ({ name, task, args }) =>
    readText(task.plan, args, [name, args.taskId], { evidence: task.plan ? "planned" : "unavailable" }),
  "journey.list": ({ name, state, task, args }) => {
    const view = journeyView(task, state);
    return paginate(
      view.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        state: node.state,
        evidence: task.journey?.find((step) => step.id === node.id)?.legacy
          ? "reconstructed"
          : task.journey?.some((step) => step.id === node.id)
            ? "recorded"
            : "planned",
      })),
      args,
      [name, args.taskId],
    );
  },
  "journey.node": ({ name, state, task, args }) => {
    const view = journeyView(task, state);
    const node = task.journey?.find((candidate) => candidate.id === args.nodeId);
    const planned = view.nodes.find((candidate) => candidate.id === args.nodeId);
    if (!node && !planned) {
      return { outcome: "missing", message: "That journey node does not exist." };
    }
    return readText(node ?? planned, args, [name, args.taskId, args.nodeId], {
      evidence: node ? (node.legacy ? "reconstructed" : "recorded") : "planned",
      input: node?.agentInputs ? "recorded" : "unavailable",
      result: node?.agentResults || node?.result ? "recorded" : "unavailable",
      trigger: node?.trigger ?? null,
      triggerEvidence: node?.trigger ? "recorded" : "unavailable",
      reviewInput: node?.reviewInput
        ? { digest: node.reviewInput.digest, read: { taskId: task.id, nodeId: node.id } }
        : null,
    });
  },
  "journey.check": ({ engine, task, args }) =>
    readCheckLog(engine.dataDir, task, {
      nodeId: args.nodeId,
      productId: args.productId,
      setupAttemptId: args.setupAttemptId,
      index: args.index,
      section: args.section,
      cursor: args.cursor,
      limit: args.limit,
      ifRevision: args.ifRevision,
    }),
  "journey.review-input": ({ name, task, args }) => {
    const node = task.journey?.find((step) => step.id === args.nodeId);
    if (!node) {
      return { outcome: "missing", message: "That journey node does not exist." };
    }
    if (args.section === "history") {
      const reviewInput = node.reviewInput;
      const saved =
        node.reviewHistory
        ?? (reviewInput
          && task.journey?.find(
            (step) =>
              step.stageId === node.stageId
              && step.round === node.round
              && step.reviewInput?.digest === reviewInput.digest
              && step.reviewHistory,
          )?.reviewHistory);
      if (!saved) {
        return { outcome: "unavailable", message: "This round retained no shortened history." };
      }
      if (createHash("sha256").update(saved.body).digest("hex") !== saved.digest) {
        return {
          outcome: "changed",
          message: "The retained frozen review history changed. No newer evidence is substituted.",
        };
      }
      return readText(saved.body, args, [name, task.id, node.id, saved.digest, args.section], {
        evidence: "recorded",
        digest: saved.digest,
      });
    }
    const ref = node.reviewInput;
    if (!ref) {
      return { outcome: "unavailable", message: "This node recorded no blind-review snapshot reference." };
    }
    return readReviewInput(ref).then(
      (input) =>
        readText(
          args.section === "findings" ? input.findings : args.section === "versions" ? ref.heads : input,
          args,
          [name, task.id, node.id, ref.digest, args.section],
          { evidence: "recorded", digest: ref.digest },
        ),
      (error) => ({
        outcome: error instanceof ImmutableEvidenceChangedError ? ("changed" as const) : ("unavailable" as const),
        message: "The saved blind-review evidence is missing or changed. No newer evidence is substituted.",
      }),
    );
  },
  "journey.input": ({ state, task, args }) => readExactInput(task, state.roles, args),
  "journey.result": ({ name, state, task, args }) => {
    const node = task.journey?.find((candidate) => candidate.id === args.nodeId);
    if (!node) {
      return { outcome: "missing", message: "That journey node does not exist." };
    }
    const results = (node.agentResults ?? []).map((result, index) => ({
      result,
      index,
      seat: resultSeatOf(node, result, state.roles, task),
    }));
    const chosen =
      args.index !== undefined
        ? results[args.index]
        : [...results].reverse().find((entry) => !args.seat || entry.seat === args.seat);
    if (!chosen || (args.seat && chosen.seat !== args.seat)) {
      return { outcome: "unavailable", message: "No accepted result is recorded for that seat on this node." };
    }
    const { value, images, findings: _findings, ...rest } = chosen.result;
    const kind = state.roles.find((role) => role.id === chosen.result.roleId)?.result;
    const label =
      kind === "findings" || kind === "votes"
        ? "Participant’s report before the round’s decision"
        : "Participant’s original report";
    return readText(value, args, [name, args.taskId, args.nodeId, chosen.index], {
      seat: chosen.seat,
      index: chosen.index,
      ...rest,
      label,
      images: images?.map(({ id, caption }) => ({ id, caption })) ?? [],
      findingCopies: chosen.result.findings?.length ?? 0,
      evidence: "recorded",
    });
  },
  "journey.finding": ({ name, state, task, args }) => {
    const node = task.journey?.find((candidate) => candidate.id === args.nodeId);
    if (!node) {
      return { outcome: "missing", message: "That journey node does not exist." };
    }
    const results = (node.agentResults ?? []).map((result, index) => ({
      result,
      index,
      seat: resultSeatOf(node, result, state.roles, task),
    }));
    const selectedResult = args.result !== undefined ? results[args.result] : undefined;
    if (args.result !== undefined && !selectedResult) {
      return { outcome: "missing", message: "That result does not exist on this node." };
    }
    const copy = selectedResult ? selectedResult.result.findings : node.result?.findings;
    if (!copy) {
      return {
        outcome: "unavailable",
        message: args.result !== undefined ? "That result saved no finding copies." : "This node recorded no finding copies.",
      };
    }
    const finding = copy.find((entry) => entry.id === args.findingId);
    if (!finding) {
      return {
        outcome: "missing",
        message: "That finding is not in this recorded copy. A newer record is never substituted.",
      };
    }
    const settled = args.result === undefined && node.result?.findingsSettled === true;
    const label = settled
      ? "Settled decision for this round"
      : args.result !== undefined
        ? "Participant’s report before the round’s decision"
        : "Hand-back copy; no settled decision was saved";
    return readText(finding, args, [name, args.taskId, args.nodeId, args.result, args.findingId], {
      findingId: args.findingId,
      copy: {
        ...(selectedResult
          ? { kind: "seat-result", result: selectedResult.index, seat: selectedResult.seat }
          : { kind: "node" }),
        basis: settled ? "settled" : "hand-back",
        label,
      },
      evidence: "recorded",
    });
  },
  "task.health": ({ engine, task }) => taskHealthView(engine, task),
};

export const GENERAL_QUERY_HANDLERS: { readonly [K in GeneralQueryName]: GeneralQueryHandler<K> } = {
  "task.history": ({ engine, args }) => queryHistoryOrFinishedTasks(engine, args),
  "task.list": ({ engine, name, state, args }) => {
    if (args.states?.some((taskState) => taskState === "done" || taskState === "cancelled")) {
      return queryHistoryOrFinishedTasks(engine, args);
    }
    return paginate(
      state.tasks
        .filter(
          (candidate) =>
            !finishedTask(candidate)
            && (!args.productId || involvesProduct(candidate, args.productId))
            && (!args.taskId || candidate.id === args.taskId)
            && (!args.states || args.states.includes(candidate.state))
            && (args.held === undefined || candidate.held === args.held)
            && (!args.search || candidate.title.toLowerCase().includes(args.search.toLowerCase())),
        )
        .sort(
          (left, right) =>
            left.priority - right.priority || left.createdAt - right.createdAt || left.id.localeCompare(right.id),
        )
        .map((candidate) => taskSummary(engine, candidate)),
      args,
      name,
    );
  },
  "inbox.list": ({ engine, name, args }) =>
    paginate(
      filteredInbox(engine, args).map(({ id, taskId, kind, title, blocking, at }) => ({
        id,
        taskId,
        kind,
        title,
        blocking,
        at,
      })),
      args,
      name,
    ),
  "inbox.inspect": inspectInboxItem,
  "learning.inspect": inspectInboxItem,
  "review-guide.inspect": inspectInboxItem,
  "product.list": ({ name, state, args }) =>
    paginate(
      state.products
        .map(({ id, name: productName, repo, delivery, approveDelivery, requiredRemoteChecks }) => ({
          id,
          name: productName,
          repo,
          delivery,
          approveDelivery,
          requiredRemoteChecks: requiredRemoteChecks ?? [],
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      args,
      name,
    ),
  "product.inspect": ({ name, product, args }) => readText(product, args, [name, args.productId]),
  "pool.inspect": ({ engine, state }) => ({ outcome: "completed", pool: state.pool, ...drainStatus(engine) }),
  "tools.inspect": ({ name, state, args }) =>
    readText(
      {
        tools: state.tools,
        checks: state.setup?.checks,
        profiles: state.profiles,
        caps: state.pool.toolCaps,
        usage: state.pool.usage,
      },
      args,
      name,
    ),
  "screen.inspect": ({ name, state, args }) => ({
    allowance: state.pool.screen ?? { mode: "off" },
    ...paginate(
      state.tasks.filter((candidate) => candidate.screen).map((candidate) => ({
        taskId: candidate.id,
        screen: candidate.screen,
        allowed: candidate.screenAllowed,
      })),
      args,
      [name, state.pool.screen],
    ),
  }),
};

const isPreCheckQuery = (name: QueryOperationName): name is PreCheckQueryName =>
  Object.hasOwn(PRE_CHECK_QUERY_HANDLERS, name);
const isTaskScopedQuery = (name: QueryOperationName): name is TaskScopedQueryName =>
  Object.hasOwn(TASK_QUERY_HANDLERS, name);
const isGeneralQuery = (name: QueryOperationName): name is GeneralQueryName =>
  Object.hasOwn(GENERAL_QUERY_HANDLERS, name);

export async function executeCoordinationQuery(
  engine: Engine,
  name: QueryOperationName,
  args: OperationInput<QueryOperationName>,
): Promise<Result> {
  if (isPreCheckQuery(name)) {
    const handler = PRE_CHECK_QUERY_HANDLERS[name] as (
      engine: Engine,
      args: OperationInput<PreCheckQueryName>,
    ) => Result | Promise<Result>;
    return handler(engine, args as OperationInput<PreCheckQueryName>);
  }
  const state = engine.activeState();
  const payload = args as Record<string, unknown>;
  const productId = typeof payload["productId"] === "string" ? payload["productId"] : undefined;
  const product = productId ? state.products.find((candidate) => candidate.id === productId) : undefined;
  if (productId && !product && name !== "journey.check") {
    return { outcome: "missing", message: "That product does not exist." };
  }

  if (isTaskScopedQuery(name)) {
    const taskArgs = args as OperationInput<TaskScopedQueryName>;
    const task = engine.taskDetails(taskArgs.taskId);
    if (!task) {
      return { outcome: "missing", message: "That task does not exist." };
    }
    const handler = TASK_QUERY_HANDLERS[name] as (
      context: TaskQueryContext<TaskScopedQueryName>,
    ) => Result | Promise<Result>;
    return handler({
      engine,
      name,
      state,
      task,
      args: taskArgs,
    });
  }

  if (isGeneralQuery(name)) {
    const generalArgs = args as OperationInput<GeneralQueryName>;
    const taskId = typeof payload["taskId"] === "string" ? payload["taskId"] : undefined;
    if (
      name === "inbox.list"
      && taskId
      && !state.tasks.some((candidate) => candidate.id === taskId)
      && !engine.store.history.item(taskId)
    ) {
      return { outcome: "missing", message: "That task does not exist." };
    }
    const handler = GENERAL_QUERY_HANDLERS[name] as (
      context: GeneralQueryContext<GeneralQueryName>,
    ) => Result | Promise<Result>;
    return handler({
      engine,
      name,
      state,
      product,
      args: generalArgs,
    });
  }

  return { outcome: "invalid", message: "This read is not available." };
}
