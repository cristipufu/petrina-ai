import { createHash } from "node:crypto";
import type { CoordinationResult as Result, ExtraValidation, Product, State, Task } from "@petrina/core";
import { finishedTask, involvesProduct, journeyView, offeredLessons, resultSeatOf } from "@petrina/core";
import { fingerprint } from "@petrina/storage/receipt-identity";
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
  type CoordinationArgs,
  type LifecycleControl,
} from "./coordination-views.js";
import type { Engine } from "./engine.js";
import { paginate, readText } from "./evidence-read.js";
import { readExactInput } from "./exact-input.js";
import { readReviewInput } from "./review-context.js";

type PreCheckQueryHandler = (engine: Engine, args: CoordinationArgs) => Result | Promise<Result>;

interface CoordinationQueryContext {
  readonly engine: Engine;
  readonly name: string;
  readonly state: State;
  readonly task: Task | undefined;
  readonly product: Product | undefined;
  readonly args: CoordinationArgs;
}

type CoordinationQueryHandler = (context: CoordinationQueryContext) => Result | Promise<Result>;

const PRE_CHECK_QUERY_HANDLERS: Readonly<Record<string, PreCheckQueryHandler>> = {
  "validation.inspect": (engine, args) => {
    const result = args.requestId ? engine.extraValidations.get(args.requestId) : undefined;
    if (!result) {
      return { outcome: "missing", message: "That extra validation reference does not exist." };
    }
    return result;
  },
  "validation.log": async (engine, args) => {
    const result = args.requestId ? engine.extraValidations.get(args.requestId) : undefined;
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
      section: args.section === "result" ? "result" : "diagnostics",
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
  "watch.event": (engine, args) => engine.events.log.read(args.eventId ?? "", args),
  // Before the shared checks: a continuation reports its read's time even when the task or product is gone.
  "analytics.inspect": (engine, args) => readAnalytics(engine, args as Parameters<typeof readAnalytics>[1]),
};

const queryHistoryOrFinishedTasks = (engine: Engine, args: CoordinationArgs): Result => {
  if (args.states?.some((state) => state !== "done" && state !== "cancelled")) {
    return {
      outcome: "invalid",
      message: "Read current work and finished history separately. Use task.history for done and cancelled tasks.",
    };
  }
  return readHistoryPage(engine, args);
};

const inspectInboxItem: CoordinationQueryHandler = async ({ engine, name, state, args }) => {
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

export const QUERY_HANDLERS: Readonly<Record<string, CoordinationQueryHandler>> = {
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
  "task.inspect": ({ engine, task }) => ({ outcome: "completed", task: taskSummary(engine, task!) }),
  "task.activity": ({ name, task, args }) => {
    const node = args.nodeId
      ? task!.journey?.find((candidate) => candidate.id === args.nodeId)
      : [...(task!.journey ?? [])].reverse().find((candidate) => candidate.kind === "agent");
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
  "task.conversation": ({ task, args }) => readConversation(task!, args),
  "task.read": ({ name, task, args }) => {
    if (args.findingId && args.section !== "findings") {
      return { outcome: "invalid", message: "A finding ID selects the findings section only." };
    }
    if (args.findingId && !task!.findings.some((finding) => finding.id === args.findingId)) {
      return { outcome: "missing", message: "That current finding does not exist." };
    }
    const sections: Record<string, unknown> = {
      request: { title: task!.title, description: task!.description },
      conversation: task!.session,
      timeline: taskTimeline(task!),
      findings: args.findingId ? task!.findings.find((finding) => finding.id === args.findingId) : task!.findings,
      design:
        task!.brief || task!.objections.length || task!.call
          ? { brief: task!.brief ?? null, objections: task!.objections, call: task!.call ?? null }
          : undefined,
      messages: task!.queued,
      "check-setup": {
        authority: "Recorded observations only; this read never verifies local setup",
        products: (task!.repositories ?? [task!]).map((work) => ({
          productId: work.productId,
          attempt: work.checkSetup ?? null,
          invalidation: work.checkSetupInvalidated ?? null,
        })),
        history:
          task!.journey?.flatMap((step) =>
            (step.checkSetups ?? []).map((attempt) => ({ nodeId: step.id, attempt })),
          ) ?? [],
      },
      source: {
        source: task!.source,
        choice: task!.workChoice,
        proposed: task!.proposedSource,
        selectedProducts: task!.selectedProducts,
        rows: task!.workRows,
      },
      error: task!.error,
    };
    return readText(sections[args.section ?? ""], args, [name, args.taskId, args.section, args.findingId]);
  },
  "plan.inspect": ({ name, task, args }) =>
    readText(task!.plan, args, [name, args.taskId], { evidence: task!.plan ? "planned" : "unavailable" }),
  "journey.list": ({ name, state, task, args }) => {
    const view = journeyView(task!, state);
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
      args,
      [name, args.taskId],
    );
  },
  "journey.node": ({ name, state, task, args }) => {
    const view = journeyView(task!, state);
    const node = task!.journey?.find((candidate) => candidate.id === args.nodeId);
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
        ? { digest: node.reviewInput.digest, read: { taskId: task!.id, nodeId: node.id } }
        : null,
    });
  },
  "journey.check": ({ engine, task, args }) =>
    readCheckLog(engine.dataDir, task!, {
      nodeId: args.nodeId,
      productId: args.productId,
      setupAttemptId: args.setupAttemptId,
      index: args.index ?? 0,
      section: args.section === "result" ? "result" : "diagnostics",
      cursor: args.cursor,
      limit: args.limit,
      ifRevision: args.ifRevision,
    }),
  "journey.review-input": ({ name, task, args }) => {
    const node = task!.journey?.find((step) => step.id === args.nodeId);
    if (!node) {
      return { outcome: "missing", message: "That journey node does not exist." };
    }
    if (args.section === "history") {
      const saved =
        node.reviewHistory
        ?? (node.reviewInput
          && task!.journey?.find(
            (step) =>
              step.stageId === node.stageId
              && step.round === node.round
              && step.reviewInput?.digest === node.reviewInput!.digest
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
      return readText(saved.body, args, [name, task!.id, node.id, saved.digest, args.section], {
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
          [name, task!.id, node.id, ref.digest, args.section],
          { evidence: "recorded", digest: ref.digest },
        ),
      (error) => ({
        outcome: /changed/.test(String(error)) ? ("changed" as const) : ("unavailable" as const),
        message: "The saved blind-review evidence is missing or changed. No newer evidence is substituted.",
      }),
    );
  },
  "journey.input": ({ state, task, args }) =>
    readExactInput(task!, state.roles, args as Parameters<typeof readExactInput>[2]),
  "journey.result": ({ name, state, task, args }) => {
    const node = task!.journey?.find((candidate) => candidate.id === args.nodeId);
    if (!node) {
      return { outcome: "missing", message: "That journey node does not exist." };
    }
    const results = (node.agentResults ?? []).map((result, index) => ({
      result,
      index,
      seat: resultSeatOf(node, result, state.roles, task!),
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
    const node = task!.journey?.find((candidate) => candidate.id === args.nodeId);
    if (!node) {
      return { outcome: "missing", message: "That journey node does not exist." };
    }
    const results = (node.agentResults ?? []).map((result, index) => ({
      result,
      index,
      seat: resultSeatOf(node, result, state.roles, task!),
    }));
    const copy = args.result !== undefined ? results[args.result]?.result.findings : node.result?.findings;
    if (args.result !== undefined && !results[args.result]) {
      return { outcome: "missing", message: "That result does not exist on this node." };
    }
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
        ...(args.result !== undefined
          ? { kind: "seat-result", result: args.result, seat: results[args.result]!.seat }
          : { kind: "node" }),
        basis: settled ? "settled" : "hand-back",
        label,
      },
      evidence: "recorded",
    });
  },
  "task.health": ({ engine, task }) => taskHealthView(engine, task!),
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
        .map(({ id, name: productName, repo, delivery, approveDelivery }) => ({
          id,
          name: productName,
          repo,
          delivery,
          approveDelivery,
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

export async function executeCoordinationQuery(
  engine: Engine,
  name: string,
  args: CoordinationArgs,
): Promise<Result> {
  const preCheck = PRE_CHECK_QUERY_HANDLERS[name];
  if (preCheck) {
    return preCheck(engine, args);
  }
  const state = engine.activeState();
  const needsTask = Boolean(args.taskId) && name !== "task.list" && name !== "task.history" && name !== "inbox.list";
  const task = needsTask && args.taskId ? engine.taskDetails(args.taskId) : undefined;
  if (needsTask && !task) {
    return { outcome: "missing", message: "That task does not exist." };
  }
  if (
    name === "inbox.list"
    && args.taskId
    && !state.tasks.some((candidate) => candidate.id === args.taskId)
    && !engine.store.history.item(args.taskId)
  ) {
    return { outcome: "missing", message: "That task does not exist." };
  }
  const product = state.products.find((candidate) => candidate.id === args.productId);
  if (args.productId && !product && name !== "journey.check") {
    return { outcome: "missing", message: "That product does not exist." };
  }
  const handler = QUERY_HANDLERS[name];
  if (!handler) {
    return { outcome: "invalid", message: "This read is not available." };
  }
  return handler({ engine, name, state, task, product, args });
}

export async function watchCoordination(
  engine: Engine,
  lifecycle: LifecycleControl | undefined,
  args: CoordinationArgs,
  signal: AbortSignal | undefined,
  engineStatus: () => Promise<Result> | Result,
): Promise<Result> {
  const deadline = Date.now() + (args.timeoutMs ?? 30_000);
  let selected: ReturnType<typeof taskSummary>[] | undefined;
  const snapshot = async (): Promise<Result> => {
    if (args.target === "engine") {
      return lifecycle?.status() ?? engineStatus();
    }
    if (args.target === "pool") {
      return { outcome: "completed", pool: engine.s.pool, ...drainStatus(engine) };
    }
    if (args.target === "inbox") {
      return executeCoordinationQuery(engine, "inbox.list", args);
    }
    const ids: string[] = args.taskIds ?? (args.taskId ? [args.taskId] : []);
    if (!ids.length) {
      return { outcome: "invalid", message: "Choose taskId or taskIds for a focused task wait." };
    }
    const tasks = ids.flatMap((id) => {
      const task = engine.taskDetails(id);
      return task ? [task] : [];
    });
    if (tasks.length !== ids.length) {
      return { outcome: "missing", message: "A selected task does not exist." };
    }
    selected = tasks.map((task) => taskSummary(engine, task));
    return paginate(
      args.condition === "decision" ? selected.filter((task) => task.inbox.length > 0) : selected,
      args,
      ["watch", ids],
    );
  };
  // Subscribe before the first read. No change between setup and snapshot can be lost.
  let wake: (() => void) | undefined;
  let dirty = false;
  const off = engine.subscribe(() => {
    dirty = true;
    wake?.();
  });
  try {
    let baseline = args.marker;
    for (;;) {
      dirty = false;
      const current = await snapshot();
      if (current.outcome !== "completed") {
        return current;
      }
      const marker = `${engine.boot}.${fingerprint([current, selected])}`;
      if (baseline && !baseline.startsWith(`${engine.boot}.`)) {
        return {
          outcome: "continuity-lost",
          marker,
          result: current,
          message: "The engine restarted. Inspect this focused result and begin a new watch.",
        };
      }
      baseline ??= marker;
      // Pagination bounds the reply, never the set whose condition the caller selected.
      const items = selected ?? (current.items as ReturnType<typeof taskSummary>[] | undefined);
      const matches =
        args.condition === "change"
          ? marker !== baseline
          : args.condition === "drained"
            ? current.drained === true
            : args.condition === "decision"
              ? args.target === "inbox"
                ? Boolean(items?.length)
                : Boolean(items?.some((task) => task.inbox.length > 0))
              : args.condition === "state"
                ? Boolean(items?.length && items.every((task) => args.states?.includes(task.state)))
                : args.condition === "landed"
                  ? Boolean(items?.length && items.every((task) => task.landing === "landed"))
                  : Boolean(items?.length && items.every((task) => task.deliveryConfirmed));
      if (matches) {
        return { outcome: "completed", marker, result: current };
      }
      if (engine.stopped) {
        return { outcome: "disconnected", marker, result: current };
      }
      if (signal?.aborted) {
        return { outcome: "disconnected", marker, result: current, message: "The wait was cancelled." };
      }
      if (Date.now() >= deadline) {
        return { outcome: "timed-out", marker, result: current, message: "The deadline ended this wait. Work continues." };
      }
      if (dirty) {
        continue;
      }
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
        timer = setTimeout(done, Math.min(1_000, Math.max(0, deadline - Date.now())));
      });
    }
  } finally {
    off();
  }
}
