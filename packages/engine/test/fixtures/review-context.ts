import { installPreparedProduct, privateCloneProduct } from "./prepared-product.js";
import * as gitOps from "@petrina/repositories/git";
import { headNow } from "@petrina/test-support/repository-head";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DeepMutable, type Finding } from "@petrina/core";
import { Context } from "../../src/context.js";
import { Engine } from "../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { createProductRepository, Fakes, makeProduct, tempDir, testBrowserRoot, waitFor } from "../fixtures.js";
import { closeDirectDrivers, directDrivers, removeFixtureRoot } from "./direct-drivers.js";
import { fakeAgentSessions } from "./fake-agent-sessions.js";
import type { Scenario } from "../fake-agent.js";
import { privateAgentToolProbe } from "../scripted-probes.js";

interface FileSnapshot {
  rel: string;
  mode: number;
  data: Buffer;
}

function captureDirectory(dir: string, prefix = ""): FileSnapshot[] {
  const out: FileSnapshot[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...captureDirectory(dir, rel));
    else if (entry.isFile()) {
      const full = join(dir, rel);
      out.push({ rel, mode: lstatSync(full).mode, data: readFileSync(full) });
    }
  }
  return out;
}

function applyDirectorySnapshot(dir: string, files: readonly FileSnapshot[]): void {
  for (const file of files) {
    const target = join(dir, file.rel);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    writeFileSync(target, file.data, { mode: file.mode });
  }
}

const headCheckScript = (failPath: string) => [
  'const fs = require("node:fs"), p = require("node:path");',
  'const dot = p.join(process.cwd(), ".git");',
  'const gitdir = fs.statSync(dot).isDirectory() ? dot : p.resolve(process.cwd(), fs.readFileSync(dot, "utf8").replace(/^gitdir:\\s*/, "").trim());',
  'const commondir = fs.existsSync(p.join(gitdir, "commondir")) ? p.resolve(gitdir, fs.readFileSync(p.join(gitdir, "commondir"), "utf8").trim()) : gitdir;',
  'const head = fs.readFileSync(p.join(gitdir, "HEAD"), "utf8").trim();',
  'const sha = head.startsWith("ref: ") ? fs.readFileSync(p.join(commondir, head.slice(5)), "utf8").trim() : head;',
  'console.log("CHECKED-CODE:" + sha);',
  `if (fs.existsSync(${JSON.stringify(failPath)})) process.exit(1);`,
].join(" ");

let bareSeedPromise: Promise<{ files: readonly FileSnapshot[]; base: string; first: string }> | undefined;

function getBareSeed() {
  bareSeedPromise ??= (async () => {
    const seedTemp = tempDir("petrina-review-bare-seed-");
    try {
      const { path: seedRepo } = await createProductRepository(seedTemp, { origin: "none" });
      writeFileSync(join(seedRepo, "REVIEW.md"), "# Rules\nPreserve the original rule.\n");
      await gitOps.commitChanges(seedRepo, "Record the original review guide");
      const base = headNow(seedRepo);
      writeFileSync(join(seedRepo, "REVIEW.md"), "# Rules\nA change cannot replace the original rule.\n");
      writeFileSync(join(seedRepo, "greeting.txt"), "FIRST-CHANGE\n");
      await gitOps.commitChanges(seedRepo, "Add the greeting");
      const first = headNow(seedRepo);
      return { files: captureDirectory(seedRepo), base, first };
    } finally {
      rmSync(seedTemp, { recursive: true, force: true });
    }
  })();
  return bareSeedPromise;
}

export function reviewContextFixtures() {
interface RootOwner { root: string; browsers?: string; lifetime: ReturnType<typeof directDrivers> }
const roots = new Map<string, RootOwner>();
const engines = new Map<Engine, RootOwner>();
let closing = false;
const createRoot = (prefix: string): RootOwner => {
  if (closing) throw new Error("Review context fixtures are closing; no new root may open");
  const root = tempDir(prefix);
  const owner: RootOwner = { root, lifetime: directDrivers(root, { beforeRemoveRoot: () => {
    if (owner.browsers) removeFixtureRoot(owner.browsers);
  } }) };
  roots.set(root, owner);
  return owner;
};
const openEngine = (owner: RootOwner, ...args: Parameters<RootOwner["lifetime"]["open"]>) => {
  const engine = owner.lifetime.open(...args);
  engines.set(engine, owner);
  return engine;
};
const shutdown = (engine: Engine): Promise<void> => {
  const owner = engines.get(engine);
  if (!owner) return Promise.reject(new Error("Review context cannot stop an unowned Engine"));
  return owner.lifetime.stop(engine);
};
const closeRoot = (owner: RootOwner) => owner.lifetime.close();
const close = () => {
  closing = true;
  return closeDirectDrivers([...roots.values()].map(owner => owner.lifetime));
};

const earlier: DeepMutable<Finding> = { id: "older", text: "An earlier bug", severity: "blocking", raisedBy: "sol-high", confirmedBy: [], status: "fixed", answer: { fixed: true, text: "Fixed the earlier bug", at: 1 } };

async function bare<T>(body: (world: Awaited<ReturnType<typeof prepareBare>>) => Promise<T>): Promise<T> {
  const owner = createRoot("petrina-review-input-");
  return setupWithCleanup(() => owner.lifetime.prepare(async () => body(await prepareBare(owner))), () => closeRoot(owner));
}

async function prepareBare(owner: RootOwner) {
  const { root } = owner;
  const [repo, seed] = await Promise.all([makeProduct(root), getBareSeed()]);
  const configBytes = readFileSync(join(repo, ".git", "config"));
  applyDirectorySnapshot(repo, seed.files);
  writeFileSync(join(repo, ".git", "config"), configBytes);
  const { base, first } = seed;
  const engine = openEngine(owner, join(root, "data"), { admissionsClosed: true, agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
  engine.schedule = () => {}; engine.setPoolPaused(true);
  engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
  const id = engine.addTask({ productId: "p", title: "A precise review", backlog: true });
  const task = engine.task(id)!;
  Object.assign(executionFor(task).work, { worktree: repo, baseSha: base, base: "main", report: { summary: "Original Builder report", changes: [] } });
  task.findings = structuredClone([earlier]);
  task.brief = { summary: "Frozen brief", forUsers: [], areas: [], risks: [], acceptance: [] };
  const context = new Context(engine, { pendingPoints: async () => [] });
  return { root, repo, base, first, engine, task, context, scope: executionFor(task), shutdown: () => shutdown(engine) };
}

const originalLines = Array.from({ length: 60 }, (_, index) => `Original line ${index}\n`).join("");

interface RunOptions { browser?: boolean; single?: boolean; shared?: boolean; limit?: number; limited?: Scenario["limited"]; reviewer?: Scenario["reviewer"]; seedFinding?: boolean; settledHistory?: boolean; advance?: boolean }
function run<T>(reopen: Scenario["reopen"], options: RunOptions, body: (world: Awaited<ReturnType<typeof prepareRun>>) => Promise<T>): Promise<T> { return startRun(reopen, options, body); }

async function startRun<T>(reopen: Scenario["reopen"], options: RunOptions, body: (world: Awaited<ReturnType<typeof prepareRun>>) => Promise<T>): Promise<T> {
  const owner = createRoot("petrina-review-resume-");
  return setupWithCleanup(() => owner.lifetime.prepare(async () => body(await prepareRun(owner, reopen, options))), () => closeRoot(owner));
}

async function prepareRun(owner: RootOwner, reopen: Scenario["reopen"], options: RunOptions) {
  const { root } = owner;
  // Only browser-instruction contracts need native browser ownership; keep their private folder across restarts.
  const browsers = options.browser ? testBrowserRoot() : undefined;
  owner.browsers = browsers;
  if (browsers) registerFixtureRoot(browsers);
  const fakes = new Fakes(join(root, "fake"));
  const scenario: Scenario = { planner: options.single ? "short" : "pair", builder: "plain", reviewer: options.reviewer ?? "important", fixes: "change", controlled: true, reopen, limited: options.limited };
  fakes.scenario(scenario);
  const data = join(root, "data");
  const hold = join(root, "hold-fixes"), script = join(root, "script.json"), failCheck = join(root, "fail-check");
  const expectedHeadScript = headCheckScript(failCheck);
  if (options.advance) {
    writeFileSync(hold, "");
    writeFixtureJson(script, { hold: { title: "You are fixing the review findings", file: hold } });
  }
  const engineOptions = {
    agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir, `--script=${script}`],
    ...(options.browser ? {} : { startAgentSession: fakeAgentSessions(fakes, { scriptPath: script }) }),
    runCheckCommand: (req: { argv: readonly string[]; cwd: string }) => {
      if (req.argv.length === 3 && req.argv[0] === process.execPath && req.argv[1] === "-e" && req.argv[2] === expectedHeadScript) {
        return { code: existsSync(failCheck) ? 1 : 0, stdout: `CHECKED-CODE:${headNow(req.cwd)}\n` };
      }
      return undefined;
    },
    toolProbe: privateAgentToolProbe(),
    toolPath: () => process.execPath,
    usageCommands: { codex: null, grok: null, antigravity: null },
    browser: options.browser ?? false,
    ...(browsers ? { browserTempRoot: browsers } : {}),
  };
  let engine = openEngine(owner, data, engineOptions);
  engine.setPoolPaused(true);
  await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
  await engine.checkTools(); engine.stopRequested.signal.throwIfAborted();
  engine.setPoolLimit(options.limit ?? 2);
  const repo = await makeProduct(root); engine.stopRequested.signal.throwIfAborted();
  const productId = installPreparedProduct(engine, privateCloneProduct(repo)); engine.setProductDelivery(productId, "local", true);
  let second: string | undefined;
  if (options.shared) {
    const copy = await makeProduct(join(root, "second")), named = join(root, "second", "api");
    engine.stopRequested.signal.throwIfAborted();
    renameSync(copy, named);
    second = installPreparedProduct(engine, { ...privateCloneProduct(named), id: "api", name: "Second", repo: "local/api", tone: "green" });
    fakes.scenario({ ...scenario, affectedProducts: [productId, second] });
  }
  if (options.advance) for (const product of engine.s.products) {
    writeFileSync(join(product.path!, "REVIEW.md"), "OLD-BASE-GUIDE\n");
    writeFileSync(join(product.path!, "overlap.txt"), originalLines);
    await gitOps.commitChanges(product.path!, "Set the original review context"); engine.stopRequested.signal.throwIfAborted();
    product.checksBy = "coordinator";
    // A product check: the engine's check runner bounds this program and stops its whole process group.
    product.checks = [{ name: "Exact code", argv: [process.execPath, "-e", headCheckScript(join(root, "fail-check"))], why: "Prove checks run on the current code" }];
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
    const before = headNow(product.path!);
    writeFileSync(join(product.path!, "REVIEW.md"), "NEW-BASE-GUIDE\n");
    writeFileSync(join(product.path!, "overlap.txt"), originalLines.replace("Original line 59\n", "Main changes the last line\n"));
    if (conflict) writeFileSync(join(product.path!, "greeting.txt"), "Main's incompatible greeting\n");
    await gitOps.commitChanges(product.path!, "Advance main independently");
    return { productId: id, before, base: headNow(product.path!) };
  };
  const done = () => { rmSync(hold, { force: true }); return waitFor(() => { tick(); return engine.getState().inbox.some((item) => item.kind === "delivery") && task(); }, "the reviewed delivery"); };
  const restart = () => owner.lifetime.prepare(async () => {
    await shutdown(engine);
    engine = openEngine(owner, data, engineOptions);
  });
  engine.setPoolPaused(false);
  return { engine: () => engine, fakes, task, tick, done, restart, beforeFix, advanceMain, hold, root, browsers, shutdown: () => shutdown(engine) };
}

type Hunted = { stageId: string; round: number; input?: { heads: Readonly<Record<string, string>> } };

const ballotOn = (hunt: Hunted, seat: string) => ({ stageId: hunt.stageId, round: hunt.round, seat, versions: { ...hunt.input!.heads } });

const answer = (hunt: Hunted, seat: string, by: string, toolId: string, verdict: "real" | "nit" | "not-a-bug") => ({ by, toolId, plannedProfileId: seat, verdict, reason: `${toolId} answered ${verdict} for its place.`, ballot: ballotOn(hunt, seat) });

const important = (id: string): DeepMutable<Finding> => ({ id, text: `The ${id} greeting is missing.`, severity: "blocking", raisedBy: "argon-high", confirmedBy: [], status: "open", evidence: `Opened the ${id} page.` });

const place = (key: string, profileId: string, toolId: string, findingIds: string[], extra: object = {}) => ({ key, profileId, toolId, findingIds, reason: "Chosen for the initial pair.", ...extra });

async function ballot<T>(profileIds: string[], findingIds: string[], round: number, body: (world: Awaited<ReturnType<typeof prepareBallot>>) => Promise<T>): Promise<T> {
    return bare(async f => body(prepareBallot(f, profileIds, findingIds, round)));
}

function prepareBallot(f: Awaited<ReturnType<typeof prepareBare>>, profileIds: string[], findingIds: string[], round: number) {
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
return { bare, run, ballot, earlier, originalLines, ballotOn, answer, important, place, close };
}
