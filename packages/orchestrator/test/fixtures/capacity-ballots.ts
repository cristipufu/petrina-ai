import { ReleaseEvents } from "./release-events.js";
import { beginAgentStep, finishTaskStep, verifierProfiles, type Id, type Stage, type VerifierSeat } from "@petrina/core";
import { ParallelAdmissionGroup } from "../../src/parallel-admission-group.js";
import { VerifierBallots } from "../../src/verifier-ballots.js";
import type { AgentOwnership } from "../../src/ports/agent-workflow.js";
import type { ParallelAdmissionHost, ParallelMember, ParallelWorkspaceEffects } from "../../src/ports/parallel-admission.js";
import { capacityFixture, CAPACITY, UsageWait } from "./capacity-recovery.js";
import type { ScriptedPrompt } from "./scripted-agents.js";

/** Actual recovery, selector, admission group and ballot share one canonical task/state and registry. */
export function capacityBallotFixture(respond: (prompt: ScriptedPrompt, signal: AbortSignal) => string | Promise<string>) {
  const f = capacityFixture(respond), { state, task, scope, clock } = f;
  f.prepare("code-reviewer", ["opus-high"]);
  const stage = task.plan!.stages[0]! as Stage;
  // This is an explicitly supplied normalized review input, not a native review/SHA/check claim.
  task.hunt!.input = { file: "scripted:review-input", digest: "opaque-review-identity", heads: {} };
  task.findings = [{ id: "finding", text: "The greeting is missing", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "open" }];
  beginAgentStep(task, "verifier", "sol-high", clock.now(), state.roles);
  const ballots = new VerifierBallots({ profile: f.profile, profileName: id => id, toolName: f.host.toolName, roleResult: (id, current) => f.host.catalog.role(id, current)?.result }, {
    candidates: current => verifierProfiles({ profiles: state.profiles, tools: state.tools, usable: f.selectionHost.usableTools(), planned: current.profileIds.map(id => ({ id, toolId: f.profile(id)?.toolId })) }),
    resolve: (current, id) => {
      const choice = f.selection.choose(id, current, "verifier");
      return !choice ? undefined : choice.kind !== "none" ? { kind: "selected", profile: choice.profile }
        : { kind: choice.waiting.startsWith(CAPACITY) ? "capacity" : "unavailable", waiting: choice.waiting };
    }, admissionsClosed: () => state.pool.paused,
  }, { checkpoint: () => { f.events.push({ kind: "ballotCheckpoint" }); }, changed: () => { f.events.push({ kind: "ballotChanged" }); }, note() {}, now: clock.now });
  const ownership: AgentOwnership = { drivers: new Map(), settling: new Map(), pendingAdmissions: new Map(), groups: new Map() };
  const stop = new AbortController(), ended = new ReleaseEvents();
  let endedCount = 0;
  const groupHost: ParallelAdmissionHost = {
    state: () => state, activeState: () => ({ ...state, now: clock.now() }), now: clock.now, draining: () => false,
    admissionsClosed: () => state.pool.paused, admissionWait: f.host.admissionWait, sourceRefreshDue: () => false,
    selectScreen() {}, syncScreen() {}, showReviewWork: f.host.showReviewWork,
    finishStep: current => finishTaskStep(current, scope.work, clock.now()),
    waitForUsage: f.host.waitForUsage, rememberReviewer() { throw new Error("Voters do not occupy reviewer-key positions"); },
    changed() {}, checkpoint() {}, schedule() { f.events.push({ kind: "groupSchedule" }); ended.release(`member-ended-${++endedCount}`); },
  };
  const group = new ParallelAdmissionGroup(groupHost, { ownership,
    catalog: { ...f.host.catalog, onUsable: id => id, choose: (request, current, room) => f.selection.choose(request.profileId, current, request.roleId, room, request.reviewerKey) },
    readiness: { ...f.host.readiness, open() { throw new Error("Unexpected readiness opening"); }, yieldHeld() { throw new Error("Unexpected readiness yield"); }, charge() { throw new Error("Unexpected readiness charge"); } },
    errors: {
      aborted: f.errors.aborted, sourceRefresh: f.errors.sourceRefresh, screenWait: f.errors.screenWait, usage: f.errors.usageWait,
      classify: error => error instanceof UsageWait ? { kind: "usage", error, words: error.words, capacity: error.capacity } : { kind: "failure" },
      waitingFor: words => { const error = new UsageWait(words, words.startsWith(CAPACITY)); return { error, words, capacity: error.capacity }; },
    },
  });
  const workspaces: ParallelWorkspaceEffects = {
    reference: key => `scripted:${key}`, prepare: async () => ({ activate() {}, finish() {} }),
    stopHelpers() {}, closeTaskRun() {}, releasedStops: async () => {}, finish: async () => {},
  };
  let pending: ReturnType<typeof ballots.next>, running: Promise<void> | undefined;
  const run = () => {
    pending = ballots.next(task, stage);
    if (!pending) throw new Error("No actual ballot phase is pending");
    const members: ParallelMember[] = pending.seats.map(place => ({ key: `vote-${place.key}`, reviewKey: `vote-${place.key}`, roleId: "verifier", profileId: place.profileId,
      async work(_copy, room, seat, used, _agent, _continuing, signal) {
        await f.recovery.member({ scope, roleId: "verifier", plannedId: place.profileId, signal, room, roomCheck: (toolId, profile) => room(toolId, profile), seat, member: `vote-${place.key}`, key: `vote-${place.key}`, used,
          attempt: async (_role, chosen) => {
            await f.perform(chosen, "verifier", `vote-${place.key}`, signal);
            // Explicit normalized verdict supplied after the actual scripted attempt; the ballot owns saved votes.
            ballots.recordAnswers(task, { place, profileId: chosen.id, plannedProfileId: place.profileId, findingIds: place.findingIds },
              place.findingIds.map(id => ({ id, verdict: "real", reason: "Controlled verifier reproduced the supplied finding" })));
            ownership.groups.get(task.id)?.finished(`vote-${place.key}`);
            return "Recorded";
          },
        });
      },
    }));
    task.holdsSlot = true;
    running = group.run({ scope, signal: stop.signal, members, status: () => "Voting", workspaces });
    return running;
  };
  const finish = () => {
    const next = ballots.next(task, stage);
    if (next?.voters.length) throw new Error("An actual required voter remains");
    if (!pending) throw new Error("No actual ballot to finish");
    return ballots.finish(task, pending);
  };
  return { ...f, group, ownership, ballots, stage, run, finish,
    selected: (): VerifierSeat[] => task.hunt?.panel?.seats ?? [],
    rejoin() { ownership.groups.get(task.id)?.rejoin?.(); },
    memberEnded(count: number) { return ended.wait(`member-ended-${count}`, stop.signal); },
    async close() { stop.abort(); await running?.catch(() => undefined); await f.close(); },
    tool(id: Id) { return f.profile(id)?.toolId; },
  };
}
