import { expect } from "bun:test";
import { endAgentStep, type DeepMutable, type Finding, type WorkflowEvent } from "@petrina/core";
import { Engine } from "../engine.js";
import { tempDir, removeDir } from "../fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import { Coordination } from "../../src/coordination.js";
import { ReviewResult } from "../../src/roles.js";

export function reviewEvidenceFixtures() {
const roots: string[] = [];
const engines: Engine[] = [];
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
async function close() {
  await Promise.all(engines.map(engine => engine.shutdown()));
  roots.forEach(removeDir);
 }
return { start, finding, fixture, handBack, settle, finish, close };
}
