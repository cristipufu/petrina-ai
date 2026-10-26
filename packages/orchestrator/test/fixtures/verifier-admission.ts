import { columnOf, finishTaskStep, roleForTask, type VerifierSeat, type Vote } from "@petrina/core";
import { ParallelAdmissionGroup } from "../../src/parallel-admission-group.js";
import { waitForAgentUsage } from "../../src/agent-step-state.js";
import { taskView } from "../../src/repository-context.js";
import type { AgentOwnership } from "../../src/ports/agent-workflow.js";
import type { ParallelAdmissionHost, ParallelMember, ParallelWorkspaceEffects } from "../../src/ports/parallel-admission.js";
import type { PendingVerification, VerifierVerdict } from "../../src/ports/verifiers.js";
import { reviewRoundsFixture } from "./review-rounds.js";
import { ReleaseEvents } from "./release-events.js";
import { ScriptedAgents, type ScriptedPrompt } from "./scripted-agents.js";
import { completionOf, completedBeforeProgress } from "@petrina/test-support/progress-wait";

export class VerifierWait extends Error { constructor(readonly words: string) { super(words); } }
class Stopped extends Error {}

export interface VerifierAttempt extends ScriptedPrompt {
  readonly seat: string;
  readonly plannedProfileId: string;
  readonly findingIds: readonly string[];
  readonly selectionReason: string;
}
export interface VerifierAdmissionOptions {
  limit?: number;
  limited?: string[];
  antigravity?: boolean;
  answer?: (attempt: VerifierAttempt, signal: AbortSignal) => Vote["verdict"] | readonly VerifierVerdict[] | Promise<Vote["verdict"] | readonly VerifierVerdict[]>;
}

/** Actual selector, ballot, admission group and round owner share one task. Only normalized provider answers are supplied. */
export function verifierAdmissionFixture(options: VerifierAdmissionOptions = {}) {
  const f = reviewRoundsFixture(options.limited ?? ["claude-code"], options.antigravity), { state, task, scope } = f;
  state.pool.limit = options.limit ?? 3;
  const stop = new AbortController(), events = new ReleaseEvents();
  const ownership: AgentOwnership = { drivers: new Map(), settling: new Map(), pendingAdmissions: new Map(), groups: new Map() };
  const attempts: VerifierAttempt[] = [], completed: VerifierAttempt[] = [], answers = new Map<string, readonly VerifierVerdict[]>();
  const assigned = new Map<string, { seat: VerifierSeat; plannedProfileId: string; selectionReason: string }>();
  const sessions = new Set<Awaited<ReturnType<ScriptedAgents["start"]>>>();
  const slotSnapshots: ReturnType<typeof f.snapshot>[] = [];
  let pending: PendingVerification | undefined, running: Promise<PendingVerification> | undefined;
  let phaseCompletion: ReturnType<typeof completionOf>;
  let phaseActive = false;
  let started = 0, accepted = 0;
  const agents = new ScriptedAgents(async (prompt, signal) => {
    const place = assigned.get(prompt.sessionId);
    if (!place) throw new Error("An admitted verifier needs its actual assigned place");
    const attempt: VerifierAttempt = { ...prompt, seat: place.seat.key, plannedProfileId: place.plannedProfileId,
      findingIds: [...place.seat.findingIds], selectionReason: place.selectionReason };
    attempts.push(attempt); events.release(`started-${++started}`);
    const value = await (options.answer?.(attempt, signal) ?? "real");
    const verdicts: readonly VerifierVerdict[] = typeof value === "string"
      ? attempt.findingIds.map(id => ({ id, verdict: value, reason: `Scripted ${attempt.toolId} checked ${id}.` })) : value;
    answers.set(prompt.sessionId, verdicts);
    // Native VerifyResult parsing is covered by retained ACP contracts. This port receives normalized verdicts.
    return JSON.stringify({ verdicts });
  });
  const observe = () => { slotSnapshots.push(structuredClone(state)); };
  const host: ParallelAdmissionHost = {
    state: () => state, activeState: () => state, now: f.now, draining: () => false,
    admissionsClosed: () => state.pool.paused, admissionWait: () => "The pool is paused", sourceRefreshDue: () => false,
    selectScreen() {}, syncScreen() {}, showReviewWork() {},
    finishStep: current => finishTaskStep(current, scope.work, f.now()),
    waitForUsage: (current, words) => waitForAgentUsage(current, words, f.now(), () => columnOf(taskView(current), state.roles)),
    rememberReviewer() { throw new Error("A voter does not occupy a reviewer place"); },
    changed: observe, checkpoint: observe, schedule: observe,
  };
  const unexpected = (): never => { throw new Error("Unexpected readiness/source/screen observation in a supplied ready verifier catalog"); };
  const group = new ParallelAdmissionGroup(host, { ownership,
    catalog: { profile: f.profile, role: (id, current) => roleForTask(state.roles, id, current), onUsable: id => id,
      choose: (request, current, room) => f.selection.choose(request.profileId, current, request.roleId, room, request.reviewerKey) },
    readiness: { hold: unexpected, open: unexpected, resolve: unexpected, resolveHeld: unexpected, yieldHeld: unexpected, charge: unexpected },
    errors: { aborted: () => new Stopped(), sourceRefresh: unexpected, screenWait: unexpected, usage: words => new VerifierWait(words),
      classify: error => error instanceof Stopped ? { kind: "abort" } : error instanceof VerifierWait ? { kind: "usage", error, words: error.words, capacity: false } : { kind: "failure" },
      waitingFor: words => ({ error: new VerifierWait(words), words, capacity: false }),
    },
  });
  const workspaces: ParallelWorkspaceEffects = {
    reference: member => `scripted:${member}`, prepare: async () => ({ activate() {}, finish() {} }),
    stopHelpers() {}, closeTaskRun() {}, releasedStops: async () => {}, finish: async () => {},
  };
  const executePhase = (): Promise<PendingVerification> => {
    if (stop.signal.aborted) return Promise.reject(new Stopped());
    const next = f.next();
    if (!next?.voters.length) return Promise.reject(new Error("No actual voter phase remains"));
    pending = next; f.voteStep(next);
    const members: ParallelMember[] = next.seats.map((place, index) => ({ key: `vote-${place.key}`, reviewKey: `verifier:${place.key}`, roleId: "verifier", profileId: next.voters[index]!,
      async work(copy, _room, seat, used, _agent, _continuing, signal, selection) {
        const profile = f.profile(seat);
        if (!profile) throw new Error("Admitted verifier profile is unavailable");
        const role = roleForTask(state.roles, "verifier", task)!;
        const session = await agents.start({ profile, cwd: copy, signal, callbacks: { onActivity() {}, onPlanStep() {}, onPermission: () => { throw new Error("No native permission in normalized verifier policy"); } } }, role);
        sessions.add(session);
        assigned.set(session.sessionId, { seat: place, plannedProfileId: place.profileId, selectionReason: [place.replaced?.reason ?? place.reason, selection?.selectionReason].filter(Boolean).join(" ") });
        try {
          await session.prompt(`Normalized assigned findings: ${place.findingIds.join(", ")}`);
          const verdicts = answers.get(session.sessionId);
          if (!verdicts) throw new Error("The scripted provider supplied no normalized answer");
          used(profile.id);
          f.ballots.recordAnswers(task, { place, profileId: profile.id, plannedProfileId: place.profileId, findingIds: place.findingIds }, verdicts);
          completed.push(attempts.find(attempt => attempt.sessionId === session.sessionId)!);
          ownership.groups.get(task.id)?.finished(`vote-${place.key}`);
          events.release(`answered-${++accepted}`);
        } finally { await session.stop(); sessions.delete(session); }
      },
    }));
    task.holdsSlot = true;
    return group.run({ scope, signal: stop.signal, members, workspaces, status: () => "Voting" }).then(() => next);
  };
  const phase = (): Promise<PendingVerification> => {
    if (phaseActive) return Promise.reject(new Error("A verifier phase is already running"));
    if (stop.signal.aborted) return Promise.reject(new Stopped());
    phaseActive = true;
    // Publish ownership before even synchronous selection/recording can begin.
    const work = Promise.resolve().then(executePhase);
    running = work;
    phaseCompletion = completionOf(work);
    void work.then(() => { phaseActive = false; }, () => { phaseActive = false; });
    return work;
  };
  const progress = async (key: string): Promise<void> => {
    const owner = phaseCompletion;
    if (!owner) throw new Error("Verifier progress needs its admitted phase");
    const cancel = new AbortController(), ended = Symbol("verifier phase ended");
    const marker = events.wait(key, AbortSignal.any([stop.signal, cancel.signal]));
    let unsubscribe = () => {};
    try {
      const completion = new Promise<typeof ended>(resolve => { unsubscribe = owner.subscribe(() => resolve(ended)); });
      // Already recorded progress wins even when its producer has subsequently settled.
      if (await Promise.race([marker, completion]) === ended)
        completedBeforeProgress(owner.current()!, `The verifier phase completed before ${key}`);
    } finally { unsubscribe(); cancel.abort(); }
  };
  return { ...f, agents, group, ownership, attempts, completed, slotSnapshots, phase, signal: stop.signal,
    started: (count: number) => progress(`started-${count}`), answered: (count: number) => progress(`answered-${count}`),
    unavailable: (words: string) => new VerifierWait(words),
    finishBallot() {
      const next = f.next();
      if (!pending || next?.voters.length) throw new Error("An actual required verifier remains");
      return f.finish(next ?? pending);
    },
    completeRound: f.close,
    async close() {
      stop.abort();
      const results = await Promise.allSettled([...(running ? [running] : []), ...[...sessions].map(async session => { await session.stop(); sessions.delete(session); })]);
      const errors = results.flatMap(result => result.status === "rejected" && !(result.reason instanceof VerifierWait) && !(result.reason instanceof Stopped) ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Verifier policy fixture work did not settle");
    },
  };
}
