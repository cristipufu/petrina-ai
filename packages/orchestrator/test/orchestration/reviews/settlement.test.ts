import { expect, it } from "vitest";
import { beginAgentStep, independentVotes, reviewRoundEnd } from "@petrina/core";
import { verifierFixture } from "../../fixtures/verifiers.js";

it.each([
  { first: "pre-existing", second: "nit" },
  { first: "nit", second: "pre-existing" },
] as const)("keeps the mildest-verdict tie rule on an exhaustive pair ($first, $second)", ({ first, second }) => {
  const f = verifierFixture(); f.finding();
  // The task really can return to its preceding builder before this ballot settles it.
  expect(reviewRoundEnd(f.task, f.stage, 1, f.roles)).toEqual({ kind: "send back", builder: 0, open: 1 });
  for (const id of ["a-high", "d-high"]) f.resolutions.set(id, { kind: "unavailable", waiting: "Usage limit" });
  const initial = f.next()!;
  expect(initial.voters).toEqual(["b-high", "c-high"]);
  expect(initial.panel!.usable).toEqual(["b", "c"]);
  f.answer(initial.seats[0]!, first); f.answer(initial.seats[1]!, second);
  const ready = f.next()!;
  expect(ready.voters).toEqual([]);
  expect(ready.panel!.seats).toHaveLength(2);
  const outcome = f.ballots.finish(f.task, ready);
  expect(f.task.findings[0]!.verification?.verdict).toBe("nit");
  expect(f.task.findings[0]!.severity).toBe("suggestion");
  expect(outcome).toBe("1 checked: none to fix now, 1 minor");
  expect(reviewRoundEnd(f.task, f.stage, 1, f.roles)).toEqual({ kind: "passed" });
});

it.each([
  { available: ["a-high", "b-high", "c-high", "d-high"], third: "d-high" },
  { available: ["a-high", "b-high", "c-high"], third: "a-high" },
])("keeps a real third answer Important after two nits (third: $third)", ({ available, third }) => {
  const f = verifierFixture(); f.finding("finding", "a-high");
  // The original regression allowed either another independent tool or the reporting tool to answer third.
  for (const id of f.candidates) if (!available.includes(id)) f.resolutions.set(id, { kind: "unavailable", waiting: "Not ready" });
  const firstStep = beginAgentStep(f.task, "verifier", "b-high", 100, f.roles);
  const initial = f.next()!;
  expect(initial.voters).toEqual(["b-high", "c-high"]);
  initial.seats.forEach(seat => f.answer(seat, "nit"));
  const targeted = f.next()!;
  expect(firstStep.seats).toEqual(["verifier:b-high", "verifier:c-high"]);
  expect(targeted.voters).toEqual([third]);
  expect(targeted.seats[0]!.findingIds).toEqual(["finding"]);
  const lastStep = beginAgentStep(f.task, "verifier", third, 200, f.roles);
  f.answer(targeted.seats[0]!, "real");
  const ready = f.next()!;
  expect(ready.voters).toEqual([]);
  const outcome = f.ballots.finish(f.task, ready);
  const finding = f.task.findings[0]!;
  expect(targeted.seats.map(seat => `verifier:${seat.key}`)).toEqual([`verifier:third:${third}`]);
  expect(lastStep.result!.findingsSettled).toBe(true);
  expect(f.task.hunt!.panel!.seats).toHaveLength(3);
  expect(independentVotes(finding.votes).map(vote => `${vote.toolId}:${vote.verdict}`))
    .toEqual(["b:nit", "c:nit", `${f.profiles.get(third)!.toolId}:real`]);
  expect(finding.verification?.verdict).toBe("real");
  expect(finding.severity).toBe("blocking");
  expect(outcome).toBe("1 checked: 1 must be fixed in this change (1 disputed)");
  expect(reviewRoundEnd(f.task, f.stage, 1, f.roles)).toEqual({ kind: "send back", builder: 0, open: 1 });
});

it.each(["b", "c"])("asks no third tool and returns to the builder when initial tool %s says real", realTool => {
  const f = verifierFixture(); f.finding();
  const open = beginAgentStep(f.task, "verifier", "b-high", 100, f.roles);
  const initial = f.next()!;
  initial.seats.forEach(seat => f.answer(seat, seat.toolId === realTool ? "real" : "nit"));
  const ready = f.next()!;
  expect(ready.voters).toEqual([]);
  expect(f.task.hunt!.panel!.seats).toHaveLength(2);
  expect(f.task.hunt!.panel!.escalations).toBeUndefined();
  const outcome = f.ballots.finish(f.task, ready);
  expect(outcome).toBe("1 checked: 1 must be fixed in this change (1 disputed)");
  expect(f.task.findings[0]!.verification).toEqual({ verdict: "real", by: `${realTool}-high`, reason: expect.stringContaining("answered only a nit"), at: 200 });
  expect(open.result!.findingsSettled).toBe(true);
  expect(open.result!.findings![0]!.verification).toEqual(f.task.findings[0]!.verification);
  expect(reviewRoundEnd(f.task, f.stage, 1, f.roles)).toEqual({ kind: "send back", builder: 0, open: 1 });
});

it("keeps unknown legacy reasons without counting a nominal profile as an actual tool", () => {
  const f = verifierFixture(); f.finding();
  const legacy = { by: "a-high", verdict: "real" as const, reason: "An older recorded reason with no proven actual identity." };
  f.task.findings[0]!.votes = [legacy];
  f.task.hunt!.voted = { "a-high": true };
  for (const id of ["a-high", "d-high"]) f.resolutions.set(id, { kind: "unavailable", waiting: "Usage limit" });
  const initial = f.next()!;
  expect(initial.voters).toEqual(["b-high", "c-high"]);
  expect(f.task.findings[0]!.votes).toEqual([legacy]);
  initial.seats.forEach(seat => f.answer(seat, "not-a-bug"));
  const ready = f.next()!;
  expect(ready.voters).toEqual([]);
  f.ballots.finish(f.task, ready);
  const finding = f.task.findings[0]!;
  expect(finding.votes).toContainEqual(legacy);
  expect(finding.votes!.filter(vote => vote.toolId)).toHaveLength(2);
  expect(finding.verification?.verdict).toBe("not-a-bug");
  expect(legacy).not.toHaveProperty("toolId");
  expect(reviewRoundEnd(f.task, f.stage, 1, f.roles)).toEqual({ kind: "passed" });
});
