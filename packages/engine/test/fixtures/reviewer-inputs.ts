import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeepMutable, Finding } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { headNow } from "@petrina/test-support/repository-head";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { createProductRepository, Fakes, makeProduct, tempDir } from "../fixtures.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { directDrivers } from "./direct-drivers.js";

const originalLines = Array.from({ length: 60 }, (_, index) => `Original line ${index}\n`).join("");

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

let reviewerSeedPromise: Promise<{ files: readonly FileSnapshot[]; base: string }> | undefined;

function getReviewerInputSeed() {
  reviewerSeedPromise ??= (async () => {
    const seedTemp = tempDir("petrina-reviewer-input-seed-");
    try {
      const { path: seedRepo } = await createProductRepository(seedTemp, { origin: "none" });
      writeFileSync(join(seedRepo, "REVIEW.md"), "OLD-BASE-GUIDE\n");
      writeFileSync(join(seedRepo, "overlap.txt"), originalLines);
      await gitOps.commitChanges(seedRepo, "Prepare the review's original base");
      const base = headNow(seedRepo);
      const prepCopy = join(seedTemp, "prep");
      await gitOps.ensureWorktree(seedRepo, prepCopy, "prepared-review", base);
      writeFileSync(join(prepCopy, "greeting.txt"), "Initial fixture change\n");
      writeFileSync(join(prepCopy, "overlap.txt"), originalLines.replace("Original line 0\n", "Task changes the first line\n"));
      await gitOps.commitChanges(prepCopy, "Prepare the committed change under review");
      await gitOps.removeWorktree(seedRepo, prepCopy);
      return { files: captureDirectory(seedRepo), base };
    } finally {
      rmSync(seedTemp, { recursive: true, force: true });
    }
  })();
  return reviewerSeedPromise;
}

/** Real reviewer/input boundaries, starting from explicit committed review prerequisites. No earlier workflow is claimed. */
export async function preparedReviewerInputs(options: { single?: boolean; native?: boolean; seedFinding?: DeepMutable<Finding> } = {}) {
  const root = tempDir("petrina-prepared-review-input-"), owners = directDrivers(root);
  return setupWithCleanup(() => owners.prepare(async () => {
    const [repo, seed] = await Promise.all([makeProduct(root), getReviewerInputSeed()]);
    const configBytes = readFileSync(join(repo, ".git", "config"));
    applyDirectorySnapshot(repo, seed.files);
    writeFileSync(join(repo, ".git", "config"), configBytes);
    const base = seed.base, copy = join(root, "review-copy"), branch = "prepared-review";
    await gitOps.ensureWorktree(repo, copy, branch, base);
    const fakes = options.native ? new Fakes(join(root, "fake")) : undefined;
    fakes?.scenario({ reopen: "resume", reviewer: "important", fixes: "change" });
    const agents = new ScriptedAgents(prompt => {
      if (prompt.result !== "findings") throw new Error(`Prepared reviewer inputs must not run ${prompt.roleId}`);
      return scriptedResult({ verdict: "pass", findings: options.seedFinding && prompt.turn === 1
        ? [{ text: "A new minor review record", severity: "nit" }] : [], confirms: [], disputes: [] });
    });
    const engine = owners.open(join(root, "data"), {
      ...(fakes ? { agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir], toolPath: () => process.execPath }
        : { startAgentSession: agents.start, agentCommand: () => { throw new Error("Prepared reviewer inputs require their scripted session"); } }),
      toolProbe: scriptedToolProbe({ git: { status: "ready" }, gh: { status: "ready" },
        codex: { status: "ready" }, "claude-code": { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "ready" } }),
    });
    // Only the explicitly invoked review phases may run; their real check queue still receives notifications.
    engine.schedule = () => engine.checkQueue.pump();
    await engine.waitUntilReady(); await engine.checkTools();
    engine.s.pool.paused = false; engine.s.pool.limit = 2;
    engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue", defaultBranch: "main", checks: [], checksBy: "coordinator" });
    const id = engine.addTask({ productId: "p", title: "Reuse independent reviewers", description: "ORIGINAL-REVIEW-REQUEST [no-check]", delivery: "local", backlog: true });
    const task = engine.task(id)!, scope = executionFor(task);
    const stage = { id: "review", kind: "review-chain" as const, title: "Review the greeting", roleId: "code-reviewer", profileIds: options.single ? ["opus-high"] : ["opus-high", "sol-high"], maxRounds: 2 };
    Object.assign(task, { state: "running", startedAt: Date.now(), stageIndex: 0,
      plan: { rationale: "Only reviewer input boundaries are under test", plannerProfileId: "sol-high", stages: [stage] },
      brief: { summary: "ORIGINAL-DESIGN-BRIEF", forUsers: [], areas: [], acceptance: [], risks: [] } });
    Object.assign(scope.work, { worktree: copy, branch, base: "main", baseSha: base, report: { summary: "Prepared review report", changes: ["A greeting"] },
      source: { product: { id: "p", name: "Product", repo: "local/product" }, start: { kind: "default", branch: "main" }, destination: { kind: "branch", mode: "local", repo: "local/product", branch: "main" }, initialSha: base, confirmed: true } });
    if (options.seedFinding) task.findings.push(structuredClone(options.seedFinding));
    const controller = new AbortController();
    const review = (round: number) => owners.run(engine, async () => {
      // The next round is supplied boundary input; no Builder, electorate or delivery transition is synthesized.
      task.rounds[stage.id] = round;
      const prepared = await engine["reviews"].runReview(task, stage, controller.signal);
      if (prepared !== "continue" || task.hunt?.round !== round || !task.hunt.input) throw new Error(`The real review did not prepare round ${round}: ${task.statusLine}`);
      const result = await engine["reviews"].runReview(task, stage, controller.signal);
      if (result !== "continue" || !task.journey?.some(step => step.roleId === stage.roleId && step.round === round && step.agentInputs?.length))
        throw new Error(`The real reviewers did not supply round ${round}: ${task.statusLine}`);
      return task;
    });
    const commitRepair = () => owners.run(engine, async () => {
      writeFileSync(join(copy, "welcome.txt"), "The second review's committed repair prerequisite\n");
      await gitOps.commitChanges(copy, "Prepare the next review's committed input");
    });
    const advanceMain = () => owners.run(engine, async () => {
      const before = headNow(repo);
      writeFileSync(join(repo, "REVIEW.md"), "NEW-BASE-GUIDE\n");
      writeFileSync(join(repo, "overlap.txt"), originalLines.replace("Original line 59\n", "Main changes the last line\n"));
      await gitOps.commitChanges(repo, "Advance main independently");
      return { before, base: headNow(repo) };
    });
    const removeNativeSession = (sessionId: string) => {
      if (!fakes) throw new Error("Removing a native session requires its real peer");
      const file = join(fakes.dir, "conversations", `${sessionId}.json`);
      if (!fakes.received("code reviewer").some(entry => entry.session === sessionId)) throw new Error("The native session never received its first review");
      rmSync(file);
    };
    const close = async () => { controller.abort(); await owners.close(); };
    engine.commitNow(task);
    return { root, repo, copy, engine, task: () => task, scope, stage, review, commitRepair, advanceMain, removeNativeSession, close };
  }), () => owners.close());
}
