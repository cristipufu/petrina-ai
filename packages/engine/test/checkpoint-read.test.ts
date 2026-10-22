import { afterAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckRun, DeepMutable, Finding, InboxKind, TaskSource } from "@petrina/core";
import { Engine } from "./engine.js";
import { Coordination, type Result } from "../src/coordination.js";
import { executionFor } from "../src/repository-context.js";
import { readText } from "../src/evidence-read.js";
import { CHECK_EXIT_UNREPORTED, tidyOutput } from "../src/checks.js";
import { CLEANUP_INCOMPLETE } from "../src/process-tree.js";
import { checkCommandOutcome } from "../src/check-log-read.js";
import { removeDir, tempDir } from "./fixtures.js";

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
const run = (name: string, output = ""): CheckRun => ({ name, command: `check ${name}`, ok: true, ms: 150, startedAt: 1, endedAt: 151, output, logComplete: true });
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
  const failed = { ...run("Startup", "Could not start the command.\n" + "Saved explanation\n".repeat(1000)), ok: false, ...verifiedLog(log) };
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
  work.checks = { at: 10, sha: "old", results: [{ ...run("Older", "Saved failure"), ok: false, logPath: join(home, "checks", taskId, "missing.log"), logFileIdentity: { device: "1", inode: "1" }, logFileLength: 13, logFileBeginning: createHash("sha256").update("Saved failure").digest("hex"), source: { stepId: "lost", checkId: "lost", attemptId: "lost" } }] };
  task.journey = [];
  const itemId = offer("delivery");
  const { value } = await complete(c, "inbox.inspect", { itemId });
  const check = value.products[0].checks.results[0];
  expect(check.original).toBeNull();
  expect(check.diagnostics).toMatchObject({ completeness: "missing-file", savedResult: { text: "Saved failure" } });
  const { operation, ...args } = check.diagnostics.read;
  expect((await c.call(operation, args)).commandOutcome).toBe("failed");
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
  const original = { ...run("Tests", "Original failure"), ok: false, source: { stepId: "checks", checkId: "test", attemptId: "attempt" } };
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
  ["Unknown exit", {}, CHECK_EXIT_UNREPORTED, "unknown"],
  ["Deadline", { timedOut: true }, "Stopped after 20 minutes without finishing.", "unfinished"],
  ["Cleanup", { cleanupIncomplete: true }, `(fail) suite > the final case\n1 fail\n${CLEANUP_INCOMPLETE}`, "unfinished"],
  ["Failure", {}, "(fail) suite > the final case\n1 fail", "failed"],
] as const) it(`keeps the ending of a long ${name.toLowerCase()} result visible beside its beginning`, async () => {
  const { c, home, taskId, work, offer } = fixture();
  const output = tidyOutput("(pass) ordinary passing line\n".repeat(600) + ending);
  expect(output.length).toBeGreaterThan(1000);
  expect(output.slice(0, 1000)).not.toContain(ending);
  work.checks = { at: 1, results: [{ ...run(name, output), ...flags, ok: false }] };
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
  work.checks = { at: 1, results: [{ ...run("Tests", output), ok: false }] };
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


it("recognizes the saved unknown-exit explanation without reclassifying passes or quoted command output", () => {
  expect(checkCommandOutcome(run("Pass", CHECK_EXIT_UNREPORTED))).toBe("passed");
  expect(checkCommandOutcome({ ...run("Failure", `A command quoted: ${CHECK_EXIT_UNREPORTED}`), ok: false })).toBe("failed");
  expect(checkCommandOutcome({ ...run("Failure", `${CHECK_EXIT_UNREPORTED}\nActual later failure`), ok: false })).toBe("failed");
  expect(checkCommandOutcome({ ...run("Unknown", `${CHECK_EXIT_UNREPORTED}\n${CLEANUP_INCOMPLETE}`), ok: false, cleanupIncomplete: true })).toBe("unknown");
});
