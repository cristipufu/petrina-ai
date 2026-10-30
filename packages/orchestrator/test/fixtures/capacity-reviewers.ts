import { beginYouStep, type CheckId, type Id } from "@petrina/core";
import { releaseAgentForDecision } from "../../src/agent-step-state.js";
import { ParallelAdmissionGroup } from "../../src/parallel-admission-group.js";
import { ReviewReports } from "../../src/review-reports.js";
import { executionFor } from "../../src/repository-context.js";
import { expireModelCapacity } from "../../src/model-capacity.js";
import { admissionFixture } from "./agent-workflow.js";
import { capacityFixture, CAPACITY, UsageWait } from "./capacity-recovery.js";
import { ReleaseEvents } from "./release-events.js";
import { waitDuring } from "./clock.js";
import type { ScriptedPrompt } from "./scripted-agents.js";

/** Recovery, review admission, reports and the queue share one actual state and ownership registry. */
export function capacityReviewersFixture(respond: (prompt: ScriptedPrompt, signal: AbortSignal) => string | Promise<string>) {
  const f = admissionFixture(4, 4, 3), current = f.task(f.ids[0]!)!;
  for (const task of f.state.tasks) { task.state = "backlog"; task.held = true; }
  const retry = capacityFixture(respond, { selection: f.selection, task: current, clock: f.clock });
  retry.prepare("code-reviewer", ["opus-high", "sol-high"]);
  current.state = "backlog";
  current.rounds.target = 1;
  executionFor(current).work.worktree = "supplied:review-workspace";
  const stage = current.plan!.stages[0]!;
  const releases = new ReleaseEvents(), calls: string[] = [], waits: string[] = [], copies: { member: string; reference: string; reuse: boolean }[] = [];
  const verdicts: { profileId: Id; round: number }[] = [];
  let sequence = 0;
  const reports = new ReviewReports({ roles: () => f.state.roles,
    hasPendingReviewers: task => Object.keys(task.hunt?.reported ?? {}).length < 2,
    id: () => `supplied-finding-${++sequence}`, now: f.clock.now,
    verdict: (_task, _roleId, profileId, round) => { verdicts.push({ profileId, round }); }, note() {},
  });
  const originalClassify = f.errors.classify;
  f.errors.classify = error => error instanceof UsageWait ? { kind: "usage", error, words: error.words, capacity: error.capacity } : originalClassify(error);
  f.errors.waitingFor = words => { const error = new UsageWait(words, words.startsWith(CAPACITY)); return { error, words, capacity: error.capacity }; };
  const originalWait = f.host.waitForUsage;
  f.groupHost.waitForUsage = (task, words) => { waits.push(words); originalWait(task, words); };
  f.host.expireLimits = () => { for (const task of f.state.tasks) expireModelCapacity(task, f.clock.now()); };
  const group = new ParallelAdmissionGroup(f.groupHost, { ownership: f.ownership, catalog: f.catalog, readiness: f.readiness, errors: f.errors });
  f.phases.review = async (task, selected, signal) => {
    if (task !== current || selected !== stage) throw new Error("Unexpected capacity review phase");
    const scope = executionFor(task);
    await group.run({ scope, signal, status: (running, waiting) => `${running} working; ${waiting} waiting`,
      members: stage.profileIds.flatMap((plannedId, index) => task.hunt!.reported[String(index)] ? [] : [{
        key: `review-${index}`, reviewKey: `reviewer:${index}`, reviewerKey: String(index), roleId: stage.roleId, profileId: plannedId,
        async work(_copy, room, seat, used, _agent, _continuing, memberSignal) {
          await retry.recovery.member({ scope, roleId: stage.roleId, plannedId, signal: memberSignal, room, roomCheck: room, seat,
            member: `review-${index}`, key: `reviewer:${index}`, reviewerKey: String(index), used,
            attempt: async (_role, chosen) => {
              calls.push(`attempt:${chosen.id}`);
              const text = await retry.perform(chosen, stage.roleId, `review-${index}`, memberSignal);
              // The provider's normalized report is supplied; the production report owner attributes it.
              reports.apply(task, stage, { verdict: "fail", findings: [{ text, severity: "important" }], confirms: [], disputes: [], resolves: [], confirmationEvidence: {} }, chosen.id, stage.roleId, String(index));
              task.hunt!.reported[String(index)] = true;
              f.ownership.groups.get(task.id)!.finished(`review-${index}`);
            },
          });
        },
      }]),
      workspaces: { reference: key => `supplied:copy:${key}`,
        prepare: async (member, reference, _continuing, reuse) => { copies.push({ member: member.key, reference, reuse }); return { activate() {}, finish() {} }; },
        stopHelpers() {}, closeTaskRun() {}, releasedStops: async () => {}, finish: async () => {},
      },
    });
    // This cohort ends at the report boundary. No ballot, acceptance or delivery result is manufactured.
    releaseAgentForDecision(task); task.state = "needs-you"; task.statusLine = "Supplied review reports are ready";
    f.host.changed(); return "stop";
  };
  f.phases.planner = async (task, signal) => {
    if (task === current) throw new Error("The prepared review has no planner");
    calls.push(`planner:${task.id}`);
    await releases.wait(task.id, signal);
    // Source/plan approval is the independent planner phase's explicit boundary response.
    task.confirmWork = true;
  };
  const originalGate = f.host.gate;
  f.host.gate = (task, kind) => {
    if (kind !== "plan") return originalGate(task, kind);
    releaseAgentForDecision(task); beginYouStep(task, "plan", f.clock.now()); task.state = "needs-you";
    task.statusLine = "Review the supplied plan"; f.host.changed();
  };
  let operation: Promise<void> | undefined;
  const checkFailures = () => {
    if (f.failures.length || f.driverErrors.length) throw new AggregateError([...f.failures, ...f.driverErrors.map(entry => entry.error)], "Capacity workflow failed before expected progress");
  };
  return { ...f, current, retry, calls, waits, copies, verdicts, releases,
    tools(ids: readonly string[]) { f.state.setup!.checks = f.state.tools.map(tool => ({ id: tool.id as CheckId, status: ids.includes(tool.id) ? "ready" : "logged-out" })); },
    start() {
      current.state = "waiting"; current.held = false; f.workflow.setPoolPaused(false);
      operation = f.ownership.settling.get(current.id);
      if (!operation) throw new Error("The review has no owned driver");
    },
    enqueue(index: 1 | 2) { const task = f.task(f.ids[index]!)!; task.held = false; task.state = "queued"; f.workflow.schedule(); return task; },
    releaseModel(model: string) { retry.release(model); f.state.now = f.clock.now(); f.workflow.schedule(); },
    waitFor<T>(check: () => T | undefined | false, what: string) {
      if (!operation) throw new Error("The review must start before progress is observed");
      return waitDuring(() => { checkFailures(); return check(); }, operation, what);
    },
    async done() { await operation; checkFailures(); if (current.state !== "needs-you") throw new Error("The reviewers did not both report"); return current; },
    async close() { try { await f.close(); } finally { await retry.close(); } },
  };
}
