import { columnOf, roleForTask, slotWait, type AgentProfile, type Id, type Role } from "@petrina/core";
import { TurnRecovery } from "../../src/turn-recovery.js";
import { ModelCapacity, capacityWaitingWords, expireModelCapacity, recordModelCapacity } from "../../src/model-capacity.js";
import type { CapacityRefusal, TurnRecoveryErrors, TurnRecoveryHost, UsageRefusal } from "../../src/turn-recovery-ports.js";
import { executionFor, taskView } from "../../src/repository-context.js";
import { waitForAgentUsage } from "../../src/agent-step-state.js";
import { profileSelectionFixture } from "./profile-selection.js";
import { ControlledClock } from "./clock.js";
import { ScriptedAgents, type ScriptedPrompt } from "./scripted-agents.js";

export const CAPACITY = "The selected model is at capacity";
export class FullModel extends Error implements CapacityRefusal {
  constructor(readonly toolId: string, readonly modelId: string, readonly profileId: string, readonly sessionId?: string, readonly retryAfterMs?: number) { super(CAPACITY); }
}
export class AccountLimit extends Error implements UsageRefusal {
  readonly source = "refusal";
  constructor(readonly toolId: string, readonly until: number, readonly reason: string, readonly retry?: boolean) { super(reason); }
}
export class UsageWait extends Error { constructor(readonly words: string, readonly capacity = false) { super(words); } }
class Aborted extends Error {}
class SourceRefresh extends Error {}
class ScreenWait extends Error {}

/** Actual recovery/selection/state owners; provider replies are the only scripted attempt effect. */
export function capacityFixture(respond: (prompt: ScriptedPrompt, signal: AbortSignal) => string | Promise<string> = () => "Completed") {
  const f = profileSelectionFixture(), { state, task, profile } = f, scope = executionFor(task);
  const clock = new ControlledClock(); clock.at = f.now();
  f.host.now = clock.now;
  f.host.awayFromBuilder = () => undefined;
  f.host.capacityWaiting = (until, now) => capacityWaitingWords(until, now, CAPACITY);
  state.pool.paused = false; state.pool.limit = 4;
  state.setup!.checks = state.tools.map(tool => ({ id: tool.id as "codex", status: "ready" }));
  const events: { kind: string; profileId?: string; retry?: boolean; ms?: number; roleId?: string; member?: string }[] = [];
  const limits: UsageRefusal[] = [], failures: unknown[] = [];
  const agents = new ScriptedAgents(respond), sessions = new Map<string, string>();
  const active = new Set<Awaited<ReturnType<typeof agents.start>>>();
  const errors: TurnRecoveryErrors = {
    capacity: (error): error is FullModel => error instanceof FullModel,
    usage: (error): error is AccountLimit => error instanceof AccountLimit,
    waiting: words => new UsageWait(words, words.startsWith(CAPACITY)), usageWait: words => new UsageWait(words), capacityWait: words => new UsageWait(words, true),
    aborted: () => new Aborted(), sourceRefresh: () => new SourceRefresh(), screenWait: () => new ScreenWait(),
  };
  const host: TurnRecoveryHost = {
    now: clock.now, catalog: { profile, role: (id, current) => roleForTask(state.roles, id, current),
      choose: (request, bound, room) => f.selection.choose(request.profileId, bound, request.roleId, room, request.reviewerKey) },
    readiness: { hold: () => { throw new Error("Unexpected readiness hold"); }, resolveHeld: () => { throw new Error("Unexpected held readiness probe"); }, resolve: () => { throw new Error("Unexpected readiness probe"); } },
    admissionsClosed: () => state.pool.paused, admissionWait: () => "The pool is paused", sourceRefreshDue: () => false,
    slotWait: (current, chosen, toolId) => slotWait(state, { ...chosen, taskId: current.id, toolId }), toolName: id => state.tools.find(tool => tool.id === id)?.name ?? id,
    attempt: (_bound, roleId, _planned, chosen, retry) => { events.push({ kind: "attempt", profileId: chosen.id, roleId, retry }); },
    owesRetry: () => { events.push({ kind: "owesRetry" }); }, keepWords: () => { events.push({ kind: "keepWords" }); },
    waitForUsage: (current, words) => { waitForAgentUsage(current, words, clock.now(), () => columnOf(taskView(current), state.roles)); },
    recordLimit: (_current, _roleId, _profileId, error) => { limits.push(error); }, waitForScreen: () => { events.push({ kind: "screenWait" }); },
    discardUnavailable: (_bound, _roleId, error) => { failures.push(error); return false; },
    beforeMainAttempt: () => { events.push({ kind: "beforeMain" }); }, showReviewWork: () => { events.push({ kind: "showWork" }); }, checkpoint: () => { events.push({ kind: "checkpoint" }); },
  };
  const capacity = new ModelCapacity({ profile, now: clock.now, words: f.host.capacityWaiting,
    record(current, roleId, profileId, error, ms) { recordModelCapacity(current, profileId, error, ms, clock.now()); events.push({ kind: "capacity", profileId, roleId, ms }); },
  });
  const recovery = new TurnRecovery(host, errors, capacity);
  const prepare = (roleId = "builder", profileIds = ["sol-xhigh"]) => {
    task.plan = { rationale: "Capacity policy", plannerProfileId: "sol-xhigh", stages: [{ id: "target", kind: roleId === "builder" ? "do" : "review-chain", title: "Target", roleId, profileIds, maxRounds: 1 }] };
    task.stageIndex = 0; task.state = "running"; task.holdsSlot = false;
    if (roleId !== "builder") task.hunt = { stageId: "target", round: 1, reported: {}, findings: 0 };
  };
  const perform = async (chosen: AgentProfile, roleId: Id, member: string | undefined, signal: AbortSignal): Promise<string> => {
    const role = roleForTask(state.roles, roleId, task)!;
    const key = JSON.stringify([roleId, chosen.id, member]);
    const reopen = sessions.get(key);
    const session = await agents.start({ profile: chosen, cwd: "scripted:capacity", signal, ...(reopen ? { reopen } : {}), callbacks: {
      onActivity() {}, onPlanStep() {}, onPermission: () => { throw new Error("Unexpected native permission"); },
    } }, role);
    active.add(session); sessions.set(key, session.sessionId);
    try { return (await session.prompt("Scripted attempt; native prompt wording has separate contracts")).text; }
    finally { await session.stop(); active.delete(session); }
  };
  const main = (roleId = "builder", plannedId = "sol-xhigh", signal = new AbortController().signal) => recovery.main({ scope, roleId, plannedId, signal, attempt: chosen => perform(chosen, roleId, undefined, signal) });
  const member = (roleId = "code-reviewer", plannedId = "sol-high", member = "review-0", signal = new AbortController().signal) => recovery.member({ scope, roleId, plannedId, signal, member, key: member, roomCheck() { throw new Error("Unexpected explicit member room check without a room callback"); }, ...(member.startsWith("review-") ? { reviewerKey: member.slice("review-".length) } : {}),
    attempt: (_role: Role, chosen) => perform(chosen, roleId, member, signal),
  });
  const release = (modelId?: string) => {
    const entries = (task.modelCapacity ?? []).filter(entry => !modelId || entry.modelId === modelId);
    if (!entries.length) throw new Error("No actual capacity wait to advance");
    clock.advance(Math.max(...entries.map(entry => entry.until)) - clock.now());
    expireModelCapacity(task, clock.now());
    task.state = "running";
  };
  const close = async () => { await Promise.all([...active].map(async session => { await session.stop(); active.delete(session); })); };
  prepare();
  return { ...f, state, task, scope, clock, events, limits, failures, agents, host, selectionHost: f.host, errors, capacity, recovery, profile, prepare, perform, main, member, release, close };
}
