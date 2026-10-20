import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as gitOps from "../src/git.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ROLES, createDemoState, type DeepMutable, type Finding } from "@petrina/core";
import { Context } from "../src/context.js";
import { Engine } from "../src/engine.js";
import { executionFor, repositoryView } from "../src/repository-context.js";
import { prepareReviewInput, readReviewInput, reviewConversationScope } from "../src/review-context.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";
import type { Scenario } from "./fake-agent.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const earlier: DeepMutable<Finding> = { id: "older", text: "An earlier bug", severity: "blocking", raisedBy: "sol-high", confirmedBy: [], status: "fixed", answer: { fixed: true, text: "Fixed the earlier bug", at: 1 } };

async function bare() {
  const root = tempDir("petrina-review-input-"); roots.push(root);
  const repo = makeProduct(root);
  writeFileSync(join(repo, "REVIEW.md"), "# Rules\nPreserve the original rule.\n");
  git(repo, "add", "REVIEW.md"); git(repo, "commit", "-qm", "Record the original review guide");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "REVIEW.md"), "# Rules\nA change cannot replace the original rule.\n");
  writeFileSync(join(repo, "greeting.txt"), "FIRST-CHANGE\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Add the greeting");
  const first = git(repo, "rev-parse", "HEAD");
  const engine = new Engine(join(root, "data"), { admissionsClosed: true, agentCommand: () => undefined, codexCommand: null, grokCommand: null, antigravityCommand: null, terminals: () => [] });
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
      git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Resolve the port");
      const head = git(f.repo, "rev-parse", "HEAD");
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
      git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Fix the greeting");
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
      git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Update a dependency and the greeting");
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
      writeFileSync(snapshot.artifacts![0]!.file, "corrupt");
      await expect(readReviewInput(ref)).rejects.toThrow("prepared review comparison changed");
    } finally { await a.engine.shutdown(); await b.engine.shutdown(); }
  });
});

async function run(reopen: Scenario["reopen"], options: { single?: boolean; shared?: boolean; limit?: number; limited?: Scenario["limited"]; reviewer?: Scenario["reviewer"] } = {}) {
  const root = tempDir("petrina-review-resume-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  const scenario: Scenario = { planner: options.single ? "short" : "pair", builder: "plain", reviewer: options.reviewer ?? "important", fixes: "change", controlled: true, reopen, limited: options.limited };
  fakes.scenario(scenario);
  const data = join(root, "data");
  const engineOptions = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], toolPath: () => "/bin/true", codexCommand: null, grokCommand: null, antigravityCommand: null };
  let engine = new Engine(data, engineOptions);
  engine.setPoolPaused(true); await engine.checkTools(); engine.setPoolLimit(options.limit ?? 2);
  const productId = await engine.addProduct(makeProduct(root)); engine.setProductDelivery(productId, "local", true);
  let second: string | undefined;
  if (options.shared) {
    const copy = makeProduct(join(root, "second")), named = join(root, "second", "api");
    renameSync(copy, named);
    second = await engine.addProduct(named, "Second");
    fakes.scenario({ ...scenario, affectedProducts: [productId, second] });
  }
  const taskId = engine.addTask({ productId, title: "Reuse independent reviewers", description: "ORIGINAL-REVIEW-REQUEST [no-check]", approvePlan: true, ...(second ? { worksOn: [productId, second].map((productId) => ({ productId, startFrom: { kind: "default" as const }, delivery: "local" as const })) } : {}) });
  const task = () => engine.task(taskId)!;
  const tick = (allow: (role: string, session: string) => boolean = () => true) => {
    for (const entry of fakes.received()) if (allow(entry.role, entry.session)) writeFileSync(join(fakes.dir, `release-${entry.session}`), "go");
    for (const item of engine.getState().inbox) {
      if (item.kind === "plan") { const stage = task().plan!.stages.find((stage) => stage.kind === "review-chain")!; stage.maxRounds = 2; if (task().workRows?.some((row) => row.error)) throw new Error(JSON.stringify(task().workRows)); engine.approve(item.id); }
      else if (item.kind === "question") engine.answer(item.id, "Yes");
      else if (item.kind === "permission") engine.allow(item.id, "once");
    }
    if (task().state === "failed") throw new Error(task().error);
  };
  const done = () => waitFor(() => { tick(); return engine.getState().inbox.some((item) => item.kind === "delivery") && task(); }, "the reviewed delivery");
  const restart = async () => { await engine.shutdown(); engine = new Engine(data, engineOptions); };
  engine.setPoolPaused(false);
  return { engine: () => engine, fakes, task, tick, done, restart };
}

describe.concurrent("reviewer conversations across fix rounds", () => {
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
        expect(prompts[0]!.text).toContain("Browser output belongs only in");
        expect(prompts[1]!.text).toContain("Browser capture folder for this turn:");
        expect(prompts[1]!.text).not.toContain("Browser output belongs only in");
      }
      const voterIds = new Set(f.fakes.received("verifier").map((entry) => entry.session));
      expect(voterIds.size).toBeGreaterThan(0);
      expect(f.fakes.opens().filter((entry) => voterIds.has(entry.session)).every((entry) => entry.how === "new")).toBe(true);
      expect(task.reviewSessions).toBeUndefined();
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
    const f = await run(undefined);
    try {
      const task = await f.done();
      const second = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!;
      expect(second.agentInputs!.every((input) => input.mode === "fresh" && input.taskDescription!.includes("ORIGINAL-REVIEW-REQUEST"))).toBe(true);
      expect(task.timeline.some((entry) => entry.text.includes("Could not go back to its own review conversation"))).toBe(true);
    } finally { await f.engine().shutdown(); }
  });

  for (const changed of ["context", "profile"] as const) it(`starts only the affected seat fresh after its ${changed} changes`, async () => {
    const f = await run("resume");
    try {
      await waitFor(() => { f.tick((role) => role !== "builder" || !f.task().fixing); return f.task().fixing && Object.keys(f.task().reviewSessions ?? {}).length && f.fakes.received("builder").some((entry) => entry.text.includes("Review findings")); }, "saved review sessions before fixes");
      const stage = f.task().plan!.stages.find((entry) => entry.kind === "review-chain")!;
      const prior = f.task().reviewSessions![stage.id]!["0"]!;
      if (changed === "context") prior.context!.file += ".missing";
      else f.engine().s.profiles = f.engine().s.profiles.map((profile) => profile.id === prior.profileId ? { ...profile, effort: "low" } : profile);
      const task = await f.done();
      const inputs = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!.agentInputs!;
      expect(inputs.find((input) => input.profileId === prior.profileId)!.mode).toBe("fresh");
      expect(inputs.find((input) => input.profileId !== prior.profileId)!.mode).toBe("continued");
      expect(inputs.find((input) => input.mode === "fresh")!.taskDescription).toContain("ORIGINAL-REVIEW-REQUEST");
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
