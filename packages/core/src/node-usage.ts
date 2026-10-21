// Usage belongs to a recorded step and an agent start, never a stage/round or native conversation.
import { figures, type Detail, type UsageContext } from "./analytics.js";
import type { Id, JourneyStep } from "./model.js";
import { listWords, type Figure } from "./numbers.js";
import { tallyOf, turnModelLabel, lineModelLabel, type TokenLine, type WorkLogReader, type WorkTurn } from "./worklog.js";

export const TOKEN_PARTS: readonly { key: keyof Detail; label: string }[] = [
  { key: "input", label: "New input" },
  { key: "cacheRead", label: "Reused from cache" },
  { key: "cacheWrite", label: "Written to cache" },
  { key: "output", label: "Output" },
];

type Breakdown = Record<keyof Detail, Figure>;
export interface NodeUsageRun {
  key: Id;
  roleId: Id;
  toolId: Id;
  model: string;
  /** The recorded zero-based reviewer position plus one; absent for unnumbered seats. */
  seat?: number;
  start: number;
  tokens: Figure;
  detail: Breakdown;
  models: { label: string; tokens: number }[];
}
export interface NodeUsage {
  view: "node";
  taskId: Id;
  nodeId: Id;
  empty?: "no-agent" | "unavailable" | "pending" | "unreported";
  tokens: Figure;
  detail: Breakdown;
  /** Reported turns or model lines omit some token parts, independently of other missing work. */
  breakdownIncomplete: boolean;
  explanation: string;
  runs: NodeUsageRun[];
}

function amounts(turns: readonly WorkTurn[], uncertain = false, lines: readonly TokenLine[] = []): { tokens: Figure; detail: Breakdown; breakdownIncomplete: boolean } {
  // A saved live report counts too. Missing live reports remain missing.
  const tally = tallyOf(turns.map(turn => ({ ...turn, end: turn.end ?? "finished" })));
  const tokens = turns.length ? figures(tally, uncertain).tokens : { atLeast: false };
  const turnIds = new Set(turns.map(turn => turn.id));
  const ownLines = lines.filter(line => turnIds.has(line.turnId));
  const detail = {} as Breakdown;
  const reports = turns.filter(turn => turn.tokens?.total !== undefined);
  const missingEnded = turns.some(turn => turn.end !== undefined && turn.tokens?.total === undefined);
  let breakdownIncomplete = false;
  for (const { key } of TOKEN_PARTS) {
    const reported = reports.filter(turn => turn.tokens?.[key] !== undefined);
    const missingPart = reported.length < reports.length || ownLines.some(line => line[key] === undefined);
    breakdownIncomplete ||= missingPart;
    detail[key] = {
      atLeast: reported.length > 0 && (missingPart || missingEnded || uncertain),
      ...(reported.length ? { value: reported.reduce((sum, turn) => sum + turn.tokens![key]!, 0) } : {}),
    };
  }
  return { tokens, detail, breakdownIncomplete };
}

/** Old evidence is usable only when the entire turn fits exactly one recorded agent step. */
function contains(step: JourneyStep, turn: WorkTurn, now: number): boolean {
  return step.kind === "agent" && !step.legacy && turn.startedAt >= step.startedAt
    && turn.startedAt < (step.endedAt ?? Infinity)
    && (turn.endedAt ?? now) <= (step.endedAt ?? Infinity);
}

export function nodeUsage(log: WorkLogReader, request: { taskId: Id; nodeId: Id }, ctx: UsageContext): NodeUsage {
  const task = ctx.state.tasks.find(task => task.id === request.taskId) ?? ctx.task?.(request.taskId);
  const step = task?.journey?.find(step => step.id === request.nodeId);
  const result: NodeUsage = { view: "node", ...request, ...amounts([]), explanation: "", runs: [] };
  if (!step) return { ...result, empty: "unavailable" };
  if (step.kind !== "agent") return { ...result, empty: "no-agent" };
  if (step.legacy) return { ...result, empty: "unavailable" };
  // Readers return one current row per turn; retaining the last also protects memory-backed evidence.
  const all = [...new Map(log.turns({ taskId: request.taskId }).map(turn => [turn.id, turn])).values()];
  const owner = (turn: WorkTurn): Id | undefined => {
    if (turn.journeyId !== undefined) return turn.journeyId;
    const turnEnd = turn.endedAt ?? ctx.now;
    const candidates = task!.journey!.filter(step => step.kind === "agent" && !step.legacy
      && (turnEnd === turn.startedAt ? step.startedAt <= turnEnd : step.startedAt < turnEnd) && (step.endedAt ?? Infinity) > turn.startedAt);
    if (candidates.length !== 1 || !contains(candidates[0]!, turn, ctx.now)) return undefined;
    const candidate = candidates[0]!;
    if ((turn.stageKind === "converge" || turn.stageKind === "review-chain") && turn.round !== candidate.round) return undefined;
    if (turn.stageId !== (candidate.stageId ?? `${task!.id}:plan`)) return undefined;
    // A grouped step can contain different reviewer roles; its time bounds still must be unique.
    const stage = task!.plan?.stages.find(stage => stage.id === candidate.stageId);
    const roles = [candidate.roleId, ...(candidate.agentInputs?.map(input => input.roleId) ?? []), ...(stage?.kind === "review-chain" ? stage.roleIds ?? [stage.roleId] : [])];
    return roles.includes(turn.roleId) ? candidate.id : undefined;
  };
  const owned = new Map(all.map(turn => [turn.id, owner(turn)]));
  const turns = all.filter(turn => owned.get(turn.id) === step.id).sort((a, b) => a.startedAt - b.startedAt);
  if (!turns.length) return { ...result, empty: step.usageTracked && step.startedAt >= log.since() ? step.endedAt === undefined ? "pending" : "unreported" : "unavailable" };
  const beforeTracking = step.startedAt < log.since();
  const ambiguous = all.some(turn => turn.journeyId === undefined && owned.get(turn.id) === undefined
    && turn.stageId === (step.stageId ?? `${task!.id}:plan`) && turn.startedAt < (step.endedAt ?? Infinity) && (turn.endedAt ?? ctx.now) > step.startedAt);
  const uncertain = beforeTracking || ambiguous;
  const missing = turns.filter(turn => turn.tokens?.total === undefined);
  const pending = missing.filter(turn => !turn.end).length;
  const explanation = [
    beforeTracking ? "Earlier work is not included in this step’s recorded usage." : "",
    pending ? "Token use for a turn still working is not reported yet." : "",
    ambiguous ? "Some older turns could not be separated safely from nearby steps and are left out." : "",
    turns.some(turn => turn.mainOnly) ? "Some reports cover only the main agent; helper use may be missing." : "",
  ].filter(Boolean).join(" ");
  const seatOf = (turn: WorkTurn): string | undefined => {
    if (turn.agentSeat !== undefined) return turn.agentSeat;
    const input = step.agentInputs?.findLast(input => input.roleId === turn.roleId && input.profileId === turn.profileId && input.at !== undefined && input.at <= turn.startedAt);
    if (input?.reviewerKey !== undefined) return input.reviewerKey;
    return step.team?.length ? undefined : turn.roleId;
  };
  const groups = new Map<string, WorkTurn[]>();
  const legacy = new Map<string, { id: string; session: string; profile: string }>();
  for (const turn of turns) {
    const seat = JSON.stringify([seatOf(turn), turn.roleId, turn.toolId, turn.profileId, turn.sessionId]);
    let key = turn.agentRunId;
    if (!key) {
      const prior = legacy.get(seat);
      if (!prior || turn.reason === "first" || prior.session !== turn.sessionId || prior.profile !== turn.profileId) legacy.set(seat, { id: turn.id, session: turn.sessionId, profile: turn.profileId });
      key = legacy.get(seat)!.id;
    }
    const list = groups.get(key) ?? [];
    list.push(turn); groups.set(key, list);
  }
  const starts = new Map<string, number>();
  const lines = log.lines({ taskId: request.taskId });
  const runs = [...groups.entries()].map(([key, list], index): NodeUsageRun => {
    const first = list[0]!;
    const seatKey = seatOf(first);
    const seat = seatKey !== undefined && /^(0|[1-9]\d*)$/.test(seatKey) ? Number(seatKey) + 1 : undefined;
    const start = seatKey === undefined ? index + 1 : (starts.get(seatKey) ?? 0) + 1;
    if (seatKey !== undefined) starts.set(seatKey, start);
    const ids = new Set(list.map(turn => turn.id));
    const models = new Map<string, number>();
    for (const line of lines) if (ids.has(line.turnId) && line.total !== undefined) models.set(lineModelLabel(line), (models.get(lineModelLabel(line)) ?? 0) + line.total);
    return { key, roleId: first.roleId, toolId: first.toolId, model: listWords([...new Set(list.map(turnModelLabel))]), ...(seat !== undefined ? { seat } : {}), start,
      ...amounts(list, false, lines), models: [...models].map(([label, tokens]) => ({ label, tokens })) };
  });
  if (turns.every(turn => turn.tokens?.total === undefined)) return {
    ...result, empty: pending ? "pending" : "unreported", runs,
    // Without a figure, there is no lower bound to explain as “at least”.
    explanation: [turns.some(turn => turn.end === "lost") ? "Petrina stopped before token use was reported." : "",
      ambiguous ? "Some older turns could not be separated safely from nearby steps and are left out." : ""].filter(Boolean).join(" "),
  };
  return { ...result, ...amounts(turns, uncertain, lines), explanation, runs };
}
