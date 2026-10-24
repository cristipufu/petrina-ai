import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as gitOps from "../src/git.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, BUILT_IN_ROLES, createDemoState, findingsNeedingVotes, panelAnswers, seatRemaining, type DeepMutable, type Finding, type Task } from "@petrina/core";
import { Context } from "../src/context.js";
import { Engine } from "./engine.js";
import { Coordination } from "../src/coordination.js";
import { executionFor, repositoryView, scopesFor } from "@petrina/orchestrator";
import { prepareReviewInput, readReviewInput, reviewBases, reviewBaseUpdates, reviewConversationScope } from "../src/review-context.js";
import { fullFollowUpCards } from "../src/review-history.js";
import { ReviewResult } from "../src/roles.js";
import { WaitingForCapacity } from "../src/usage.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { Fakes, git, makeProduct, removeDir, tempDir, testBrowserRoot, waitFor } from "./fixtures.js";
import type { Scenario } from "./fake-agent.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
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
  const context = new Context(engine, { pendingPoints: async () => [] } as never);
  return { root, repo, base, first, engine, task, context, scope: executionFor(task) };
}

describe("immutable review inputs", () => {
  it("records a passed round against its saved snapshot, and omits unknown versions on older inputs", async () => {
    const f = await bare();
    try {
      const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high"] };
      f.task.plan = { rationale: "Review", plannerProfileId: "sol-high", stages: [stage] };
      f.task.stageIndex = 0; f.task.findings = [];
      const signal = new AbortController().signal;
      const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
      const originalTree = await git(f.repo, "rev-parse", "HEAD^{tree}");
      expect(input.trees).toEqual({ p: originalTree });
      f.task.hunt = { stageId: stage.id, round: 1, reported: { "0": true }, input };
      beginAgentStep(f.task, "code-reviewer", "sol-high", Date.now(), f.engine.s.roles, undefined, f.scope.work);
      writeFileSync(join(f.repo, "later.txt"), "Different current code\n");
      await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Later contents");
      await f.engine["reviews"].runReview(f.task, stage, signal);
      expect(f.task.journey!.at(-1)!.checkReviews?.map((review) => review.tree)).toEqual([originalTree]);
      expect(originalTree).not.toBe(await git(f.repo, "rev-parse", "HEAD^{tree}"));
      f.task.stageIndex = 0;
      const { trees: _trees, ...olderInput } = input;
      f.task.hunt = { stageId: stage.id, round: 1, reported: { "0": true }, input: olderInput };
      beginAgentStep(f.task, "code-reviewer", "sol-high", Date.now(), f.engine.s.roles, undefined, f.scope.work);
      await f.engine["reviews"].runReview(f.task, stage, signal);
      expect(f.task.journey!.at(-1)!.checkReviews).toBeUndefined();
    } finally { await f.engine.shutdown(); }
  });

  it("keeps a later review stage's ballot to its own answers, never re-asking a finding left unresolved earlier", async () => {
    const f = await bare();
    try {
      const code = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"] };
      const security = { id: "security", title: "Security review", kind: "review-chain" as const, roleId: "security-reviewer", profileIds: ["sol-high", "opus-high"] };
      f.task.plan = { rationale: "Verify", plannerProfileId: "sol-high", stages: [code, security] }; f.task.stageIndex = 1;
      const codeBallot = { stageId: code.id, round: 1, seat: "sol-high", versions: { p: f.first } };
      f.task.findings = [
        { id: "unresolved", text: "Both first answers called it a nit", severity: "blocking", raisedBy: "grok-high", confirmedBy: [], status: "open", votes: [{ by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "nit", reason: "Only a nit on the code review's ballot.", ballot: codeBallot }], unresolved: { at: 1, reason: "No ready independent tool could give the third answer." } },
        { id: "security-finding", text: "Anyone can ask for the greeting.", severity: "blocking", raisedBy: "grok-high", confirmedBy: [], status: "open", votes: [{ by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "not-a-bug", reason: "An answer on the code review's ballot.", ballot: codeBallot }] },
      ];
      f.task.hunt = { stageId: security.id, round: 1, reported: { "0": true, "1": true }, findings: 0, input: { file: "input.json", digest: "d", heads: { p: f.first } } };
      const vote = f.engine["reviews"]["pendingVote"](f.task, security)!;
      expect(vote.findings.map((finding) => finding.id)).toEqual(["security-finding"]);
      expect(vote.seats.map((seat) => seat.toolId).sort()).toEqual(["claude-code", "codex"]);
      // The code review's Codex answer is history on this ballot: Codex's place still owes its own answer.
      for (const seat of vote.seats) expect(seatRemaining(vote.panel!, seat, f.task.findings, f.task.hunt!)).toEqual(["security-finding"]);
    } finally { await f.engine.shutdown(); }
  });

  it("gives queued voters complete reproduction evidence without current peer ballots", async () => {
    const f = await bare();
    const reviews = f.engine["reviews"];
    const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"] };
    f.task.plan = { rationale: "Verify", plannerProfileId: "sol-high", stages: [stage] }; f.task.stageIndex = 0;
    f.task.findings = [{ ...structuredClone(earlier), status: "open", answer: undefined, evidence: "Original full diagnostic ".repeat(100), steps: "Exact reproduction" }];
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: stage.id, round: 1, reported: {}, findings: 1, input };
    const bodies: string[] = [];
    const turn = spyOn(f.engine["turns"], "parallel").mockImplementation(async (_scope, _role, _profile, _copy, given) => {
      bodies.push(JSON.stringify(await given()));
      f.task.findings[0]!.votes = [{ by: "sol-high", toolId: "codex", verdict: "real", reason: "CURRENT-PEER-BALLOT" }];
      return undefined as never;
    });
    const together = spyOn(reviews as unknown as { together: typeof reviews["together"] }, "together").mockImplementation(async (_task, members) => {
      for (const member of members) await member.work(f.repo, () => true, member.profileId, () => {}, {} as never, false, signal);
    });
    try {
      const ids = f.task.findings.map((finding) => finding.id);
      const seats = stage.profileIds.map((profileId) => ({ key: profileId, profileId, toolId: f.engine.profile(profileId)!.toolId, findingIds: ids, reason: "Chosen for the initial pair." }));
      await reviews["vote"](f.task, { findings: f.task.findings, seats, voters: stage.profileIds }, signal);
      expect(bodies).toHaveLength(2);
      for (const body of bodies) { expect(body).toContain("Exact reproduction"); expect(body).toContain(f.task.findings[0]!.evidence!); expect(body).not.toContain("CURRENT-PEER-BALLOT"); }
    } finally { together.mockRestore(); turn.mockRestore(); await f.engine.shutdown(); }
  });
  it("omits settled native failures while retaining open failures and settled agent findings", async () => {
    const f = await bare();
    try {
      f.task.findings.push({ ...structuredClone(earlier), id: "native-fixed", raisedBy: "petrina", text: "Old native failure", evidence: "OLD-LONG-DIAGNOSTIC" }, { ...structuredClone(earlier), id: "native-open", status: "open", raisedBy: "petrina", text: "Still failing native check" });
      const input = await f.context.captureReview(f.scope);
      const body = input.parts.findings!.map((part) => part.body).join("\n");
      expect(body).not.toContain("OLD-LONG-DIAGNOSTIC"); expect(body).toContain("Still failing native check"); expect(body).toContain(earlier.text);
      expect(input.findings.map((finding) => finding.id)).toEqual([earlier.id, "native-open"]);
      expect(f.task.findings).toHaveLength(3);
    } finally { await f.engine.shutdown(); }
  });

  it("prepares only port comparisons and keeps lockfile evidence out of the inline port material", async () => {
    const f = await bare();
    try {
      writeFileSync(join(f.repo, "bun.lock"), "PORT-LOCKFILE-SENTINEL\n".repeat(1_000));
      mkdirSync(join(f.repo, "packages", "[new]"), { recursive: true });
      writeFileSync(join(f.repo, "packages", "[new]", "package-lock.json"), "NESTED-PORT-LOCKFILE\n");
      writeFileSync(join(f.repo, "greeting.txt"), "A-PORTED-GREETING\n");
      await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Resolve the port");
      const head = await git(f.repo, "rev-parse", "HEAD");
      f.scope.work.portReview = { from: f.base, head: f.first, onto: f.first, files: ["greeting.txt", "bun.lock", "packages/[new]/package-lock.json"] };
      f.scope.work.reviewedSha = f.first;
      const run = spyOn(gitOps, "run");
      try {
        const ref = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), new AbortController().signal);
        const input = await readReviewInput(ref);
        const full = readFileSync(input.artifacts![0]!.file, "utf8");
        expect(full).toContain("A-PORTED-GREETING"); expect(full).toContain("bun.lock"); expect(full).not.toContain("PORT-LOCKFILE-SENTINEL");
        expect(full).toContain("packages/[new]/package-lock.json"); expect(full).not.toContain("NESTED-PORT-LOCKFILE");
        expect(full).not.toContain("## Complete change");
        expect(input.artifacts!.some((file) => file.file.endsWith(".incremental.md"))).toBe(false);
        const locks = input.artifacts!.find((file) => file.file.endsWith(".port-lockfiles.md"))!;
        expect(readFileSync(locks.file, "utf8")).toContain("PORT-LOCKFILE-SENTINEL");
        expect(readFileSync(locks.file, "utf8")).toContain("NESTED-PORT-LOCKFILE");
        expect(run.mock.calls.some(([args]) => args.includes(`${f.base}...${head}`))).toBe(false);
      } finally { run.mockRestore(); }
    } finally { await f.engine.shutdown(); }
  });

  it("uses high-effort verifiers without changing discovery profiles, retaining a configured fallback when high is absent", async () => {
    const f = await bare();
    try {
      const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["opus-xhigh", "sol-xhigh"], maxRounds: 2 };
      f.engine.s.tools.forEach((tool) => { tool.status = "ready"; });
      const voters = f.engine["reviews"]["voters"](stage);
      expect(voters.length).toBeGreaterThan(1);
      expect(voters.every((id) => f.engine.profile(id)!.effort === "high")).toBe(true);
      expect(stage.profileIds).toEqual(["opus-xhigh", "sol-xhigh"]);
      f.engine.s.profiles = f.engine.s.profiles.filter((profile) => profile.toolId !== "codex" || profile.effort !== "high");
      expect(f.engine["reviews"]["voters"](stage)).toContain("sol-xhigh");
    } finally { await f.engine.shutdown(); }
  });
  for (const empty of ["old", "new", "both"]) it(`prepares a port whose ${empty} commit range is empty`, async () => {
    const f = await bare();
    try {
      f.scope.work.portReview = { from: f.base, head: empty === "new" ? f.first : f.base, onto: empty === "old" ? f.base : f.first, files: ["greeting.txt"] };
      const ref = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), new AbortController().signal);
      const input = await readReviewInput(ref);
      const body = readFileSync(input.artifacts![0]!.file, "utf8");
      expect(body).toContain("No commits in this range.");
      if (empty !== "both") expect(body).toContain("+FIRST-CHANGE");
    } finally { await f.engine.shutdown(); }
  });
  it("keeps earlier facts frozen while delivering new coordinator notes, including after saving and reopening the input", async () => {
    const f = await bare();
    try {
      const ref = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), new AbortController().signal);
      f.task.findings[0]!.status = "open"; f.task.findings[0]!.confirmedBy.push("opus-high");
      f.task.findings.push({ ...structuredClone(earlier), id: "peer", text: "PEER-THIS-ROUND", status: "open" });
      f.task.brief!.summary = "Changed after the round began";
      f.scope.work.report!.summary = "A changed Builder report";
      f.task.notes = [{ at: 2, text: "NEW-COORDINATOR-INSTRUCTION" }];
      const frozen = await readReviewInput(ref);
      const sections = await f.context.sectionsFor(f.scope, "code-reviewer", "review-1", undefined, undefined, frozen);
      const text = sections.map((section) => section.body).join("\n");
      expect(text).toContain("Frozen brief"); expect(text).toContain("Original Builder report");
      expect(text).toContain("(fixed)"); expect(text).toContain("NEW-COORDINATOR-INSTRUCTION");
      expect(text).not.toContain("PEER-THIS-ROUND"); expect(text).not.toContain("Changed after the round began");
      expect(frozen.findings[0]!.confirmedBy).toEqual([]);
      expect(ref.heads.p).toBe(f.first);
      expect(text).not.toContain("+FIRST-CHANGE");
    } finally { await f.engine.shutdown(); }
  });

  it("prepares exact full and incremental comparisons with the base guide, independently of later refs and worktree edits", async () => {
    const f = await bare();
    try {
      f.scope.work.reviewedSha = f.first;
      writeFileSync(join(f.repo, "greeting.txt"), "FIRST-CHANGE\nFIX-ONLY\n");
      await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Fix the greeting");
      const ref = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), new AbortController().signal);
      const snapshot = await readReviewInput(ref);
      const file = /: ("[^"\n]+\.md") \(reference/.exec(snapshot.material!.body)![1]!;
      const body = readFileSync(JSON.parse(file), "utf8");
      expect(body).toContain(`git diff ${f.base}...${ref.heads.p}`);
      expect(body).not.toContain("## Changes since the last completed code-review round");
      const guide = body.split("## Complete change")[0]!;
      expect(guide).toContain("Preserve the original rule.");
      expect(guide).not.toContain("A change cannot replace the original rule.");
      const incremental = snapshot.artifacts!.find((artifact) => artifact.file.endsWith(".incremental.md"))!;
      const delta = readFileSync(incremental.file, "utf8");
      expect(delta).toContain(`git diff ${f.first}..${ref.heads.p}`);
      expect(delta).toContain("+FIX-ONLY"); expect(delta).not.toContain("+FIRST-CHANGE");
      writeFileSync(join(f.repo, "REVIEW.md"), "MUTATED-WORKTREE-GUIDE");
      expect(readFileSync(JSON.parse(file), "utf8")).toBe(body);
      expect(JSON.stringify(repositoryView(f.scope))).not.toContain("+FIX-ONLY");
    } finally { await f.engine.shutdown(); }
  });

  it("keeps lockfile patches separate, with paths in the statistics and the complete evidence available", async () => {
    const f = await bare();
    try {
      f.scope.work.reviewedSha = f.first;
      writeFileSync(join(f.repo, "bun.lock"), "LOCKFILE-ONLY-SENTINEL\n".repeat(5_000));
      writeFileSync(join(f.repo, "greeting.txt"), "FIRST-CHANGE\nFIX-ONLY\n");
      await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Update a dependency and the greeting");
      const ref = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), new AbortController().signal);
      const input = await readReviewInput(ref);
      const ordinary = input.artifacts!.filter((artifact) => !artifact.file.endsWith("-lockfiles.md"));
      const locks = input.artifacts!.filter((artifact) => artifact.file.endsWith("-lockfiles.md"));
      expect(ordinary).toHaveLength(2); expect(locks).toHaveLength(2);
      for (const artifact of ordinary) {
        const text = readFileSync(artifact.file, "utf8");
        expect(text).toContain("bun.lock"); expect(text).not.toContain("LOCKFILE-ONLY-SENTINEL");
        expect(text).toContain("These changes remain in review scope");
      }
      for (const artifact of locks) expect(readFileSync(artifact.file, "utf8")).toContain("+LOCKFILE-ONLY-SENTINEL");
      const delta = readFileSync(ordinary.find((artifact) => artifact.file.endsWith(".incremental.md"))!.file, "utf8");
      expect(delta).toContain("+FIX-ONLY"); expect(delta).not.toContain("+FIRST-CHANGE");
      expect(input.material!.body).toContain("never excluded from review scope");
    } finally { await f.engine.shutdown(); }
  });

  it("prepares each shared product's own base guide and comparison, and rejects a damaged artifact", async () => {
    const a = await bare(), b = await bare();
    try {
      b.scope.work.productId = "second";
      a.task.repositories = [a.scope.work, b.scope.work].map((work) => ({ ...work, completedStages: [] }));
      const input = await a.context.captureReview(a.scope);
      const ref = await prepareReviewInput(a.engine.dataDir, a.scope, input, new AbortController().signal);
      const snapshot = await readReviewInput(ref);
      expect(ref.heads).toEqual({ p: a.first, second: b.first });
      expect(snapshot.artifacts).toHaveLength(2);
      const sections = await a.context.sectionsFor(a.scope, "code-reviewer", "review-0", { p: "/own/a", second: "/own/b" }, undefined, snapshot);
      expect(sections[0]!.body).toContain("copy: /own/a"); expect(sections[0]!.body).toContain("copy: /own/b");
      for (const artifact of snapshot.artifacts!) expect(readFileSync(artifact.file, "utf8")).toContain("Preserve the original rule.");
      for (const artifact of snapshot.artifacts!) {
        const original = readFileSync(artifact.file, "utf8");
        writeFileSync(artifact.file, "corrupt");
        await expectRejection(readReviewInput(ref), "prepared review comparison changed");
        writeFileSync(artifact.file, original);
      }
      expect(await readReviewInput(ref)).toEqual(snapshot);
    } finally { await a.engine.shutdown(); await b.engine.shutdown(); }
  });
});

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
  const engineOptions = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, `--script=${script}`], toolPath: () => process.execPath, usageCommands: { codex: null, grok: null, antigravity: null }, browser: true, browserTempRoot: browsers };
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

describe.concurrent("reviewer conversations across fix rounds", () => {
  it("records compact frozen evidence for three fresh reviewers after a real conflict, restart and usage replacement", async () => {
    const f = await run("resume", { advance: true, settledHistory: true, limit: 3 });
    try {
      await f.beforeFix();
      await f.advanceMain(undefined, true);
      const port = join(f.root, "hold-compact-port");
      writeFileSync(port, "");
      writeFileSync(join(f.root, "script.json"), JSON.stringify({ hold: { title: "Bring the work up to date first", file: port } }));
      rmSync(f.hold);
      await waitFor(() => { f.tick(); return existsSync(`${port}.reached`); }, "the compact-history conflict port");
      expect(f.task().reviewSessions).toBeUndefined();
      await f.restart();
      // The conflict round needs a fresh replacement as well as fresh planned seats.
      f.fakes.scenario({ planner: "pair", builder: "plain", reviewer: "important", fixes: "change", controlled: true, reopen: "resume", limited: [{ model: "opus", role: "code reviewer" }] });
      rmSync(port);
      const task = await f.done();
      const rounds = task.journey!.filter(step => step.roleId === "code-reviewer" && step.id !== "prior-examination");
      expect(rounds).toHaveLength(2);
      const round = rounds[1]!;
      expect([...new Set(round.agentInputs!.map(input => input.reviewerKey))].sort()).toEqual(["0", "1", "2"]);
      expect(round.agentInputs).toHaveLength(4); // The refused attempt and its replacement both keep receipts.
      const history = task.journey!.filter(step => step.round === round.round && step.reviewInput?.digest === round.reviewInput?.digest && step.reviewHistory);
      expect(history).toHaveLength(1);
      const copy = history[0]!.reviewHistory!;
      expect(createHash("sha256").update(copy.body).digest("hex")).toBe(copy.digest);
      expect(copy.body).toContain("Original settled reproduction and evidence");
      expect(copy.body).toContain("Original independent judgment");
      expect(copy.body).toContain("Original full follow-up evidence");
      const supplied = round.agentInputs!.map(input => {
        expect(input.mode).toBe("fresh");
        if (input.profileId === ["sol-high", "opus-high", "grok-high"][Number(input.reviewerKey)]) expect(input.freshReason).toContain("Builder had to port");
        const text = readFileSync(input.exact!.file, "utf8");
        expect(text).toContain(copy.digest);
        expect(text).not.toContain("Original settled reproduction and evidence");
        expect(text).toContain("ORIGINAL-REVIEW-REQUEST");
        expect(text).toContain("ORIGINAL-DESIGN-BRIEF");
        expect(text).toContain("Prepared review material");
        expect(input.manifest).toContainEqual(expect.objectContaining({ name: "Findings so far (confirm or dispute by id)", kind: "text" }));
        expect(f.fakes.received("code reviewer").filter(entry => entry.session === input.sessionId).map(entry => entry.text)).toContain(text);
        return input.sections.filter(section => ["Findings so far (confirm or dispute by id)", "Open follow-up cards"].includes(section.title));
      });
      for (const sections of supplied) expect(sections).toEqual(supplied[0]!);
      expect(round.agentInputs!.some(input => input.profileId !== ["sol-high", "opus-high", "grok-high"][Number(input.reviewerKey)])).toBe(true);
      const replacement = round.agentInputs!.find(input => input.profileId !== ["sol-high", "opus-high", "grok-high"][Number(input.reviewerKey)])!;
      expect(replacement.sections.some(section => section.title === "Where the agent before you stopped")).toBe(true);
      const frozen = await readReviewInput(round.reviewInput!);
      expect(frozen).toMatchObject({ history: { digest: copy.digest } });
      const complete = new Map([...(frozen.parts.findings ?? []).map(section => [section.title, section.body] as const), ["Open follow-up cards", fullFollowUpCards(frozen.cards)]]);
      const sizes: string[] = [];
      const previous = { ...round, reviewHistory: undefined, agentInputs: round.agentInputs!.map(input => {
        let text = readFileSync(input.exact!.file, "utf8");
        const sections = input.sections.map(section => {
          const body = complete.get(section.title);
          if (body === undefined) return section;
          text = text.replace(section.body, body);
          return { ...section, body };
        });
        sizes.push(`${text.length} -> ${input.exact!.size}`);
        const digest = createHash("sha256").update(text).digest("hex");
        return { ...input, sections, exact: { ...input.exact!, digest, size: text.length, file: input.exact!.file.replace(input.exact!.digest, digest) }, manifest: input.manifest!.map(entry => {
          const body = complete.get(entry.name);
          return body === undefined ? entry : { ...entry, size: body.length, digest: createHash("sha256").update(body).digest("hex").slice(0, 16) };
        }) };
      }) };
      console.log(`History characters actual conflict/restart/replacement: openings by attempt ${sizes.join(", ")}; serialized journey round ${JSON.stringify(previous).length} -> ${JSON.stringify(round).length}; complete reference available. Tokens, cost and time unmeasured.`);
    } finally { await f.engine().shutdown(); }
  });
  for (const mode of ["pair", "single", "shared", "builder-update"] as const) it(`continues each own ${mode} reviewer after main advances, with current full and incremental evidence`, async () => {
    const reopen = mode === "single" ? "load" : "resume";
    const f = await run(reopen, { advance: true, single: mode === "single", shared: mode === "shared" });
    try {
      await f.beforeFix();
      const moved = await f.advanceMain();
      const saved = structuredClone(f.task().reviewSessions!);
      if (mode === "builder-update") {
        const worktree = executionFor(f.task()).work.worktree!;
        await git(worktree, "add", "."); await git(worktree, "commit", "-qm", "The Builder's fix");
        await git(worktree, "merge", "--no-edit", "-m", "The Builder brings main in itself", moved.base);
      }
      f.task().notes = [{ at: 1, text: "REFRESHED-COORDINATOR-INSTRUCTION" }];
      const task = await f.done();
      const rounds = task.journey!.filter((step) => step.roleId === "code-reviewer");
      expect(rounds).toHaveLength(2);
      // A conflict-free update keeps the conversations, so no seat has a dropped-conversation reason waiting.
      expect(task.reviewFreshReasons).toBeUndefined();
      expect(rounds[0]!.agentInputs!.every((input) => input.mode === "fresh" && input.taskDescription?.includes("ORIGINAL-REVIEW-REQUEST"))).toBe(true);
      expect(rounds[0]!.agentInputs!.every((input) => !input.sections.some((section) => section.title.startsWith("Findings so far")))).toBe(true);
      const works = scopesFor(task).map(({ work }) => work);
      const current = works.find((work) => work.productId === moved.productId)!;
      const head = await git(current.worktree!, "rev-parse", "HEAD");
      expect(current.baseSha).toBe(moved.base);
      expect(current.checks!.sha).toBe(head);
      expect(current.checks!.results.every((run) => run.ok && run.output.includes(`CHECKED-CODE:${head}`))).toBe(true);
      for (const input of rounds[1]!.agentInputs!) {
        expect(input.mode).toBe("continued");
        expect(input.freshReason).toBeUndefined();
        expect(input.taskDescription).toBeUndefined();
        expect(input.sections.some((section) => section.title === "Design brief")).toBe(false);
        expect(input.sections.some((section) => section.title === "Current product checks, run by Petrina itself")).toBe(true);
        expect(input.sections.some((section) => section.title === "Related check evidence")).toBe(false);
        expect(input.at).toBeNumber();
        expect(current.checks!.at).toBeLessThanOrEqual(input.at!);
        const update = input.sections.find((section) => section.title === "The review base advanced since your last review")!.body;
        expect(input.manifest).toContainEqual(expect.objectContaining({ name: "The review base advanced since your last review", kind: "text", size: update.length }));
        const exact = readFileSync(input.exact!.file, "utf8");
        expect(exact).toContain(update);
        expect(f.fakes.received("code reviewer").filter((entry) => entry.session === input.sessionId).map((entry) => entry.text)).toContain(exact);
        expect(input.reviewInput).toEqual(rounds[1]!.reviewInput);
        expect(input.reviewInput!.heads[moved.productId]).toBe(head);
        for (const value of [moved.before, moved.base, head, "Main gained 1 commit.", "without an engine conflict port", "overlap.txt", "read their current versions again", "Main's incoming changes are not in the incremental comparison", "complete prepared comparison", "including beyond the files listed above"]) expect(update).toContain(value);
        expect(update.match(/^### /gm)).toHaveLength(1);
        expect(update).toContain(`(${moved.productId})`);
        expect(input.sections.some((section) => section.body.includes("REFRESHED-COORDINATOR-INSTRUCTION"))).toBe(true);
        const material = input.sections.find((section) => section.title === "Prepared review material")!.body;
        const files = [...material.matchAll(/("[^"\n]+\.md") \(reference/g)].map((match) => JSON.parse(match[1]!) as string);
        expect(files).toHaveLength(works.length * 2);
        for (const work of works) {
          expect(material).toContain(`base ${work.baseSha}`);
          expect(work.baseSha).toBe(work.productId === moved.productId ? moved.base : Object.values(saved)[0]!["0"]!.bases![work.productId]);
          expect(work.checks!.current).toBe(true);
          expect(task.journey!.flatMap((step) => step.checkReviews ?? [])).toContainEqual(expect.objectContaining({ productId: work.productId, tree: work.checks!.tree, round: rounds[1]!.round }));
        }
        const changedFiles = files.map((file) => ({ file, body: readFileSync(file, "utf8") })).filter(({ body }) => body.includes(`Product: ${moved.productId}\n`));
        expect(changedFiles).toHaveLength(2);
        for (const { body } of changedFiles) {
          const guide = body.split(/## Complete change|## Changes since/)[0]!;
          expect(guide).toContain("NEW-BASE-GUIDE"); expect(guide).not.toContain("OLD-BASE-GUIDE");
          expect(body).toContain(`Reviewed commit: ${head}`);
        }
        const full = changedFiles.find(({ file }) => file.endsWith(".full.md"))!.body;
        expect(full).toContain(`git diff ${moved.base}...${head}`);
        expect(full).toContain("+Task changes the first line");
        const delta = changedFiles.find(({ file }) => file.endsWith(".incremental.md"))!.body;
        expect(delta).not.toContain("+Task changes the first line");
        expect(delta).not.toContain("+Main changes the last line");
        expect(delta).toContain("welcome.txt");
      }
      const sessions = Object.values(saved).flatMap((seats) => Object.values(seats));
      expect(new Set(sessions.map((seat) => seat.sessionId)).size).toBe(mode === "single" ? 1 : 2);
      for (const seat of sessions) {
        expect(f.fakes.opens().filter((entry) => entry.session === seat.sessionId).map((entry) => entry.how)).toEqual(["new", reopen]);
        const prompts = f.fakes.received("code reviewer").filter((entry) => entry.session === seat.sessionId);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]!.text).not.toContain("ORIGINAL-REVIEW-REQUEST");
        expect(prompts[1]!.text).not.toContain("ORIGINAL-DESIGN-BRIEF");
      }
      const voters = new Set(f.fakes.received("verifier").map((entry) => entry.session));
      expect(voters.size).toBeGreaterThan(0);
      expect(f.fakes.opens().filter((entry) => voters.has(entry.session)).every((entry) => entry.how === "new")).toBe(true);
    } finally { await f.engine().shutdown(); }
  });

  for (const single of [false, true]) it(`omits unchanged closed findings from the actual continued ${single ? "single" : "parallel"} reviewer input`, async () => {
    const f = await run("resume", { single, seedFinding: true });
    try {
      const task = await f.done();
      const first = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!;
      const next = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!;
      expect(first.agentInputs!.every((input) => input.sections.some((section) => section.body.includes(earlier.text)))).toBe(true);
      for (const input of next.agentInputs!) {
        expect(input.mode).toBe("continued");
        expect(input.sections.some((section) => section.title === "Current finding status index" && section.body.includes("older: fixed"))).toBe(true);
        expect(input.sections.map((section) => section.body).join("\n")).not.toContain(earlier.text);
        expect(input.sections.some((section) => section.title.startsWith("New or changed finding records"))).toBe(true);
      }
    } finally { await f.engine().shutdown(); }
  });

  for (const reopen of ["resume", "load"] as const) for (const single of [false, true]) it(`continues ${single ? "one reviewer" : "each parallel reviewer"} with ${reopen}, while voters stay fresh`, async () => {
    const f = await run(reopen, { single });
    try {
      const task = await f.done();
      const rounds = task.journey!.filter((step) => step.roleId === "code-reviewer" && step.endedAt);
      expect(rounds).toHaveLength(2);
      expect(rounds[0]!.agentInputs!.every((input) => input.mode === "fresh")).toBe(true);
      expect(rounds[1]!.agentInputs!.every((input) => input.mode === "continued")).toBe(true);
      for (const input of rounds[1]!.agentInputs!) {
        expect(input.taskDescription).toBeUndefined();
        expect(input.sections.some((section) => section.title === "Design brief")).toBe(false);
        expect(input.sections.some((section) => section.title === "Findings so far (confirm or dispute by id)")).toBe(true);
        expect(input.sections.some((section) => section.title === "Current authoritative task context")).toBe(true);
        expect(input.sections.some((section) => section.title === "Prepared review material")).toBe(true);
      }
      const sessions = new Set(f.fakes.received("code reviewer").map((entry) => entry.session));
      expect(sessions.size).toBe(single ? 1 : 2);
      for (const id of sessions) {
        expect(f.fakes.opens().filter((entry) => entry.session === id).map((entry) => entry.how)).toEqual(["new", reopen]);
        const prompts = f.fakes.received("code reviewer").filter((entry) => entry.session === id);
        expect(prompts[0]!.text).toContain(`Browser output belongs only in ${join(f.browsers, "petrina-browser-")}`);
        expect(prompts[1]!.text).toContain(`Browser capture folder for this turn: ${join(f.browsers, "petrina-browser-")}`);
        expect(prompts[1]!.text).not.toContain("Browser output belongs only in");
      }
      const voterIds = new Set(f.fakes.received("verifier").map((entry) => entry.session));
      expect(voterIds.size).toBeGreaterThan(0);
      expect(f.fakes.opens().filter((entry) => voterIds.has(entry.session)).every((entry) => entry.how === "new")).toBe(true);
      expect(Object.values(task.reviewSessions ?? {}).flatMap(seats => Object.values(seats).map(seat => seat.sessionId)).sort()).toEqual([...sessions].sort());
      const copy = JSON.parse(readFileSync(join(f.fakes.dir, "conversations", `${[...sessions][0]}.json`), "utf8")).cwd as string;
      if (!single) expect(existsSync(copy)).toBe(false);
    } finally { await f.engine().shutdown(); }
  });

  it("keeps a queued reviewer blind to a faster peer, including after an engine restart", async () => {
    const f = await run("resume", { limit: 1 });
    try {
      await waitFor(() => { f.tick((role, session) => role !== "code reviewer" || !f.fakes.settings(session).includes("model=gpt-6.1-sol")); return Object.keys(f.task().hunt?.reported ?? {}).length === 1; }, "one blind reviewer to finish");
      const ref = structuredClone(f.task().hunt!.input!);
      const saved = readFileSync(ref.file, "utf8");
      await f.restart();
      const task = await f.done();
      expect(readFileSync(ref.file, "utf8")).toBe(saved);
      const firstRound = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!;
      expect(firstRound.agentInputs!.every((input) => !input.sections.some((section) => section.title === "Findings so far (confirm or dispute by id)"))).toBe(true);
      expect(f.fakes.received("code reviewer").filter((entry) => entry.text.includes("This is review round 2")).every((entry) => entry.text.includes("Findings so far"))).toBe(true);
      expect(task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!.agentInputs!.every((input) => input.mode === "continued")).toBe(true);
    } finally { await f.engine().shutdown(); }
  });

  it("starts fresh with complete inputs when the harness cannot reopen a reviewer", async () => {
    const f = await run(undefined, { advance: true });
    try {
      await f.beforeFix(); await f.advanceMain();
      const task = await f.done();
      const second = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!;
      expect(second.agentInputs!.every((input) => input.mode === "fresh" && input.taskDescription!.includes("ORIGINAL-REVIEW-REQUEST"))).toBe(true);
      expect(task.timeline.some((entry) => entry.text.includes("Could not go back to its own review conversation"))).toBe(true);
      expect(task.hunt).toBeUndefined();
      expect(second.reviewInput?.digest).toBeString();
      expect(second.agentInputs!.every(input => input.reviewInput?.digest === second.reviewInput!.digest)).toBe(true);
      const c = new Coordination(f.engine());
      expect(await c.call("journey.node", { taskId: task.id, nodeId: second.id, limit: 1 })).toMatchObject({ reviewInput: { digest: second.reviewInput!.digest } });
      const heads = await c.call("journey.review-input", { taskId: task.id, nodeId: second.id, section: "versions" });
      expect(JSON.parse(String(heads.text))).toEqual(second.reviewInput!.heads);
      let page = await c.call("journey.review-input", { taskId: task.id, nodeId: second.id, section: "findings", limit: 200 });
      let text = String(page.text);
      while (page.next) { page = await c.call("journey.review-input", { taskId: task.id, nodeId: second.id, section: "findings", limit: 200, cursor: page.next }); text += page.text; }
      expect(JSON.parse(text).length).toBeGreaterThan(0);
      writeFileSync(second.reviewInput!.file, "Changed snapshot");
      expect((await c.call("journey.review-input", { taskId: task.id, nodeId: second.id })).outcome).toBe("changed");
      renameSync(second.reviewInput!.file, `${second.reviewInput!.file}.missing`);
      expect((await c.call("journey.review-input", { taskId: task.id, nodeId: second.id })).outcome).toBe("unavailable");
    } finally { await f.engine().shutdown(); }
  });

  for (const changed of ["context", "absent context", "profile", "source", "bases", "incomplete bases", "native session"] as const) it(`starts the affected seats fresh after ${changed} changes while main advances`, async () => {
    const f = await run("resume", { advance: true });
    try {
      await f.beforeFix(); await f.advanceMain();
      const stage = f.task().plan!.stages.find((entry) => entry.kind === "review-chain")!;
      const prior = f.task().reviewSessions![stage.id]!["0"]!;
      if (changed === "context") {
        // Both seats saved the complete packet; only this seat's reference then loses its file.
        for (const seat of ["0", "1"]) {
          const saved = f.task().reviewSessions![stage.id]![seat]!.context!;
          const packet = readFileSync(saved.file, "utf8");
          expect(createHash("sha256").update(packet).digest("hex")).toBe(saved.digest);
          expect(packet).toContain("ORIGINAL-REVIEW-REQUEST");
        }
        prior.context!.file += ".missing";
      } else if (changed === "absent context") {
        // Context storage is optional: a failed save sends complete instructions without a packet.
        delete prior.context;
      } else if (changed === "profile") stage.profileIds[0] = "opus-xhigh";
      else if (changed === "source") {
        const work = executionFor(f.task()).work;
        work.source!.initialSha = await git(work.worktree!, "rev-parse", `${prior.bases![work.productId]}~1`);
      } else if (changed === "bases") delete prior.bases;
      else if (changed === "incomplete bases") prior.bases = {};
      else rmSync(join(f.fakes.dir, "conversations", `${prior.sessionId}.json`));
      const task = await f.done();
      const inputs = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!.agentInputs!;
      expect(inputs.find((input) => input.reviewerKey === "0")!.mode).toBe("fresh");
      expect(inputs.find((input) => input.reviewerKey === "1")!.mode).toBe(changed === "source" ? "fresh" : "continued");
      expect(inputs.find((input) => input.mode === "fresh")!.taskDescription).toContain("ORIGINAL-REVIEW-REQUEST");
      expect(inputs.find((input) => input.mode === "fresh")!.sections.some((section) => section.title === "Design brief")).toBe(true);
      expect(inputs.filter((input) => input.mode === "fresh").every((input) => !input.sections.some((section) => section.title === "The review base advanced since your last review"))).toBe(true);
      const reason = changed === "context" || changed === "absent context" ? "saved context is unavailable" : changed === "bases" || changed === "incomplete bases" ? "saved repository bases are unavailable" : changed === "native session" ? "Could not go back to its own review conversation" : changed === "profile" ? "you changed who works on this seat" : "role, profile, request or starting point changed";
      expect(task.timeline.some((entry) => entry.text.includes(reason))).toBe(true);
      // The recorded fresh reason is the one the selection gave, including a reopen failure discovered before instructions.
      for (const input of inputs) {
        if (input.mode === "continued") expect(input.freshReason).toBeUndefined();
        else if (changed === "native session") expect(input.freshReason).toContain("could not reopen the conversation");
        else expect(input.freshReason).toBe(changed === "profile" ? reason : `its ${reason}`);
      }
    } finally { await f.engine().shutdown(); }
  });

  for (const { between, shared, single } of [{}, { between: "pause" }, { between: "restart" }, { shared: true }, { single: true }] as { between?: "pause" | "restart"; shared?: boolean; single?: boolean }[]) it(`drops ${single ? "a single reviewer's conversation" : "reviewer conversations"} when main conflicts${shared ? " in one shared product" : ""} and records why on each seat's next start${between ? `, across a ${between} before admission` : ""}`, async () => {
    const f = await run(single ? "load" : "resume", { advance: true, shared, single });
    try {
      await f.beforeFix();
      const moved = await f.advanceMain(undefined, true);
      const saved = f.task().reviewSessions!;
      const sessions = Object.values(saved).flatMap((seats) => Object.values(seats).map((seat) => seat.sessionId));
      const why = `main conflicted with the change${shared ? ` in ${f.engine().s.products.find((product) => product.id === moved.productId)!.name}` : ""}, so the Builder had to port it`;
      const dropped = Object.fromEntries(Object.entries(saved).map(([stageId, seats]) => [stageId, Object.fromEntries(Object.keys(seats).map((seat) => [seat, why]))]));
      if (between) {
        // Held in the Builder's port: the conversations are already dropped and no reviewer has been admitted.
        const port = join(f.root, "hold-port");
        writeFileSync(port, "");
        writeFileSync(join(f.root, "script.json"), JSON.stringify({ hold: { title: "Bring the work up to date first", file: port } }));
        rmSync(f.hold);
        await waitFor(() => { f.tick(); return existsSync(`${port}.reached`); }, "the held conflict port");
        expect(f.task().reviewSessions).toBeUndefined();
        expect(f.task().reviewFreshReasons).toEqual(dropped);
        if (between === "pause") f.engine().pause(f.task().id);
        else await f.restart();
        expect(f.task().reviewFreshReasons).toEqual(dropped);
        rmSync(port);
        if (between === "pause") f.engine().resume(f.task().id);
      }
      const task = await f.done();
      expect(task.timeline.some((entry) => entry.text.includes("Reviewer conversations will start fresh") && entry.text.includes("port"))).toBe(true);
      const [first, second] = task.journey!.filter((step) => step.roleId === "code-reviewer");
      // A first review had no earlier conversation, so nothing describes it as a failed return.
      expect(first!.agentInputs!.every((input) => input.mode === "fresh" && input.freshReason === undefined)).toBe(true);
      expect(second!.agentInputs!.map((input) => input.reviewerKey).sort()).toEqual(Object.keys(Object.values(dropped)[0]!).sort());
      for (const input of second!.agentInputs!) {
        expect([input.mode, input.freshReason]).toEqual(["fresh", why]);
        expect(input.selectionReason).toContain(`Started a fresh conversation: ${why}.`);
        expect(input.taskDescription).toContain("ORIGINAL-REVIEW-REQUEST");
      }
      for (const session of sessions) expect(f.fakes.opens().filter((entry) => entry.session === session).map((entry) => entry.how)).toEqual(["new"]);
      // The compact handoff carries the same explanation, and each start used up its own seat's reason.
      const events = (await new Coordination(f.engine()).call("watch.events", { taskIds: [task.id], from: "oldest", kinds: ["seat.started"], timeoutMs: 0 })).events as { nodeId: string; freshReason?: string; summary: string }[];
      expect(events.filter((event) => event.nodeId === first!.id).map((event) => event.freshReason)).toEqual(first!.agentInputs!.map(() => undefined));
      expect(events.filter((event) => event.nodeId === second!.id)).toHaveLength(second!.agentInputs!.length);
      for (const event of events.filter((event) => event.nodeId === second!.id)) {
        expect(event.freshReason).toBe(why);
        expect(event.summary).toContain(`fresh conversation (${why})`);
      }
      expect(task.reviewFreshReasons).toBeUndefined();
    } finally { await f.engine().shutdown(); }
  });

  it("stops before reopening reviewers when main replaces the saved base history", async () => {
    const f = await run("resume", { advance: true });
    try {
      await f.beforeFix();
      const product = f.engine().s.products[0]!;
      await git(product.path!, "reset", "--hard", "HEAD~1");
      writeFileSync(join(product.path!, "replacement.txt"), "Different history\n");
      await git(product.path!, "add", "."); await git(product.path!, "commit", "-qm", "Replace the source history");
      await expectRejection(f.done(), "history was replaced or diverged");
      const sessions = new Set(f.fakes.received("code reviewer").map((entry) => entry.session));
      expect(sessions.size).toBe(2);
      expect(f.fakes.opens().filter((entry) => sessions.has(entry.session)).every((entry) => entry.how === "new")).toBe(true);
    } finally { await f.engine().shutdown(); }
  });

  it("returns failed checks on updated code to the Builder before spending another review", async () => {
    const f = await run("resume", { advance: true });
    try {
      await f.beforeFix(); await f.advanceMain();
      writeFileSync(join(f.root, "fail-check"), "");
      const task = await f.done();
      expect(task.journey!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(1);
      expect(executionFor(task).work.checks!.results.some((run) => !run.ok)).toBe(true);
      expect(task.findings.some((finding) => finding.status === "open" && finding.text.startsWith("Check failed"))).toBe(true);
      expect(task.timeline.some((entry) => entry.text.includes("before review"))).toBe(true);
    } finally { await f.engine().shutdown(); }
  });

  it("resumes the actual usage replacement in its own reviewer seat", async () => {
    const f = await run("resume", { reviewer: "important-twice", limited: [{ model: "opus", role: "code reviewer", spendCap: true }] });
    try {
      const task = await f.done();
      const inputs = task.journey!.filter((step) => step.roleId === "code-reviewer").map((step) => step.agentInputs!);
      const replacement = inputs[0]!.find((input) => input.profileId !== "opus-high" && input.profileId !== "sol-high")!;
      expect(replacement).toBeDefined();
      expect(inputs[1]!.find((input) => input.profileId === replacement.profileId)!.mode).toBe("continued");
      const id = f.fakes.received("code reviewer").find((entry) => f.fakes.settings(entry.session).some((setting) => setting.startsWith("model=grok")))!.session;
      expect(f.fakes.opens().filter((entry) => entry.session === id).map((entry) => entry.how)).toEqual(["new", "resume"]);
    } finally { await f.engine().shutdown(); }
  });

  it("continues a shared-product review with its own detached map and both prepared comparisons", async () => {
    const f = await run("resume", { shared: true });
    try {
      const task = await f.done();
      const rounds = task.journey!.filter((step) => step.roleId === "code-reviewer");
      expect(rounds).toHaveLength(2);
      expect(rounds[1]!.agentInputs!.every((input) => input.mode === "continued")).toBe(true);
      for (const entry of f.fakes.received("code reviewer").filter((entry) => entry.text.startsWith("Petrina is back"))) {
        expect(entry.text).toContain("Check every point of the saved base");
        expect(entry.text).not.toContain("copy " + task.repositories![0]!.worktree);
        const context = rounds[1]!.agentInputs!.find((input) => input.sections.some((section) => section.title === "Current authoritative task context"))!;
        expect(context).toBeDefined();
      }
      const inputs = rounds[1]!.agentInputs!;
      expect(inputs.every((input) => input.sections.find((section) => section.title === "Prepared review material")!.body.match(/\(reference /g)?.length === 4)).toBe(true);
    } finally { await f.engine().shutdown(); }
  });
});

it("invalidates only a changed reviewer identity or scope, while permitting a new patch in the same scope", () => {
  const task = createDemoState(1_000_000_000).tasks[0]!, role = BUILT_IN_ROLES.find((role) => role.id === "code-reviewer")!, profile = ENGINE_PROFILES[0]!;
  const key = (t = task, r = role, p = profile, seat = "0") => reviewConversationScope(t, "review", seat, r, profile, p);
  expect(key({ ...task, reviewedSha: "a new reviewed patch" })).toBe(key());
  expect(key({ ...task, description: "Changed request" })).not.toBe(key());
  expect(key(task, { ...role, instructions: "Changed review rules" })).not.toBe(key());
  expect(key(task, role, { ...profile, effort: "low" })).not.toBe(key());
  expect(key(task, role, profile, "1")).not.toBe(key());
});

for (const shared of [false, true]) it(`keeps moving bases out of the ${shared ? "multi" : "single"}-product identity while retaining approved choices`, () => {
  const demo = createDemoState(1_000_000_000).tasks[0]!;
  const source: NonNullable<Task["source"]> = { product: { id: "p", name: "Product", repo: "local/product", path: "/clone" }, start: { kind: "default", branch: "main" }, destination: { mode: "local", repo: "local/product", branch: "main", kind: "branch" }, confirmed: true, initialSha: "initial" };
  const work = { productId: "p", worktree: "/copy", source, delivery: "local" as const, baseSha: "original", completedStages: [] };
  const stage = { id: "review", kind: "review-chain" as const, title: "Independent review", roleId: "code-reviewer", profileIds: ["sol-high"] };
  const task = { ...demo, productId: "p", worktree: "/copy", source, baseSha: "original", repositories: shared ? [work, { ...work, productId: "companion", worktree: "/companion" }] : undefined, plan: { rationale: "Review", plannerProfileId: "sol-high", stages: [stage] } };
  const role = BUILT_IN_ROLES.find((role) => role.id === "code-reviewer")!, profile = ENGINE_PROFILES[0]!;
  const key = (value = task) => reviewConversationScope(value, "review", "0", role, profile, profile);
  expect(key({ ...task, baseSha: "advanced", repositories: task.repositories?.map((work) => ({ ...work, baseSha: "advanced" })) })).toBe(key());
  expect(key({ ...task, source: { ...source, start: { kind: "branch", branch: "main" } } })).not.toBe(key());
  expect(key({ ...task, worktree: "/new-copy" })).not.toBe(key());
  expect(key({ ...task, plan: { ...task.plan, stages: [{ ...stage, title: "Changed assignment" }] } })).not.toBe(key());
  const port = { from: "old", head: "reviewed", onto: "new", files: ["greeting.txt"] };
  expect(reviewConversationScope({ ...task, portReview: port }, "review", "0", role, profile, profile)).not.toBe(key());
  expect(reviewConversationScope({ ...task, updating: port }, "review", "0", role, profile, profile)).not.toBe(key());
  expect(reviewConversationScope(task, "review", "0", role, { ...profile, effort: "low" }, profile)).not.toBe(key());
  if (task.repositories) {
    expect(key({ ...task, repositories: task.repositories.slice(0, 1) })).not.toBe(key());
    for (const change of [{ worktree: "/different-companion" }, { source: { ...source, initialSha: "changed-approved-source" } }, { portReview: port }]) {
      expect(key({ ...task, repositories: task.repositories.map((work, index) => index ? { ...work, ...change } : work) })).not.toBe(key());
    }
  }
});

it("checks each seat's remembered bases, including missing, unchanged, forward, port and incompatible anchors", async () => {
  const f = await bare();
  try {
    const bases = reviewBases(f.scope), heads = { p: f.first };
    expect((await reviewBaseUpdates(f.scope, bases, heads)).sections).toEqual([]);
    expect((await reviewBaseUpdates(f.scope, undefined, heads)).reason).toContain("saved repository bases");
    f.scope.work.baseSha = f.first;
    const moved = await reviewBaseUpdates(f.scope, bases, heads);
    expect(moved.sections).toHaveLength(1);
    expect(moved.sections[0]!.body).toContain("No incremental comparison is available");
    f.scope.work.source = { product: { id: "p", name: "Product", repo: "local/product" }, start: { kind: "branch", branch: "release" }, destination: { mode: "local", repo: "local/product", branch: "release", kind: "branch" }, confirmed: true };
    f.scope.work.reviewedSha = f.first;
    const branch = await reviewBaseUpdates(f.scope, bases, heads);
    expect(branch.sections[0]!.body).toContain("release gained 1 commit.");
    expect(branch.sections[0]!.body).toContain("release's incoming changes are not in the incremental comparison");
    expect((await reviewBaseUpdates(f.scope, { p: f.first }, heads)).sections).toEqual([]);
    const unrelated = await git(f.repo, "commit-tree", `${f.first}^{tree}`, "-m", "A base without the original history");
    expect((await reviewBaseUpdates(f.scope, { p: unrelated }, heads)).reason).toContain("replaced or diverged");
    f.scope.work.portReview = { from: f.base, head: f.first, onto: f.first, files: ["greeting.txt"] };
    expect((await reviewBaseUpdates(f.scope, bases, heads)).reason).toContain("conflict port review");
  } finally { await f.engine.shutdown(); }
});

describe("bounded verifier places after handoffs", () => {
  type Hunted = { stageId: string; round: number; input?: { heads: Readonly<Record<string, string>> } };
  const ballotOn = (hunt: Hunted, seat: string) => ({ stageId: hunt.stageId, round: hunt.round, seat, versions: { ...hunt.input!.heads } });
  const answer = (hunt: Hunted, seat: string, by: string, toolId: string, verdict: "real" | "nit" | "not-a-bug") => ({ by, toolId, plannedProfileId: seat, verdict, reason: `${toolId} answered ${verdict} for its place.`, ballot: ballotOn(hunt, seat) });
  const important = (id: string): DeepMutable<Finding> => ({ id, text: `The ${id} greeting is missing.`, severity: "blocking", raisedBy: "argon-high", confirmedBy: [], status: "open", evidence: `Opened the ${id} page.` });
  const place = (key: string, profileId: string, toolId: string, findingIds: string[], extra: object = {}) => ({ key, profileId, toolId, findingIds, reason: "Chosen for the initial pair.", ...extra });
  /** A review stage whose fallback verifiers are the stage's own tools, with admissions open and nothing scheduled. */
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

  it("records only what a takeover still owes, and its step still expects every place", async () => {
    const f = await ballot(["opus-high", "sol-high", "grok-high"], ["a", "b"]);
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true }, findings: 2, input };
    const hunt = f.task.hunt;
    // Claude answered "a" before running out; Codex took over its place, which still owes "b". Grok answered both.
    f.task.findings[0]!.votes = [answer(hunt, "opus-high", "opus-high", "claude-code", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "real")];
    f.task.findings[1]!.votes = [answer(hunt, "grok-high", "grok-high", "grok", "real")];
    const taken = place("opus-high", "sol-high", "codex", ["a", "b"], { replaced: { from: "opus-high", reason: "Claude Code ran out." } });
    const grok = place("grok-high", "grok-high", "grok", ["a", "b"]);
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok"], seats: [taken, grok] };
    const bodies: string[] = [];
    const expected: unknown[] = [];
    const named: unknown[] = [];
    let status = "";
    const turn = spyOn(f.engine["turns"], "parallel").mockImplementation(async (_scope, _role, _profile, _copy, given, _schema, _signal, options) => {
      bodies.push(JSON.stringify(await given()));
      expected.push(options?.seats);
      named.push([options?.key, options?.member, options?.place]);
      // Shown only "b", the takeover also answers "a", which its place already holds from Claude Code.
      await (options!.check as (value: unknown) => unknown)({ verdicts: [{ id: "a", verdict: "nit", reason: "An unasked answer on a finding this place already holds." }, { id: "b", verdict: "nit", reason: "The answer this place still owed." }] });
      return undefined as never;
    });
    const together = spyOn(f.reviews as unknown as { together: typeof f.reviews["together"] }, "together").mockImplementation(async (_task, members, _signal, words) => {
      status = words(1, 0);
      for (const member of members) await member.work(f.repo, () => true, member.profileId, () => {}, {} as never, false, signal);
    });
    try {
      await f.reviews["vote"](f.task, { findings: f.task.findings, seats: [hunt.panel.seats[0]!], voters: ["sol-high"], phase: [...hunt.panel.seats], panel: hunt.panel }, signal);
      const shown = JSON.parse(bodies[0]!).map((section: { body: string }) => section.body).at(-1) as string;
      expect(shown).toContain("- [b]");
      expect(shown).not.toContain("- [a]");
      expect(panelAnswers(hunt.panel, f.task.findings[0]!, hunt).map((vote) => [vote.toolId, vote.verdict])).toEqual([["claude-code", "nit"], ["grok", "real"]]);
      expect(f.task.findings[0]!.votes).toHaveLength(2);
      expect(panelAnswers(hunt.panel, f.task.findings[1]!, hunt).map((vote) => [vote.toolId, vote.verdict])).toEqual([["grok", "real"], ["codex", "nit"]]);
      // The step expects Grok's finished place as well as the one being taken over, each named by its place.
      expect(expected).toEqual([["verifier:opus-high", "verifier:grok-high"]]);
      expect(named).toEqual([["verifier:opus-high", "vote-opus-high", "opus-high"]]);
      expect(status).toBe("1 fresh agent voting on 2 important findings");
    } finally { together.mockRestore(); turn.mockRestore(); await f.engine.shutdown(); }
  });

  it("counts only the findings a third answer was given in its live status", async () => {
    const f = await ballot(["opus-high", "sol-high", "grok-high"], ["a", "b"]);
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true }, findings: 2, input };
    const third = place("third:opus-high", "opus-high", "claude-code", ["b"], { third: true, reason: "Third answer." });
    f.task.hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok"], seats: [place("sol-high", "sol-high", "codex", ["a", "b"]), place("grok-high", "grok-high", "grok", ["a", "b"]), third], escalatedAt: 1 };
    let status = "";
    const together = spyOn(f.reviews as unknown as { together: typeof f.reviews["together"] }, "together").mockImplementation(async (_task, _members, _signal, words) => { status = words(1, 0); });
    try {
      await f.reviews["vote"](f.task, { findings: f.task.findings, seats: [third], voters: ["opus-high"], phase: [third], third: true, panel: f.task.hunt.panel }, signal);
      expect(status).toBe("1 fresh agent giving a third answer on 1 important finding");
    } finally { together.mockRestore(); await f.engine.shutdown(); }
  });

  it("gives each third place, a replaced one included, its own portable copy and records its answer on that place", async () => {
    const f = await ballot(["opus-high", "sol-high", "grok-high", "argon-high"], ["x", "y"]);
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true, "3": true }, findings: 2, input };
    const hunt = f.task.hunt;
    for (const finding of f.task.findings) finding.votes = [answer(hunt, "sol-high", "sol-high", "codex", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "nit")];
    // Claude Code gives x its third answer; Antigravity took over y's third place from Codex.
    const third = place("third:opus-high", "opus-high", "claude-code", ["x"], { third: true });
    const taken = place("third:sol-high", "argon-high", "antigravity", ["y"], { third: true, replaced: { from: "sol-high", reason: "Codex ran out." } });
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok", "antigravity"], escalatedAt: 1, seats: [place("sol-high", "sol-high", "codex", ["x", "y"]), place("grok-high", "grok-high", "grok", ["x", "y"]), third, taken] };
    const folder = join(f.engine.dataDir, "worktrees", "p", `${f.task.id}.copies`);
    const seen: { member?: string; place?: string; copy: string; head: string; peers: string[] }[] = [];
    const turn = spyOn(f.engine["turns"], "parallel").mockImplementation(async (_scope, _role, _profile, copy, _given, _schema, _signal, options) => {
      // Each start in call order, with the folder as it was then; its version follows once Git answers.
      const entry = { member: options?.member, place: options?.place, copy, head: "", peers: readdirSync(folder).sort() };
      seen.push(entry);
      entry.head = await git(copy, "rev-parse", "HEAD");
      await (options!.check as (value: unknown) => unknown)({ verdicts: [{ id: "x", verdict: "real", reason: "Reproduced the missing x greeting." }, { id: "y", verdict: "real", reason: "Reproduced the missing y greeting." }] });
      return undefined as never;
    });
    try {
      await f.reviews["vote"](f.task, { findings: f.task.findings, seats: [third, taken], voters: ["opus-high", "argon-high"], phase: [third, taken], third: true, panel: hunt.panel }, signal);
      // Each place works in a folder named after its place, never its tool, and never the raw `third:` name.
      expect(seen.map(({ peers: _peers, ...entry }) => entry).sort((a, b) => a.copy.localeCompare(b.copy))).toEqual([
        { member: "vote-third:opus-high", place: "third:opus-high", copy: join(folder, "vote-third_3aopus-high"), head: f.first },
        { member: "vote-third:sol-high", place: "third:sol-high", copy: join(folder, "vote-third_3asol-high"), head: f.first },
      ]);
      // The later start still sees its peer's separate copy: both were made beside each other.
      expect(seen.at(-1)!.peers).toEqual(["vote-third_3aopus-high", "vote-third_3asol-high"]);
      expect(existsSync(folder)).toBe(false);
      expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain(`${f.task.id}.copies`);
      // Answers keep their logical places: the takeover's answer counts for the place it took.
      const [x, y] = f.task.findings;
      expect(x!.votes!.at(-1)).toMatchObject({ by: "opus-high", toolId: "claude-code", verdict: "real", ballot: { seat: "third:opus-high" } });
      expect(y!.votes!.at(-1)).toMatchObject({ by: "argon-high", toolId: "antigravity", plannedProfileId: "argon-high", verdict: "real", ballot: { seat: "third:sol-high" } });
      expect(x!.votes).toHaveLength(3);
      expect(y!.votes).toHaveLength(3);
      expect(hunt.panel.seats.map((seat) => seat.key)).toEqual(["sol-high", "grok-high", "third:opus-high", "third:sol-high"]);
    } finally { turn.mockRestore(); await f.engine.shutdown(); }
  });

  it("brings a third place stopped by a full model back into the copy it made, while its peer still works", async () => {
    const f = await ballot(["opus-high", "sol-high", "grok-high", "argon-high"], ["x", "y"]);
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true, "3": true }, findings: 2, input };
    const hunt = f.task.hunt;
    for (const finding of f.task.findings) finding.votes = [answer(hunt, "sol-high", "sol-high", "codex", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "nit")];
    const third = place("third:opus-high", "opus-high", "claude-code", ["x"], { third: true });
    const taken = place("third:sol-high", "argon-high", "antigravity", ["y"], { third: true, replaced: { from: "sol-high", reason: "Codex ran out." } });
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok", "antigravity"], escalatedAt: 1, seats: [place("sol-high", "sol-high", "codex", ["x", "y"]), place("grok-high", "grok-high", "grok", ["x", "y"]), third, taken] };
    const folder = join(f.engine.dataDir, "worktrees", "p", `${f.task.id}.copies`);
    const starts: { member?: string; copy: string; draft: boolean }[] = [];
    const back = () => starts.filter((entry) => entry.member === "vote-third:sol-high").length === 2;
    const turn = spyOn(f.engine["turns"], "parallel").mockImplementation(async (_scope, _role, _profile, copy, _given, _schema, _signal, options) => {
      const first = !starts.some((entry) => entry.member === options?.member);
      starts.push({ member: options?.member, copy, draft: existsSync(join(copy, "capacity-draft.txt")) });
      // Antigravity's model is full on its first try and leaves a partial draft in its copy.
      if (options?.member === "vote-third:sol-high" && first) {
        writeFileSync(join(copy, "capacity-draft.txt"), "A partial third answer\n");
        throw new WaitingForCapacity("Gemini 4 Argon is at capacity");
      }
      // Claude Code keeps working until its peer has come back.
      if (options?.member === "vote-third:opus-high") await waitFor(back, "the stopped third place to come back beside its working peer");
      await (options!.check as (value: unknown) => unknown)({ verdicts: [{ id: "x", verdict: "real", reason: "Reproduced the missing x greeting." }, { id: "y", verdict: "real", reason: "Reproduced the missing y greeting." }] });
      return undefined as never;
    });
    try {
      await f.reviews["vote"](f.task, { findings: f.task.findings, seats: [third, taken], voters: ["opus-high", "argon-high"], phase: [third, taken], third: true, panel: hunt.panel }, signal);
      const own = join(folder, "vote-third_3asol-high");
      expect(starts.filter((entry) => entry.member === "vote-third:sol-high")).toEqual([{ member: "vote-third:sol-high", copy: own, draft: false }, { member: "vote-third:sol-high", copy: own, draft: true }]);
      expect(starts.filter((entry) => entry.member === "vote-third:opus-high")).toEqual([{ member: "vote-third:opus-high", copy: join(folder, "vote-third_3aopus-high"), draft: false }]);
      expect(f.task.findings[1]!.votes!.at(-1)).toMatchObject({ by: "argon-high", toolId: "antigravity", verdict: "real", ballot: { seat: "third:sol-high" } });
      expect(f.task.findings[0]!.votes!.at(-1)).toMatchObject({ by: "opus-high", toolId: "claude-code", verdict: "real", ballot: { seat: "third:opus-high" } });
      expect(existsSync(folder)).toBe(false);
      expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain(`${f.task.id}.copies`);
    } finally { turn.mockRestore(); await f.engine.shutdown(); }
  });

  it("gives a verifier its own copy when a screen wait saved before the folder rule kept that folder name", async () => {
    const f = await ballot(["opus-high", "sol-high"], ["a"]);
    // Two accepted profile names: the earlier version saved `_46`'s copy as vote-_46, which is F's encoded folder now.
    f.engine.s.profiles.push({ ...f.engine.profile("opus-high")!, id: "_46" }, { ...f.engine.profile("sol-high")!, id: "F" });
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true }, findings: 1, input };
    const hunt = f.task.hunt;
    const saved = place("_46", "_46", "claude-code", ["a"]), peer = place("F", "F", "codex", ["a"]);
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex"], seats: [saved, peer] };
    const folder = join(f.engine.dataDir, "worktrees", "p", `${f.task.id}.copies`);
    const old = join(folder, "vote-_46");
    expect(join(folder, gitOps.copyFolderName("vote-F"))).toBe(old);
    await gitOps.addCopy(f.repo, old, f.first);
    writeFileSync(join(old, "screen-notes.txt"), "Kept through the upgrade\n");
    const conversation = { step: "review", roleId: "verifier", profileId: "_46", toolId: "claude-code", model: "opus", sessionId: "saved-before-upgrade", startedAt: Date.now() };
    hunt.screenTurns = { "vote-_46": { reason: "Check the window", at: Date.now(), copy: old, conversation } };
    f.task.screen = { reason: "Check the window", at: Date.now(), roleId: "verifier", profileId: "_46", member: "vote-_46", granted: true };
    const starts: { member?: string; copy: string; head: string; notes: boolean; peers: string[] }[] = [];
    const record = async (copy: string, options: { member?: string; check?: unknown } | undefined) => {
      // Each start in call order, with its copy and folder as they were then; its version follows once Git answers.
      const entry = { member: options?.member, copy, head: "", notes: existsSync(join(copy, "screen-notes.txt")), peers: readdirSync(folder).sort() };
      starts.push(entry);
      entry.head = await git(copy, "rev-parse", "HEAD");
      await (options!.check as (value: unknown) => unknown)({ verdicts: [{ id: "a", verdict: "real", reason: `Reproduced the missing a greeting in ${options?.member}.` }] });
      return undefined as never;
    };
    const continued = spyOn(f.engine["turns"], "turn").mockImplementation(async (_scope, _role, _profile, _given, _schema, _signal, options) => record(options!.copy!, options));
    const fresh = spyOn(f.engine["turns"], "parallel").mockImplementation(async (_scope, _role, _profile, copy, _given, _schema, _signal, options) => record(copy, options));
    try {
      await f.reviews["vote"](f.task, { findings: f.task.findings, seats: [saved, peer], voters: ["_46", "F"], phase: [saved, peer], panel: hunt.panel }, signal);
      // The saved verifier finishes in the copy it kept; that folder stays until the group ends, so F works beside it.
      expect(starts).toEqual([
        { member: "vote-_46", copy: old, head: f.first, notes: true, peers: ["vote-_46"] },
        { member: "vote-F", copy: join(folder, "vote-_46.1"), head: f.first, notes: false, peers: ["vote-_46", "vote-_46.1"] },
      ]);
      expect(f.task.findings[0]!.votes!.map((vote) => [vote.by, vote.ballot?.seat])).toEqual([["_46", "_46"], ["F", "F"]]);
      expect(existsSync(folder)).toBe(false);
      expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain(`${f.task.id}.copies`);
    } finally { continued.mockRestore(); fresh.mockRestore(); await f.engine.shutdown(); }
  });

  it("never gives two unfinished places one tool at once, and lets a tool that finished one place take another", async () => {
    const f = await ballot(["opus-high", "sol-high", "grok-high"], ["x", "y"]);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true }, findings: 0, input: { file: "input.json", digest: "d", heads: { p: f.first } } };
    const hunt = f.task.hunt;
    // Complementary partial answers: Claude Code answered x, Grok answered y. Both then run out.
    f.task.findings[0]!.votes = [answer(hunt, "opus-high", "opus-high", "claude-code", "nit")];
    f.task.findings[1]!.votes = [answer(hunt, "grok-high", "grok-high", "grok", "nit")];
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok"], seats: [place("opus-high", "opus-high", "claude-code", ["x", "y"]), place("grok-high", "grok-high", "grok", ["x", "y"])] };
    f.limit("claude-code", "grok");
    try {
      const vote = f.reviews["pendingVote"](f.task, f.stage)!;
      // Codex takes one place; the other waits while Codex still works there.
      expect(hunt.panel.seats.map((seat) => [seat.key, seat.toolId])).toEqual([["opus-high", "codex"], ["grok-high", "grok"]]);
      expect(vote.voters).toEqual(["sol-high", "grok-high"]);
      // Codex finished that place: it never answered x, so it takes the other place under that place's own name.
      f.task.findings[1]!.votes = [...f.task.findings[1]!.votes!, answer(hunt, "opus-high", "sol-high", "codex", "nit")];
      const next = f.reviews["pendingVote"](f.task, f.stage)!;
      expect(next.seats.map((seat) => [seat.key, seat.toolId, seat.profileId])).toEqual([["grok-high", "codex", "sol-high"]]);
      expect(next.phase!.map((seat) => seat.key)).toEqual(["opus-high", "grok-high"]);
      // A short same-conversation retry for Codex is looked up under the unfinished place it now works.
      expect(f.engine["usageCoordinator"]["votePlace"](f.task, "sol-high")).toBe("vote-grok-high");
    } finally { await f.engine.shutdown(); }
  });

  for (const finished of [true, false]) it(`${finished ? "lets a tool that finished another finding's third answer give a stalled one" : "keeps a stalled third answer waiting while the free tool still works another place"}`, async () => {
    const f = await ballot(["opus-high", "sol-high", "grok-high", "argon-high"], ["x", "y"]);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true, "3": true }, findings: 0, input: { file: "input.json", digest: "d", heads: { p: f.first } } };
    const hunt = f.task.hunt;
    // After partial handoffs x has Codex and Grok, y has Claude Code and Grok: separate third places.
    f.task.findings[0]!.votes = [answer(hunt, "sol-high", "sol-high", "codex", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "nit"), ...(finished ? [answer(hunt, "third:argon-high", "argon-high", "antigravity", "nit")] : [])];
    f.task.findings[1]!.votes = [answer(hunt, "sol-high", "opus-high", "claude-code", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "nit")];
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok", "antigravity"], escalatedAt: 1, seats: [
      place("sol-high", "sol-high", "codex", ["x", "y"]), place("grok-high", "grok-high", "grok", ["x", "y"]),
      place("third:argon-high", "argon-high", "antigravity", ["x"], { third: true }), place("third:sol-high", "sol-high", "codex", ["y"], { third: true }),
    ] };
    // y's third tool runs out; Antigravity stays free and has never answered y.
    f.limit("codex");
    try {
      const vote = f.reviews["pendingVote"](f.task, f.stage)!;
      const y = hunt.panel.seats.find((seat) => seat.key === "third:sol-high")!;
      if (finished) {
        expect([y.toolId, y.profileId]).toEqual(["antigravity", "argon-high"]);
        expect(y.replaced?.reason).toContain("takes its required seat on a different tool");
        expect(vote.seats.map((seat) => seat.key)).toEqual(["third:sol-high"]);
      } else {
        expect(y.toolId).toBe("codex");
        expect(vote.seats.map((seat) => [seat.key, seat.toolId])).toEqual([["third:argon-high", "antigravity"], ["third:sol-high", "codex"]]);
      }
    } finally { await f.engine.shutdown(); }
  });

  for (const [name, limited, profiles, expected] of [
    ["waits for the saved third tool rather than one left out at selection", ["claude-code", "antigravity"], ["opus-high", "sol-high", "grok-high", "argon-high"], { toolId: "antigravity" }],
    ["lets a tool left out at selection answer only when it can start now", ["antigravity"], ["opus-high", "sol-high", "grok-high", "argon-high"], { toolId: "claude-code" }],
    ["leaves the finding unresolved rather than waiting for a tool left out at selection", ["claude-code"], ["opus-high", "sol-high", "grok-high"], { unresolved: true }],
  ] as const) it(`${name}`, async () => {
    const f = await ballot([...profiles], ["f"]);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: Object.fromEntries(profiles.map((_, index) => [String(index), true as const])), findings: 0, input: { file: "input.json", digest: "d", heads: { p: f.first } } };
    const hunt = f.task.hunt;
    // Claude Code was out of usage when the panel was saved; both first answers say the finding does not block.
    f.task.findings[0]!.votes = [answer(hunt, "sol-high", "sol-high", "codex", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "nit")];
    hunt.panel = { rule: "bounded", usable: ["codex", "grok", "antigravity"], seats: [place("sol-high", "sol-high", "codex", ["f"]), place("grok-high", "grok-high", "grok", ["f"])] };
    f.limit(...limited);
    try {
      const vote = f.reviews["pendingVote"](f.task, f.stage);
      const third = hunt.panel.seats.filter((seat) => seat.third);
      if ("unresolved" in expected) {
        expect(third).toEqual([]);
        expect(hunt.panel.escalations?.f?.unresolved).toBe(true);
        expect(vote?.seats).toEqual([]);
      } else {
        expect(third.map((seat) => [seat.toolId, seat.findingIds])).toEqual([[expected.toolId, ["f"]]]);
        expect(vote?.seats.map((seat) => seat.toolId)).toEqual([expected.toolId]);
      }
    } finally { await f.engine.shutdown(); }
  });

  it("reopens a finding a vote left unresolved when a reviewer brings a current reproduction", async () => {
    const f = await ballot(["sol-high", "opus-high"], ["u", "kept"], 2);
    const round1 = { stageId: f.stage.id, round: 1, input: { heads: { p: f.base } } };
    for (const finding of f.task.findings) {
      finding.votes = [answer(round1, "sol-high", "sol-high", "codex", "nit"), answer(round1, "grok-high", "grok-high", "grok", "nit")];
      finding.unresolved = { at: 1, reason: "No ready independent tool could give the third answer.", heads: { p: f.base } };
    }
    f.task.hunt = { stageId: f.stage.id, round: 2, reported: {}, findings: 2, input: { file: "input.json", digest: "d", heads: { p: f.first } } };
    try {
      const evidence = "On the changed code the u greeting is still missing: expected Hello Ada, observed Hello. The kept page shows its greeting.";
      await f.reviews["applyReview"](f.scope, f.stage, ReviewResult.parse({ verdict: "fail", findings: [], confirms: [{ id: "u", evidence }, "kept"], disputes: [] }), "argon-high", "code-reviewer", "0");
      const u = f.task.findings[0]!, kept = f.task.findings[1]!;
      expect(u.unresolved).toBeUndefined();
      expect(u.votes).toBeUndefined();
      expect(u.reopenedAt).toBeDefined();
      expect(u.evidence).toBe(evidence);
      expect(u.confirmedBy).toEqual(["argon-high"]);
      expect(u.earlierReviews?.[0]?.unresolved?.reason).toBe("No ready independent tool could give the third answer.");
      expect(u.earlierReviews?.[0]?.votes).toHaveLength(2);
      // A confirmation without a reproduction keeps the unresolved episode, and its completed ballot is not repeated.
      expect(kept.unresolved).toBeDefined();
      expect(kept.votes).toHaveLength(2);
      expect(findingsNeedingVotes(f.task, id => f.engine.profile(id)?.toolId).map((finding) => finding.id)).toEqual(["u"]);
    } finally { await f.engine.shutdown(); }
  });

  // An older round may have saved only the commit; a later round of the same commit records its tree as well.
  for (const recorded of ["commit", "commit and tree"] as const) it(`keeps a finding a vote left unresolved when a written confirmation arrives on the same code, its ${recorded} saved`, async () => {
    const f = await ballot(["sol-high", "opus-high"], ["u"], 2);
    const tree = await git(f.repo, "rev-parse", `${f.first}^{tree}`);
    const round1 = { stageId: f.stage.id, round: 1, input: { heads: { p: f.first } } };
    const finding = f.task.findings[0]!;
    finding.votes = [answer(round1, "sol-high", "sol-high", "codex", "nit"), answer(round1, "grok-high", "grok-high", "grok", "nit")];
    finding.unresolved = { at: 1, reason: "No ready independent tool could give the third answer.", heads: { p: f.first }, ...(recorded === "commit" ? {} : { trees: { p: tree } }) };
    const saved = structuredClone(finding.unresolved);
    f.task.hunt = { stageId: f.stage.id, round: 2, reported: {}, findings: 1, input: { file: "input.json", digest: "d", heads: { p: f.first }, trees: { p: tree } } };
    try {
      const restated = "The u greeting is still missing: expected Hello Ada, observed Hello.";
      await f.reviews["applyReview"](f.scope, f.stage, ReviewResult.parse({ verdict: "fail", findings: [], confirms: [{ id: "u", evidence: restated }], disputes: [] }), "argon-high", "code-reviewer", "0");
      await f.reviews["applyReview"](f.scope, f.stage, ReviewResult.parse({ verdict: "fail", findings: [], confirms: [{ id: "u", evidence: restated }], disputes: [] }), "opus-high", "code-reviewer", "1");
      expect(finding.unresolved).toEqual(saved);
      expect(finding.votes).toHaveLength(2);
      expect(finding.reopenedAt).toBeUndefined();
      expect(finding.earlierReviews).toBeUndefined();
      expect(finding.confirmedBy).toEqual(["argon-high", "opus-high"]);
      expect(findingsNeedingVotes(f.task, id => f.engine.profile(id)?.toolId)).toEqual([]);
    } finally { await f.engine.shutdown(); }
  });
});
