import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { ballotOf, endAgentStep, type DeepMutable, type VerifierPanel, type Vote, type WorkflowEvent } from "@petrina/core";
import { Coordination } from "../../../src/coordination.js";
import { formatFindings } from "../../../src/prompts.js";
import { reviewEvidenceFixtures } from "../../fixtures/review-evidence.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const { start, finding, fixture, handBack, settle, finish } = reviewEvidenceFixtures();
it("settles the original unsupported dispute after real hand-backs, retaining the participant's open report", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = fixture(owner, [finding("disputed")]);
    const own = await handBack(f, "0", { verdict: "pass", disputes: [{ id: "disputed", reason: "The reproduction passes." }] });
    settle(f);
    expect(f.task.findings[0]!.status).toBe("open");
    expect(f.task.journey![0]!.result?.findingsSettled).toBeUndefined();
    await handBack(f, "1", { verdict: "pass" });
    const { event, coordination } = await finish(f);
    expect(event.dismissed).toEqual(["disputed"]);
    expect(event.openImportant).toEqual([]);
    expect(event.reports).toEqual([expect.objectContaining({ id: "disputed", status: "dismissed", evidence: { read: { taskId: f.task.id, nodeId: "review", findingId: "disputed" } } })]);
    expect(f.task.journey![0]!.outcome).toBe("Nothing to fix");
    expect(f.task.journey![0]!.agentResults![0]).toEqual(own);
    const read = await coordination.call("journey.finding", { taskId: f.task.id, nodeId: "review", findingId: "disputed", result: 0 });
    expect(JSON.parse(String(read.text))).toMatchObject({ status: "open", disputes: [{ reason: "The reproduction passes." }] });
    expect(read.copy).toMatchObject({ basis: "hand-back", label: "Participant’s report before the round’s decision" });

  });
});

for (const reverse of [false, true]) it(`keeps confirmation ${reverse ? "before" : "after"} a dispute open in both copies`, async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = fixture(owner, [finding("confirmed")]);
    const values = [{ verdict: "pass", disputes: [{ id: "confirmed", reason: "My case passes." }] }, { verdict: "fail", confirms: ["confirmed"] }];
    if (reverse) values.reverse();
    const first = await handBack(f, "0", values[0]);
    const second = await handBack(f, "1", values[1]);
    await finish(f);
    expect(f.task.journey![0]!.result!.findings![0]!.status).toBe("open");
    expect(f.task.journey![0]!.agentResults).toEqual([first, second]);

  });
});

for (const peer of ["pass", "fail", "confirm"] as const) it(`saves an unmentioned shared fix from scratch when its peer says ${peer}`, async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const answer = { fixed: true, text: "Repaired my part", at: 5 };
    const f = fixture(owner, [finding("shared", { productIds: ["product", "second"], answer, answers: { product: answer, second: answer } })], true);
    await handBack(f, "0", { verdict: "pass" });
    settle(f);
    expect(f.task.findings[0]!.status).toBe("open");
    expect(f.task.journey![0]!.result!.findings).toEqual([]);
    await handBack(f, "1", { verdict: peer === "pass" ? "pass" : "fail", confirms: peer === "confirm" ? [{ id: "shared", evidence: "Still fails across products." }] : [] });
    const { event } = await finish(f);
    const expected = peer === "pass" ? "fixed" : "open";
    expect(f.task.findings[0]!.status).toBe(expected);
    expect(f.task.journey![0]!.result!.findings![0]!.status).toBe(expected);
    expect(event.fixed).toEqual(peer === "pass" ? ["shared"] : []);

  });
});

for (const contested of [false, true]) it(`saves a proven pre-existing repair${contested ? " contested by current proof" : ""}`, async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = fixture(owner, [finding("older", { severity: "pre-existing" })]);
    const proof = "Original reproduction now passes; nearby control still passes.";
    const own = await handBack(f, "0", { verdict: "pass", resolves: [{ id: "older", evidence: proof }] });
    await handBack(f, "1", { verdict: contested ? "fail" : "pass", confirms: contested ? [{ id: "older", evidence: "The other account still fails." }] : [] });
    await finish(f);
    expect(f.task.journey![0]!.agentResults![0]).toEqual(own);
    const copy = f.task.journey![0]!.result!.findings![0]!;
    expect(copy.status).toBe(contested ? "open" : "fixed");
    if (!contested) expect(copy.resolution).toMatchObject({ evidence: proof, versions: { product: "reviewed-head" } });

  });
});

it("includes an unmentioned builder fix claim and a newly raised report in settled evidence", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = fixture(owner, [finding("claimed", { status: "fixed", answer: { fixed: true, text: "Repaired", at: 5 } })]);
    await handBack(f, "0", { verdict: "pass" });
    await handBack(f, "1", { verdict: "fail", findings: [{ text: "A new problem", severity: "important" }] });
    const { event } = await finish(f);
    expect(event.fixed).toEqual(["claimed"]);
    expect(event.claimedFixed).toEqual(["claimed"]);
    expect(event.raised).toHaveLength(1);

  });
});

it("never records a settled decision when a partial group is closed", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = fixture(owner, [finding("partial")]);
    await handBack(f, "0", { verdict: "pass", disputes: [{ id: "partial", reason: "My case passes." }] });
    settle(f);
    endAgentStep(f.task, { outcome: "Stopped" }, Date.now());
    settle(f);
    f.engine.commit(f.task);
    expect(f.task.findings[0]!.status).toBe("open");
    expect(f.task.journey![0]!.result?.findingsSettled).toBeUndefined();
    const events = (await new Coordination(f.engine).call("watch.events", { taskIds: [f.task.id], from: "oldest", timeoutMs: 0 })).events as WorkflowEvent[];
    expect(events.some(event => event.kind === "review.finished")).toBe(false);

  });
});

for (const rule of ["majority", "bounded"] as const) it(`keeps the reviewers' pre-vote copy while saving every ${rule} vote outcome after tally`, async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const verdicts: Vote["verdict"][] = ["real", "pre-existing", "nit", "not-a-bug"];
    const f = fixture(owner, [...verdicts.map(id => finding(id)), finding("rejected-reopen", { reopenedAt: 5, earlierReviews: [{ at: 4, confirmedBy: [], answer: { at: 3, fixed: true, text: "Repaired" }, verification: { by: "opus-high", verdict: "real", at: 2, reason: "Originally reproduced" } }] })]);
    await handBack(f, "0", { verdict: "fail", confirms: f.task.findings.map(finding => ({ id: finding.id, evidence: "The current reproduction still fails." })) });
    await handBack(f, "1", { verdict: "pass" });
    await finish(f);
    const before = structuredClone(f.task.journey![0]);
    f.task.journey!.push({ id: "vote", kind: "agent", roleId: "verifier", profileId: "sol-high", seats: ["verifier:sol-high"], round: 1, sub: 0, stageId: "review", startedAt: Date.now() });
    f.engine.commit(f.task);
    const voters = [{ profileId: "sol-high", toolId: "codex" }, { profileId: "grok-high", toolId: "grok" }, { profileId: "opus-high", toolId: "claude-code" }, { profileId: "argon-high", toolId: "antigravity" }];
    const panel: VerifierPanel = {
      rule,
      usable: voters.map(voter => voter.toolId),
      seats: voters.slice(0, rule === "bounded" ? 3 : voters.length).map((voter, index) => ({
        ...voter, key: voter.profileId, reason: "Checks the assigned current reports",
        findingIds: f.task.findings.filter(finding => rule !== "bounded" || index < 2 || finding.id !== "real").map(finding => finding.id),
        ...(rule === "bounded" && index === 2 ? { third: true } : {}),
      })),
    };
    f.task.hunt!.panel = structuredClone(panel) as DeepMutable<VerifierPanel>;
    for (const finding of f.task.findings) finding.votes = panel.seats.filter(seat => seat.findingIds.includes(finding.id)).map(seat => ({ by: seat.profileId, toolId: seat.toolId, verdict: verdicts.includes(finding.id as Vote["verdict"]) ? finding.id as Vote["verdict"] : "not-a-bug", reason: "Checked the current reproduction", ballot: ballotOf(f.task.hunt!, seat.key) }));
    const step = f.task.journey!.at(-1)!;
    step.agentResults = [{ roleId: "verifier", profileId: "sol-high", at: Date.now(), value: { verdicts: f.task.findings.map(finding => ({ id: finding.id, verdict: finding.votes![0]!.verdict, reason: finding.votes![0]!.reason })) }, findings: structuredClone(f.task.findings) }];
    const own = structuredClone(step.agentResults);
    const outcome = f.engine["reviews"]["ballots"].finish(f.task, { findings: f.task.findings, seats: [], voters: [], panel });
    expect(outcome).toBe("5 checked: 1 must be fixed in this change, 1 already there before this change, 1 minor, 2 not a bug");
    expect(f.task.findings.map(finding => [finding.status, finding.severity])).toEqual([["open", "blocking"], ["open", "pre-existing"], ["open", "suggestion"], ["dismissed", "blocking"], ["fixed", "blocking"]]);
    expect(f.task.journey!.at(-1)!.result).toEqual({ findings: f.task.findings, findingsSettled: true });
    const { event } = await finish(f);
    expect(event.nodeId).toBe("vote");
    expect(step.agentResults).toEqual(own);
    expect(f.task.journey![0]).toEqual(before);

  });
});

for (const [verdict, label] of [["pre-existing", "an older bug unrelated to the approved task"], ["nit", "only a nit"], ["not-a-bug", "not a bug"]] as const) it(`records the scope of a disputed ${verdict} vote in saved reasons and downstream findings, preserving history`, async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const repair = finding("required-repair", { text: "The explicitly requested older repair still fails.", evidence: "The starting and current versions fail the requested case; the nearby control passes." });
    const f = fixture(owner, [repair]);
    const oldReason = "An earlier verifier answered older than the change: the problem was already there.";
    f.task.journey![0]!.result = { findings: [finding("historical", { verification: { by: "sol-high", verdict: "real", reason: oldReason, at: 1 } })], findingsSettled: true };
    const history = structuredClone(f.task.journey![0]);
    const panel: VerifierPanel = {
      rule: "bounded", usable: ["codex", "grok"],
      seats: [{ key: "real", profileId: "sol-high", toolId: "codex", findingIds: [repair.id], reason: "Check the required repair" },
        { key: "dispute", profileId: "grok-high", toolId: "grok", findingIds: [repair.id], reason: "Independently check the same finding" }],
    };
    f.task.hunt!.panel = structuredClone(panel) as DeepMutable<VerifierPanel>;
    const realReason = "The approved task explicitly requires this older repair; the current reproduction still fails.";
    const disputeReason = "The independent verifier's recorded explanation.";
    repair.votes = panel.seats.map(seat => ({ by: seat.profileId, toolId: seat.toolId, verdict: seat.key === "real" ? "real" : verdict, reason: seat.key === "real" ? realReason : disputeReason, ballot: ballotOf(f.task.hunt!, seat.key) }));
    f.task.journey!.push({ id: "vote", kind: "agent", roleId: "verifier", profileId: "sol-high", stageId: "review", round: 1, sub: 0, startedAt: Date.now() });
    const votes = structuredClone(repair.votes);
    const outcome = f.engine["reviews"]["ballots"].finish(f.task, { findings: f.task.findings, seats: [], voters: [], panel });
    expect(outcome).toBe("1 checked: 1 must be fixed in this change (1 disputed)");
    expect(repair.status).toBe("open"); expect(repair.severity).toBe("blocking");
    expect(repair.verification?.verdict).toBe("real");
    expect(repair.verification!.reason).toStartWith(`${realReason} Disputed: `);
    expect(repair.verification!.reason).toContain(`answered ${label}: ${disputeReason}`);
    expect(repair.votes).toEqual(votes);
    expect(f.task.journey!.at(-1)!.result?.findings?.[0]?.verification).toEqual(repair.verification);
    expect(formatFindings([repair], { complete: true })).toContain(repair.verification!.reason);
    expect(f.task.journey![0]).toEqual(history);
    await owner.stop(f.engine);
    const reloaded = start(owner, f.home).task(f.task.id)!;
    expect(reloaded.findings[0]!.verification).toEqual(repair.verification);
    expect(reloaded.journey![0]).toEqual(history);

  });
});

it("settles added reviewer roles by their result contract", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = fixture(owner, [finding("custom")]);
    f.engine.s.roles.push({ ...f.engine.s.roles.find(role => role.result === "findings")!, id: "custom-review", name: "A new reviewer" });
    f.stage.roleId = "custom-review";
    f.task.journey![0]!.roleId = f.stage.roleId;
    await handBack(f, "0", { verdict: "pass", disputes: [{ id: "custom", reason: "The reproduction passes." }] });
    await handBack(f, "1", { verdict: "pass" });
    const { event } = await finish(f);
    expect(event.dismissed).toEqual(["custom"]);

  });
});
