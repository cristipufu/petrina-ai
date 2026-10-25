import { stepKey, type Id } from "@petrina/core";
import { executionFor } from "../../src/repository-context.js";
import { ParallelAdmissionGroup } from "../../src/parallel-admission-group.js";
import type { ParallelAdmissionRequest, ParallelMember, ParallelWorkspaceEffects } from "../../src/ports/parallel-admission.js";
import { admissionFixture } from "./agent-workflow.js";

/** One actual group and live registry; copy/program work is supplied explicitly by each contract. */
export function parallelFixture() {
  const base = admissionFixture(2, 2, 1), task = base.task(base.ids[0]!)!;
  base.state.pool.paused = false;
  task.state = "running"; task.stageIndex = 0;
  task.plan = { plannerProfileId: "opus-high", rationale: "Two independent review places", stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 }] };
  task.hunt = { stageId: "review", round: 1, reported: {}, findings: 0 };
  task.holdsSlot = true; task.agent = { roleId: "code-reviewer", profileId: "opus-high", since: base.clock.now(), step: 0 };
  // External scheduler notification is observed here; the group still owns its actual admission loop.
  const scheduled: Id[] = [];
  base.groupHost.schedule = () => { scheduled.push(task.id); };
  const group = new ParallelAdmissionGroup(base.groupHost, { ownership: base.ownership, catalog: base.catalog, readiness: base.readiness, errors: base.errors });
  const stop = new AbortController(), effects: string[] = [];
  const workspaces: ParallelWorkspaceEffects = {
    reference: key => `scripted:${key}`,
    prepare: async member => { effects.push(`prepare:${member.key}`); return { activate() { effects.push(`activate:${member.key}`); }, finish() { effects.push(`finish:${member.key}`); } }; },
    stopHelpers() { effects.push("stopHelpers"); }, closeTaskRun() { effects.push("closeTaskRun"); },
    releasedStops: async () => { effects.push("releasedStops"); }, finish: async readOnly => { effects.push(`finishCopies:${readOnly}`); },
  };
  const member = (key: "0" | "1", work: ParallelMember["work"]): ParallelMember => ({ key: `review-${key}`, reviewKey: `reviewer:${key}`, reviewerKey: key, roleId: "code-reviewer", profileId: task.plan!.stages[0]!.profileIds[Number(key)]!, work });
  const request = (members: readonly ParallelMember[]): ParallelAdmissionRequest => ({ scope: executionFor(task), signal: stop.signal, members, status: (running, waiting) => `${running} working; ${waiting} waiting`, workspaces });
  return { ...base, current: task, group, stop, effects, scheduled, workspaces, member, request, step: () => stepKey(task) };
}
