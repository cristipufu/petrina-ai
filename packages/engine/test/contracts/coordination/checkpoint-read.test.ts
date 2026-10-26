import { afterAll, expect, it } from "bun:test";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeCheckPrerequisites, type CheckRun, type DeepMutable, type Finding, type InboxKind, type JourneyStep, type TaskSource } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Coordination, type Result } from "../../../src/coordination.js";
import { executionFor } from "@petrina/orchestrator";
import { readText } from "../../../src/evidence-read.js";
import { CHECK_EXIT_UNREPORTED, tidyOutput } from "../../../src/checks.js";
import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";

import { removeDir, tempDir } from "../../fixtures.js";
import { saveExactMessage } from "../../../src/exact-input.js";
import { Work } from "../../../src/work.js";
import type { Turns } from "../../../src/turn.js";






const roots: string[] = [], engines: Engine[] = [];
afterAll(async () => {
  await Promise.all(engines.map((engine) => engine.shutdown()));
  roots.forEach(removeDir);
});
function fixture() {
  const home = tempDir("petrina-checkpoint-");
  roots.push(home);
  const e = new Engine(home, { agentCommand: () => undefined, terminals: () => [] });
  engines.push(e);
  e.setPoolPaused(true);
  e.schedule = () => {};
  e.s.products.push({ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" });
  const taskId = e.addTask({ productId: "product", title: "A compact decision" });
  const task = e.task(taskId)!;
  const c = new Coordination(e);
  const offer = (kind: InboxKind, body = "Inspect the recorded work before deciding.") => {
    const id = `request-${kind}`;
    e.s.inbox.push({ id, taskId, kind, title: `A ${kind} decision`, body, at: 10, blocking: false, options: ["Approve", "Request changes"] });
    return id;
  };
  return { e, c, home, taskId, task, work: executionFor(task).work, offer };
}
const source = (id = "product", delivery: TaskSource["destination"]["mode"] = "local"): TaskSource => ({ product: { id, name: id === "product" ? "Example" : "API", repo: `local/${id}` }, start: { kind: "branch", branch: "main" }, destination: { mode: delivery, repo: `local/${id}`, branch: "main", kind: delivery === "local" ? "branch" : "new-pr" }, confirmed: true });
// The facts Petrina records when it creates a log, taken here from a hand-built file.
const verifiedLog = (path: string) => {
  const info = statSync(path, { bigint: true });
  const beginning = createHash("sha256").update(readFileSync(path).subarray(0, 4096)).digest("hex");
  return { logPath: path, logFileIdentity: { device: String(info.dev), inode: String(info.ino) }, logFileLength: Number(info.size), logFileBeginning: beginning };
};
const run = (name: string, output = ""): CheckRun => ({ name, command: `check ${name}`, ok: true, execution: completeCheckExecution(0), ms: 150, startedAt: 1, endedAt: 151, output, logComplete: true });
const finding = (id: string, severity: Finding["severity"] = "blocking"): DeepMutable<Finding> => ({ id, text: `Report ${id}`, severity, status: "open", raisedBy: "opus-high", confirmedBy: [] });
async function complete(c: Coordination, name: string, args: Record<string, unknown> = {}) {
  const pages: Result[] = [];
  let page = await c.call(name, args), text = String(page.text);
  pages.push(page);
  while (page.next) {
    page = await c.call(name, { ...args, cursor: page.next });
    expect(page.outcome).toBe("completed");
    pages.push(page);
    text += page.text;
  }
  return { pages, value: JSON.parse(text), text, size: pages.reduce((size, page) => size + JSON.stringify(page).length, 0) };
}

const linuxReason = "This machine is a Mac; Linux verification could not be run here.";
function acceptanceRun(roleId = "tester", id = "actual-testing"): DeepMutable<JourneyStep> {
  const checks = [...Array.from({ length: 7 }, (_, index) => ({ text: `Recorded scenario ${index + 1}`, result: "pass" as const, evidence: `Observed scenario ${index + 1}` })), { text: "Linux verification", result: "blocked" as const, reason: linuxReason }];
  return { id, kind: "agent", roleId, stageId: "test", profileId: "sol-high", round: 1, sub: 0, startedAt: 20, endedAt: 30, end: "done", acceptanceChecks: checks, agentResults: [{ roleId, profileId: "sol-high", at: 30, versions: { product: "tested-tree" }, value: { summary: "Seven checks passed; Linux unavailable", checks } }] };
}
function recordAcceptance(f: ReturnType<typeof fixture>, roleId = "tester") {
  f.task.journey = [acceptanceRun(roleId)];
  f.work.checks = { at: 35, current: true, tree: "tested-tree", sha: "tested-head", results: [] };
  f.work.checkedSha = "tested-head";
  f.work.checkedPatch = "tested-change";
  f.task.testedPatch = "tested-change";
  f.task.journey[0]!.acceptancePatch = "tested-change";
  f.task.testedVersions = { product: "tested-tree" };
  f.task.acceptancePassed = false;
  f.task.acceptanceUnverified = true;
  f.task.plan = { rationale: "Test the change", plannerProfileId: "sol-high", stages: [{ id: "test", title: "Try the finished work", kind: "do", roleId, profileIds: ["sol-high"] }] };
  return f.task.journey[0]!;
}

it("links a no-brief delivery to its actual seven passes, unavailable Linux check, original report and exact input", async () => {
  const f = fixture(), node = recordAcceptance(f);
  f.task.description = "Keep full Linux validation in its separate task.";
  const exact = await saveExactMessage(f.home, f.taskId, "Try the acceptance scenarios. Keep full Linux validation separate.");
  node.agentInputs = [
    { roleId: "builder", profileId: "sol-high", taskTitle: f.task.title, mode: "fresh", sections: [] },
    { roleId: "tester", profileId: "sol-high", taskTitle: f.task.title, mode: "fresh", at: 20, sections: [], exact },
  ];
  node.agentResults!.unshift({ roleId: "builder", profileId: "sol-high", at: 18, value: { summary: "Unrelated original response" } });
  node.agentResults![1]!.inputIndex = 1;
  const itemId = f.offer("delivery");
  const { value, pages } = await complete(f.c, "inbox.inspect", { itemId, limit: 700 });
  expect(pages.length).toBeGreaterThan(1);
  const a = value.acceptance;
  expect(a).toMatchObject({ passed: false, unverified: true, items: [], requirements: { state: "no-brief", message: expect.stringContaining("No design brief recorded") } });
  expect(a.evidence.counts).toEqual({ passed: 7, failed: 0, couldNotVerify: 1 });
  expect(a.evidence.checks[0]).toEqual({ index: 7, text: "Linux verification", result: "blocked", kind: "additional", reason: linuxReason, evidenceRecorded: false, shortened: false });
  expect(a.evidence.products[0].state).toBe("same-contents");
  expect(a.evidence.report).toEqual({ operation: "journey.result", taskId: f.taskId, nodeId: node.id, index: 1, seat: "tester" });
  expect(a.evidence.inputs).toEqual({ operation: "journey.input", taskId: f.taskId, nodeId: node.id, seat: "tester", index: 0 });
  const { operation: nr, ...na } = a.evidence.read;
  expect((await complete(f.c, nr, na)).value.acceptanceChecks).toEqual(node.acceptanceChecks);
  const { operation: rr, ...ra } = a.evidence.report;
  expect((await complete(f.c, rr, ra)).value).toEqual(node.agentResults![1]!.value);
  const { operation: ir, ...ia } = a.evidence.inputs;
  expect((await f.c.call(ir, ia)).text).toBe("Try the acceptance scenarios. Keep full Linux validation separate.");
  const { operation: tr, ...ta } = value.task.request.read;
  expect(String((await f.c.call(tr, ta)).text)).toContain("Keep full Linux validation in its separate task.");
  expect((await f.c.call("inbox.inspect", { itemId })).revision).toBe(pages[0]!.revision);
});

it("keeps delivery evidence readable and decisions bound to that evidence through prerequisite wait changes", async () => {
  const f = fixture(), node = recordAcceptance(f);
  f.task.startedAt = 1;
  f.task.state = "needs-you";
  const prerequisiteId = f.e.addTask({ productId: "product", title: "Fix the unavailable verification" });
  const itemId = f.offer("delivery");
  const before = await complete(f.c, "inbox.inspect", { itemId });
  for (const [index, reason] of ["The verification fix must land", "The final verification still needs the fix"].entries()) {
    expect((await f.c.call("task.wait", { taskId: f.taskId, after: [prerequisiteId], reason, requestId: `wait-evidence-${index}` })).outcome).toBe("completed");
    const held = await complete(f.c, "inbox.inspect", { itemId });
    expect(held.pages[0]!.revision).toBe(before.pages[0]!.revision);
    expect(held.value.acceptance).toEqual(before.value.acceptance);
    const { operation, ...args } = held.value.acceptance.evidence.report;
    expect((await complete(f.c, operation, args)).value).toEqual(node.agentResults![0]!.value);
  }
  node.acceptanceChecks![0]!.evidence += " A changed recorded observation";
  expect((await f.c.call("inbox.approve", { itemId, revision: before.pages[0]!.revision, requestId: "changed-held-evidence" })).outcome).toBe("changed");
  const changed = await complete(f.c, "inbox.inspect", { itemId });
  expect(changed.pages[0]!.revision).not.toBe(before.pages[0]!.revision);
  expect((await f.c.call("task.wait", { taskId: f.taskId, after: [], reason: "Proceed with the recorded evidence", requestId: "clear-evidence-wait" })).outcome).toBe("completed");
  const cleared = await complete(f.c, "inbox.inspect", { itemId });
  expect(cleared.pages[0]!.revision).toBe(changed.pages[0]!.revision);
  expect(cleared.value.acceptance).toEqual(changed.value.acceptance);
  expect(f.e.s.inbox.find((item) => item.id === itemId)).toBeDefined();
});

it("leaves acceptance coverage unknown after only the product's check commands change", async () => {
  const f = fixture(); recordAcceptance(f);
  const itemId = f.offer("delivery");
  const before = await complete(f.c, "inbox.inspect", { itemId });
  expect(before.value.acceptance.evidence.products[0].state).toBe("same-contents");
  f.e.setProductChecks("product", [{ name: "New check", command: "new-check" }]);
  expect(f.work.checks!.current).toBe(false);
  const after = await complete(f.c, "inbox.inspect", { itemId });
  expect(after.value.acceptance.evidence.products[0]).toMatchObject({ state: "unknown", testedTree: "tested-tree", checkedTree: "tested-tree" });
  expect(after.value.acceptance.evidence.counts).toEqual(before.value.acceptance.evidence.counts);
  expect(after.value.acceptance.passed).toBe(false);
  expect(after.value.acceptance.unverified).toBe(true);
  expect((await f.c.call("inbox.approve", { itemId, revision: before.pages[0]!.revision, requestId: "check-commands-changed" })).outcome).toBe("changed");
  // A subsequent current record on the tested contents restores the coverage answer.
  f.work.checks!.current = true;
  expect((await complete(f.c, "inbox.inspect", { itemId })).value.acceptance.evidence.products[0].state).toBe("same-contents");
});

it("keeps uncertain check status separate from a known later edit for each product", async () => {
  const f = fixture(), node = recordAcceptance(f);
  node.agentResults![0]!.versions = { product: "tested-tree", api: "tested-api" };
  f.work.checks!.current = false;
  f.task.repositories = [{ ...f.work, completedStages: [] }, { productId: "api", delivery: "local", completedStages: [], checks: { at: 40, tree: "tested-api", current: true, results: [] } }];
  delete f.task.repository;
  const itemId = f.offer("delivery");
  let a = (await complete(f.c, "inbox.inspect", { itemId })).value.acceptance;
  expect(a.evidence.products.map((product: any) => [product.productId, product.state])).toEqual([["product", "unknown"], ["api", "same-contents"]]);
  delete f.task.repositories[0]!.checks!.current;
  a = (await complete(f.c, "inbox.inspect", { itemId })).value.acceptance;
  expect(a.evidence.products.map((product: any) => [product.productId, product.state])).toEqual([["product", "unknown"], ["api", "same-contents"]]);
  f.task.repositories[0]!.checks!.current = false;
  f.task.journey!.push({ ...acceptanceRun("builder", "changed-product"), acceptanceChecks: undefined, agentResults: undefined, buildVersions: { product: "new-tree" }, endedAt: 40 });
  a = (await complete(f.c, "inbox.inspect", { itemId })).value.acceptance;
  expect(a.evidence.products.map((product: any) => [product.productId, product.state])).toEqual([["product", "changed"], ["api", "same-contents"]]);
});

for (const retainInputs of [false, true]) it(`opens retained acceptance checks without a participant report (${retainInputs ? "with" : "without"} instructions)`, async () => {
  const f = fixture(), node = recordAcceptance(f);
  delete node.agentResults;
  if (retainInputs) node.agentInputs = [{ roleId: "tester", profileId: "sol-high", at: 20, taskTitle: f.task.title, mode: "fresh", instructions: "Try the recorded scenarios", sections: [] }];
  const a = (await complete(f.c, "inbox.inspect", { itemId: f.offer("delivery") })).value.acceptance;
  expect(a.evidence.counts).toEqual({ passed: 7, failed: 0, couldNotVerify: 1 });
  expect(a.evidence.report).toBeUndefined();
  expect(a.evidence.reportUnavailable).toBe("No original participant report was retained on this step.");
  expect(a.evidence.inputs).toBeUndefined();
  expect(a.evidence.inputsUnavailable).toContain("No exact input reference");
  expect(a.evidence.products[0].state).toBe("unknown");
  const { operation, ...args } = a.evidence.read;
  const saved = (await complete(f.c, operation, args)).value;
  expect(saved.acceptanceChecks).toEqual(node.acceptanceChecks);
  if (retainInputs) expect(saved.agentInputs[0].instructions).toBe("Try the recorded scenarios");
});

for (const variant of ["no testing planned", "not run", "no results", "empty results", "name only"]) it(`explains unavailable acceptance evidence: ${variant}`, async () => {
  const f = fixture();
  const node = recordAcceptance(f);
  if (variant === "no testing planned") { f.task.journey = []; delete f.task.plan; }
  if (variant === "not run") f.task.journey = [];
  if (variant === "no results") { delete node.acceptanceChecks; delete node.agentResults; }
  if (variant === "empty results") node.acceptanceChecks = [];
  if (variant === "name only") {
    f.e.s.roles = f.e.s.roles.map((role) => role.id === "tester" ? { ...role, result: "notes" } : role);
  }
  const evidence = (await complete(f.c, "inbox.inspect", { itemId: f.offer("delivery") })).value.acceptance.evidence;
  expect(evidence.state).toBe("unavailable");
  expect(evidence.reason).toBe(variant === "not run" ? "Testing has not run yet." : ["no results", "empty results"].includes(variant) ? "Testing ran but recorded no completed check results." : "No testing step is planned or recorded.");
  expect(evidence.counts).toEqual({ passed: 0, failed: 0, couldNotVerify: 0 });
  if (variant !== "empty results") { expect(evidence.report).toBeUndefined(); expect(evidence.read).toBeUndefined(); }
});

for (const owned of [false, true]) it(`recognizes ${owned ? "task-owned" : "custom"} testing roles by their checks result`, async () => {
  const f = fixture();
  const role = { ...f.e.s.roles.find((role) => role.result === "checks")!, id: "quality-partner", name: "Quality partner" };
  if (owned) f.task.maintenance = { routineId: "routine", routineName: "Routine", scheduledAt: 1, queuedAt: 1, zone: "UTC", focus: "Try it", input: "Try it", role, profile: f.e.s.profiles[0]!, product: f.e.s.products[0]! };
  else f.e.s.roles.push(role);
  recordAcceptance(f, role.id);
  const a = (await complete(f.c, "inbox.inspect", { itemId: f.offer("delivery") })).value.acceptance;
  expect(a.evidence.counts).toEqual({ passed: 7, failed: 0, couldNotVerify: 1 });
  expect(a.evidence.report.seat).toBe(role.id);
  const { operation, ...args } = a.evidence.report;
  expect((await complete(f.c, operation, args)).value.checks).toHaveLength(8);
});

for (const variant of ["later edit", "later edit without checks", "later edit with unverified checks", "same change", "different change", "unbound test", "unbound checks", "missing run change", "different run change", "later empty test", "missing tested version", "running edit", "restored contents"]) it(`reports acceptance version coverage honestly: ${variant}`, async () => {
  const f = fixture(); recordAcceptance(f);
  if (variant !== "restored contents") f.work.checks!.tree = "new-tree";
  if (variant.startsWith("later edit") || ["same change", "different change", "running edit", "restored contents"].includes(variant)) {
    f.task.journey!.push({ ...acceptanceRun("builder", "later-edit"), acceptanceChecks: undefined, agentResults: undefined, buildVersions: { product: variant === "restored contents" ? "tested-tree" : "new-tree" }, endedAt: variant === "running edit" ? undefined : 40 });
  }
  if (variant === "later edit") f.work.checkedPatch = "different-change";
  if (variant === "later edit without checks") delete f.work.checks;
  if (variant === "later edit with unverified checks") delete f.work.checks!.current;
  if (variant === "different change") f.work.checkedPatch = "different-change";
  if (variant === "unbound test") f.task.testedVersions = { product: "other-run" };
  if (variant === "unbound checks") f.work.checkedSha = "other-checks";
  if (variant === "missing run change") delete f.task.journey![0]!.acceptancePatch;
  if (variant === "different run change") f.task.journey![0]!.acceptancePatch = "other-change";
  if (variant === "later empty test") f.task.journey!.push({ ...acceptanceRun("tester", "later-empty"), acceptanceChecks: [] });
  if (variant === "missing tested version") delete f.task.journey![0]!.agentResults![0]!.versions;
  const a = (await complete(f.c, "inbox.inspect", { itemId: f.offer("delivery") })).value.acceptance;
  const expected = variant === "restored contents" ? "same-contents" : variant === "same change" ? "same-change" : variant.startsWith("later edit") || variant === "different change" ? "changed" : "unknown";
  expect(a.evidence.products[0].state).toBe(expected);
  expect(a.evidence.products[0].reason.length).toBeGreaterThan(0);
  expect(a.evidence.counts).toEqual({ passed: 7, failed: 0, couldNotVerify: 1 });
  expect(a.passed).toBe(false);
});

for (const patch of ["newly-tested-change", undefined]) it(`binds only this acceptance run's calculated change (${patch ? "available" : "unavailable"})`, async () => {
  const f = fixture(), node = recordAcceptance(f);
  node.endedAt = undefined;
  node.end = undefined;
  delete node.acceptancePatch;
  const stage = f.task.plan!.stages[0]!;
  const unexpected = (): never => { throw new Error("Unexpected acceptance-controller effect"); };
  const turns: Pick<Turns, "turn"> = { turn: async (_scope, _role, _planned, _given, schema) => schema.parse({ summary: "Tried it", checks: [{ text: "Try it", result: "pass", evidence: "Observed the expected result" }], learnings: [] }) };
  const work = new Work(f.e, turns, { sectionsFor: unexpected }, { proposeGuideLine: unexpected }, { patch: async () => patch, reopen: unexpected, fold: unexpected, message: unexpected }, { note: async () => {} }, f.e["checks"]);
  expect(await work.runDo(executionFor(f.task), stage, new AbortController().signal)).toBe("continue");
  const recorded = f.task.journey!.find((step) => step.id === node.id)!;
  expect(recorded.acceptancePatch).toBe(patch);
  expect(f.task.testedPatch).toBe(patch ?? "tested-change");
  expect(f.task.acceptancePassed).toBe(true);
});

it("uses each shared product's saved version and keeps brief results separate from extra checks", async () => {
  const f = fixture(), node = recordAcceptance(f);
  node.agentResults![0]!.versions = { product: "tested-tree", api: "old-api" };
  f.task.repositories = [{ ...f.work, completedStages: [] }, { productId: "api", delivery: "local", completedStages: [], checks: { at: 40, tree: "new-api", current: true, results: [] } }];
  delete f.task.repository;
  f.task.brief = { summary: "Brief", forUsers: [], areas: [], risks: [], acceptance: [
    { text: "Recorded scenario 1", productIds: ["product"], versions: { product: "tested-tree" }, met: true, verification: "passed" },
    { text: "Recorded scenario 2", productIds: ["api"], versions: { api: "old-api" }, met: true, verification: "passed" },
    { text: "Not in the latest report", verification: "passed", met: true },
  ] };
  f.task.journey!.push({ ...acceptanceRun("builder", "api-change"), acceptanceChecks: undefined, agentResults: undefined, buildVersions: { api: "new-api" }, endedAt: 40 });
  const a = (await complete(f.c, "inbox.inspect", { itemId: f.offer("delivery") })).value.acceptance;
  expect(a.items).toEqual(f.task.brief.acceptance);
  expect(a.requirements.results).toEqual([{ index: 0, result: "pass", current: true }, { index: 1, result: "pass", current: false }, { index: 2, result: "not-reported", current: false }]);
  expect(a.evidence.products.map((product: any) => [product.productId, product.state])).toEqual([["product", "same-contents"], ["api", "changed"]]);
  expect(a.evidence.checks.filter((check: any) => check.kind === "requirement")).toHaveLength(2);
  f.task.brief.acceptance[0]!.versions = { product: "unrelated-run" };
  const next = (await complete(f.c, "inbox.inspect", { itemId: "request-delivery" })).value.acceptance;
  expect(next.requirements.results[0].current).toBe(false);
});

it("summarizes only the latest finished testing run, with bounded named links to other attempts", async () => {
  const f = fixture(), node = recordAcceptance(f);
  f.task.journey = [
    ...Array.from({ length: 6 }, (_, index) => ({ ...acceptanceRun("tester", `earlier-${index}`), acceptanceChecks: [{ text: "Contradictory old failure", result: "fail" as const, evidence: "Old failure" }] })), node,
    { ...acceptanceRun("tester", "later-running"), endedAt: undefined, acceptanceChecks: undefined, agentResults: undefined },
    { ...acceptanceRun("tester", "later-empty"), acceptanceChecks: [], agentResults: undefined },
    { id: "commands", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 50, endedAt: 60, productChecks: [{ name: "Automated", result: "pass" }] },
  ];
  const itemId = f.offer("delivery");
  const a = (await complete(f.c, "inbox.inspect", { itemId })).value.acceptance;
  expect(a.evidence.nodeId).toBe(node.id);
  expect(a.evidence.counts).toEqual({ passed: 7, failed: 0, couldNotVerify: 1 });
  expect(a.evidence.otherRuns).toHaveLength(4);
  expect(a.evidence.omittedRuns).toBe(4);
  expect(a.evidence.otherRuns.slice(0, 2).map((entry: any) => [entry.nodeId, entry.name, entry.state, entry.position])).toEqual([["later-empty", "Try the finished work", "no-results", "later"], ["later-running", "Try the finished work", "unfinished", "later"]]);
  expect(a.evidence.runsRead).toEqual({ operation: "journey.list", taskId: f.taskId });
  const { operation, ...args } = a.evidence.otherRuns[0].read;
  expect((await complete(f.c, operation, args)).value.id).toBe("later-empty");
  const commands = await complete(f.c, "journey.node", { taskId: f.taskId, nodeId: "commands" });
  expect(commands.value.acceptanceChecks).toBeUndefined();
  expect(commands.value.productChecks).toEqual([{ name: "Automated", result: "pass" }]);
});

it("lists result-free testing attempts without comparing them to a nonexistent summary", async () => {
  const f = fixture(), node = recordAcceptance(f);
  node.acceptanceChecks = [];
  f.task.journey!.push({ ...acceptanceRun("tester", "second-empty"), acceptanceChecks: [] });
  const evidence = (await complete(f.c, "inbox.inspect", { itemId: f.offer("delivery") })).value.acceptance.evidence;
  expect(evidence.state).toBe("unavailable");
  expect(evidence.nodeId).toBeUndefined();
  expect(evidence.otherRuns.map((run: any) => [run.nodeId, run.state, run.position])).toEqual([["second-empty", "no-results", undefined], [node.id, "no-results", undefined]]);
  for (const run of evidence.otherRuns) {
    const { operation, ...args } = run.read;
    expect((await complete(f.c, operation, args)).value.acceptanceChecks).toEqual([]);
  }
});

it("caps check previews and invalidates decisions for changes to omitted acceptance and version evidence", async () => {
  const f = fixture(), node = recordAcceptance(f);
  node.acceptanceChecks!.push(...Array.from({ length: 15 }, (_, index) => ({ text: `Extra ${index}`, result: "fail" as const, reason: "Long reason ".repeat(1000), evidence: "Long evidence ".repeat(1000) })));
  const itemId = f.offer("delivery");
  const before = await complete(f.c, "inbox.inspect", { itemId });
  expect(before.value.acceptance.evidence).toMatchObject({ shortened: true, omittedChecks: 15, counts: { passed: 7, failed: 15, couldNotVerify: 1 } });
  expect(before.value.acceptance.evidence.checks).toHaveLength(8);
  expect(before.value.acceptance.evidence.checks.every((check: any) => check.result !== "pass")).toBe(true);
  expect(before.text).not.toContain("Long evidence");
  node.acceptanceChecks![8]!.reason += "Even longer ".repeat(1000);
  const longer = await complete(f.c, "inbox.inspect", { itemId });
  expect(longer.text.length).toBe(before.text.length);
  expect(longer.pages[0]!.revision).not.toBe(before.pages[0]!.revision);
  let first = await f.c.call("inbox.inspect", { itemId, limit: 500 });
  node.acceptanceChecks![0]!.evidence += " Changed recorded probe";
  expect((await f.c.call("inbox.inspect", { itemId, cursor: first.next })).outcome).toBe("changed");
  expect((await f.c.call("inbox.approve", { itemId, revision: first.revision, requestId: "acceptance-changed" })).outcome).toBe("changed");
  for (const change of [() => { f.work.checkedSha = "different-head"; }, () => { node.agentResults![0]!.versions!.product = "different-version"; }, () => { f.task.journey!.push({ ...acceptanceRun("builder", "later-edit"), acceptanceChecks: undefined, buildVersions: { product: "new-version" } }); }]) {
    first = await f.c.call("inbox.inspect", { itemId, limit: 500 });
    change();
    expect((await f.c.call("inbox.approve", { itemId, revision: first.revision, requestId: `version-changed-${first.revision}` })).outcome).toBe("changed");
  }
});

it("shows a failed check's recorded observation when no separate reason was supplied", async () => {
  const f = fixture(), node = recordAcceptance(f);
  const observation = "The saved choice disappeared after reopening the task.";
  node.acceptanceChecks!.push({ text: "Retain the choice", result: "fail", evidence: observation });
  const itemId = f.offer("delivery");
  let a = (await complete(f.c, "inbox.inspect", { itemId })).value.acceptance;
  expect(a.evidence.checks[1]).toMatchObject({ text: "Retain the choice", result: "fail", evidence: observation, evidenceRecorded: true, shortened: false });
  expect(a.evidence.checks[1].reason).toBeUndefined();
  node.acceptanceChecks!.at(-1)!.evidence = observation.repeat(100);
  a = (await complete(f.c, "inbox.inspect", { itemId })).value.acceptance;
  expect(a.evidence.checks[1].evidence).toBe(observation.repeat(100).slice(0, 400));
  expect(a.evidence.checks[1].shortened).toBe(true);
  const { operation, ...args } = a.evidence.read;
  expect((await complete(f.c, operation, args)).value.acceptanceChecks.at(-1).evidence).toBe(observation.repeat(100));
});

it("fits a representative four-check delivery on one page regardless of successful log length", async () => {
  const { c, task, taskId, work, offer } = fixture();
  work.source = source();
  const results = ["Types", "Web build", "Tests", "Desktop shell"].map((name, index) => ({ ...run(name, "Passing output\n".repeat(400)), source: { stepId: "checks", attemptId: "attempt", checkId: `c${index}` } }));
  task.journey = [{ id: "checks", kind: "petrina", work: "checks", startedAt: 1, endedAt: 151, round: 1, sub: 0, checkAttempts: [{ id: "attempt", productId: "product", sha: "a".repeat(40), tree: "b".repeat(40), definition: "d".repeat(64), commands: results.map((run) => run.command), passed: true }], productChecks: results.map((run, index) => ({ id: `c${index}`, attemptId: "attempt", productId: "product", name: run.name, result: "pass", run })) }];
  work.checks = { current: true, at: 151, sha: "a".repeat(40), tree: "b".repeat(40), definition: "d".repeat(64), results };
  task.plan = { stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] }, { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"] }], rationale: "Build and independently review", plannerProfileId: "opus-high" };
  task.brief = { summary: "Make coordinator decisions clearer", forUsers: ["Concise evidence"], areas: ["Coordinator reports"], risks: [], acceptance: [{ text: "Reports preserve the recorded decision", verification: "passed", met: true }] };
  task.acceptancePassed = true;
  task.findings = [finding("nit", "suggestion"), finding("old", "pre-existing")];
  task.journey.push({ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 200, endedAt: 300, agentResults: [{ roleId: "code-reviewer", profileId: "opus-high", at: 300, value: { findings: [], verdict: "pass" }, findings: structuredClone(task.findings) }] });
  const itemId = offer("delivery");
  const after = await complete(c, "inbox.inspect", { itemId });
  expect(after.pages).toHaveLength(1);
  expect(after.value.products[0].checks.results).toHaveLength(4);
  expect(after.text).not.toContain("Passing output");
  expect(after.value.products[0].checks).toMatchObject({ freshness: "recorded-current", versions: { sha: work.checks.sha, tree: work.checks.tree, definition: work.checks.definition } });
  expect(after.value.products[0].checks.results[3]).toMatchObject({ commandOutcome: "passed", durationMs: 150, startedAt: 1, endedAt: 151, original: { taskId, nodeId: "checks", index: 3 }, diagnostics: { omitted: "Successful process output and saved result", completeness: "excerpt-only" } });
  const beforeValue = { request: (after.value.request), plan: task.plan, source: work.source, proposedSource: task.proposedSource, brief: task.brief, objections: task.objections, call: task.call, findings: task.findings, checks: work.checks };
  const beforePages: Result[] = [];
  let page = readText(beforeValue, {}, ["inbox.inspect", itemId], Object.fromEntries(["itemId", "kind", "revision", "decisions", "recommendation", "choices"].map((key) => [key, after.pages[0]![key]])));
  beforePages.push(page);
  while (page.next) { page = readText(beforeValue, { cursor: String(page.next) }, ["inbox.inspect", itemId], Object.fromEntries(["itemId", "kind", "revision", "decisions", "recommendation", "choices"].map((key) => [key, after.pages[0]![key]]))); beforePages.push(page); }
  expect(beforePages.length).toBeGreaterThan(1);
  for (const result of results) result.output += "More successful output\n".repeat(1000);
  const longer = await complete(c, "inbox.inspect", { itemId });
  expect(longer.size).toBe(after.size);
  expect(longer.pages[0]!.revision).not.toBe(after.pages[0]!.revision);
  expect(longer.value).toEqual(after.value);
  console.info("Four-check delivery measurement", JSON.stringify({ before: { pages: beforePages.length, responseCharacters: beforePages.reduce((size, page) => size + JSON.stringify(page).length, 0), contentCharacters: beforePages[0]!.total }, after: { pages: after.pages.length, responseCharacters: after.size, contentCharacters: after.text.length } }));
});

it("keeps large recorded setup declarations behind an exact focused read without losing revision sensitivity", async () => {
  const f = fixture();
  const requirements = Array.from({ length: 12 }, (_, index) => ({
    id: `requirement-${index}`, name: `Recorded prerequisite ${index}`,
    argv: ["compiler", `argument-${index}`, "literal argument ".repeat(25)],
  }));
  expect(normalizeCheckPrerequisites(requirements)).toEqual(requirements);
  // A recorded in-progress declaration is not modeled successful native execution.
  f.work.checkSetup = { id: "recorded-setup", productId: f.work.productId, queuedAt: 10, startedAt: 11,
    lifecycle: "running", position: "before-checks", requirements, results: [],
    input: { sha: "a".repeat(40), tree: "b".repeat(40), definition: "d".repeat(64), contract: "c".repeat(64) } };
  const itemId = f.offer("delivery");
  const first = await complete(f.c, "inbox.inspect", { itemId });
  expect(first.pages).toHaveLength(1);
  expect(first.value.products[0].localSetup).toMatchObject({ outcome: { kind: "running" }, attempt: {
    id: "recorded-setup", position: "before-checks", lifecycle: "running", queuedAt: 10, startedAt: 11,
    requirementCount: 12, resultCount: 0,
  }, authority: "Recorded only; not live verification" });
  expect(first.value.products[0].localSetup.attempt).not.toHaveProperty("input");
  expect(first.text).not.toContain(requirements[0]!.name);
  const { operation, ...args } = first.value.products[0].localSetup.read;
  const details = await complete(f.c, operation, args);
  expect(details.value.products[0].attempt.requirements).toEqual(requirements);
  expect(details.value.products[0].attempt.input).toEqual(f.work.checkSetup.input);
  expect(details.value.authority).toContain("never verifies local setup");
  const short = await f.c.call("inbox.inspect", { itemId, limit: 500 });
  requirements[0]!.argv[2] += "changed retained argument";
  const later = await complete(f.c, "inbox.inspect", { itemId });
  expect(later.value).toEqual(first.value);
  expect(later.pages[0]!.revision).not.toBe(first.pages[0]!.revision);
  expect((await f.c.call("inbox.inspect", { itemId, cursor: short.next })).outcome).toBe("changed");
  expect((await f.c.call("inbox.approve", { itemId, revision: first.pages[0]!.revision, requestId: "setup-declaration-changed" })).outcome).toBe("changed");
});

it("preserves scope validation, product starting points, destinations and plan assignments", async () => {
  const { c, task, work, offer } = fixture();
  work.source = source();
  task.plan = { stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] }, { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"] }], rationale: "An independent review", plannerProfileId: "opus-high" };
  task.selectedProducts = [{ productId: "api", startFrom: { kind: "branch", name: "next" }, delivery: "pull-request" }];
  task.workProposal = task.selectedProducts;
  task.workRows = [{ choice: task.selectedProducts[0]!, source: { ...source("api", "pull-request"), confirmed: false }, error: "Confirm the folder" }];
  task.workError = "Resolve the proposed scope";
  task.proposedSource = task.workRows[0]!.source;
  const page = await c.call("inbox.inspect", { itemId: offer("plan") });
  expect(page.decisions).toEqual(["inbox.approve", "inbox.changes"]);
  expect(page.recommendation).toBe("Approve");
  const view = JSON.parse(String(page.text));
  expect(view.plan).toEqual(task.plan);
  expect(view.scope).toMatchObject({ selectedProducts: task.selectedProducts, proposed: task.workProposal, rows: task.workRows, proposedSource: task.proposedSource, error: task.workError });
  expect(view.products[0].source).toEqual(work.source);
  expect(view.products[0].checks.state).toBe("unavailable");
});

for (const kind of ["design", "disagreement"] as const) it(`keeps the entire ${kind} request and objections across explicit continuation pages`, async () => {
  const { c, task, taskId, offer } = fixture();
  const body = "Actual coordinator request.\n".repeat(1000);
  task.brief = { summary: "The proposed design", forUsers: ["Clearer decisions"], areas: [], acceptance: [], risks: [] };
  task.objections = [{ id: "objection", round: 1, text: "Material objection\n".repeat(1000), answer: "Recorded response", status: "open", raisedBy: "sol-high", blocking: true }];
  task.call = { text: "Keep the simpler design", stageId: "design", open: ["objection"], at: 4 };
  const itemId = offer(kind, body);
  const first = await c.call("inbox.inspect", { itemId });
  expect(first.shortened).toBe(true);
  const { value } = await complete(c, "inbox.inspect", { itemId });
  expect(value.request.body).toBe(body);
  expect(value.brief).toEqual(task.brief);
  expect(value.objections).toEqual(task.objections);
  expect(value.call).toEqual(task.call);
  expect(value.designRead).toEqual({ operation: "task.read", taskId, section: "design" });
  task.objections[0]!.answer = "New response behind the first page";
  expect((await c.call("inbox.inspect", { itemId, cursor: first.next })).outcome).toBe("changed");
  expect((await c.call("inbox.approve", { itemId, revision: first.revision, requestId: `${kind}-changed` })).outcome).toBe("changed");
});

it("distinguishes product checks, acceptance and accepting unresolved review from delivery approval", async () => {
  const { e, c, task, offer } = fixture();
  task.repositories = [{ productId: "product", source: source(), delivery: "local", completedStages: [], checks: { at: 5, sha: "older", definition: "old-def", current: false, results: [run("Old pass")] } }, { productId: "api", source: source("api", "pull-request"), delivery: "pull-request", completedStages: [], checks: { at: 6, current: true, sha: "api-head", definition: "api-def", results: [] } }];
  task.activeProductId = "product";
  delete task.repository;
  task.reviewDecision = { stageId: "review", round: 2, accepted: false };
  task.findings = [finding("important"), finding("nit", "suggestion"), { ...finding("older", "pre-existing"), tracking: { taskId: "follow-up" } }, { ...finding("uncertain"), status: "unverified" }];
  task.acceptanceUnverified = true;
  task.brief = { summary: "A brief", forUsers: [], areas: [], risks: [], acceptance: [{ text: "Try it", verification: "blocked", reason: "No service" }] };
  const itemId = offer("delivery");
  const { value, pages } = await complete(c, "inbox.inspect", { itemId });
  expect(value.products.map((product: any) => [product.id, product.delivery, product.source.destination.kind, product.checks.state])).toEqual([["product", "local", "branch", "recorded"], ["api", "pull-request", "new-pr", "none-configured"]]);
  expect(value.products[0].checks).toMatchObject({ freshness: "stale", results: [{ commandOutcome: "passed" }] });
  expect(value.approvalMeaning).toContain("continue to final verification");
  expect(value.approvalMeaning).toContain("does not approve delivery");
  expect(value.acceptance).toMatchObject({ passed: null, unverified: true, items: task.brief.acceptance });
  expect(value.findings.counts).toEqual({ total: 4, open: { total: 3, important: 1, nits: 1, preExisting: 1 }, fixed: 0, dismissed: 0, unverified: 1 });
  const ref = value.findings.reports[1].read;
  const { operation, ...args } = ref;
  expect(JSON.parse(String((await c.call(operation, args)).text))).toEqual(task.findings[1]);
  // A relevant change on the product hidden from the selected task view invalidates approval.
  task.repositories[1]!.source!.destination.branch = "release";
  expect((await c.call("inbox.approve", { itemId, revision: pages[0]!.revision, requestId: "other-product-changed" })).outcome).toBe("changed");
  expect(e.s.inbox).toHaveLength(1);
});

it("keeps startup explanations, unfinished results, skipped checks and quiet complete logs distinct", async () => {
  const { c, home, task, taskId, work, offer } = fixture();
  const folder = join(home, "checks", taskId);
  mkdirSync(folder, { recursive: true });
  const log = join(folder, "quiet.log");
  writeFileSync(log, "");
  const quiet = { ...run("Quiet"), ...verifiedLog(log) };
  const failed = { ...run("Startup", "Could not start the command.\n" + "Saved explanation\n".repeat(1000)), ok: false, execution: { ...completeCheckExecution(7), started: false, exit: { status: "unreported" as const }, stdout: "incomplete" as const, stderr: "incomplete" as const, failure: { kind: "start" as const, message: "Cannot launch" } }, ...verifiedLog(log) };
  const stopped = { ...run("Interrupted", "Stopped after machine sleep"), interruption: { source: "macOS power log" as const, at: 2, event: "Sleep" }, logComplete: false };
  const results = [quiet, failed, stopped].map((run, index) => ({ ...run, source: { stepId: "checks", attemptId: "a", checkId: `c${index}` } }));
  task.journey = [{ id: "checks", kind: "petrina", work: "checks", startedAt: 1, round: 1, sub: 0, productChecks: [...results.map((run, index) => ({ id: `c${index}`, attemptId: "a", productId: "product", name: run.name, result: index === 0 ? "pass" as const : "fail" as const, run })), { id: "skipped", attemptId: "a", productId: "product", name: "Skipped", result: "skipped" }] }];
  work.checks = { at: 10, results };
  const { value, pages } = await complete(c, "inbox.inspect", { itemId: offer("delivery") });
  expect(pages[0]!.decisions).toEqual(["inbox.rerun-checks", "inbox.changes"]);
  const checks = value.products[0].checks;
  expect(checks.freshness).toBe("unverified");
  expect(checks.results[0].diagnostics.completeness).toBe("complete");
  expect(checks.results[0].diagnostics.savedResult).toBeUndefined();
  expect(structuredClone(checks.results[1].diagnostics)).toMatchObject({ completeness: "complete", savedResult: { text: expect.stringContaining("Could not start"), total: failed.output.length, shortened: true } });
  expect(checks.results[1].diagnostics.savedResult.text.length + checks.results[1].diagnostics.savedResultEnding.text.length).toBe(1000);
  const { operation, ...args } = checks.results[1].diagnostics.savedResultRead;
  const tail = await c.call(operation, { ...args, cursor: checks.results[1].diagnostics.savedResult.next });
  expect(tail.outcome).toBe("completed");
  expect(tail.offset).toBe(500);
  expect(checks.results[2].commandOutcome).toBe("unfinished");
  expect(checks.results[3]).toMatchObject({ result: "skipped", original: { taskId, nodeId: "checks", index: 3 }, commandOutcome: "not-executed", diagnostics: { completeness: "not-executed" } });
});

it("labels missing historical diagnostics honestly and pins fallback reads without substituting a newer run", async () => {
  const { c, task, work, taskId, offer, home } = fixture();
  work.checks = { at: 10, sha: "old", results: [{ ...run("Older", "Saved failure"), ok: false, execution: undefined, logPath: join(home, "checks", taskId, "missing.log"), logFileIdentity: { device: "1", inode: "1" }, logFileLength: 13, logFileBeginning: createHash("sha256").update("Saved failure").digest("hex"), source: { stepId: "lost", checkId: "lost", attemptId: "lost" } }] };
  task.journey = [];
  const itemId = offer("delivery");
  const { value } = await complete(c, "inbox.inspect", { itemId });
  const check = value.products[0].checks.results[0];
  expect(check.original).toBeNull();
  expect(check.diagnostics).toMatchObject({ completeness: "missing-file", savedResult: { text: "Saved failure" } });
  const { operation, ...args } = check.diagnostics.read;
  expect((await c.call(operation, args)).commandOutcome).toBe("unknown");
  expect(check.reportedOk).toBe(false);
  task.journey = [{ id: "lost", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 1, productChecks: [{ id: "lost", attemptId: "lost", productId: "product", name: "Older", result: "fail", startedAt: 1 }] }];
  const retained = (await complete(c, "inbox.inspect", { itemId })).value.products[0].checks.results[0];
  expect(retained.original).toEqual({ taskId, nodeId: "lost", index: 0 });
  expect(retained.originalUnavailable).toContain("no retained run");
  expect(retained.diagnostics.savedResult.text).toBe("Saved failure");
  const { operation: savedOperation, ...savedArgs } = retained.diagnostics.savedResultRead;
  expect((await c.call(savedOperation, savedArgs)).text).toBe("Saved failure");
  work.checks.results = [run("Newer", "Do not substitute")];
  const missing = await c.call(operation, args);
  expect(missing.outcome).toBe("changed");
  expect(missing.text).toBeUndefined();
});

it("keeps paged report summaries revision-bound even when the changed evidence body is omitted", async () => {
  const { e, c, task, offer } = fixture();
  task.findings = Array.from({ length: 30 }, (_, index) => ({ ...finding(`f${index}`, "suggestion"), evidence: "Long saved reproduction\n".repeat(1000) }));
  const itemId = offer("delivery");
  const first = await c.call("inbox.inspect", { itemId, limit: 1000 });
  e.say(task, "activity", "An unrelated clock tick");
  expect((await c.call("inbox.inspect", { itemId, cursor: first.next, limit: 1000 })).outcome).toBe("completed");
  const all = await complete(c, "inbox.inspect", { itemId });
  expect(all.value.findings.reports).toHaveLength(30);
  expect(all.text).not.toContain("Long saved reproduction");
  task.findings.at(-1)!.evidence += "Changed evidence";
  expect((await c.call("inbox.inspect", { itemId, cursor: first.next })).outcome).toBe("changed");
  expect((await c.call("inbox.approve", { itemId, revision: first.revision, requestId: "omitted-changed" })).outcome).toBe("changed");
});

it("invalidates inspection and approval when omitted process diagnostics change, while reading them stays harmless", async () => {
  const { c, taskId, work, home, offer } = fixture();
  const folder = join(home, "checks", taskId);
  mkdirSync(folder, { recursive: true });
  const log = join(folder, "pass.log");
  writeFileSync(log, "Original successful output");
  work.checks = { current: true, at: 5, sha: "head", definition: "definition", results: [{ ...run("Pass"), ...verifiedLog(log) }] };
  const itemId = offer("delivery");
  const first = await c.call("inbox.inspect", { itemId, limit: 500 });
  const read = await c.call("journey.check", { taskId, index: 0 });
  expect(read.text).toBe("Original successful output");
  expect((await c.call("inbox.inspect", { itemId, limit: 500, cursor: first.next })).outcome).toBe("completed");
  writeFileSync(log, "Changed successful output behind the omitted body");
  expect((await c.call("inbox.inspect", { itemId, cursor: first.next })).outcome).toBe("changed");
  expect((await c.call("inbox.approve", { itemId, revision: first.revision, requestId: "log-changed" })).outcome).toBe("changed");
});

it("keeps reuse timing separate from execution and reads another product’s pinned saved run", async () => {
  const { c, task, taskId, offer } = fixture();
  const original = { ...run("Tests", "Original failure"), ok: false, execution: completeCheckExecution(7), source: { stepId: "checks", checkId: "test", attemptId: "attempt" } };
  task.journey = [{ id: "checks", kind: "petrina", work: "checks", startedAt: 1, endedAt: 151, round: 1, sub: 0, productChecks: [{ id: "test", attemptId: "attempt", name: "Tests", productId: "api", result: "fail", run: original }], reuses: [{ at: 500, purpose: "delivery-check", productId: "api", attemptId: "attempt", basis: "same-tree", originalAt: 151, passed: false }] }];
  task.repositories = [{ productId: "product", source: source(), delivery: "local", completedStages: [], checks: { at: 100, results: [run("Tests", "Other product pass")] } }, { productId: "api", source: source("api"), delivery: "local", completedStages: [], checks: { at: 151, results: [original] } }];
  task.activeProductId = "product";
  delete task.repository;
  const { value } = await complete(c, "inbox.inspect", { itemId: offer("delivery") });
  const check = value.products[1].checks.results[0];
  expect(check).toMatchObject({ startedAt: 1, endedAt: 151, durationMs: 150, reuse: { at: 500, originalAt: 151, purpose: "delivery-check", basis: "same-tree" }, original: { taskId, nodeId: "checks", index: 0 } });
  const saved = await c.call("journey.check", { taskId, productId: "api", index: 0, section: "result" });
  expect(saved.text).toBe("Original failure");
  expect(saved.commandOutcome).toBe("failed");
  expect((await c.call("journey.check", { taskId, index: 0, section: "result" })).text).toBe("Other product pass");
});

for (const [name, flags, ending, outcome] of [
  ["Unknown exit", { execution: { ...completeCheckExecution(7), exit: { status: "unreported" } } }, CHECK_EXIT_UNREPORTED, "unknown"],
  ["Deadline", { timedOut: true }, "Stopped after 20 minutes without finishing.", "unfinished"],
  ["Cleanup", { cleanupIncomplete: true }, `(fail) suite > the final case\n1 fail\n${CLEANUP_INCOMPLETE}`, "unfinished"],
  ["Failure", {}, "(fail) suite > the final case\n1 fail", "failed"],
] as const) it(`keeps the ending of a long ${name.toLowerCase()} result visible beside its beginning`, async () => {
  const { c, home, taskId, work, offer } = fixture();
  const output = tidyOutput("(pass) ordinary passing line\n".repeat(600) + ending);
  expect(output.length).toBeGreaterThan(1000);
  expect(output.slice(0, 1000)).not.toContain(ending);
  work.checks = { at: 1, results: [{ ...run(name, output), ok: false, execution: completeCheckExecution(7), ...flags }] };
  const itemId = offer("delivery");
  const { value } = await complete(c, "inbox.inspect", { itemId });
  const check = value.products[0].checks.results[0];
  expect(check.commandOutcome).toBe(outcome);
  if (outcome === "unknown") expect(check.exitUnreported).toBe(true);
  const diagnostics = check.diagnostics;
  expect(diagnostics.savedResult.text).toBe(output.slice(0, 500));
  expect(diagnostics.savedResultEnding.text).toContain(ending);
  expect(diagnostics.savedResult.text.length + diagnostics.savedResultEnding.text.length).toBe(1000);
  expect(diagnostics.savedResultEnding.offset).toBe(output.length - 500);
  expect(diagnostics.savedResultEnding.omittedBefore).toBe(output.length - 500);
  const { operation, ...args } = diagnostics.savedResultRead;
  let page = await c.call(operation, { ...args, cursor: diagnostics.savedResult.next });
  let full = diagnostics.savedResult.text + page.text;
  while (page.next) { page = await c.call(operation, { ...args, cursor: page.next }); full += page.text; }
  expect(full).toBe(output);
  // Short saved explanations remain complete and do not get a redundant ending.
  work.checks.results[0]!.output = ending;
  const short = (await complete(c, "inbox.inspect", { itemId })).value.products[0].checks.results[0];
  expect(short.diagnostics.savedResult.text).toBe(ending);
  expect(short.diagnostics.savedResultEnding).toBeUndefined();
  // A verified original process log can contain the failure only at its end, with no saved text.
  const folder = join(home, "checks", taskId);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "long.log");
  const processOutput = "é🙂 passing\n".repeat(1000) + "(fail) suite > final process failure";
  writeFileSync(path, processOutput);
  Object.assign(work.checks.results[0]!, { output: "", ...verifiedLog(path) });
  const process = (await complete(c, "inbox.inspect", { itemId })).value.products[0].checks.results[0].diagnostics;
  expect(process.processExcerpt).toEndWith("(fail) suite > final process failure");
  expect(Array.from(process.processExcerpt).length).toBeLessThanOrEqual(1000);
  expect(process.processExcerpt).not.toContain("�");
  expect(process.processOmittedBefore).toBeGreaterThan(0);
});

for (const prefix of ["", "é"]) it(`keeps whole characters at both saved-result preview boundaries (${prefix ? "mixed text" : "emoji"})`, async () => {
  const { c, work, offer } = fixture();
  const ending = "\n(fail) end";
  const output = prefix + "🙂".repeat(3000) + ending;
  work.checks = { at: 1, results: [{ ...run("Tests", output), ok: false, execution: completeCheckExecution(7) }] };
  const { value } = await complete(c, "inbox.inspect", { itemId: offer("delivery") });
  const diagnostics = value.products[0].checks.results[0].diagnostics;
  const head = diagnostics.savedResult, tail = diagnostics.savedResultEnding;
  for (const excerpt of [head, tail]) {
    expect(excerpt.text).toBe(Buffer.from(excerpt.text).toString("utf8"));
    expect(excerpt.text).toBe(output.slice(excerpt.offset, excerpt.offset + excerpt.text.length));
  }
  expect(head.text.length + tail.text.length).toBeLessThanOrEqual(1000);
  expect(tail.text).toEndWith(ending);
  expect(tail.offset).toBe(output.length - tail.text.length);
  expect(tail.omittedBefore).toBe(tail.offset);
  expect(tail.shortened).toBe(false);
  const { operation, ...args } = diagnostics.savedResultRead;
  const focused = await c.call(operation, { ...args, section: "diagnostics" });
  const focusedPreview = focused.savedResult as Result;
  expect(focusedPreview.text).toBe(Buffer.from(String(focusedPreview.text)).toString("utf8"));
  let full = head.text, next = head.next;
  while (next) {
    const page = await c.call(operation, { ...args, cursor: next });
    expect(page.outcome).toBe("completed");
    full += page.text;
    next = page.next;
  }
  expect(full).toBe(output);
});

for (const shared of [false, true]) it(`preserves ${shared ? "shared" : "single-product"} report assignments without guessing`, async () => {
  const { c, task, offer } = fixture();
  if (shared) {
    task.repositories = ["product", "api"].map((productId) => ({ productId, delivery: "local", completedStages: [] }));
    delete task.repository;
  }
  task.findings = [
    { ...finding("missing"), productIds: undefined },
    { ...finding("empty"), productIds: [] },
    { ...finding("named"), productIds: ["product"] },
    { ...finding("invalid"), productIds: ["product", "unknown"] },
  ];
  const { value } = await complete(c, "inbox.inspect", { itemId: offer("delivery") });
  expect(value.findings.reports.map((report: any) => report.productIds)).toEqual(shared ? [[], [], ["product"], []] : [["product"], ["product"], ["product"], ["product"]]);
});

for (const reportedOk of [false, true]) it(`keeps text-only legacy reportedOk=${reportedOk} unverified without reading an exit fact from prose`, async () => {
  const { c, taskId, work, offer } = fixture();
  const old = { ...run("Older", CHECK_EXIT_UNREPORTED), ok: reportedOk, execution: undefined };
  work.checks = { at: 1, results: [old] };
  const itemId = offer("delivery");
  const { value, pages } = await complete(c, "inbox.inspect", { itemId });
  const saved = value.products[0].checks.results[0];
  expect(pages[0]!.decisions).toEqual(["inbox.rerun-checks", "inbox.changes"]);
  expect(saved.commandOutcome).toBe("unknown");
  expect(saved.reportedOk).toBe(reportedOk);
  expect(saved.exitUnreported).toBeUndefined();
  expect(saved.diagnostics.savedResult.text).toBe(CHECK_EXIT_UNREPORTED);
  const focused = await c.call("journey.check", { taskId, index: 0 });
  expect(focused.commandOutcome).toBe("unknown");
  expect(focused.reportedOk).toBe(reportedOk);
  expect(old.execution).toBeUndefined();
});

for (const result of ["pending", "running", "skipped", "stopped"] as const) it(`reads a ${result} lifecycle ahead of a carried old successful run`, async () => {
  const { c, task, taskId, work, offer } = fixture();
  const old = { ...run("Tests", "Earlier successful diagnostic"), source: { stepId: "checks", checkId: "c0", attemptId: "run-0" } };
  task.journey = [{ id: "checks", kind: "petrina", work: "checks", startedAt: 1, round: 1, sub: 0, productChecks: [{ id: "c0", attemptId: "run-0", productId: "product", name: "Tests", result, run: old }] }];
  work.checks = { at: 1, results: [old] };
  const expected = result === "skipped" ? "not-executed" : "unfinished";
  const saved = (await complete(c, "inbox.inspect", { itemId: offer("delivery") })).value.products[0].checks.results;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ result, commandOutcome: expected, reportedOk: true });
  const focused = await c.call("journey.check", { taskId, nodeId: "checks", index: 0 });
  expect(focused.commandOutcome).toBe(expected);
  expect(focused.reportedOk).toBe(true);
  expect(focused.savedResult).toMatchObject({ text: "Earlier successful diagnostic" });
});
