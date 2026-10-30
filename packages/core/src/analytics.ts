// What each view shows about the work log, worked out from the log itself. The app never
// gets the log: it asks for one of these views and gets just its numbers.

import { figures, type Detail } from "./analytics-figures.js";
export { figures, type Detail } from "./analytics-figures.js";
import {
  byTokens, dayBuckets, detailOf, ended, group, names, periodRange, ranAsAsked, reasonsOf, settingsWords, squadView,
  USAGE_PERIODS, type AboutCounts, type AgentUsage, type AnalyticsUsage, type ChartBucket, type ProductsUsage,
  type SquadRow, type SquadUsage, type StageUsage, type TaskUsage, type TaskUsageSummary, type TodayUsage,
  type UsageContext, type UsagePeriod, type UsageRequest, type UsageView, type UsageViewFor, type WorkUsageLine,
} from "./analytics-squad.js";
export {
  dayBuckets, periodRange, ranAsAsked, USAGE_PERIODS,
  type AboutCounts, type AgentUsage, type AnalyticsUsage, type ChartBucket, type ProductsUsage,
  type SquadRow, type SquadUsage, type StageUsage, type TaskUsage, type TaskUsageSummary, type TodayUsage,
  type UsageContext, type UsagePeriod, type UsageRequest, type UsageView, type UsageViewFor, type WorkUsageLine,
};
import { tokensOverTime } from "./charts.js";
import { limitBuckets, limitsOverTime, readingsView } from "./limit-history-view.js";
import type { Id } from "./model.js";
import { nodeUsage } from "./node-usage.js";
import type { Figure } from "./numbers.js";
import {
  addTurn, CHANGED_LABEL, emptyTally, lineModelLabel, modelLabel, NOT_CONFIRMED_LABEL, turnModelLabel,
  type Tally, type TokenLine, type WorkLogReader, type WorkTurn,
} from "./worklog.js";

function taskSummary(tally: Tally, untracked: boolean): TaskUsageSummary {
  if (tally.turns === 0 && !untracked) return { empty: "nothing", tokens: { atLeast: false }, time: { atLeast: false } };
  return { ...figures(tally, untracked), ...(tally.turns === 0 ? { empty: "untracked" as const } : {}) };
}

export function taskUsageSummaries(log: WorkLogReader, taskIds: readonly Id[]): Map<Id, TaskUsageSummary> {
  return new Map([...log.taskTallies(taskIds)].map(([id, { tally, untracked }]) => [id, taskSummary(tally, untracked)]));
}

function taskView(log: WorkLogReader, taskId: Id, ctx: UsageContext): TaskUsage {
  const turns = ended(log.turns({ taskId }));
  const lines = log.lines({ taskId });
  const untracked = log.untracked().has(taskId);
  const tally = turns.reduce(addTurn, emptyTally());
  const summary = taskSummary(tally, untracked);
  if (summary.empty) return { view: "task", ...summary, ...figures(tally, untracked), atLeast: "", stages: [] };

  const task = ctx.state.tasks.find((entry) => entry.id === taskId) ?? ctx.task?.(taskId);
  const order = new Map<Id, number>([[`${taskId}:plan`, -1]]);
  task?.plan?.stages.forEach((stage, index) => order.set(stage.id, index));
  const currentTitle = new Map(task?.plan?.stages.map((stage) => [stage.id, stage.title]) ?? []);
  const linesByTurn = group(lines, (line) => line.turnId);

  const stages: StageUsage[] = [...group(turns, (turn) => turn.stageId).entries()]
    .map(([stageId, stageTurns]) => {
      const agents = [...group(stageTurns, (turn) => `${turn.roleId}|${turn.profileId}`).entries()].map(([key, agentTurns]): AgentUsage => {
        const agentTally = agentTurns.reduce(addTurn, emptyTally());
        const models = new Map<string, number>();
        for (const turn of agentTurns) {
          for (const line of linesByTurn.get(turn.id) ?? []) {
            const label = modelLabel(line.model) || "Model not reported";
            models.set(label, (models.get(label) ?? 0) + (line.total ?? 0));
          }
        }
        const words = settingsWords(agentTurns);
        const first = agentTurns[0]!;
        return {
          key,
          roleId: first.roleId,
          toolId: first.toolId,
          profileId: first.profileId,
          settings: words.text,
          differs: words.differs,
          notConfirmed: words.notConfirmed,
          rounds: new Set(agentTurns.map((turn) => turn.round)).size,
          turns: agentTurns.length,
          ...figures(agentTally),
          models: models.size > 1 ? [...models.entries()].map(([label, value]) => ({ label, tokens: value })).sort((a, b) => b.tokens - a.tokens) : [],
        };
      });
      const stageTally = stageTurns.reduce(addTurn, emptyTally());
      const first = stageTurns[0]!;
      return {
        stageId,
        title: currentTitle.get(stageId) ?? (stageId === `${taskId}:plan` ? "Planning" : first.stageTitle),
        removed: stageId !== `${taskId}:plan` && !currentTitle.has(stageId),
        rounds: new Set(stageTurns.map((turn) => turn.round)).size,
        ...figures(stageTally),
        agents,
        firstAt: first.startedAt,
      };
    })
    .sort((a, b) => (order.get(a.stageId) ?? 1e6) - (order.get(b.stageId) ?? 1e6) || a.firstAt - b.firstAt)
    .map(({ firstAt: _firstAt, ...stage }) => stage);

  return {
    view: "task",
    ...summary,
    ...(tally.hasCacheRead ? { cacheRead: tally.cacheRead } : {}),
    atLeast: reasonsOf(tally, untracked),
    stages,
  };
}

function productsView(log: WorkLogReader, ctx: UsageContext): ProductsUsage {
  const tallies = log.productTallies();
  const untrackedProducts = new Set(log.untracked().values());
  const shown = ctx.state.products.map((product) => ({ product, tally: tallies.get(product.id) ?? emptyTally() }));
  const all = shown.reduce(
    (
    sum,
    { tally }
  ) => ({
    ...sum,
    turns: sum.turns + tally.turns,
    noTokens: sum.noTokens + tally.noTokens,
    lost: sum.lost + tally.lost
  }),
    emptyTally()
  );
  return {
    view: "products",
    products: shown.map(({ product, tally }) => ({ productId: product.id, turns: tally.turns, ...figures(tally, untrackedProducts.has(product.id)) })),
    atLeast: reasonsOf(all, shown.some(({ product }) => untrackedProducts.has(product.id))),
  };
}

function todayView(log: WorkLogReader, ctx: UsageContext): TodayUsage {
  const { from, to } = periodRange("today", ctx.now);
  const turns = ended(log.turns({ from, to }));
  const lookup = names(ctx.state, log, ctx.task, ctx.taskName);
  const before = from < log.since();
  const tally = turns.reduce(addTurn, emptyTally());
  const toolIds = [...new Set([
    ...ctx.state.tools.filter((tool) => tool.status === "ready" || turns.some((turn) => turn.toolId === tool.id)).map((tool) => tool.id),
    ...turns.map((turn) => turn.toolId)
  ])];
  const byTool = toolIds.map((toolId) => {
    const toolTally = turns.filter((turn) => turn.toolId === toolId).reduce(addTurn, emptyTally());
    return { toolId, label: lookup.tool(toolId), turns: toolTally.turns, ...figures(toolTally, before && toolTally.turns > 0) };
  });
  return { view: "today", turns: tally.turns, ...figures(tally, before), atLeast: reasonsOf(tally, before), byTool };
}

function lineOf(key: string, label: string, turns: readonly WorkTurn[], extra: Partial<WorkUsageLine> = {}, beforeTracking = false): WorkUsageLine {
  const tally = turns.reduce(addTurn, emptyTally());
  return { key, label, ...figures(tally, beforeTracking), detail: detailOf(tally), ...extra };
}

/**
 * Tokens per model exactly as reported; agent time only with the model the agent's session ran on.
 * `beforeTracking`: the period starts before Petrina kept track, so any model's line may miss work.
 */
export function modelSplit(turns: readonly WorkTurn[], lines: readonly TokenLine[], beforeTracking = false): WorkUsageLine[] {
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const rows = new Map<string, {
    tokens: number;
    hasTokens: boolean;
    workMs: number;
    hasTime: boolean;
    lost: number;
    noTokens: number;
    tools: Set<Id>;
    detail: Required<Detail>;
    has: Record<keyof Detail, boolean>
  }>();
  const row = (label: string, toolId: Id) => {
    let entry = rows.get(label);
    if (!entry) {
      entry = {
        tokens: 0,
        hasTokens: false,
        workMs: 0,
        hasTime: false,
        lost: 0,
        noTokens: 0,
        tools: new Set(),
        detail: {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0
      },
        has: {
        input: false,
        cacheRead: false,
        cacheWrite: false,
        output: false
      }
      };
      rows.set(label, entry);
    }
    entry.tools.add(toolId);
    return entry;
  };
  for (const line of lines) {
    const owner = turnById.get(line.turnId);
    if (!owner) continue;
    const entry = row(lineModelLabel(line), owner.toolId);
    entry.tokens += line.total ?? 0;
    entry.hasTokens = true;
    for (const key of ["input", "cacheRead", "cacheWrite", "output"] as const) {
      if (line[key] === undefined) continue;
      entry.detail[key] += line[key]!;
      entry.has[key] = true;
    }
  }
  for (const turn of turns) {
    if (!turn.end) continue;
    const entry = row(turnModelLabel(turn), turn.toolId);
    if (turn.workMs !== undefined) {
      entry.workMs += turn.workMs;
      entry.hasTime = true;
    }
    if (turn.end === "lost") entry.lost += 1;
    else if (!turn.tokens || turn.tokens.total === undefined) entry.noTokens += 1;
  }
  return [...rows.entries()]
    .map(([label, entry]) => {
      const tokens: Figure = { atLeast: entry.hasTokens && (entry.lost > 0 || entry.noTokens > 0 || beforeTracking) };
      if (entry.hasTokens) tokens.value = entry.tokens;
      else if (entry.lost > 0 || beforeTracking) tokens.unknown = true;
      const time: Figure = { atLeast: entry.hasTime && (entry.lost > 0 || beforeTracking) };
      if (entry.hasTime) time.value = entry.workMs;
      else if (entry.lost > 0 || beforeTracking) time.unknown = true;
      const detail: Detail = {};
      for (const key of ["input", "cacheRead", "cacheWrite", "output"] as const) if (entry.has[key]) detail[key] = entry.detail[key];
      const toolId = entry.tools.size === 1 && label !== CHANGED_LABEL && label !== NOT_CONFIRMED_LABEL ? [...entry.tools][0] : undefined;
      return { key: `model:${label}`, label, tokens, time, detail, ...(toolId ? { toolId } : {}) };
    })
    .sort(byTokens);
}

function analyticsView(log: WorkLogReader, request: { period: UsagePeriod; productId?: Id }, ctx: UsageContext): AnalyticsUsage {
  const range = periodRange(request.period, ctx.now);
  const filter = { from: range.from, to: range.to, ...(request.productId ? { productId: request.productId } : {}) };
  const turns = ended(log.turns(filter));
  const lines = log.lines(filter);
  const moments = log.moments(filter);
  const lookup = names(ctx.state, log, ctx.task, ctx.taskName);
  const since = log.since();
  const addedLater = (productId: Id) => (lookup.record(productId)?.addedAt ?? -Infinity) > since;
  const before = range.from < since && !(request.productId && addedLater(request.productId));
  const untracked = log.untracked();
  const tally = turns.reduce(addTurn, emptyTally());

  const toolIds = [...new Set(turns.map((turn) => turn.toolId))];
  for (const tool of ctx.state.tools) if (tool.status === "ready" && !toolIds.includes(tool.id)) toolIds.push(tool.id);

  const buckets: ChartBucket[] = range.buckets.map((bucket) => {
    const inside = turns.filter((turn) => (turn.endedAt ?? turn.startedAt) >= bucket.start && (turn.endedAt ?? turn.startedAt) < bucket.end);
    const tokens: Record<Id, number> = {};
    const timeMs: Record<Id, number> = {};
    for (const turn of inside) {
      tokens[turn.toolId] = (tokens[turn.toolId] ?? 0) + (turn.tokens?.total ?? 0);
      timeMs[turn.toolId] = (timeMs[turn.toolId] ?? 0) + (turn.workMs ?? 0);
    }
    return { start: bucket.start, label: bucket.label, tokens, timeMs };
  });

  const byTool = [...group(
    turns,
    (turn) => turn.toolId
  ).entries()].map(([toolId, list]) => lineOf(
    `tool:${toolId}`,
    lookup.tool(toolId),
    list,
    { toolId },
    before
  )).sort(byTokens);
  const byRole = [...group(
    turns,
    (turn) => turn.roleId
  ).entries()].map(([roleId, list]) => lineOf(
    `role:${roleId}`,
    lookup.role(roleId),
    list,
    { roleId },
    before
  )).sort(byTokens);
  const byProduct = request.productId
    ? undefined
    : [...group(turns, (turn) => turn.productId).entries()]
        .map(([productId, list]) => {
          const product = lookup.product(productId);
          return lineOf(
            `product:${productId}`,
            product.label,
            list,
            {
            productId,
            ...(product.removed ? { note: "removed" } : {})
          },
            before && !addedLater(productId)
          );
        })
        .sort(byTokens);
  const byTask = [...group(turns, (turn) => turn.taskId).entries()]
    .map(([taskId, list]) => {
      const product = lookup.product(list[0]!.productId);
      return lineOf(
        `task:${taskId}`,
        lookup.taskName(taskId) ?? "A task no longer on the board",
        list,
        {
        taskId,
        productId: list[0]!.productId,
        context: product.label,
        ...(product.removed ? { note: "removed" } : {})
      },
        before && untracked.has(taskId)
      );
    })
    .sort(byTokens);

  const claudeMainOnly = turns.filter((turn) => turn.toolId === "claude-code" && turn.mainOnly).length;
  const codexHelperTurns = turns.filter((turn) => turn.toolId === "codex" && turn.helpers > 0).length;

  return {
    view: "analytics",
    period: request.period,
    ...(request.productId ? { productId: request.productId } : {}),
    from: range.from,
    to: range.to,
    headline: { ...figures(tally, before), turns: tally.turns, tasks: new Set(turns.map((turn) => turn.taskId)).size },
    atLeast: reasonsOf(tally, before),
    chart: { hourly: range.hourly, tools: toolIds.map((toolId) => ({ toolId, label: lookup.tool(toolId) })), buckets },
    overTime: tokensOverTime(turns, lines, range.buckets, range.hourly, lookup.tool),
    limits: limitsOverTime(
      log.usageHistory({
      from: ctx.now - 30 * 86_400_000,
      to: ctx.now + 1
    }),
      ctx.usage ?? ctx.state.pool.usage ?? [],
      limitBuckets(
      request.period,
      ctx.now
    ),
      request.period === "today",
      ctx.now,
      lookup.tool,
      ctx.state.tools.map((tool) => tool.id)
    ),
    byTool,
    byModel: modelSplit(turns, lines, before),
    byRole,
    ...(byProduct ? { byProduct } : {}),
    byTask,
    squad: squadView(turns, moments, dayBuckets(request.period, ctx.now), lookup, (taskId) => log.turns({ taskId })),
    about: { turns: tally.turns, codexHelperTurns, claudeMainOnly, tools: toolIds },
  };
}

/** Work out one view from the log. */
export function usageView<R extends UsageRequest>(log: WorkLogReader, request: R, ctx: UsageContext): UsageViewFor<R> {
  switch (request.view) {
    case "readings":
      return readingsView(
        log.usageHistory({
        from: request.snapshotAt - 30 * 86_400_000,
        to: request.snapshotAt + 1
      }),
        ctx.state.pool.usage ?? [],
        request
      ) as UsageViewFor<R>;
    case "node":
      return nodeUsage(log, request, ctx) as UsageViewFor<R>;
    case "task":
      return taskView(log, request.taskId, ctx) as UsageViewFor<R>;
    case "products":
      return productsView(log, ctx) as UsageViewFor<R>;
    case "today":
      return todayView(log, ctx) as UsageViewFor<R>;
    case "analytics":
      return analyticsView(log, request, ctx) as UsageViewFor<R>;
  }
  throw new Error("Unknown view");
}
