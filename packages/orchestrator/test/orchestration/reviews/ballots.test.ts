import { expect, it } from "vitest";
import { beginAgentStep, BUILT_IN_ROLES, endAgentStep, seatRemaining, type VerifierSeat } from "@petrina/core";
import { verifierFixture } from "../../fixtures/verifiers.js";

it("saves two independent places before admission, avoiding the reporting tool", () => {
  const f = verifierFixture(); f.finding();
  const next = f.next()!;
  expect(next.seats.map(seat => seat.toolId)).toEqual(["b", "c"]);
  expect(next.voters).toEqual(["b-high", "c-high"]);
  expect(f.task.hunt!.panel!.usable).toEqual(["a", "b", "c", "d"]);
  expect(f.checkpoints).toHaveLength(1);
  expect(f.checkpoints[0]!.hunt!.panel!.seats.map(seat => seat.key)).toEqual(["b-high", "c-high"]);
  expect(f.notes[0]!.text).toContain("usable at selection: Tool a, Tool b, Tool c and Tool d");
});

it("leaves an unavailable electorate open instead of recording an empty completed panel", () => {
  const f = verifierFixture(); f.finding();
  for (const id of f.candidates) f.resolutions.set(id, { kind: "unavailable", waiting: "Usage limit" });
  expect(f.next()!.voters).toEqual(["a-high"]);
  expect(f.task.hunt!.panel).toBeUndefined(); expect(f.checkpoints).toEqual([]);
  f.resolutions.set("b-high", { kind: "selected", profile: f.profiles.get("b-high")! });
  expect(f.next()!.voters).toEqual(["b-high"]);
  expect(f.task.hunt!.panel!.seats).toHaveLength(1);
});

it("keeps previews provisional while admissions are closed", () => {
  const f = verifierFixture(); f.finding(); f.closeAdmissions();
  expect(f.next()!.seats).toHaveLength(2);
  expect(f.task.hunt!.panel).toBeUndefined(); expect(f.checkpoints).toEqual([]);
  f.openAdmissions(); f.next();
  const saved = structuredClone(f.task.hunt!.panel);
  f.closeAdmissions(); f.resolutions.set("c-high", { kind: "unavailable", waiting: "Usage limit" });
  f.next(); expect(f.task.hunt!.panel).toEqual(saved);
});

it("adds newly eligible claims to the initial places before they finish", () => {
  const f = verifierFixture(); f.finding(); f.next();
  f.finding("second");
  const next = f.next()!;
  expect(next.findings.map(finding => finding.id)).toEqual(["finding", "second"]);
  expect(next.seats.map(seat => seat.findingIds)).toEqual([["finding", "second"], ["finding", "second"]]);
  expect(f.checkpoints).toHaveLength(2);
});

it("waits for every initial answer, keeping a finished partner out of remaining work", () => {
  const f = verifierFixture(); f.finding();
  const initial = f.next()!;
  f.answer(initial.seats[0]!, "not-a-bug");
  const pending = f.next()!;
  expect(pending.voters).toEqual(["c-high"]);
  expect(pending.phase!.map(seat => seat.key)).toEqual(["b-high", "c-high"]);
  expect(f.task.hunt!.panel!.seats).toHaveLength(2);
  expect(f.task.hunt!.panel!.escalatedAt).toBeUndefined();
});

it("retains a capacity-paused seat even when another tool is available", () => {
  const f = verifierFixture(); f.finding();
  const initial = f.next()!; f.answer(initial.seats[0]!, "not-a-bug");
  f.resolutions.set("c-high", { kind: "capacity", waiting: "Model capacity" });
  expect(f.next()!.voters).toEqual(["c-high"]);
  expect(f.task.hunt!.panel!.seats.map(seat => seat.toolId)).toEqual(["b", "c"]);
  expect(f.task.hunt!.panel!.seats[1]!.replaced).toBeUndefined();
});

it("replaces an unavailable seat independently while preserving its identity and prior answers", () => {
  const f = verifierFixture(); f.finding();
  const initial = f.next()!; f.answer(initial.seats[0]!, "not-a-bug");
  const saved = structuredClone(f.task.findings[0]!.votes);
  f.resolutions.set("c-high", { kind: "unavailable", waiting: "Usage limit" });
  const next = f.next()!;
  expect(next.voters).toEqual(["d-high"]);
  expect(next.seats[0]).toMatchObject({ key: "c-high", profileId: "d-high", toolId: "d", replaced: { from: "c-high" } });
  expect(f.task.findings[0]!.votes).toEqual(saved);
  expect(f.notes.at(-1)!.text).toContain("saved votes remain");
});

it("never borrows a finished partner's vote when no independent replacement is usable", () => {
  const f = verifierFixture(); f.finding();
  const initial = f.next()!; f.answer(initial.seats[0]!, "real");
  for (const id of ["a-high", "c-high", "d-high"]) f.resolutions.set(id, { kind: "unavailable", waiting: "Usage limit" });
  expect(f.next()!.voters).toEqual(["c-high"]);
  expect(f.task.hunt!.panel!.seats.map(seat => seat.toolId)).toEqual(["b", "c"]);
  expect(f.task.findings[0]!.votes).toHaveLength(1);
});

it("uses a same-tool model replacement on its original required place", () => {
  const f = verifierFixture(); f.finding(); f.next();
  f.profiles.set("c-other", { id: "c-other", toolId: "c" });
  f.resolutions.set("c-high", { kind: "selected", profile: f.profiles.get("c-other")! });
  expect(f.next()!.voters).toEqual(["b-high", "c-other"]);
  expect(f.task.hunt!.panel!.seats[1]).toMatchObject({ key: "c-high", profileId: "c-high", toolId: "c" });
});

it("asks one targeted third answer after both first tools say the claim does not block", () => {
  const f = verifierFixture(); f.finding(); f.finding("second");
  const initial = f.next()!;
  for (const seat of initial.seats) { f.answer(seat, "nit"); f.answer(seat, "real", "second"); }
  const next = f.next()!;
  expect(next.third).toBe(true);
  expect(next.seats).toHaveLength(1);
  expect(next.seats[0]).toMatchObject({ toolId: "d", third: true, findingIds: ["finding"] });
  expect(f.task.hunt!.panel!.escalatedAt).toBe(200);
  expect(f.next()!.seats.map(seat => seat.key)).toEqual(next.seats.map(seat => seat.key));
  expect(f.task.hunt!.panel!.seats).toHaveLength(3);
});

it("asks no third answer when an initial tool has a current real verdict", () => {
  const f = verifierFixture(); f.finding();
  const initial = f.next()!;
  f.answer(initial.seats[0]!, "nit"); f.answer(initial.seats[1]!, "real");
  expect(f.next()!.voters).toEqual([]);
  expect(f.task.hunt!.panel!.seats).toHaveLength(2);
});

it("names required places only on an open vote step and closes the pair before its third phase", () => {
  const f = verifierFixture(); f.finding();
  const open = beginAgentStep(f.task, "verifier", "b-high", 100, BUILT_IN_ROLES);
  const initial = f.next()!;
  expect(open.seats).toEqual(["verifier:b-high", "verifier:c-high"]);
  f.answer(initial.seats[0]!, "nit"); f.answer(initial.seats[1]!, "nit");
  f.next();
  expect(open.endedAt).toBe(200);
  expect(open.reason).toBe("1 finding to check on a third tool");
  expect(open.seats).toEqual(["verifier:b-high", "verifier:c-high"]);
});

it("recovers complementary proven answers before selecting work without pretending either place is complete", () => {
  const f = verifierFixture(); f.finding(); f.finding("second");
  const seat = (toolId: string): VerifierSeat => ({ key: `${toolId}-high`, profileId: `${toolId}-high`, toolId, findingIds: ["finding", "second"], reason: "Saved vote" });
  f.answer(seat("b"), "not-a-bug"); f.answer(seat("c"), "not-a-bug", "second");
  for (const id of f.candidates) f.resolutions.set(id, { kind: "unavailable", waiting: "Usage limit" });
  const next = f.next()!, panel = f.task.hunt!.panel!;
  expect(panel.seats.map(seat => seat.toolId)).toEqual(["b", "c"]);
  expect(next.voters).toEqual(["b-high", "c-high"]);
  expect(seatRemaining(panel, panel.seats[0]!, f.task.findings, f.task.hunt!)).toEqual(["second"]);
  expect(seatRemaining(panel, panel.seats[1]!, f.task.findings, f.task.hunt!)).toEqual(["finding"]);
  expect(f.task.findings.every(finding => finding.verification === undefined)).toBe(true);
});

it.each(["round", "code"] as const)("keeps an answer from another %s as history without admitting its tool on that evidence", changed => {
  const f = verifierFixture(); f.finding();
  const seat: VerifierSeat = { key: "b-high", profileId: "b-high", toolId: "b", findingIds: ["finding"], reason: "Saved vote" };
  f.answer(seat, "real");
  const vote = f.task.findings[0]!.votes![0]!;
  if (changed === "round") vote.ballot!.round = 0;
  else vote.ballot!.versions = { product: "older-code" };
  const saved = structuredClone(vote);
  f.checkpoints.length = 0; // The restored record predates the admission being asserted below.
  for (const id of f.candidates) f.resolutions.set(id, { kind: "unavailable", waiting: "Usage limit" });
  f.next();
  expect(f.task.hunt!.panel).toBeUndefined();
  expect(f.task.findings[0]!.votes).toEqual([saved]); expect(f.checkpoints).toEqual([]);
});

it.each([false, true])("recovers an older untagged answer only from this ballot's recorded input (%s)", sameInput => {
  const f = verifierFixture(); f.finding();
  f.task.findings[0]!.votes = [{ by: "b-high", toolId: "b", plannedProfileId: "b-high", verdict: "not-a-bug", reason: "Saved answer" }];
  const old = beginAgentStep(f.task, "verifier", "b-high", 100, BUILT_IN_ROLES);
  old.reviewInput = { ...f.task.hunt!.input!, digest: sameInput ? "snapshot" : "another-snapshot" };
  old.result = { findings: structuredClone(f.task.findings) };
  endAgentStep(f.task, { outcome: "A partial answer", reason: "Waiting for peers" }, 101);
  for (const id of f.candidates) f.resolutions.set(id, { kind: "unavailable", waiting: "Usage limit" });
  f.next();
  expect(f.task.hunt!.panel !== undefined).toBe(sameInput);
  expect(f.task.findings[0]!.votes![0]!.ballot !== undefined).toBe(sameInput);
  expect(old.seats).toBeUndefined();
});

it("retains an already admitted majority electorate and its recorded replacements", () => {
  const f = verifierFixture(); f.finding();
  f.task.hunt!.voterProfiles = ["b-high", "c-high"];
  f.task.hunt!.voterReplacements = { "c-high": { from: "d-high", reason: "Recorded earlier handoff" } };
  f.closeAdmissions();
  const next = f.next()!;
  expect(next.panel!.rule).toBe("majority");
  expect(next.panel!.seats[1]!.replaced).toEqual({ from: "d-high", reason: "Recorded earlier handoff" });
  expect(f.task.hunt!.voterProfiles).toBeUndefined(); expect(f.task.hunt!.voterReplacements).toBeUndefined();
  expect(f.checkpoints).toHaveLength(1);
});

it("keeps an unavailable third place that was usable at selection, instead of changing the saved electorate", () => {
  const f = verifierFixture(); f.finding();
  const initial = f.next()!;
  initial.seats.forEach(seat => f.answer(seat, "nit"));
  f.resolutions.set("d-high", { kind: "unavailable", waiting: "Usage limit" });
  f.resolutions.set("a-high", { kind: "unavailable", waiting: "Usage limit" });
  const next = f.next()!;
  expect(next.voters).toEqual(["d-high"]);
  expect(next.seats[0]!.third).toBe(true);
  expect(f.task.hunt!.panel!.usable).toEqual(["a", "b", "c", "d"]);
});

it("records an unresolved escalation if a required third tool cannot be supplied", () => {
  const f = verifierFixture(); f.finding(); f.candidates.pop();
  const initial = f.next()!;
  initial.seats.forEach(seat => f.answer(seat, "nit"));
  f.candidates.splice(0, 1); // The author tool signs out after the panel was saved.
  const next = f.next()!;
  expect(next.voters).toEqual([]);
  expect(f.task.hunt!.panel!.escalations!.finding!.unresolved).toBe(true);
  expect(f.task.findings[0]!.verification).toBeUndefined();
});

it("does no selection work after every eligible finding has already been settled", () => {
  const f = verifierFixture(); f.finding(); f.task.findings[0]!.status = "fixed";
  f.resolutions.clear();
  expect(f.next()).toBeUndefined(); expect(f.checkpoints).toEqual([]);
});

it("synchronizes a custom voting role by result kind", () => {
  const f = verifierFixture(); f.finding();
  const verifier = BUILT_IN_ROLES.find(role => role.result === "votes")!;
  f.roles.push({ ...verifier, id: "independent-checker", name: "Independent checker" });
  const open = beginAgentStep(f.task, "independent-checker", "b-high", 100, f.roles);
  const initial = f.next()!;
  expect(open.seats).toEqual(["verifier:b-high", "verifier:c-high"]);
  initial.seats.forEach(seat => f.answer(seat, "nit")); f.next();
  expect(open.endedAt).toBe(200);
});
