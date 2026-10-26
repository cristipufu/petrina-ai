import { expect, it } from "bun:test";
import { beginAgentStep, BUILT_IN_ROLES, checkReviewEvidence, DEFAULT_PROFILES, endAgentStep } from "@petrina/core";
import { repositoryView, ReviewReports, ReviewRoundCompletion, type ReviewReport } from "@petrina/orchestrator";
import { readFile } from "node:fs/promises";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { acceptanceContext } from "../../fixtures/acceptance-context.js";
import { builderContext } from "../../../src/builder-context.js";
import { buildPrompt } from "../../../src/prompts.js";

it("never asks reviewers to confirm a used-up acceptance failure, so reviewers who confirm what they are shown neither answer twice nor count it", async () => {
  const root = tempDir("petrina-held-acceptance-input-");
  try {
    const f = acceptanceContext(root), { task, scope } = f;
    task.acceptanceBlocked = true;
    task.findings.push({ id: "held-acceptance", text: "Failed acceptance check: People see the greeting on the welcome page", severity: "blocking", raisedBy: "opus-high", productIds: ["a"], status: "open", confirmedBy: [], answer: { fixed: true, text: "Recorded Builder repair claim", at: 150 } });
    const held = task.findings[0]!, stage = task.plan!.stages[2]!;
    // Acceptance already tried the Builder's claim; its saved failure is no new claim for a review to examine.
    task.stageIndex = 1;
    const earlier = beginAgentStep(task, "tester", "opus-high", 160, BUILT_IN_ROLES, undefined, scope.work);
    earlier.acceptanceChecks = [{ text: "People see the greeting on the welcome page", result: "fail", evidence: "Opened the welcome page; no greeting appeared." }];
    endAgentStep(task, { outcome: "1 failed", reason: "The acceptance repair did not pass" }, 180);
    task.stageIndex = 2;
    const snapshot = await f.context.captureReview(scope);
    expect(snapshot.findings).toEqual([]);
    const prompts = await Promise.all(["code-reviewer", "security-reviewer"].map(async role => (await f.context.sectionsFor(scope, role, undefined, undefined, undefined, snapshot)).map(section => `${section.title}\n${section.body}`).join("\n\n")));
    expect(prompts.filter(text => text.includes(held.id))).toEqual([]);
    const notes: string[] = []; let now = 200;
    const reports = new ReviewReports({ roles: () => BUILT_IN_ROLES, hasPendingReviewers: () => false, id: () => { throw new Error("No new findings were reported"); }, now: () => now++, verdict() {}, note(_task, _tone, text) { notes.push(text); } });
    task.hunt = { stageId: stage.id, round: 1, findings: task.findings.length, reported: { "0": true, "1": true } };
    const step = beginAgentStep(task, stage.roleId, "opus-high", now++, BUILT_IN_ROLES, stage.profileIds, scope.work);
    // These accepted reports confirm everything the actual immutable input offered, not a hand-maintained filter.
    const reply: ReviewReport = { verdict: "pass", findings: [], confirms: snapshot.findings.map(finding => finding.id), confirmationEvidence: {}, disputes: [], resolves: [] };
    // This is the actual validation callback used before a report is accepted. A leaked claimed fix would ask twice.
    expect(checkReviewEvidence([held], { ...reply, confirms: [held.id] }, task)).toContain("Current evidence is required");
    expect(checkReviewEvidence(snapshot.findings, reply, task)).toBeUndefined();
    for (const [index, profileId] of stage.profileIds.entries()) {
      step.agentResults = [...(step.agentResults ?? []), { roleId: stage.roleId, profileId, at: now++, value: reply }];
      reports.apply(task, stage, reply, profileId, stage.roleId, String(index));
    }
    reports.settle(task, stage);
    const rounds = new ReviewRoundCompletion({
      role: (id, current) => f.host.role(id, current), roles: () => BUILT_IN_ROLES, incrementalReview: () => true,
      ownChanges: async () => { throw new Error("A held acceptance failure cannot require review repair evidence"); },
      anchor: async () => { throw new Error("This report-only contract has no native repository"); },
      reviewEnd() {}, releaseInput() {}, note(_task, _tone, text) { notes.push(text); }, changed() {}, commitNow() {},
      openDeliveryDecision() { throw new Error("Held acceptance does not stop this review"); }, now: () => now++,
    });
    await rounds.finish(task, stage, 1, "Nothing to fix");
    expect(held.confirmedBy).toEqual([]);
    expect(step.result?.findings?.some(finding => finding.id === held.id)).toBe(false);
    expect(step.agentResults!.flatMap(result => result.findings ?? []).some(finding => finding.id === held.id)).toBe(false);
    expect(notes.some(text => /confirmed \d/.test(text))).toBe(false);
    expect(task.stageIndex).toBe(3); expect(task.repair).toBeUndefined(); expect(task.rounds[stage.id] ?? 1).toBe(1);
    // The two retained exhausted-failure journeys prove actual seat admission, no second answer and one real inbox decision.
  } finally { removeDir(root); }
});

it("keeps an ordinary finding visible while withholding only the exhausted acceptance failure", async () => {
  const root = tempDir("petrina-held-acceptance-visible-");
  try {
    const f = acceptanceContext(root);
    f.task.acceptanceBlocked = true;
    f.task.findings.push(
      { id: "held", text: "Failed acceptance check: Greeting", severity: "blocking", raisedBy: "opus-high", productIds: ["a"], status: "open", confirmedBy: [] },
      { id: "visible", text: "A separate review finding", severity: "suggestion", raisedBy: "sol-high", productIds: ["a"], status: "open", confirmedBy: [] },
    );
    const snapshot = await f.context.captureReview(f.scope);
    expect(snapshot.findings.map(finding => finding.id)).toEqual(["visible"]);
    const text = (await f.context.sectionsFor(f.scope, "code-reviewer", undefined, undefined, undefined, snapshot)).map(section => section.body).join("\n");
    expect(text).toContain("visible"); expect(text).not.toContain("Failed acceptance check: Greeting");
  } finally { removeDir(root); }
});

it("supplies only the independent review finding to a fresh Builder and its immutable complete packet", async () => {
  const root = tempDir("petrina-fresh-builder-packet-");
  try {
    const f = acceptanceContext(root), { task, scope } = f;
    task.acceptanceBlocked = true; task.stageIndex = 0; task.fixing = true;
    const held = { id: "held-acceptance", text: "Failed acceptance check: People see the greeting on the welcome page", severity: "blocking" as const, raisedBy: "opus-high", productIds: ["a", "b"], status: "open" as const, confirmedBy: [] };
    const review = { id: "independent-review", text: "The greeting is missing on the welcome page.", severity: "blocking" as const, raisedBy: "opus-high", productIds: ["a"], status: "open" as const, confirmedBy: [] };
    const nit = { id: "review-nit", text: "Consider a friendlier greeting.", severity: "suggestion" as const, raisedBy: "sol-high", productIds: ["a"], status: "open" as const, confirmedBy: [] };
    task.findings.push(review, held, nit);
    const builder = BUILT_IN_ROLES.find(role => role.id === "builder")!, view = repositoryView(scope);
    const step = beginAgentStep(task, builder.id, "sol-high", 200, BUILT_IN_ROLES, undefined, scope.work);
    const sections = await f.context.sectionsFor(scope, builder.id);
    const supplied = await builderContext(root, view, builder, "fresh-builder", sections);
    const prompt = buildPrompt({ task: view, product: f.products[0]!, role: builder, roles: BUILT_IN_ROLES,
      profiles: DEFAULT_PROFILES, tools: [{ id: "codex", name: "Codex" }, { id: "claude-code", name: "Claude Code" }],
      worktree: root, branch: "greeting", base: "", defaultBranch: "main", sections: supplied.sections,
    });
    expect(step.findingIds).toContain(review.id); expect(step.findingIds).not.toContain(held.id);
    expect(prompt).toContain(review.text); expect(prompt).not.toContain(held.text);
    expect(prompt).not.toContain(`[${held.id}]`); expect(prompt).not.toContain(`${held.id}: open`);
    expect(prompt).not.toContain(held.id);
    expect(supplied.snapshot).toBeDefined();
    const packet = await readFile(supplied.snapshot!.file, "utf8");
    expect(packet).toContain(review.id); expect(packet).not.toContain(held.id); expect(packet).not.toContain(held.text);
    expect(held.status).toBe("open");
  } finally { removeDir(root); }
});
