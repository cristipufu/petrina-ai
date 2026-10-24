import { expect, it } from "vitest";
import { beginAgentStep, BUILT_IN_ROLES, panelAnswers, type Vote } from "@petrina/core";
import { verifierFixture } from "../../fixtures/verifiers.js";

it("records only assigned claims and checkpoints partial results before the remaining work", () => {
  const f = verifierFixture(); f.finding(); f.finding("other");
  const open = beginAgentStep(f.task, "verifier", "b-high", 100, BUILT_IN_ROLES);
  const pending = f.next()!, place = pending.seats[0]!;
  f.ballots.recordAnswers(f.task, { profileId: "b-high", plannedProfileId: "b-high", place, findingIds: ["finding"] },
    [{ id: "finding", verdict: "real", reason: "Current reproduction" }, { id: "other", verdict: "real", reason: "Unassigned" }, { id: "unknown", verdict: "real", reason: "Unknown" }]);
  expect(f.task.findings[0]!.votes).toHaveLength(1);
  expect(f.task.findings[1]!.votes).toBeUndefined();
  expect(f.checkpoints.at(-1)!.findings[0]!.votes).toHaveLength(1);
  expect(open.result!.findings!.map(finding => finding.id)).toEqual(["finding"]);
  expect(open.result!.findingsSettled).toBeUndefined();
});

it("retains changed reasons and corrections while counting the latest answer only once per actual tool", () => {
  const f = verifierFixture(); f.finding();
  const initial = f.next()!, place = initial.seats[0]!;
  f.answer(place, "not-a-bug"); f.answer(place, "not-a-bug");
  expect(f.task.findings[0]!.votes).toHaveLength(1);
  f.ballots.recordAnswers(f.task, { profileId: "b-high", plannedProfileId: "b-high", place, findingIds: ["finding"] },
    [{ id: "finding", verdict: "real", reason: "Corrected after reproducing the bug" }]);
  f.answer(initial.seats[1]!, "nit");
  const next = f.next()!;
  expect(next.voters).toEqual([]);
  const outcome = f.ballots.finish(f.task, next);
  const finding = f.task.findings[0]!;
  expect(finding.votes).toHaveLength(3);
  expect(panelAnswers(f.task.hunt!.panel!, finding, f.task.hunt!)).toHaveLength(2);
  expect(finding.verification).toMatchObject({ verdict: "real", by: "b-high", reason: expect.stringContaining("Corrected after reproducing the bug") });
  expect(finding.verification!.reason).toContain("c-high answered only a nit");
  expect(outcome).toBe("1 checked: 1 must be fixed in this change (1 disputed)");
  expect(f.changes.at(-1)!.findings[0]!.verification).toEqual(finding.verification);
});

it("never accepts a partner's tool through another place or overwrites a place's different-tool answer", () => {
  const f = verifierFixture(); f.finding(); const initial = f.next()!;
  f.answer(initial.seats[0]!, "real");
  const original = structuredClone(f.task.findings[0]!.votes);
  f.ballots.recordAnswers(f.task, { profileId: "b-high", plannedProfileId: "c-high", place: initial.seats[1]!, findingIds: ["finding"] },
    [{ id: "finding", verdict: "not-a-bug", reason: "The partner cannot vote twice" }]);
  f.ballots.recordAnswers(f.task, { profileId: "c-high", plannedProfileId: "b-high", place: initial.seats[0]!, findingIds: ["finding"] },
    [{ id: "finding", verdict: "not-a-bug", reason: "A takeover cannot overwrite the prior tool" }]);
  expect(f.task.findings[0]!.votes).toEqual(original);
});

it.each([
  { verdict: "not-a-bug", status: "dismissed", severity: "blocking" },
  { verdict: "nit", status: "open", severity: "suggestion" },
  { verdict: "pre-existing", status: "open", severity: "pre-existing" },
] as const)("settles a completed $verdict ballot and its saved finding copy together", expected => {
  const f = verifierFixture(); f.finding();
  const open = beginAgentStep(f.task, "verifier", "b-high", 100, BUILT_IN_ROLES);
  const initial = f.next()!;
  initial.seats.forEach(seat => f.answer(seat, expected.verdict));
  const third = f.next()!;
  expect(open.endedAt).toBe(200);
  expect(open.result!.findingsSettled).toBeUndefined();
  f.advance();
  const finalStep = beginAgentStep(f.task, "verifier", third.voters[0]!, 201, BUILT_IN_ROLES);
  third.seats.forEach(seat => f.answer(seat, expected.verdict));
  const ready = f.next()!;
  expect(ready.voters).toEqual([]);
  f.ballots.finish(f.task, ready);
  expect(f.task.findings[0]).toMatchObject({ status: expected.status, severity: expected.severity, verification: { verdict: expected.verdict } });
  expect(finalStep.result!.findingsSettled).toBe(true);
  expect(finalStep.result!.findings![0]).toMatchObject({ status: expected.status, severity: expected.severity, verification: { verdict: expected.verdict } });
  expect(f.changes.at(-1)!.findings[0]!.verification?.verdict).toBe(expected.verdict);
});

it("labels a genuine one-tool ballot truthfully", () => {
  const f = verifierFixture(); f.finding();
  for (const id of ["a-high", "c-high", "d-high"]) f.resolutions.set(id, { kind: "unavailable", waiting: "Usage limit" });
  const initial = f.next()!; expect(initial.seats).toHaveLength(1);
  f.answer(initial.seats[0]!, "not-a-bug");
  const outcome = f.ballots.finish(f.task, f.next()!);
  expect(outcome).toBe("1 checked by one tool: none to fix now, 1 not a bug");
  expect(f.task.findings[0]!.votes).toHaveLength(1);
  expect(f.task.findings[0]!.verification?.by).toBe("b-high");
});

it("leaves an unavailable third answer unresolved with exact reviewed versions", () => {
  const f = verifierFixture(); f.finding(); f.candidates.pop();
  const initial = f.next()!; initial.seats.forEach(seat => f.answer(seat, "nit"));
  f.candidates.splice(0, 1);
  const pending = f.next()!;
  const outcome = f.ballots.finish(f.task, pending);
  expect(outcome).toBe("1 checked: 1 unresolved");
  expect(f.task.findings[0]).toMatchObject({ status: "open", severity: "blocking", unresolved: { at: 200, heads: { product: "head" } } });
  expect(f.task.findings[0]!.verification).toBeUndefined();
});

it("keeps a saved majority ballot's original rule", () => {
  const f = verifierFixture(); f.finding();
  f.task.hunt!.voterProfiles = [...f.candidates];
  const initial = f.next()!;
  initial.seats.forEach((seat, index) => f.answer(seat, index === 0 ? "real" : "nit"));
  const ready = f.next()!;
  expect(ready.voters).toEqual([]); expect(ready.panel!.rule).toBe("majority");
  f.ballots.finish(f.task, ready);
  expect(f.task.findings[0]!.votes).toHaveLength(4);
  expect(f.task.findings[0]!.verification?.verdict).toBe("nit");
});

it("refuses unknown participants or an absent active ballot before modifying any finding", () => {
  const f = verifierFixture(); f.finding(); const place = f.next()!.seats[0]!;
  const verdicts = [{ id: "finding", verdict: "real", reason: "An answer" }] satisfies { id: string; verdict: Vote["verdict"]; reason: string }[];
  const checkpoints = f.checkpoints.length;
  expect(() => f.ballots.recordAnswers(f.task, { profileId: "unknown", plannedProfileId: "b-high", place, findingIds: ["finding"] }, verdicts)).toThrow("recorded participant");
  delete f.task.hunt;
  expect(() => f.ballots.recordAnswers(f.task, { profileId: "b-high", plannedProfileId: "b-high", place, findingIds: ["finding"] }, verdicts)).toThrow("active ballot");
  expect(f.task.findings[0]!.votes).toBeUndefined(); expect(f.checkpoints).toHaveLength(checkpoints);
});
