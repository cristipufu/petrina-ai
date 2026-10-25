import type { State, Task } from '../../src/model.js';
import { DEFAULT_PROFILES } from '../../src/profiles.js';
import { MemoryWorkLog, type TokenLine, type WorkMoment, type WorkTurn } from '../../src/worklog.js';
import { stateFixture, taskFixture } from './state.js';

export const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();

export const MIN = 60_000;

export const HOUR = 60 * MIN;

export function task(id: string, productId: string, extra: Partial<Task> = {}): Task {
  return taskFixture(stateFixture({ now: NOW, products: [{ id: productId, name: productId, repo: 'local/' + productId, tone: 'blue' }] }), {
    id, productId, title: 'Task ' + id, area: 'it', kind: 'feature', state: 'done', column: 'done', approvePlan: false, delivery: 'pull-request', approveDelivery: true, stageIndex: 3, statusLine: '', createdAt: NOW - 5 * HOUR, startedAt: NOW - 4 * HOUR, timeline: [],
    plan: { plannerProfileId: 'sonnet-medium', rationale: '', stages: [
      { id: id + ':design', kind: 'converge', title: 'Design', roleId: 'architect', profileIds: ['opus-high'], reviewerRoleId: 'design-reviewer', reviewerProfileIds: ['sol-xhigh'], maxRounds: 3 },
      { id: id + ':build', kind: 'do', title: 'Build', roleId: 'builder', profileIds: ['sol-high'] },
      { id: id + ':review', kind: 'review-chain', title: 'Review', roleId: 'code-reviewer', profileIds: ['opus-high', 'sol-xhigh'], maxRounds: 2 },
    ] }, ...extra,
  });
}

export function state(tasks: Task[]): State {
  return stateFixture({ now: NOW, products: [{ id: 'shop', name: 'Shop', repo: 'acme/shop', tone: 'blue' }, { id: 'notes', name: 'Notes', repo: 'acme/notes', tone: 'green' }], tasks, pool: { limit: 3, paused: false, toolCaps: {} }, work: { version: 1, since: NOW - 10 * 24 * HOUR } });
}

let serial = 0;

export function turn(extra: Partial<WorkTurn> & Pick<WorkTurn, "taskId" | "roleId" | "profileId">): WorkTurn {
  serial += 1;
  const profile = DEFAULT_PROFILES.find((entry) => entry.id === extra.profileId)!;
  const startedAt = extra.startedAt ?? NOW - 2 * HOUR;
  return {
    id: `t${serial}`,
    productId: "shop",
    stageId: `${extra.taskId}:build`,
    stageTitle: "Build",
    stageKind: "do",
    round: 1,
    fixing: false,
    toolId: profile.toolId,
    modelAsked: profile.modelId!,
    modelAskedName: profile.model,
    effortAsked: profile.effort,
    modelRan: profile.modelId!,
    modelRanName: profile.toolId === "codex" ? profile.modelId! : profile.model,
    effortRan: profile.effort,
    sessionId: `s-${extra.taskId}`,
    reason: "first",
    startedAt,
    endedAt: startedAt + 10 * MIN,
    end: "finished",
    mainOnly: false,
    helpers: 0,
    workMs: 10 * MIN,
    tokens: { input: 1000, cacheRead: 8000, cacheWrite: 500, output: 500, total: 10_000 },
    ...extra,
  };
}

export function line(turnId: string, model: string, total: number, extra: Partial<TokenLine> = {}): Omit<TokenLine, "turnId"> & { turnId?: string } {
  return { model, input: total * 0.1, cacheRead: total * 0.8, cacheWrite: total * 0.05, output: total * 0.05, total, ...extra, turnId };
}

export function logWith(entries: { turn: WorkTurn; lines?: Omit<TokenLine, "turnId">[] }[], moments: WorkMoment[] = [], since = NOW - 10 * 24 * HOUR): MemoryWorkLog {
  const log = new MemoryWorkLog(since);
  for (const entry of entries) log.addTurn(entry.turn, entry.lines ?? []);
  for (const moment of moments) log.addMoment(moment);
  return log;
}
