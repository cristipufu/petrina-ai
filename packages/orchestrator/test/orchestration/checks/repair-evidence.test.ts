import { expect, it } from "vitest";
import { checkRepairs, findingText, observedCheck } from "../../fixtures/check-repairs.js";
import { executionFor } from "../../../src/repository-context.js";

for (const shared of [false, true]) {
  it.each(["failed", "passed", "incomplete", "removed", "not-reported"])("settles %s evidence independently of a Builder claim (shared: " + shared + ")", kind => {
    const f = checkRepairs(shared), run = observedCheck(kind === "passed" ? 0 : 1), text = findingText(run);
    f.task.findings.push({ id: "old", text, raisedBy: "petrina", severity: "blocking", status: "open", confirmedBy: [],
      ...(shared ? { productIds: [f.scope.work.productId] } : {}), answer: { text: "Fixed it", fixed: true, at: 1 } });
    if (kind === "incomplete") run.execution!.stdout = "incomplete";
    const result = f.controller.settleFindings(f.scope, ["not-reported", "removed"].includes(kind) ? [] : [run], new Set(kind === "removed" ? [] : [text]));
    expect(f.task.findings[0]!.status).toBe(kind === "passed" || kind === "removed" ? "fixed" : kind === "incomplete" ? "unverified" : "open");
    expect(result).toEqual(kind === "failed" ? [run] : []);
    expect(f.task.findings[0]!.answer!.fixed).toBe(true);
    expect(f.task.findings).toHaveLength(1);
    expect(f.calls).toEqual([]);
  });

  it("reopens the same check and keeps other checks and review findings intact (shared: " + shared + ")", () => {
    const f = checkRepairs(shared), run = observedCheck(), text = findingText(run);
    run.output = "prefix" + "e".repeat(1600);
    f.task.findings.push(
      { id: "old", text, raisedBy: "petrina", severity: "suggestion", status: "fixed", confirmedBy: [], ...(shared ? { productIds: [f.scope.work.productId] } : {}) },
      { id: "peer", text: "Check failed: A different check", raisedBy: "petrina", severity: "blocking", status: "open", confirmedBy: [] },
      { id: "review", text, raisedBy: "reviewer", severity: "blocking", status: "open", confirmedBy: [] });
    f.controller.recordFailedFindings(f.scope, [run]);
    expect(f.task.findings).toHaveLength(3);
    expect(f.task.findings[0]).toMatchObject({ id: "old", status: "open", severity: "blocking", evidence: "e".repeat(1500) });
    expect(f.task.findings.slice(1).map(finding => finding.status)).toEqual(["open", "open"]);
    expect(f.calls).toEqual([]);
  });

  it("creates one finding per check and product, without spending a repair (shared: " + shared + ")", () => {
    const f = checkRepairs(shared), run = observedCheck(); f.scope.work.checkReturns = 1;
    f.controller.recordFailedFindings(f.scope, [run, run]);
    expect(f.task.findings).toHaveLength(1);
    expect(f.task.findings[0]).toMatchObject({ id: "finding-1", status: "open", severity: "blocking", evidence: run.output });
    expect(f.task.findings[0]!.productIds).toEqual(shared ? [f.scope.work.productId] : undefined);
    expect(f.scope.work.checkReturns).toBe(1);
    expect(f.checkpoints).toEqual([]);
  });
}

it("does not settle an identical finding belonging only to another product", () => {
  const f = checkRepairs(true), run = observedCheck(0);
  f.task.findings.push({ id: "peer", text: findingText(run), raisedBy: "petrina", severity: "blocking", status: "open", confirmedBy: [], productIds: ["b"] });
  f.controller.settleFindings(f.scope, [run], new Set([findingText(run)]));
  expect(f.task.findings[0]!.status).toBe("open");
  f.controller.recordFailedFindings(f.scope, [observedCheck()]);
  expect(f.task.findings.map(finding => [finding.id, finding.productIds])).toEqual([["peer", ["b"]], ["finding-1", ["a"]]]);
});

it.each(["same", "changed", "invalidated", "open failure", "no worktree", "no allowance"])("closes an episode only on a currently applicable pass: %s", async kind => {
  const f = checkRepairs(); f.scope.work.checkReturns = 2;
  if (kind === "changed") f.definition("other-checks");
  if (kind === "no worktree") delete f.scope.work.worktree;
  if (kind === "no allowance") delete f.scope.work.checkReturns;
  if (kind === "open failure") f.controller.recordFailedFindings(f.scope, [observedCheck()]);
  await f.controller.closeEpisode(f.scope, { sha: "modeled:commit", definition: "declared-checks" }, () => kind !== "invalidated");
  expect(f.scope.work.checkReturns).toBe(kind === "same" || kind === "no allowance" ? undefined : 2);
  expect(f.calls).toEqual(["open failure", "no worktree", "no allowance"].includes(kind) ? [] : ["definition:a:modeled:commit"]);
});

for (const [label, failure] of [["Error", new Error("Cannot inspect declarations")], ["undefined", undefined]] as const) it(`propagates a ${label} declaration failure and retains the allowance`, async () => {
  const f = checkRepairs(); f.scope.work.checkReturns = 2;
  f.host.definition = async () => { throw failure; };
  const outcome = await f.controller.closeEpisode(f.scope, { definition: "declared-checks" }, () => true).then(() => ({ ok: true }), error => ({ ok: false, error }));
  expect(outcome).toEqual({ ok: false, error: failure });
  expect(f.scope.work.checkReturns).toBe(2);
});

it("checks applicability after declaration inspection settles, and ignores another owner's open failure", async () => {
  const f = checkRepairs(true); f.scope.work.checkReturns = 2;
  f.controller.recordFailedFindings(executionFor(f.task, "b"), [observedCheck()]);
  let applicable = true;
  f.host.definition = async () => { applicable = false; return "declared-checks"; };
  await f.controller.closeEpisode(f.scope, { definition: "declared-checks" }, () => applicable);
  expect(f.scope.work.checkReturns).toBe(2);
  applicable = true; f.host.definition = async () => "declared-checks";
  await f.controller.closeEpisode(f.scope, { definition: "declared-checks" }, () => applicable);
  expect(f.scope.work.checkReturns).toBeUndefined();
  expect(f.task.findings[0]!.status).toBe("open");
});
