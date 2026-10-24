import { afterAll, expect, it, spyOn } from "bun:test";
import { ballotOf, beginAgentStep, endAgentStep, type DeepMutable, type Finding, type VerifierPanel, type Vote, type WorkflowEvent } from "@petrina/core";
import { Engine } from "./engine.js";
import { tempDir, removeDir } from "./fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import { Coordination } from "../src/coordination.js";
import { ReviewResult } from "../src/roles.js";
import { formatFindings } from "../src/prompts.js";

const roots: string[] = [];
const engines: Engine[] = [];
afterAll(async () => {
  await Promise.all(engines.map(engine => engine.shutdown()));
  roots.forEach(removeDir);
});
const options = { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] };
function start(home: string) {
  const engine = new Engine(home, options);
  engine.setPoolPaused(true);
  engine.schedule = () => {};
  engines.push(engine);
  return engine;
}
function finding(id: string, extra: Partial<Finding> = {}): DeepMutable<Finding> {
  return structuredClone({ id, text: id, raisedBy: "opus-high", status: "open", severity: "blocking", confirmedBy: [], ...extra }) as DeepMutable<Finding>;
}
function fixture(findings: DeepMutable<Finding>[], shared = false) {
  const home = tempDir("petrina-review-evidence-"); roots.push(home);
  const engine = start(home);
  engine.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
  const task = engine.task(engine.addTask({ productId: "product", title: "A settled review", backlog: true }))!;
  if (shared) {
    task.repositories = ["product", "second"].map(productId => ({ productId, delivery: "local", completedStages: [] }));
    delete task.repository;
  }
  const stage = { id: "review", kind: "review-chain" as const, title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"] };
  task.plan = { rationale: "Examine the reports", plannerProfileId: "sol-high", stages: [stage] };
  task.stageIndex = 0; task.state = "running"; task.findings = findings;
  task.hunt = { stageId: stage.id, round: 1, reported: {}, findings: findings.length, input: { file: "unused", digest: "saved-round", heads: { product: "reviewed-head" }, trees: { product: "reviewed-tree" } } };
  task.journey = [{ id: "review", kind: "agent", stageId: stage.id, round: 1, sub: 0, roleId: stage.roleId, profileId: stage.profileIds[0], team: stage.profileIds, seats: ["reviewer:0", "reviewer:1"], startedAt: 10, reviewInput: structuredClone(task.hunt.input) }];
  engine.commit(task);
  return { engine, home, task, stage };
}
type Fixture = ReturnType<typeof fixture>;
async function handBack(f: Fixture, key: string, value: unknown) {
  const result = ReviewResult.parse(value);
  const node = f.task.journey!.at(-1)!;
  const profileId = f.stage.profileIds[Number(key)]!;
  node.agentInputs = [...(node.agentInputs ?? []), { at: 11, roleId: f.stage.roleId, profileId, reviewerKey: key, taskTitle: f.task.title, sections: [], mode: "fresh" }];
  node.agentResults = [...(node.agentResults ?? []), { roleId: f.stage.roleId, profileId, at: 12, inputIndex: node.agentInputs.length - 1, value: result }];
  await f.engine["reviews"]["applyReview"](executionFor(f.task), f.stage, result, profileId, f.stage.roleId, key);
  f.task.hunt!.reported[key] = true;
  f.engine.commit(f.task);
  return structuredClone(node.agentResults.at(-1)!);
}
function settle(f: Fixture) { f.engine["reviews"]["settleReviews"](f.task, f.stage); }
async function finish(f: Fixture) {
  settle(f);
  endAgentStep(f.task, { outcome: f.engine["reviews"]["raised"](f.task), reason: "Review finished" }, Date.now());
  f.engine.commit(f.task);
  const coordination = new Coordination(f.engine);
  const events = (await coordination.call("watch.events", { taskIds: [f.task.id], from: "oldest", timeoutMs: 0 })).events as WorkflowEvent[];
  const event = events.findLast(event => event.kind === "review.finished")!;
  expect(event).toBeDefined();
  const changes = f.task.journey!.at(-1)!.result?.findingChanges;
  if (changes) {
    expect(event.raised).toEqual(changes.raised);
    expect(event.fixed).toEqual(changes.fixed);
    expect(event.dismissed).toEqual(changes.dismissed);
    if (changes.reopened) expect(event.reopened).toEqual(changes.reopened);
    if (changes.claimedFixed) expect(event.claimedFixed).toEqual(changes.claimedFixed);
  }
  // Every transition named in a completed summary must resolve to that round's decision.
  const ids = [...event.raised as string[], ...event.fixed as string[], ...event.claimedFixed as string[], ...(event.reopened as { id: string }[]).map(entry => entry.id), ...event.dismissed as string[]];
  for (const id of new Set(ids)) {
    const read = await coordination.call("journey.finding", { taskId: f.task.id, nodeId: event.nodeId, findingId: id });
    expect(read.outcome).toBe("completed");
    expect(read.copy).toMatchObject({ basis: "settled" });
    expect(JSON.parse(String(read.text))).toEqual(f.task.findings.find(finding => finding.id === id));
  }
  return { event, coordination };
}

it("settles the original unsupported dispute after real hand-backs, retaining the participant's open report", async () => {
  const f = fixture([finding("disputed")]);
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

for (const reverse of [false, true]) it(`keeps confirmation ${reverse ? "before" : "after"} a dispute open in both copies`, async () => {
  const f = fixture([finding("confirmed")]);
  const values = [{ verdict: "pass", disputes: [{ id: "confirmed", reason: "My case passes." }] }, { verdict: "fail", confirms: ["confirmed"] }];
  if (reverse) values.reverse();
  const first = await handBack(f, "0", values[0]);
  const second = await handBack(f, "1", values[1]);
  await finish(f);
  expect(f.task.journey![0]!.result!.findings![0]!.status).toBe("open");
  expect(f.task.journey![0]!.agentResults).toEqual([first, second]);
});

for (const peer of ["pass", "fail", "confirm"] as const) it(`saves an unmentioned shared fix from scratch when its peer says ${peer}`, async () => {
  const answer = { fixed: true, text: "Repaired my part", at: 5 };
  const f = fixture([finding("shared", { productIds: ["product", "second"], answer, answers: { product: answer, second: answer } })], true);
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

for (const contested of [false, true]) it(`saves a proven pre-existing repair${contested ? " contested by current proof" : ""}`, async () => {
  const f = fixture([finding("older", { severity: "pre-existing" })]);
  const proof = "Original reproduction now passes; nearby control still passes.";
  const own = await handBack(f, "0", { verdict: "pass", resolves: [{ id: "older", evidence: proof }] });
  await handBack(f, "1", { verdict: contested ? "fail" : "pass", confirms: contested ? [{ id: "older", evidence: "The other account still fails." }] : [] });
  await finish(f);
  expect(f.task.journey![0]!.agentResults![0]).toEqual(own);
  const copy = f.task.journey![0]!.result!.findings![0]!;
  expect(copy.status).toBe(contested ? "open" : "fixed");
  if (!contested) expect(copy.resolution).toMatchObject({ evidence: proof, versions: { product: "reviewed-head" } });
});

it("includes an unmentioned builder fix claim and a newly raised report in settled evidence", async () => {
  const f = fixture([finding("claimed", { status: "fixed", answer: { fixed: true, text: "Repaired", at: 5 } })]);
  await handBack(f, "0", { verdict: "pass" });
  await handBack(f, "1", { verdict: "fail", findings: [{ text: "A new problem", severity: "important" }] });
  const { event } = await finish(f);
  expect(event.fixed).toEqual(["claimed"]);
  expect(event.claimedFixed).toEqual(["claimed"]);
  expect(event.raised).toHaveLength(1);
});

it("never records a settled decision when a partial group is closed", async () => {
  const f = fixture([finding("partial")]);
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

for (const rule of ["majority", "bounded"] as const) it(`keeps the reviewers' pre-vote copy while saving every ${rule} vote outcome after tally`, async () => {
  const verdicts: Vote["verdict"][] = ["real", "pre-existing", "nit", "not-a-bug"];
  const f = fixture([...verdicts.map(id => finding(id)), finding("rejected-reopen", { reopenedAt: 5, earlierReviews: [{ at: 4, confirmedBy: [], answer: { at: 3, fixed: true, text: "Repaired" }, verification: { by: "opus-high", verdict: "real", at: 2, reason: "Originally reproduced" } }] })]);
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

for (const [verdict, label] of [["pre-existing", "an older bug unrelated to the approved task"], ["nit", "only a nit"], ["not-a-bug", "not a bug"]] as const) it(`records the scope of a disputed ${verdict} vote in saved reasons and downstream findings, preserving history`, async () => {
  const repair = finding("required-repair", { text: "The explicitly requested older repair still fails.", evidence: "The starting and current versions fail the requested case; the nearby control passes." });
  const f = fixture([repair]);
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
  await f.engine.shutdown();
  const reloaded = start(f.home).task(f.task.id)!;
  expect(reloaded.findings[0]!.verification).toEqual(repair.verification);
  expect(reloaded.journey![0]).toEqual(history);
});

it("settles added reviewer roles by their result contract", async () => {
  const f = fixture([finding("custom")]);
  f.engine.s.roles.push({ ...f.engine.s.roles.find(role => role.result === "findings")!, id: "custom-review", name: "A new reviewer" });
  f.stage.roleId = "custom-review";
  f.task.journey![0]!.roleId = f.stage.roleId;
  await handBack(f, "0", { verdict: "pass", disputes: [{ id: "custom", reason: "The reproduction passes." }] });
  await handBack(f, "1", { verdict: "pass" });
  const { event } = await finish(f);
  expect(event.dismissed).toEqual(["custom"]);
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
