import { verifierProfiles, type Stage } from "@petrina/core";
import { VerifierBallots } from "../../src/verifier-ballots.js";
import { ReviewReports } from "../../src/review-reports.js";
import type { VerifierSelection } from "../../src/ports/verifiers.js";
import { executionFor } from "../../src/repository-context.js";
import { profileSelectionFixture } from "./profile-selection.js";

/** The real report and ballot controllers share the real profile selector, with explicit catalog/time/history observations. */
export function reviewSelectionFixture(profileIds: string[], findingIds: string[], round = 1) {
  const f = profileSelectionFixture();
  f.state.products[0]!.id = "p"; f.task.productId = "p"; f.task.repository!.productId = "p";
  const scope = executionFor(f.task);
  const stage = { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds } satisfies Stage;
  f.task.plan = { rationale: "Verify", plannerProfileId: "sol-high", stages: [stage] }; f.task.stageIndex = 0; f.task.rounds = { [stage.id]: round };
  f.state.pool.paused = false;
  const offered = new Set(profileIds.map(id => f.profile(id)!.toolId));
  f.state.tools = f.state.tools.map(tool => ({ ...tool, status: offered.has(tool.id) ? "ready" : "not-installed" }));
  f.state.setup!.checks = f.state.profiles.filter((profile, index, all) => all.findIndex(item => item.toolId === profile.toolId) === index)
    .map(profile => ({ id: profile.toolId as "codex", status: offered.has(profile.toolId) ? "ready" : "not-installed" }));
  const selection: VerifierSelection = {
    candidates: stage => verifierProfiles({ profiles: f.state.profiles, tools: f.state.tools, usable: f.host.usableTools(), planned: stage.profileIds.map(id => ({ id, toolId: f.profile(id)?.toolId })) }),
    resolve: (task, id) => { const choice = f.selection.choose(id, task, "verifier"); return !choice ? undefined : choice.kind === "none" ? { kind: "unavailable", waiting: choice.waiting } : { kind: "selected", profile: choice.profile }; },
    admissionsClosed: () => false,
  };
  const checkpoints: unknown[] = [], notes: string[] = [];
  const reports = new ReviewReports({ roles: () => f.state.roles, hasPendingReviewers: () => false,
    id: () => { throw new Error("This scenario does not raise a new report"); }, now: f.now, verdict() {}, note(_task, _tone, text) { notes.push(text); } });
  const ballots = new VerifierBallots({ profile: f.profile, profileName: id => f.host.profileName(id), toolName: id => f.host.toolName(id), roleResult: (id, task) => f.host.role(id, task)?.result }, selection,
    { checkpoint: task => { checkpoints.push(structuredClone(task)); }, changed: task => { checkpoints.push(structuredClone(task)); }, note(_task, _tone, text) { notes.push(text); }, now: f.now });
  f.task.findings = findingIds.map(id => ({ id, text: 'The ' + id + ' greeting is missing.', severity: "blocking", raisedBy: "argon-high", confirmedBy: [], status: "open", evidence: 'Opened the ' + id + ' page.' }));
  return { ...f, scope, stage, reports, ballots, checkpoints, notes, base: "a".repeat(40), first: "b".repeat(40), tree: "c".repeat(40),
    limit(...tools: string[]) { f.state.pool.limited = tools.map(toolId => ({ toolId, until: f.now() + 3_600_000, reason: toolId + "'s usage limit" })); },
    next() { reports.settle(f.task, stage); return ballots.next(f.task, stage); },
  };
}
