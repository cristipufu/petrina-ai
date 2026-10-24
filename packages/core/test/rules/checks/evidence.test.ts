import { describe, expect, it } from "vitest";
import { builderCheckSummary, builderReturnWords, checkDecisionLabel, checkProblem, decisionEvidence, evidenceFor, checkResult, incompleteCheckOutcome, latestCheckResults, reusedCheckWords } from "../../../src/check-evidence.js";
import { beginYouStep, journeyView, recordCheckReuse } from "../../../src/journey.js";
import { gateTitle, type DeepMutable } from "../../../src/flow.js";
import type { Task } from "../../../src/model.js";
import { fixture, now } from "../../fixtures/check-evidence.js";

describe("saved check evidence", () => {
  it("retains a real failure alongside interrupted verification in actual and reused outcomes", () => {
    const { task, state, run } = fixture();
    const interrupted = { ...run, name: "Build", interruption: { source: "macOS power log" as const, at: now - 60_000, event: "Sleep" } };
    const step = task.journey![0]!;
    step.productChecks!.push({ ...step.productChecks![0]!, id: "check-1", name: "Build", run: interrupted });
    task.checks!.results.push(interrupted);
    expect(incompleteCheckOutcome(step.productChecks!)).toBe("Checks: 1 still failing, 1 unverified");
    expect(reusedCheckWords(step.productChecks!)).toBe("Previous checks reused — 1 still failing, 1 unverified");
    const node = journeyView(task, { roles: state.roles, profiles: state.profiles, tasks: [task], inbox: [] }).nodes.find((node) => node.id === step.id)!;
    expect(node.outcome).toBe("Checks: 1 still failing, 1 unverified");
    expect(node.reason).toBe(node.outcome);
    expect(builderCheckSummary(task)).toContain("Checks still failing. 1 check also unverified.");
    expect(gateTitle(task, "delivery")).toContain("a check still fails (Tests); unverified (Build)");
  });

  it("keeps reused failures beside fresh interrupted checks in the same resumed attempt", () => {
    const { task, state, run } = fixture();
    const step = task.journey![0]!;
    step.productChecks = [
      { ...step.productChecks![0]!, attemptId: "run-0", result: "stopped", run: { ...run, interrupted: true } },
      { ...step.productChecks![0]!, attemptId: "run-3", reusedAt: now },
      { id: "run-3:hook", attemptId: "run-3", productId: task.productId, name: "Hook", result: "stopped", run: { ...run, source: { stepId: step.id, attemptId: "run-3", checkId: "run-3:hook" }, interruption: { source: "macOS power log", at: now, event: "Sleep" } } },
    ];
    expect(latestCheckResults(step.productChecks)).toEqual(step.productChecks.slice(1));
    const node = journeyView(task, { roles: state.roles, profiles: state.profiles, tasks: [task], inbox: [] }).nodes.find((node) => node.id === step.id)!;
    expect(node.outcome).toBe("Checks: 1 still failing, 1 unverified");
  });

  it("uses the latest attempt for the step outcome while preserving earlier interrupted evidence", () => {
    const { task, state, run } = fixture(true);
    const step = task.journey![0]!;
    const earlier = { ...step.productChecks![0]!, attemptId: "run-0", run: { ...run, ok: false, source: { ...run.source!, attemptId: "run-0" }, interruption: { source: "macOS power log" as const, at: now - 60_000, event: "Sleep" } } };
    step.productChecks!.unshift(earlier);
    step.outcome = "The check passes";
    const recorded = JSON.stringify(step);
    const node = journeyView(task, { roles: state.roles, profiles: state.profiles, tasks: [task], inbox: [] }).nodes.find((node) => node.id === step.id)!;
    expect(node.outcome).toBe("The check passes");
    expect(latestCheckResults(step.productChecks!)).toEqual([step.productChecks![1]]);
    expect(JSON.stringify(step)).toBe(recorded);
    expect(node.productChecks![0]!.run!.interruption).toBeDefined();
  });

  it("attributes the latest return, check problem and reuse to their own product", () => {
    const { task, run } = fixture();
    const first = task.productId;
    const peer = { ...run, ok: true, source: { ...run.source!, stepId: "peer-original" } };
    task.repositories = [
      { productId: first, delivery: "local", completedStages: [], checks: task.checks },
      { productId: "API", delivery: "local", completedStages: [], checks: { at: now, current: true, results: [peer] } },
    ];
    task.journey!.push({ ...task.journey![1]!, id: "peer-builder", builderReturn: { productId: "API", changed: true, claimedFixes: 1, outcome: "Changes returned; 1 fix claimed" } });
    recordCheckReuse(task, task.repositories[0]!, now);
    expect(builderCheckSummary(task)).toBe(`${first}: No code changes. Checks still failing. Previous check evidence reused. API: Changes returned; 1 fix claimed. Current checks passed.`);
  });

  it.each([false, true])("records a selectable reuse handoff for a passing=%s run without another execution or allowance", (ok) => {
    const { task, state, run } = fixture(ok);
    const original = JSON.parse(JSON.stringify(task.journey![0]));
    recordCheckReuse(task, task, now);
    expect(task.journey!.at(-1)?.work).toBe("check-reuse");
    expect(task.journey!.at(-1)?.outcome).toBe(`Previous checks reused — 1 ${ok ? "passing" : "still failing"}`);
    expect(task.journey!.filter((step) => step.work === "checks")).toHaveLength(1);
    expect(task.checkReturns).toBe(2);
    expect(task.journey![0]).toEqual(original);
    expect(task.checks!.results).toEqual([run]);
    const count = task.journey!.length;
    recordCheckReuse(task, task, now + 1);
    expect(task.journey).toHaveLength(count);
    const decision = beginYouStep(task, "delivery", now + 2);
    decision.productChecks = decisionEvidence(task);
    expect(decision.productChecks[0]).toEqual(expect.objectContaining({ reusedAt: now, result: ok ? "pass" : "fail", run: expect.objectContaining({ ms: 41000, output: run.output, source: run.source }) }));
    expect(journeyView(task, { roles: state.roles, profiles: state.profiles, tasks: [task], inbox: [] }).nodes.find((node) => node.id === decision.id)?.name).toBe(ok ? "Your delivery check" : "Your call: checks still failing");
    expect(builderCheckSummary(task)).toContain("Previous check evidence reused");
  });

  it("keeps products, source runs and interrupted evidence independent of the selected passing product", () => {
    const { task, run } = fixture(true);
    const other = { ...run, name: "Startup", ok: false, source: { stepId: "other", attemptId: "run-0", checkId: "check-0" } };
    task.repositories = [{ productId: "shop", delivery: "local", completedStages: [], checks: task.checks }, { productId: "notes", delivery: "local", completedStages: [], checks: { at: now, results: [other] } }];
    expect(checkDecisionLabel(task)).toBe("Your call: checks still failing");
    expect(decisionEvidence(task).map((check) => [check.productId, check.result, check.run?.source?.stepId])).toEqual([["shop", "pass", "original"], ["notes", "fail", "other"]]);
    other.interruption = { source: "macOS power log", at: now - 20_000, event: "Entering Sleep state" };
    expect(checkDecisionLabel(task)).toBe("Your call: checks unverified");
    expect(decisionEvidence(task)[1]?.result).toBe("stopped");
    expect(other.output).toBe("passed");
  });

  it("attributes mixed execution and reused results separately and preserves skipped entries", () => {
    const { task, run } = fixture(true);
    task.journey![0]!.productChecks = [...task.journey![0]!.productChecks!, { id: "skipped", attemptId: "run-2", productId: task.productId, name: "Build", result: "skipped" }];
    recordCheckReuse(task, task, now);
    const hook = { ...run, name: "Commit message hook", source: { stepId: "new-run", attemptId: "run-0", checkId: "hook" } };
    task.checks!.results = [run, hook];
    const evidence = evidenceFor(task, task);
    expect(evidence.map((check) => [check.name, check.reusedAt !== undefined, check.result])).toEqual([["Tests", true, "pass"], ["Commit message hook", false, "pass"], ["Build", true, "skipped"]]);
    expect(evidence[2]!.run).toBeUndefined();
    expect(evidence[2]!.source).toEqual({ stepId: "original", attemptId: "run-2", checkId: "skipped" });
  });

  it("does not invent missing timing or provenance, and keeps skipped checks separate", () => {
    const { task, run } = fixture();
    delete run.source; delete run.startedAt; delete run.endedAt;
    task.journey = [];
    expect(evidenceFor(task, task)[0]?.run?.source).toBeUndefined();
    expect(evidenceFor(task, task)[0]?.run?.startedAt).toBeUndefined();
    expect(checkResult({ ...run, interrupted: true })).toBe("stopped");
    expect(builderReturnWords(true, "unverified", 1)).toBe("Changes returned; checks unverified; 1 fix claimed");
    expect(builderReturnWords(false, "failing")).toBe("No code changes; checks still failing");
  });

  it("keeps a fresh rerun's skipped checks separate from an earlier reused attempt", () => {
    const { task, run } = fixture();
    task.journey![0]!.productChecks!.push({ id: "skipped", attemptId: "run-2", productId: task.productId, name: "Build", result: "skipped" });
    recordCheckReuse(task, task, now);
    expect(evidenceFor(task, task).find(check => check.result === "skipped")?.reusedAt).toBe(now);
    const rerun = { ...run, source: { stepId: "rerun", attemptId: "run-0", checkId: "check-0" }, startedAt: now + 1, endedAt: now + 2 };
    task.checks!.results = [rerun];
    task.journey!.push({ id: "rerun", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: now + 1, endedAt: now + 2, productChecks: [
      { id: "check-0", attemptId: "run-0", productId: task.productId, name: rerun.name, result: "fail", run: rerun },
      { id: "skipped", attemptId: "run-0", productId: task.productId, name: "Build", result: "skipped" },
    ] });
    const decision = beginYouStep(task, "delivery", now + 3);
    decision.productChecks = decisionEvidence(task);
    expect(decision.productChecks.map(check => [check.name, check.reusedAt, check.run?.source?.stepId ?? check.source?.stepId])).toEqual([["Tests", undefined, "rerun"], ["Build", undefined, "rerun"]]);
    expect(builderCheckSummary(task)).not.toContain("reused");
  });

  it("does not add handoffs for later read-only steps or approval", () => {
    const { task } = fixture(true);
    recordCheckReuse(task, task, now);
    const count = task.journey!.length;
    task.journey!.push({ id: "review", kind: "agent", roleId: "reviewer", round: 1, sub: 0, startedAt: now + 1, endedAt: now + 2 });
    recordCheckReuse(task, task, now + 3);
    const decision = beginYouStep(task, "delivery", now + 4);
    decision.endedAt = now + 5;
    recordCheckReuse(task, task, now + 6);
    expect(task.journey).toHaveLength(count + 2);
    expect(task.journey!.filter(step => step.work === "check-reuse")).toHaveLength(1);
    expect(decisionEvidence(task)[0]?.reusedAt).toBe(now);
  });

  it.each([false, true])("retains unresolved outdated passing=%s evidence without inventing interruption", (ok) => {
    const { task, run } = fixture(ok);
    task.checks!.current = false;
    expect(checkProblem(task)).toBe(ok ? undefined : "failing");
    expect(builderCheckSummary(task)).toContain("Checks need updating");
    if (!ok) expect(builderCheckSummary(task)).toContain("Earlier checks failed");
    run.interruption = { source: "macOS power log", at: now, event: "Sleep" };
    expect(checkProblem(task)).toBe("unverified");
    task.checks!.current = true;
    expect(checkProblem(task)).toBe("unverified");
  });

  it.each(["failed", "passed", "interrupted"] as const)("does not attribute earlier %s checks or reuse to a changed return awaiting verification", (kind) => {
    const { task, run } = fixture(kind === "passed");
    if (kind === "interrupted") run.interruption = { source: "macOS power log", at: now - 60_000, event: "Sleep" };
    recordCheckReuse(task, task, now);
    expect(builderCheckSummary(task)).toContain("Previous check evidence reused");
    const earlierHistory = JSON.stringify(task.journey);
    task.journey!.push({ ...task.journey![1]!, id: "changed-builder", startedAt: now + 1, endedAt: now + 2, builderReturn: { productId: task.productId, changed: true, claimedFixes: 1, outcome: "Changes returned; 1 fix claimed" } });
    task.checks!.current = false;
    const summary = builderCheckSummary(task)!;
    expect(summary).toContain("Changes returned; 1 fix claimed. Checks need updating.");
    expect(summary).not.toContain("Checks still failing");
    expect(summary).not.toContain("Checks unverified");
    expect(summary).not.toContain("evidence reused");
    if (kind !== "passed") expect(summary).toContain(kind === "failed" ? "Earlier checks failed" : "Earlier checks were unverified");
    expect(checkProblem(task)).toBe(kind === "failed" ? "failing" : kind === "interrupted" ? "unverified" : undefined);
    // Waiting and running both describe the same pending verification; neither changes history.
    task.state = "running";
    task.journey!.push({ id: "fresh-checks", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: now + 3 });
    expect(builderCheckSummary(task)).toBe(summary);
    expect(JSON.stringify(task.journey!.slice(0, -2))).toBe(earlierHistory);
    // A fresh applicable result can now describe the new work, without inheriting older reuse.
    task.checks = { at: now + 4, current: true, results: [{ ...run, source: { stepId: "fresh-checks", attemptId: "run-0", checkId: "check-0" } }] };
    expect(builderCheckSummary(task)).toContain(kind === "failed" ? "Checks still failing" : kind === "interrupted" ? "Checks unverified" : "Current checks passed");
    expect(builderCheckSummary(task)).not.toContain("reused");
  });

  it("keeps another product's current reused failure visible while the changed product awaits new checks", () => {
    const { task, run } = fixture();
    const first = task.productId;
    task.repositories = [
      { productId: first, delivery: "local", completedStages: [], checks: task.checks },
      { productId: "API", delivery: "local", completedStages: [], checks: { at: now - 49_000, current: true, results: [{ ...run, source: { ...run.source!, stepId: "api-original" } }] } },
    ];
    task.journey!.push({ ...task.journey![1]!, id: "api-builder", builderReturn: { ...task.journey![1]!.builderReturn!, productId: "API" } });
    for (const work of task.repositories) recordCheckReuse(task, work, now);
    task.journey!.push({ ...task.journey![1]!, id: "changed-builder", builderReturn: { productId: first, changed: true, claimedFixes: 1, outcome: "Changes returned; 1 fix claimed" } });
    task.repositories[0]!.checks!.current = false;
    expect(builderCheckSummary(task)).toBe(`${first}: Changes returned; 1 fix claimed. Checks need updating. Earlier checks failed. API: No code changes. Checks still failing. Previous check evidence reused.`);
  });

  it.each([false, true])("attributes each shared return when the first product ran fresh=%s checks", (fresh) => {
    const { task, run } = fixture();
    const first = task.productId, second = "second";
    const peer = { ...run, source: { ...run.source!, stepId: "peer-original" } };
    const original = task.journey![0]!, builder = task.journey![1]!;
    task.repositories = [
      { productId: first, delivery: "local", completedStages: [], checkReturns: 2, checks: task.checks },
      { productId: second, delivery: "local", completedStages: [], checkReturns: 2, checks: { at: now - 49_000, current: true, results: [peer] } },
    ];
    task.journey = [original, { ...original, id: "peer-original", productChecks: [{ ...original.productChecks![0]!, productId: second, run: peer }] }, builder,
      { ...builder, id: "peer-builder", builderReturn: { ...builder.builderReturn!, productId: second } }];
    if (fresh) {
      const next = { ...run, ok: true, source: { stepId: "fresh-first", attemptId: "run-0", checkId: "check-0" } };
      task.repositories[0]!.checks = { at: now, current: true, results: [next] };
      task.journey.push({ ...original, id: "fresh-first", startedAt: now, endedAt: now + 1, productChecks: [{ id: "check-0", attemptId: "run-0", productId: first, name: run.name, result: "pass", run: next }] });
    }
    for (const work of task.repositories) recordCheckReuse(task, work, now + 2);
    const handoffs = task.journey.filter(step => step.work === "check-reuse");
    expect(handoffs.flatMap(step => step.productChecks!.map(check => check.productId))).toEqual(fresh ? [second] : [first, second]);
    const decision = beginYouStep(task, "delivery", now + 3);
    decision.productChecks = decisionEvidence(task);
    expect(decision.productChecks.map(check => [check.productId, check.reusedAt !== undefined, check.run!.source!.stepId])).toEqual([
      [first, !fresh, fresh ? "fresh-first" : "original"], [second, true, "peer-original"],
    ]);
    expect(task.repositories.map(work => work.checkReturns)).toEqual([2, 2]);
    const restored = JSON.parse(JSON.stringify(task)) as DeepMutable<Task>;
    for (const work of restored.repositories!) recordCheckReuse(restored, work, now + 4);
    expect(restored.journey).toHaveLength(task.journey.length);
  });

  it("preserves completed passing summaries when check definitions change", () => {
    const { task } = fixture(true);
    task.state = "done";
    const before = builderCheckSummary(task);
    task.checks!.current = false;
    expect(builderCheckSummary(task)).toBe(before);
  });

  it("names an older waiting decision from available evidence without rewriting history", () => {
    const { task, state } = fixture();
    const decision = beginYouStep(task, "delivery", now);
    task.state = "needs-you";
    const view = () => journeyView(task, { roles: state.roles, profiles: state.profiles, tasks: [task], inbox: [] }).nodes.find(node => node.id === decision.id)!;
    expect(view().name).toBe("Your call: checks still failing");
    expect(decision.productChecks).toBeUndefined();
    decision.endedAt = now + 1;
    expect(view().name).toBe("Your delivery check");
  });
});
