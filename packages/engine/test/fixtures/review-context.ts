import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DeepMutable, type Finding } from "@petrina/core";
import { Context } from "../../src/context.js";
import { Engine } from "../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { Fakes, git, makeProduct, removeDir, tempDir, testBrowserRoot, waitFor } from "../fixtures.js";
import type { Scenario } from "../fake-agent.js";

export function reviewContextFixtures() {
const roots: string[] = [];

const earlier: DeepMutable<Finding> = { id: "older", text: "An earlier bug", severity: "blocking", raisedBy: "sol-high", confirmedBy: [], status: "fixed", answer: { fixed: true, text: "Fixed the earlier bug", at: 1 } };

async function bare() {
  const root = tempDir("petrina-review-input-"); roots.push(root);
  const repo = await makeProduct(root);
  writeFileSync(join(repo, "REVIEW.md"), "# Rules\nPreserve the original rule.\n");
  await git(repo, "add", "REVIEW.md"); await git(repo, "commit", "-qm", "Record the original review guide");
  const base = await git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "REVIEW.md"), "# Rules\nA change cannot replace the original rule.\n");
  writeFileSync(join(repo, "greeting.txt"), "FIRST-CHANGE\n");
  await git(repo, "add", "."); await git(repo, "commit", "-qm", "Add the greeting");
  const first = await git(repo, "rev-parse", "HEAD");
  const engine = new Engine(join(root, "data"), { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
  engine.schedule = () => {}; engine.setPoolPaused(true);
  engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
  const id = engine.addTask({ productId: "p", title: "A precise review", backlog: true });
  const task = engine.task(id)!;
  Object.assign(executionFor(task).work, { worktree: repo, baseSha: base, base: "main", report: { summary: "Original Builder report", changes: [] } });
  task.findings = structuredClone([earlier]);
  task.brief = { summary: "Frozen brief", forUsers: [], areas: [], risks: [], acceptance: [] };
  const context = new Context(engine, { pendingPoints: async () => [] });
  return { root, repo, base, first, engine, task, context, scope: executionFor(task) };
}

const originalLines = Array.from({ length: 60 }, (_, index) => `Original line ${index}\n`).join("");

async function run(reopen: Scenario["reopen"], options: { single?: boolean; shared?: boolean; limit?: number; limited?: Scenario["limited"]; reviewer?: Scenario["reviewer"]; seedFinding?: boolean; settledHistory?: boolean; advance?: boolean } = {}) {
  const root = tempDir("petrina-review-resume-"); roots.push(root);
  // Reviewers check browser instructions across reopened conversations and restarts in one browser folder.
  const browsers = testBrowserRoot(); roots.push(browsers);
  const fakes = new Fakes(join(root, "fake"));
  const scenario: Scenario = { planner: options.single ? "short" : "pair", builder: "plain", reviewer: options.reviewer ?? "important", fixes: "change", controlled: true, reopen, limited: options.limited };
  fakes.scenario(scenario);
  const data = join(root, "data");
  const hold = join(root, "hold-fixes"), script = join(root, "script.json");
  if (options.advance) {
    writeFileSync(hold, "");
    writeFileSync(script, JSON.stringify({ hold: { title: "You are fixing the review findings", file: hold } }));
  }
  const engineOptions = { agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir, `--script=${script}`], toolPath: () => process.execPath, usageCommands: { codex: null, grok: null, antigravity: null }, browser: true, browserTempRoot: browsers };
  let engine = new Engine(data, engineOptions);
  engine.setPoolPaused(true); await engine.checkTools(); engine.setPoolLimit(options.limit ?? 2);
  const productId = await engine.addProduct(await makeProduct(root)); engine.setProductDelivery(productId, "local", true);
  let second: string | undefined;
  if (options.shared) {
    const copy = await makeProduct(join(root, "second")), named = join(root, "second", "api");
    renameSync(copy, named);
    second = await engine.addProduct(named, "Second");
    fakes.scenario({ ...scenario, affectedProducts: [productId, second] });
  }
  if (options.advance) for (const product of engine.s.products) {
    writeFileSync(join(product.path!, "REVIEW.md"), "OLD-BASE-GUIDE\n");
    writeFileSync(join(product.path!, "overlap.txt"), originalLines);
    await git(product.path!, "add", "."); await git(product.path!, "commit", "-qm", "Set the original review context");
    product.checksBy = "coordinator";
    // A product check: the engine's check runner bounds this program and stops its whole process group.
    product.checks = [{ name: "Exact code", argv: [process.execPath, "-e", `import { git } from ${JSON.stringify(import.meta.resolve("@petrina/test-support/commands"))}; console.log('CHECKED-CODE:' + await git(process.cwd(), 'rev-parse', 'HEAD')); if (require('node:fs').existsSync(${JSON.stringify(join(root, "fail-check"))})) process.exit(1);`], why: "Prove checks run on the current code" }];
  }
  const taskId = engine.addTask({ productId, title: "Reuse independent reviewers", description: "ORIGINAL-REVIEW-REQUEST [no-check]", approvePlan: true, ...(second ? { worksOn: [productId, second].map((productId) => ({ productId, startFrom: { kind: "default" as const }, delivery: "local" as const })) } : {}) });
  const task = () => engine.task(taskId)!;
  if (options.advance) task().brief = { summary: "ORIGINAL-DESIGN-BRIEF", forUsers: [], areas: [], acceptance: [], risks: [] };
  if (options.seedFinding) task().findings.push(structuredClone(earlier));
  if (options.settledHistory) {
    task().findings.push({ ...structuredClone(earlier), roleId: "code-reviewer", evidence: "Original settled reproduction and evidence. ".repeat(100), votes: [{ by: "opus-high", toolId: "claude-code", verdict: "real", reason: "Original independent judgment" }] });
    task().journey = [{ id: "prior-examination", kind: "agent", roleId: "code-reviewer", stageId: "prior-stage", round: 0, sub: 0, startedAt: 2, endedAt: 3, result: { findingsSettled: true, findings: structuredClone(task().findings), findingChanges: { raised: [], fixed: [earlier.id], dismissed: [], claimedFixed: [earlier.id] } } }];
    engine.addTask({ productId, title: "Long original follow-up", description: "Original full follow-up evidence. ".repeat(100), kind: "bug", backlog: true });
  }
  const released = new Set<string>();
  const tick = (allow: (role: string, session: string) => boolean = () => true) => {
    for (const entry of fakes.received()) if (allow(entry.role, entry.session) && !released.has(entry.session)) {
      if (options.advance && entry.role === "builder" && !task().fixing) {
        const { cwd } = JSON.parse(readFileSync(join(fakes.dir, "conversations", `${entry.session}.json`), "utf8")) as { cwd: string };
        writeFileSync(join(cwd, "overlap.txt"), originalLines.replace("Original line 0\n", "Task changes the first line\n"));
      }
      writeFileSync(join(fakes.dir, `release-${entry.session}`), "go");
      released.add(entry.session);
    }
    for (const item of engine.getState().inbox) {
      if (item.kind === "plan") { const stage = task().plan!.stages.find((stage) => stage.kind === "review-chain")!; stage.maxRounds = 2; if (options.settledHistory) stage.profileIds = ["sol-high", "opus-high", "grok-high"]; if (task().workRows?.some((row) => row.error)) throw new Error(JSON.stringify(task().workRows)); engine.approve(item.id); }
      else if (item.kind === "question") engine.answer(item.id, "Yes");
      else if (item.kind === "permission") engine.allow(item.id, "once");
    }
    if (task().state === "failed") throw new Error(task().error);
  };
  const beforeFix = () => waitFor(() => { tick(); return existsSync(`${hold}.reached`); }, "the controlled Builder fix");
  const advanceMain = async (id = second ?? productId, conflict = false) => {
    const product = engine.s.products.find((product) => product.id === id)!;
    const before = await git(product.path!, "rev-parse", "HEAD");
    writeFileSync(join(product.path!, "REVIEW.md"), "NEW-BASE-GUIDE\n");
    writeFileSync(join(product.path!, "overlap.txt"), originalLines.replace("Original line 59\n", "Main changes the last line\n"));
    if (conflict) writeFileSync(join(product.path!, "greeting.txt"), "Main's incompatible greeting\n");
    await git(product.path!, "add", "."); await git(product.path!, "commit", "-qm", "Advance main independently");
    return { productId: id, before, base: await git(product.path!, "rev-parse", "HEAD") };
  };
  const done = () => { rmSync(hold, { force: true }); return waitFor(() => { tick(); return engine.getState().inbox.some((item) => item.kind === "delivery") && task(); }, "the reviewed delivery"); };
  const restart = async () => { await engine.shutdown(); engine = new Engine(data, engineOptions); };
  engine.setPoolPaused(false);
  return { engine: () => engine, fakes, task, tick, done, restart, beforeFix, advanceMain, hold, root, browsers };
}

type Hunted = { stageId: string; round: number; input?: { heads: Readonly<Record<string, string>> } };

const ballotOn = (hunt: Hunted, seat: string) => ({ stageId: hunt.stageId, round: hunt.round, seat, versions: { ...hunt.input!.heads } });

const answer = (hunt: Hunted, seat: string, by: string, toolId: string, verdict: "real" | "nit" | "not-a-bug") => ({ by, toolId, plannedProfileId: seat, verdict, reason: `${toolId} answered ${verdict} for its place.`, ballot: ballotOn(hunt, seat) });

const important = (id: string): DeepMutable<Finding> => ({ id, text: `The ${id} greeting is missing.`, severity: "blocking", raisedBy: "argon-high", confirmedBy: [], status: "open", evidence: `Opened the ${id} page.` });

const place = (key: string, profileId: string, toolId: string, findingIds: string[], extra: object = {}) => ({ key, profileId, toolId, findingIds, reason: "Chosen for the initial pair.", ...extra });

async function ballot(profileIds: string[], findingIds: string[], round = 1) {
    const f = await bare();
    const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds };
    f.task.plan = { rationale: "Verify", plannerProfileId: "sol-high", stages: [stage] }; f.task.stageIndex = 0; f.task.rounds = { [stage.id]: round };
    f.task.findings = findingIds.map(important);
    f.engine.draining = false; f.engine.s.pool.paused = false;
    // The stage's tools are the ready ones, whatever this machine has installed.
    const offered = new Set(profileIds.map((id) => f.engine.profile(id)!.toolId));
    f.engine.s.tools = f.engine.s.tools.map((tool) => ({ ...tool, status: offered.has(tool.id) ? "ready" as const : "not-installed" as const }));
    const limit = (...tools: string[]) => { f.engine.s.pool.limited = tools.map((toolId) => ({ toolId, until: Date.now() + 3_600_000, reason: `${toolId}'s usage limit` })); };
    return { ...f, stage, limit, reviews: f.engine["reviews"] };
  }
return { bare, run, ballot, earlier, originalLines, ballotOn, answer, important, place, close: () => roots.forEach(removeDir) };
}
