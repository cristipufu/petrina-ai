import { afterAll, expect, it, spyOn } from "bun:test";
import { beginAgentStep, type WorkflowEvent } from "@petrina/core";
import { Coordination } from "../../../src/coordination.js";
import { reviewEvidenceFixtures } from "../../fixtures/review-evidence.js";

const { start, finding, fixture, handBack, settle, finish, close } = reviewEvidenceFixtures();
afterAll(close);
for (const recovery of ["uninterrupted", "try again", "try again with restarts"] as const) it(`keeps completed review claims and immutable links consistent after ${recovery}`, async () => {
  const f = fixture([
    finding("claim", { status: "fixed", answer: { fixed: true, text: "Repaired before review", at: 5 } }),
    finding("disputed"),
  ]);
  const first = await handBack(f, "0", { verdict: "pass", disputes: [{ id: "disputed", reason: "The reported case passes." }] });
  const input = structuredClone(f.task.hunt!.input);
  const restart = async () => {
    f.engine.commitNow(); await f.engine.shutdown();
    f.engine = start(f.home); f.task = f.engine.task(f.task.id)!;
  };
  const resume = () => {
    const step = beginAgentStep(f.task, f.stage.roleId, "sol-high", Date.now(), f.engine.s.roles, f.stage.profileIds);
    step.seats = ["reviewer:0", "reviewer:1"];
    step.reviewInput = structuredClone(f.task.hunt!.input);
    f.engine.commit(f.task);
    return step.id;
  };
  if (recovery !== "uninterrupted") {
    f.engine.fail(f.task.id, new Error("The second reviewer's tool stopped."));
    const item = f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "stuck")!;
    await f.engine.retry(item.id);
    const events = (await new Coordination(f.engine).call("watch.events", { taskIds: [f.task.id], from: "oldest", timeoutMs: 0 })).events as WorkflowEvent[];
    expect(events.find(event => event.kind === "node.finished" && event.nodeId === "review")!.review).toEqual({ examined: false, acceptedResults: 1, seats: 2 });
    if (recovery === "try again with restarts") await restart();
    resume();
  }
  // A new step, or a restart, does not finish the missing reviewer's work.
  settle(f);
  expect(f.task.hunt!.input).toEqual(input);
  expect(f.task.hunt!.reported).toEqual({ "0": true });
  expect(f.task.findings.find(finding => finding.id === "disputed")!.status).toBe("open");
  expect(f.task.journey!.at(-1)!.result?.findingsSettled).toBeUndefined();
  const incomplete = (await new Coordination(f.engine).call("watch.events", { taskIds: [f.task.id], from: "oldest", timeoutMs: 0 })).events as WorkflowEvent[];
  expect(incomplete.some(event => event.kind === "review.finished")).toBe(false);
  await handBack(f, "1", { verdict: "pass" });
  settle(f);
  if (recovery === "try again with restarts") await restart();
  const { event, coordination } = await finish(f);
  expect(event.nodeId).toBe(f.task.journey!.at(-1)!.id);
  expect(event.claimedFixed).toEqual(["claim"]);
  expect(event.fixed).toEqual(["claim"]);
  expect(event.dismissed).toEqual(["disputed"]);
  const settledNode = structuredClone(f.task.journey!.at(-1)!);
  const originalNode = structuredClone(f.task.journey![0]!);
  expect(originalNode.agentResults![0]).toEqual(first);
  const reads = ["claim", "disputed"].map(findingId => ({ taskId: f.task.id, nodeId: settledNode.id, findingId }));
  const saved = await Promise.all(reads.map(read => coordination.call("journey.finding", read)));
  f.task.rounds.review = 2;
  f.task.hunt = { stageId: f.stage.id, round: 2, reported: {}, findings: f.task.findings.length };
  resume();
  await handBack(f, "0", { verdict: "pass" }); await handBack(f, "1", { verdict: "pass" });
  const later = await finish(f);
  expect(later.event.claimedFixed).toEqual([]);
  expect(later.event.fixed).toEqual([]);
  expect(later.event.dismissed).toEqual([]);
  expect(f.task.journey!.at(-1)!.result!.findings).toEqual([]);
  if (recovery === "try again with restarts") await restart();
  expect(f.task.journey!.find(step => step.id === settledNode.id)).toEqual(settledNode);
  expect(f.task.journey![0]).toEqual(originalNode);
  for (const [index, read] of reads.entries()) expect(await new Coordination(f.engine).call("journey.finding", read)).toEqual(saved[index]!);
});

for (const status of ["dismissed", "fixed"] as const) it(`retains a ${status} round through restarts before and after settlement and later reopening`, async () => {
  const f = fixture([finding("reopened", status === "fixed" ? { status, answer: { fixed: true, text: "Repaired", at: 5 } } : {})]);
  const own = await handBack(f, "0", { verdict: "pass", disputes: status === "dismissed" ? [{ id: "reopened", reason: "The current reproduction passes." }] : [] });
  const restart = async () => {
    f.engine.commitNow(); await f.engine.shutdown();
    f.engine = start(f.home); f.task = f.engine.task(f.task.id)!;
  };
  await restart();
  expect(f.task.journey![0]!.agentResults![0]).toEqual(own);
  await handBack(f, "1", { verdict: "pass" });
  await restart();
  settle(f);
  const decision = structuredClone(f.task.journey![0]!.result);
  await restart();
  expect(f.task.journey![0]!.result).toEqual(decision);
  const { event } = await finish(f);
  const settled = structuredClone(f.task.journey![0]);
  const ref = (event.reports as { evidence: { read: Record<string, unknown> } }[])[0]!.evidence.read;
  await restart();
  f.task.rounds.review = 2;
  f.task.hunt = { stageId: "review", round: 2, reported: {}, findings: 1 };
  f.task.journey!.push({ id: "second-review", kind: "agent", stageId: "review", roleId: "code-reviewer", round: 2, sub: 0, startedAt: Date.now() });
  f.engine.commit(f.task);
  await handBack(f, "0", { verdict: "fail", confirms: [{ id: "reopened", evidence: "A fresh failing reproduction." }] });
  await handBack(f, "1", { verdict: "pass" });
  const second = await finish(f);
  expect(second.event.reopened).toEqual([{ id: "reopened", evidence: true }]);
  expect(f.task.findings[0]!.status).toBe("open");
  expect(f.task.journey![0]).toEqual(settled);
  await restart();
  const read = await new Coordination(f.engine).call("journey.finding", ref);
  expect(JSON.parse(String(read.text))).toMatchObject({ status });
  expect(read.copy).toMatchObject({ basis: "settled" });
});

for (const subject of ["a claimed fix", "a dismissed report and older nit"] as const) for (const recovery of ["uninterrupted", "try again", "try again with restarts"] as const) it(`retains the whole round when reopening ${subject} after ${recovery}`, async () => {
  const clock = spyOn(Date, "now").mockReturnValue(100);
  try {
    const claimed = subject === "a claimed fix";
    const id = claimed ? "claim" : "dismissed";
    const f = fixture(claimed
      ? [finding(id, { status: "fixed", answer: { fixed: true, text: "Builder's repair", at: 5 } })]
      : [finding(id, { status: "dismissed" }), finding("older-nit", { severity: "suggestion" })]);
    const proof = "Fresh reproduction: the reported case still fails on the reviewed code.";
    const own = await handBack(f, "0", { verdict: "fail", confirms: [{ id, evidence: proof }, ...(claimed ? [] : ["older-nit"])] });
    // A saved hand-back from before explicit transition records must also survive this recovery.
    if (!claimed && recovery === "try again with restarts") delete f.task.journey![0]!.result!.findingChanges;
    const input = structuredClone(f.task.hunt!.input);
    const restart = async () => {
      f.engine.commitNow(); await f.engine.shutdown();
      f.engine = start(f.home); f.task = f.engine.task(f.task.id)!;
    };
    const resume = () => {
      const step = beginAgentStep(f.task, f.stage.roleId, "sol-high", Date.now(), f.engine.s.roles, f.stage.profileIds);
      step.seats = ["reviewer:0", "reviewer:1"];
      step.reviewInput = structuredClone(f.task.hunt!.input);
      f.engine.commit(f.task);
    };
    if (recovery !== "uninterrupted") {
      clock.mockReturnValue(200);
      f.engine.fail(f.task.id, new Error("The second reviewer's tool stopped."));
      await f.engine.retry(f.engine.s.inbox.find(item => item.kind === "stuck" && item.taskId === f.task.id)!.id);
      if (recovery === "try again with restarts") await restart();
      resume();
    }
    const partial = structuredClone(f.task.journey![0]!);
    settle(f);
    expect(f.task.hunt!.input).toEqual(input);
    expect(f.task.hunt!.reported).toEqual({ "0": true });
    expect(f.task.journey!.at(-1)!.result?.findingsSettled).toBeUndefined();
    const incomplete = (await new Coordination(f.engine).call("watch.events", { taskIds: [f.task.id], from: "oldest", timeoutMs: 0 })).events as WorkflowEvent[];
    expect(incomplete.some(event => event.kind === "review.finished")).toBe(false);
    clock.mockReturnValue(300);
    await handBack(f, "1", { verdict: "pass" });
    settle(f);
    if (recovery === "try again with restarts") await restart();
    const { event, coordination } = await finish(f);
    expect(event.claimedFixed).toEqual(claimed ? [id] : []);
    expect(event.fixed).toEqual([]);
    expect(event.reopened).toEqual([{ id, evidence: true }]);
    expect((event.refs as { results: unknown[] }).results).toHaveLength(2);
    expect((event.refs as { inputs: unknown[] }).inputs).toHaveLength(2);
    if (recovery === "try again with restarts") expect(event.since).toBe("engine-start");
    else expect(event.reportCounts).toMatchObject({ opening: claimed ? { fixed: 1 } : { dismissed: 1, open: { nits: 1 } } });
    const decided = structuredClone(f.task.journey!.at(-1)!);
    const ids = claimed ? [id] : [id, "older-nit"];
    expect(decided.result?.findings?.map(finding => finding.id)).toEqual(ids);
    for (const findingId of ids) {
      const report = (event.reports as { id: string; evidence: unknown }[]).find(report => report.id === findingId)!;
      expect(report.evidence).toEqual({ read: { taskId: f.task.id, nodeId: decided.id, findingId } });
      const read = await coordination.call("journey.finding", { taskId: f.task.id, nodeId: decided.id, findingId });
      expect(JSON.parse(String(read.text))).toEqual(f.task.findings.find(finding => finding.id === findingId)!);
    }
    const saved = await coordination.call("journey.finding", { taskId: f.task.id, nodeId: decided.id, findingId: id });
    expect(JSON.parse(String(saved.text))).toMatchObject({ status: "open", evidence: proof, reopenedAt: 100 });
    expect(f.task.journey![0]!.agentResults![0]).toEqual(own);
    if (recovery !== "uninterrupted") expect(f.task.journey![0]).toEqual(partial);
    clock.mockReturnValue(400);
    f.task.rounds.review = 2;
    f.task.hunt = { stageId: f.stage.id, round: 2, reported: {}, findings: f.task.findings.length };
    resume();
    await handBack(f, "0", { verdict: "pass" }); await handBack(f, "1", { verdict: "pass" });
    const later = await finish(f);
    expect(later.event.claimedFixed).toEqual([]); expect(later.event.reopened).toEqual([]);
    expect(f.task.journey!.at(-1)!.result!.findings).toEqual([]);
    if (recovery === "try again with restarts") await restart();
    expect(f.task.journey!.find(step => step.id === decided.id)).toEqual(decided);
    expect(await new Coordination(f.engine).call("journey.finding", { taskId: f.task.id, nodeId: decided.id, findingId: id })).toEqual(saved);
  } finally { clock.mockRestore(); }
});

for (const status of ["fixed", "dismissed"] as const) for (const legacy of ["no changes", "no reopenings"] as const) it(`recovers a ${status} report reopened in the same unfinished step with ${legacy} recorded`, async () => {
  const clock = spyOn(Date, "now").mockReturnValue(100);
  try {
    const f = fixture([
      finding("reopened", { status, ...(status === "fixed" ? { answer: { fixed: true, text: "Builder's repair", at: 5 } } : {}) }),
      finding("already-open", { severity: "suggestion", reopenedAt: 5, evidence: "An earlier round's reproduction." }),
    ]);
    const proof = "Fresh reproduction after the reported fix: the case still fails.";
    const own = await handBack(f, "0", { verdict: "fail", confirms: [{ id: "reopened", evidence: proof }, "already-open"] });
    // Older releases saved the same participant copies without explicit reopening transitions.
    if (legacy === "no changes") delete f.task.journey![0]!.result!.findingChanges;
    else delete f.task.journey![0]!.result!.findingChanges!.reopened;
    const restart = async () => {
      f.engine.commitNow(); await f.engine.shutdown();
      f.engine = start(f.home); f.task = f.engine.task(f.task.id)!;
    };
    await restart();
    settle(f);
    expect(f.task.hunt!.reported).toEqual({ "0": true });
    expect(f.task.journey![0]!.result?.findingsSettled).toBeUndefined();
    const incomplete = (await new Coordination(f.engine).call("watch.events", { taskIds: [f.task.id], from: "oldest", timeoutMs: 0 })).events as WorkflowEvent[];
    expect(incomplete.some(event => event.kind === "review.finished")).toBe(false);
    clock.mockReturnValue(200);
    await handBack(f, "1", { verdict: "pass" });
    const { event, coordination } = await finish(f);
    expect(event.reopened).toEqual([{ id: "reopened", evidence: true }]);
    expect(event.claimedFixed).toEqual(status === "fixed" ? ["reopened"] : []);
    expect(event.fixed).toEqual([]);
    expect(f.task.journey).toHaveLength(1);
    expect(f.task.journey![0]!.agentResults![0]).toEqual(own);
    const settled = structuredClone(f.task.journey![0]!);
    const ref = { taskId: f.task.id, nodeId: settled.id, findingId: "reopened" };
    const saved = await coordination.call("journey.finding", ref);
    expect(JSON.parse(String(saved.text))).toMatchObject({ status: "open", evidence: proof, reopenedAt: 100 });
    // A later confirmation is still open, not another reopening; earlier evidence remains immutable.
    clock.mockReturnValue(300);
    f.task.rounds.review = 2;
    f.task.hunt = { stageId: f.stage.id, round: 2, reported: {}, findings: f.task.findings.length };
    const next = beginAgentStep(f.task, f.stage.roleId, "opus-high", Date.now(), f.engine.s.roles, f.stage.profileIds);
    next.seats = ["reviewer:0", "reviewer:1"];
    f.engine.commit(f.task);
    await handBack(f, "0", { verdict: "fail", confirms: [{ id: "reopened", evidence: proof }] });
    await handBack(f, "1", { verdict: "pass" });
    const later = await finish(f);
    expect(later.event.reopened).toEqual([]);
    expect(later.event.claimedFixed).toEqual([]);
    await restart();
    expect(f.task.journey![0]).toEqual(settled);
    expect(await new Coordination(f.engine).call("journey.finding", ref)).toEqual(saved);
  } finally { clock.mockRestore(); }
});

it("attributes only this round's decisions after earlier dismissals, fixes and unmentioned reports, including restart", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(100);
  try {
    const f = fixture([
      finding("dismissed"),
      finding("earlier-fix", { status: "fixed", answer: { fixed: true, text: "Earlier repair", at: 5 } }),
      finding("later-fix"),
      finding("untouched", { severity: "suggestion" }),
      finding("confirmed-old", { severity: "suggestion" }),
    ]);
    await handBack(f, "0", { verdict: "pass", disputes: [{ id: "dismissed", reason: "The original case passes." }], confirms: ["confirmed-old"] });
    await handBack(f, "1", { verdict: "pass" });
    await finish(f);
    const first = structuredClone(f.task.journey![0]!);
    expect(first.result?.findingChanges).toEqual({ raised: [], fixed: ["earlier-fix"], dismissed: ["dismissed"], reopened: [], claimedFixed: ["earlier-fix"] });
    expect(first.result?.findings?.map(finding => finding.id)).toEqual(["dismissed", "earlier-fix", "confirmed-old"]);
    const later = f.task.findings.find(finding => finding.id === "later-fix")!;
    later.status = "fixed"; later.answer = { fixed: true, text: "New repair", at: 150 };
    for (const number of [2, 3]) {
      clock.mockReturnValue(number * 100);
      f.task.rounds.review = number;
      f.task.hunt = { stageId: "review", round: number, reported: {}, findings: f.task.findings.length };
      f.task.journey!.push({ id: `review-${number}`, kind: "agent", stageId: "review", round: number, sub: 0, roleId: "code-reviewer", profileId: "opus-high", team: f.stage.profileIds, seats: ["reviewer:0", "reviewer:1"], startedAt: Date.now() });
      f.engine.commit(f.task);
      await handBack(f, "0", { verdict: "pass" });
      if (number === 2) {
        f.engine.commitNow(); await f.engine.shutdown();
        f.engine = start(f.home); f.task = f.engine.task(f.task.id)!;
      }
      await handBack(f, "1", { verdict: "pass" });
      const { event } = await finish(f);
      expect(event.fixed).toEqual(number === 2 ? ["later-fix"] : []);
      expect(event.raised).toEqual([]); expect(event.dismissed).toEqual([]);
      expect(f.task.journey!.at(-1)!.result!.findings!.map(finding => finding.id)).toEqual(number === 2 ? ["later-fix"] : []);
      expect(f.task.journey!.at(-1)!.outcome).toBe("Nothing to fix");
      expect(f.task.journey![0]).toEqual(first);
    }
  } finally { clock.mockRestore(); }
});
