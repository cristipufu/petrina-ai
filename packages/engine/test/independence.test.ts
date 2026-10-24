import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { draftOf, independentVotes, slotUses, type Vote } from "@petrina/core";
import { Engine } from "./engine.js";
import { ADAPTERS } from "../src/tools.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";
import { scriptedToolProbe } from "./scripted-probes.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture(scenario: Scenario, limit = 3, reviewers?: string[], builderProfile?: string, reviewOnly = true, antigravity = false) {
  const root = tempDir("petrina-independence-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ builder: "plain", ...scenario });
  const options = { agentCommand: (profile: { toolId: string }) => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, ...(!antigravity && profile.toolId === "antigravity" ? ["--logged-out"] : [])], toolPath: () => process.execPath, usageCommands: { codex: null },
    // These journeys test native seat handoffs, not login transport. The setup contract owns real probes.
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" },
      antigravity: { status: antigravity ? "ready" : "logged-out" }, gh: { status: "unknown" }, git: { status: "ready" }, node: { status: "ready" } }),
  };
  let engine = new Engine(join(root, "data"), options);
  engine.setPoolPaused(true);
  await engine.checkTools();
  engine.setPoolLimit(limit);
  for (const tool of Object.keys(ADAPTERS)) engine.setToolCap(tool, 1);
  const repo = await makeProduct(root);
  const productId = await engine.addProduct(repo);
  engine.setProductDelivery(productId, "local", true);
  if (reviewOnly) {
    const product = engine.s.products.find((entry) => entry.id === productId)!;
    product.checks = [];
    product.checksBy = "coordinator";
  }
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]", approvePlan: true });
  const task = () => engine.getState().tasks.find((entry) => entry.id === taskId)!;
  const model = (session: string) => fakes.settings(session).find((setting) => setting.startsWith("model="))?.slice(6);
  const models = (role: string) => [...new Set(fakes.received(role).map((entry) => entry.session))].map(model);
  const release = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
  const advance = (done: () => boolean, allow: (role: string, session: string) => boolean = () => true) => waitFor(() => {
    for (const prompt of fakes.received()) if (allow(prompt.role, prompt.session)) release(prompt.session);
    for (const item of engine.getState().inbox) {
      if (item.kind === "plan") {
        // Cases asserting design or brief preservation keep their design stages; code-review cases need neither.
        if (reviewOnly) {
          const planned = engine.s.tasks.find((entry) => entry.id === taskId)!.plan!;
          planned.stages = planned.stages.filter((stage) => stage.kind !== "converge");
        }
        const stage = task().plan!.stages.find((stage) => stage.kind === "review-chain")!;
        reviewers?.forEach((profile, index) => engine.setStageProfile(taskId, stage.id, "profileIds", index, profile));
        const build = task().plan!.stages.find((stage) => stage.roleId === "builder")!;
        if (builderProfile) engine.setStageProfile(taskId, build.id, "profileIds", 0, builderProfile);
        engine.approve(item.id);
      } else if (item.kind === "design") engine.approve(item.id);
      else if (item.kind === "permission") engine.allow(item.id, "once");
      else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
    }
    if (task().state === "failed") throw new Error(task().error);
    return done();
  }, "the independent reviews", 60_000);
  const delivery = () => engine.getState().inbox.some((item) => item.kind === "delivery");
  const restart = async () => { await engine.shutdown(); engine = new Engine(join(root, "data"), options); };
  engine.setPoolPaused(false);
  return { get engine() { return engine; }, fakes, task, model, models, release, advance, delivery, restart, repo };
}

describe.concurrent("reviews after a usage handoff", () => {
  it("includes a reopened finding in the saved reviewer outcome before handing it to verifiers", async () => {
    const f = await fixture({ controlled: true, reviewer: "confirm-dismissed", reopenedEvidence: "The current greeting is still missing its name: expected Hello Ada, observed Hello. The named greeting control passes." }, 3, ["sol-high", "opus-high"], undefined, true);
    try {
      await f.advance(() => f.fakes.received("builder").length > 0, (role) => role !== "builder");
      const task = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      const id = task.id + "-earlier";
      task.findings.push({ id, text: "The greeting loses its name", severity: "blocking", status: "fixed", raisedBy: "sol-high", confirmedBy: [], answer: { fixed: true, text: "Kept the name", at: Date.now() - 1000 } });
      await f.advance(() => f.task().journey?.some((step) => step.roleId === "code-reviewer" && step.endedAt !== undefined) ?? false, (role) => role !== "verifier");
      const review = f.task().journey!.find((step) => step.roleId === "code-reviewer")!;
      expect(review.result?.findings?.map((finding) => finding.id)).toEqual([id]);
      expect(review.outcome).toBe("1 important");
      expect(review.reason).toBe("1 important finding to check");
    } finally { await f.engine.shutdown(); }
  });

  for (const limit of [1, 2]) it(`keeps a real reviewer handoff independent with ${limit} pool slots and one slot per tool`, async () => {
    // With two seats it is the helper that hands over, while the pool is full.
    const f = await fixture({ planner: "build-review", limited: [{ model: "opus", role: "code reviewer", spendCap: true }], reviewer: "important-twice" }, limit, limit === 2 ? ["sol-high", "opus-high"] : undefined);
    const violations: unknown[] = [];
    let peak = 0;
    const unsub = f.engine.subscribe(() => {
      const uses = slotUses(f.engine.getState());
      peak = Math.max(peak, uses.length);
      if (uses.length > limit || ["claude-code", "codex", "grok"].some((tool) => uses.filter((use) => use.toolId === tool).length > 1)) violations.push(uses);
    });
    try {
      await f.advance(f.delivery);
      const reviewers = f.fakes.received("code reviewer");
      const replacement = reviewers.find((entry) => f.model(entry.session) === "grok-4.7");
      expect(replacement?.text).toContain("Claude Code · Opus 5.5 was doing this part of the review and ran out of usage");
      expect(replacement?.text).toContain("I drafted notes.txt");
      const first = f.engine.tracking.log.moments({ taskId: f.task().id, kinds: ["verdict"] }).filter((entry) => entry.round === 1);
      expect(new Set(first.map((entry) => f.engine.s.profiles.find((profile) => profile.id === entry.profileId)?.toolId))).toEqual(new Set(["codex", "grok"]));
      expect(first).toHaveLength(2);
      expect(f.fakes.openings("verifier").length).toBeGreaterThan(0);
      expect(violations).toEqual([]);
      expect(peak).toBe(limit === 1 ? 1 : 2);
    } finally { unsub(); await f.engine.shutdown(); }
  });

  it("keeps a design review away from the replacement that actually wrote the brief", async () => {
    const f = await fixture({ limited: [{ model: "opus", role: "architect", spendCap: true }] }, 1, undefined, undefined, false);
    try {
      await f.advance(f.delivery);
      expect(f.models("architect")).toEqual(["opus", "gpt-6.1-sol"]);
      expect(f.models("design reviewer")).toEqual(["grok-4.7"]);
      expect(f.task().brief?.summary).toBe("A greeting file.");
    } finally { await f.engine.shutdown(); }
  });

  it("hands a design reviewer to another tool when its own usage runs out", async () => {
    const f = await fixture({ limited: [{ model: "gpt-6.1-sol", role: "design reviewer" }] }, 1, undefined, undefined, false);
    try {
      await f.advance(f.delivery);
      expect(f.models("architect")).toEqual(["opus"]);
      expect(f.models("design reviewer")).toEqual(["gpt-6.1-sol", "grok-4.7"]);
    } finally { await f.engine.shutdown(); }
  });

  it("retains a reported review after a restart of a saved legacy pair", async () => {
    const f = await fixture({ controlled: true }, 1, undefined, undefined, false);
    try {
      // Save the legacy Sol + Opus plan with Claude already out before the review starts.
      await f.advance(() => f.fakes.received("builder").length === 1, (role) => role !== "builder");
      const stage = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!.plan!.stages.find((stage) => stage.kind === "review-chain")!;
      stage.profileIds = ["sol-high", "opus-high"];
      f.engine.s.pool.limited = [{ toolId: "claude-code", until: Date.now() + 3_600_000, reason: "Claude Code's usage limit" }];
      await f.advance(() => Object.keys(f.task().hunt?.reported ?? {}).length === 1, (role, session) => role !== "code reviewer" || f.model(session) === "gpt-6.1-sol");
      expect(f.task().hunt?.profiles?.["0"]).toBe("sol-high");
      await f.restart();
      await f.advance(f.delivery);
      const reviewers = f.fakes.received("code reviewer");
      expect(reviewers.filter((entry) => f.model(entry.session) === "gpt-6.1-sol")).toHaveLength(1);
      expect(reviewers.filter((entry) => f.model(entry.session) === "grok-4.7").length).toBeGreaterThanOrEqual(1);
      expect(f.task().hunt).toBeUndefined();
      expect(f.task().brief?.summary).toBe("A greeting file.");
    } finally { await f.engine.shutdown(); }
  });

  it("keeps an actual replacement's verdict in older saved rounds without recorded reviewer positions", async () => {
    const f = await fixture({ controlled: true, limited: [{ model: "opus", role: "code reviewer", spendCap: true }] }, 1);
    try {
      // Initially only Codex can finish the review. Both other tools recover before the restart.
      f.engine.s.pool.limited = [{ toolId: "grok", until: Date.now() + 3_600_000, reason: "Grok's usage limit" }];
      await f.advance(() => Object.keys(f.task().hunt?.reported ?? {}).length === 1);
      f.engine.setPoolPaused(true);
      expect(f.task().hunt?.profiles?.["0"]).toBe("sol-high");
      const saved = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      delete saved.hunt!.profiles;
      f.engine.s.pool.limited = [];
      f.engine.s.pool.usage = [];
      f.fakes.scenario({ controlled: true, builder: "plain" });
      await f.restart();
      f.engine.setPoolPaused(false);
      await f.advance(f.delivery);
      const verdicts = f.engine.tracking.log.moments({ taskId: f.task().id, kinds: ["verdict"] });
      expect(verdicts.map((entry) => entry.profileId)).toEqual(["sol-high", "opus-high"]);
      expect(f.fakes.openings("builder")).toHaveLength(1);
    } finally { await f.engine.shutdown(); }
  });

  it("reviews a real conflict port away from its latest builder, even when neither planned reviewer can do that", async () => {
    const f = await fixture({ controlled: true }, 3, ["sol-high", "opus-high"], "opus-high");
    try {
      // The usage stand-in writes notes.txt. Include it in the reviewed feature so its handoff later
      // remains a genuine port, rather than adding an unreviewed file alongside the conflict.
      await f.advance(() => f.fakes.received("builder").length === 1, (role) => role !== "builder");
      writeFileSync(join(f.task().worktree!, "notes.txt"), "A first draft\n");
      await f.advance(f.delivery);
      expect(await git(f.task().worktree!, "show", "HEAD:notes.txt")).toBe("A first draft");
      // The original build and review finished. A conflicting change lands before delivery.
      expect(f.task().builderSession?.toolId).toBe("claude-code");
      writeFileSync(join(f.repo, "greeting.txt"), "Hi from main\n");
      await git(f.repo, "add", "greeting.txt");
      await git(f.repo, "commit", "-q", "-m", "A greeting on main");
      f.fakes.scenario({ builder: "plain", controlled: true, limited: [{ model: "opus", role: "builder", spendCap: true }] });
      f.engine.approve(f.engine.getState().inbox.find((item) => item.kind === "delivery")!.id);
      await f.advance(() => f.task().portReview !== undefined && f.fakes.received("code reviewer").some((entry) => entry.text.includes("Review only the port")), (role) => role !== "code reviewer");
      const port = f.fakes.received("code reviewer").find((entry) => entry.text.includes("Review only the port"))!;
      expect(f.task().builderSession?.toolId).toBe("codex");
      const update = f.task().timeline.find((entry) => entry.text.startsWith("Brought up to date with main:"))!;
      expect(f.engine.s.profiles.find((profile) => profile.id === update.profileId)?.toolId).toBe("codex");
      expect(f.task().plan!.stages.find((stage) => stage.roleId === "builder")!.profileIds).toEqual(["opus-high"]);
      expect(f.model(port.session)).toBe("grok-4.7");
      const step = f.task().journey!.find((entry) => entry.roleId === "code-reviewer" && entry.port)!;
      expect(step.team).toEqual(["grok-high"]);
      await f.restart();
      await f.advance(f.delivery);
      expect(f.fakes.received("code reviewer").filter((entry) => entry.text.includes("Review only the port")).every((entry) => f.model(entry.session) === "grok-4.7")).toBe(true);
      const completed = f.task().journey!.filter((entry) => entry.roleId === "code-reviewer" && entry.port);
      expect(completed).toHaveLength(1);
      expect(completed[0]).toEqual(expect.objectContaining({ id: step.id, team: ["grok-high"], end: "done", reason: "review passed" }));
    } finally { await f.engine.shutdown(); }
  });

  it("finishes both reviews on the remaining tool when independence is unavailable", async () => {
    const f = await fixture({ limited: [{ model: "opus", role: "code reviewer", spendCap: true }] }, 1);
    try {
      f.engine.s.pool.limited = [{ toolId: "grok", until: Date.now() + 3_600_000, reason: "Grok's usage limit" }];
      await f.advance(f.delivery);
      const verdicts = f.engine.tracking.log.moments({ taskId: f.task().id, kinds: ["verdict"] });
      expect(verdicts).toHaveLength(2);
      expect(verdicts.every((entry) => f.engine.s.profiles.find((profile) => profile.id === entry.profileId)?.toolId === "codex")).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

  it("restores the full planned review when an older saved port has no proof of completed feature review", async () => {
    const f = await fixture({ controlled: true }, 3);
    try {
      await f.advance(f.delivery);
      writeFileSync(join(f.repo, "greeting.txt"), "Hi from main\n");
      await git(f.repo, "add", "greeting.txt");
      await git(f.repo, "commit", "-q", "-m", "A greeting on main");
      f.engine.approve(f.engine.getState().inbox.find((item) => item.kind === "delivery")!.id);
      await f.advance(() => f.fakes.received("code reviewer").some((entry) => entry.text.includes("Review only the port")), (role) => role !== "code reviewer");
      // Older releases saved this mark even for an unreviewed feature. A restart must not trust it.
      f.engine.setPoolPaused(true);
      const saved = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      delete executionFor(saved).work.reviewedTree;
      // Even a report already saved under that narrower scope cannot replace an ordinary review.
      const key = Object.keys(saved.hunt!.profiles!)[0]!;
      saved.hunt!.reported[key] = true;
      const before = f.fakes.received("code reviewer").length;
      await f.restart();
      f.engine.setPoolPaused(false);
      await f.advance(f.delivery);
      const reviews = f.fakes.received("code reviewer").slice(before);
      expect(reviews).toHaveLength(2);
      for (const review of reviews) {
        expect(review.text).not.toContain("Review only the port");
        expect(review.text).toContain(`git diff ${f.task().baseSha}...HEAD`);
      }
      expect(f.task().portReview).toBeUndefined();
      expect(f.task().reviewedTree).toBe(await git(f.task().worktree!, "rev-parse", "HEAD^{tree}"));
    } finally { await f.engine.shutdown(); }
  });

  for (const reopen of ["resume", "load"] as const) for (const legacy of [true, false]) {
    it(`${legacy ? "replaces a legacy port conversation with full instructions" : "keeps a genuine port conversation"} for a single reviewer after ${reopen}`, async () => {
      const f = await fixture({ planner: "short", controlled: true, reopen }, 1);
      try {
        await f.advance(f.delivery);
        expect(f.fakes.openings("code reviewer")).toHaveLength(1);
        writeFileSync(join(f.repo, "greeting.txt"), "Hi from main\n");
        await git(f.repo, "add", "greeting.txt");
        await git(f.repo, "commit", "-q", "-m", "A greeting on main");
        f.engine.approve(f.engine.getState().inbox.find((item) => item.kind === "delivery")!.id);
        await f.advance(() => f.fakes.received("code reviewer").length === 2 && !!f.task().conversation?.briefed, (role) => role !== "code reviewer");
        const port = f.fakes.received("code reviewer").at(-1)!;
        expect(port.text).toContain("Review only the port");
        expect(f.task().plan!.stages.find((stage) => stage.kind === "review-chain")!.profileIds).toHaveLength(1);
        f.engine.setPoolPaused(true);
        const saved = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
        expect(executionFor(saved).work.conversation?.sessionId).toBe(port.session);
        if (legacy) delete executionFor(saved).work.reviewedTree;
        f.engine.sendMessage(f.task().id, "Check the welcome page too.");
        await f.restart();
        f.engine.setPoolPaused(false);
        if (legacy) {
          await f.advance(() => f.fakes.received("code reviewer").length > 2 && !!f.task().conversation?.briefed, (role) => role !== "code reviewer");
          expect(f.task().reviewedTree).toBeUndefined();
        }
        await f.advance(f.delivery);
        const after = f.fakes.received("code reviewer").slice(2);
        expect(after).toHaveLength(1);
        expect(after.map((entry) => entry.text).join("\n")).toContain("Check the welcome page too.");
        if (legacy) {
          expect(after[0]!.session).not.toBe(port.session);
          expect(after[0]!.text).not.toContain("Review only the port");
          expect(after[0]!.text).toContain(`git diff ${f.task().baseSha}...HEAD`);
          expect(after[0]!.text).toContain("Check every acceptance item");
        } else {
          expect(after[0]!.session).toBe(port.session);
          expect(after[0]!.text).toContain("Petrina restarted");
        }
        expect(f.task().reviewedTree).toBe(await git(f.task().worktree!, "rev-parse", "HEAD^{tree}"));
      } finally { await f.engine.shutdown(); }
    });
  }

  for (const status of ["ready", "logged-out", "unknown"] as const) it(`keeps review replacements within the checked tools when Grok is ${status}`, async () => {
    const f = await fixture({ controlled: true, limited: [{ model: "opus", role: "code reviewer", spendCap: true }] }, 1, ["sol-high", "opus-high"]);
    try {
      // Keep the saved plan, then apply newer login checks before its reviewers work.
      await f.advance(() => f.fakes.received("builder").length === 1, (role) => role !== "builder");
      f.engine.s.setup!.checks = [
        { id: "claude-code", status: "ready" },
        { id: "codex", status: "ready" },
        { id: "grok", status },
      ];
      await f.advance(f.delivery);
      const verdicts = f.engine.tracking.log.moments({ taskId: f.task().id, kinds: ["verdict"] });
      expect(verdicts.map((entry) => entry.profileId)).toEqual(["sol-high", status === "ready" ? "grok-high" : "sol-high"]);
      expect(f.models("code reviewer").includes("grok-4.7")).toBe(status === "ready");
    } finally { await f.engine.shutdown(); }
  });
});

/** Let the reviewers start, then change availability before any fresh voter starts. */
async function voting(scenario: Scenario = {}, limit = 3, limited = ["claude-code"], antigravity = false) {
  const f = await fixture({ controlled: true, reviewer: "important", ...scenario }, limit, undefined, undefined, true, antigravity);
  try {
    await f.advance(() => f.fakes.received("code reviewer").length >= (limit > 1 ? 2 : 1), (role) => role !== "code reviewer");
    f.engine.s.pool.limited = limited.map((toolId) => ({ toolId, until: Date.now() + 3_600_000, reason: `${toolId}'s usage limit` }));
    return f;
  } catch (error) { await f.engine.shutdown(); throw error; }
}

const checkedFinding = (f: Awaited<ReturnType<typeof voting>>) => f.task().findings.find((finding) => finding.text === "The greeting is missing on the welcome page.")!;
/** What each tool answered, without the ballot details every new answer records. */
const plain = (votes?: readonly Vote[]) => votes?.map(({ ballot: _ballot, ...vote }) => vote);
const verifierSteps = (f: Awaited<ReturnType<typeof voting>>) => f.task().journey!.filter((step) => step.roleId === "verifier");
/** task-59268's dissent: Codex reported it; Claude and Grok called it a nit, Codex and Antigravity real. */
const HISTORICAL = "task-59268-65829";
const historical = { [HISTORICAL]: { opus: "nit", "grok-4.7": "nit", "gpt-6.1-sol": "real", "gemini-4-argon": "real" } } as const;
const inject = (f: Awaited<ReturnType<typeof voting>>, id: string, raisedBy: string, text = "The second greeting is missing.") =>
  f.engine.s.tasks.find((entry) => entry.id === f.task().id)!.findings.push({ id, text, severity: "blocking", raisedBy, confirmedBy: [], status: "open", evidence: "Opened the second page" });

describe.concurrent("bounded verifier panels", () => {
  it("starts two fresh verifiers instead of one per ready tool, avoiding the reporting tool", async () => {
    const f = await fixture({ reviewer: "important" }, 4, undefined, undefined, true, true);
    try {
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      expect(new Set(independentVotes(finding.votes).map((vote) => vote.toolId))).toEqual(new Set(["codex", "grok"]));
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      expect(finding.status).toBe("fixed");
      const steps = verifierSteps(f);
      expect(steps).toHaveLength(1);
      expect(steps[0]!.seats).toEqual(["verifier:sol-high", "verifier:grok-high"]);
      expect(steps[0]!.agentInputs).toHaveLength(2);
      for (const input of steps[0]!.agentInputs!) expect(input.selectionReason).toContain("usable at selection: Claude Code, Codex, Grok and Antigravity; avoided Claude Code, which reported a finding");
      expect(f.task().timeline.some((entry) => entry.text.startsWith("Verifiers: ") && entry.text.includes("usable at selection: Claude Code, Codex, Grok and Antigravity"))).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

  it("settles with the two usable tools when two of four registered tools are already out of usage", async () => {
    const f = await voting({ verifier: "not-a-bug" }, 3, ["claude-code", "grok"], true);
    try {
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      expect(new Set(plain(finding.votes)!.map((vote) => vote.toolId))).toEqual(new Set(["codex", "antigravity"]));
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      // The two tools out of usage at selection never became required tie-breakers.
      expect(finding.status).toBe("dismissed");
      expect(finding.verification?.verdict).toBe("not-a-bug");
      expect(verifierSteps(f)).toHaveLength(1);
      expect(verifierSteps(f)[0]!.agentInputs![0]!.selectionReason).toContain("usable at selection: Codex and Antigravity");
      expect(f.fakes.openings("builder")).toHaveLength(1);
    } finally { await f.engine.shutdown(); }
  });

  it("keeps a tool near its usage limit eligible for the pair", async () => {
    const f = await voting({}, 3, []);
    try {
      f.engine.s.pool.usage = [{ toolId: "grok", kind: "five_hour", status: "allowed", utilization: 0.95, resetsAt: Date.now() + 3_600_000, at: Date.now() }];
      await f.advance(f.delivery);
      expect(new Set(plain(checkedFinding(f).votes)!.map((vote) => vote.toolId))).toEqual(new Set(["codex", "grok"]));
      expect(f.fakes.openings("verifier")).toHaveLength(2);
    } finally { await f.engine.shutdown(); }
  });

  for (const third of ["real", "nit"] as const) it(`asks the usable unasked tool for a third answer when both first answers do not block, which then says ${third}`, async () => {
    const f = await voting({ verifierByModel: { "gpt-6.1-sol": "nit", "grok-4.7": "nit", opus: third } }, 3, []);
    try {
      await f.advance(() => f.delivery() || f.fakes.openings("builder").length === 2, (role) => role !== "builder");
      const finding = checkedFinding(f);
      expect(f.models("verifier")).toEqual(expect.arrayContaining(["gpt-6.1-sol", "grok-4.7", "opus"]));
      expect(f.fakes.openings("verifier")).toHaveLength(3);
      const [first, second] = verifierSteps(f);
      expect(first).toMatchObject({ outcome: "1 checked: 0 must be fixed in this change, 1 awaiting a third answer", reason: "1 finding to check on a third tool" });
      expect(first!.result?.findingsSettled).toBeUndefined();
      expect(first!.result?.findings?.find(copy => copy.id === finding.id)?.verification).toBeUndefined();
      expect(second!.result?.findingsSettled).toBe(true);
      expect(second!.result?.findings?.find(copy => copy.id === finding.id)?.verification?.verdict).toBe(third);
      expect(f.task().timeline.some(entry => entry.step === second!.id && entry.text === second!.outcome)).toBe(true);
      expect(second!.seats).toEqual(["verifier:third:opus-high"]);
      expect(second!.agentInputs![0]!.selectionReason).toContain("Third answer: both first verifiers said this finding does not block");
      expect(plain(finding.votes)!.find((vote) => vote.toolId === "claude-code")).toEqual({ by: "opus-high", toolId: "claude-code", plannedProfileId: "opus-high", verdict: third, reason: expect.any(String) });
      expect(finding.votes!.find((vote) => vote.toolId === "claude-code")!.ballot!.seat).toBe("third:opus-high");
      if (third === "real") {
        expect(finding.verification?.verdict).toBe("real");
        expect(finding.verification?.reason).toContain("Disputed: ");
        expect(second!.outcome).toBe("1 checked: 1 must be fixed in this change (1 disputed)");
        expect(f.task().fixing).toBe(true);
      } else {
        // Three answers settle it; no fourth is asked.
        expect(finding.verification?.verdict).toBe("nit");
        expect(finding.severity).toBe("suggestion");
        expect(second!.outcome).toBe("1 checked: none to fix now, 1 minor");
      }
      await f.advance(f.delivery);
      expect(f.fakes.openings("verifier")).toHaveLength(3);
    } finally { await f.engine.shutdown(); }
  });

  for (const antigravity of [true, false]) it(`keeps ${HISTORICAL} Important after Claude and Grok call it a nit, with ${antigravity ? "Antigravity" : "Codex"} as the third tool`, async () => {
    const f = await voting({ reviewer: undefined, verifierByFinding: historical }, 4, [], antigravity);
    try {
      inject(f, HISTORICAL, "sol-high");
      await f.advance(() => f.delivery() || f.fakes.openings("builder").length === 2, (role) => role !== "builder");
      const finding = f.task().findings.find((entry) => entry.id === HISTORICAL)!;
      const steps = verifierSteps(f);
      expect(steps.map((step) => step.seats)).toEqual([["verifier:opus-high", "verifier:grok-high"], [antigravity ? "verifier:third:argon-high" : "verifier:third:sol-high"]]);
      expect(new Set(plain(finding.votes)!.map((vote) => `${vote.toolId}:${vote.verdict}`))).toEqual(new Set(["claude-code:nit", "grok:nit", antigravity ? "antigravity:real" : "codex:real"]));
      expect(finding.verification?.verdict).toBe("real");
      expect(finding.severity).toBe("blocking");
      expect(f.fakes.openings("verifier")).toHaveLength(3);
      expect(f.task().fixing).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

  it("asks no third tool when an initial answer is already real", async () => {
    const f = await voting({ reviewer: undefined, verifierByFinding: { [HISTORICAL]: { opus: "nit", "grok-4.7": "real" } } }, 4, [], true);
    try {
      inject(f, HISTORICAL, "sol-high");
      await f.advance(() => f.delivery() || f.fakes.openings("builder").length === 2, (role) => role !== "builder");
      const finding = f.task().findings.find((entry) => entry.id === HISTORICAL)!;
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      expect(verifierSteps(f)).toHaveLength(1);
      expect(verifierSteps(f)[0]!.outcome).toBe("1 checked: 1 must be fixed in this change (1 disputed)");
      expect(finding.verification).toMatchObject({ verdict: "real", by: "grok-high" });
      expect(finding.verification!.reason).toContain("answered only a nit");
    } finally { await f.engine.shutdown(); }
  });

  it("targets a mixed batch's third answer at the unsettled finding only", async () => {
    const f = await voting({ verifierByFinding: { second: { "gpt-6.1-sol": "nit", "grok-4.7": "nit", opus: "not-a-bug" } } }, 3, []);
    try {
      inject(f, "second", "opus-high");
      await f.advance(() => f.delivery() || f.fakes.openings("builder").length === 2, (role) => role !== "builder");
      const main = checkedFinding(f), second = f.task().findings.find((entry) => entry.id === "second")!;
      const openings = f.fakes.openings("verifier");
      expect(openings).toHaveLength(3);
      const third = openings.find((text) => f.fakes.received("verifier").find((entry) => entry.text === text && f.model(entry.session) === "opus"))!;
      const ballot = third.slice(third.indexOf("## Important findings to check"));
      expect(ballot).toContain("- [second]");
      expect(ballot).not.toContain(`- [${main.id}]`);
      expect(plain(main.votes)!.map((vote) => vote.toolId).sort()).toEqual(["codex", "grok"]);
      expect(main.verification?.verdict).toBe("real");
      expect(second.verification?.verdict).toBe("nit");
      expect(second.severity).toBe("suggestion");
      expect(verifierSteps(f)[1]!.outcome).toBe("2 checked: 1 must be fixed in this change, 1 minor");
    } finally { await f.engine.shutdown(); }
  });

  it("leaves a finding unresolved when no ready tool can give its third answer, and never repeats that ballot", async () => {
    const f = await voting({ verifier: "not-a-bug", answer: { fixed: false, text: "It is not broken." }, reviewRounds: 2 }, 3, []);
    try {
      await f.advance(() => f.fakes.received("verifier").length === 2, (role) => role !== "verifier");
      // Claude Code signs out after selection: it was usable, but cannot give the required third answer.
      f.engine.s.setup!.checks = [{ id: "claude-code", status: "logged-out" }, { id: "codex", status: "ready" }, { id: "grok", status: "ready" }];
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      expect(finding.verification).toBeUndefined();
      expect(finding.unresolved?.reason).toContain("no ready independent tool can give the required third answer");
      // The reviewed commit and its tree, so a later round compares like with like.
      expect(Object.values(finding.unresolved?.heads ?? {})).toHaveLength(1);
      expect(Object.values(finding.unresolved?.trees ?? {})).toHaveLength(1);
      expect(finding.severity).toBe("blocking");
      expect(finding.status).toBe("open");
      expect(verifierSteps(f).map((step) => step.outcome)).toEqual(["1 checked: 1 unresolved"]);
      const { answer: laterAnswer, ...reviewed } = finding;
      expect(laterAnswer).toEqual({ fixed: false, text: "It is not broken.", at: expect.any(Number) });
      expect(verifierSteps(f)[0]!.result).toEqual({ findings: [reviewed], findingsSettled: true });
      expect(f.task().timeline.some((entry) => entry.text.startsWith("Review rounds used up"))).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

  for (const limit of [1, 3]) it(`does not turn Claude's lost place into a second Codex vote with ${limit} pool slots`, async () => {
    const f = await voting({ verifierByModel: { "gpt-6.1-sol": "not-a-bug", "grok-4.7": "real" } }, limit);
    const violations: unknown[] = [];
    const unsub = f.engine.subscribe(() => {
      const uses = slotUses(f.engine.getState());
      if (uses.length > limit || ["claude-code", "codex", "grok"].some((tool) => uses.filter((use) => use.toolId === tool).length > 1)) violations.push(uses);
    });
    try {
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      expect(new Set(f.models("verifier"))).toEqual(new Set(["gpt-6.1-sol", "grok-4.7"]));
      expect(finding.votes).toHaveLength(2);
      expect(new Set(finding.votes!.map((vote) => vote.toolId))).toEqual(new Set(["codex", "grok"]));
      for (const vote of finding.votes!) expect(f.engine.profile(vote.by)?.toolId).toBe(vote.toolId);
      // Any real answer keeps it Important. The old duplicate Codex vote would incorrectly dismiss this finding.
      expect(finding.verification?.verdict).toBe("real");
      expect(finding.status).toBe("fixed");
      expect(violations).toEqual([]);
    } finally { unsub(); await f.engine.shutdown(); }
  });

  it("uses one truthful fresh vote when only Codex remains", async () => {
    const f = await voting({ verifier: "not-a-bug" }, 3, ["claude-code", "grok"]);
    try {
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      expect(f.fakes.openings("verifier")).toHaveLength(1);
      expect(plain(finding.votes)).toEqual([{ by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "not-a-bug", reason: "The welcome page shows the greeting already." }]);
      expect(finding.verification?.by).toBe("sol-high");
      expect(finding.status).toBe("dismissed");
      expect(f.fakes.openings("builder")).toHaveLength(1);
      expect(verifierSteps(f)[0]!.outcome).toBe("1 checked by one tool: none to fix now, 1 not a bug");
      expect(f.task().timeline.some((entry) => entry.text === "1 checked by one tool: none to fix now, 1 not a bug")).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

  it("keeps the existing mildest-verdict tie rule on an exhaustive pair", async () => {
    const f = await voting({ verifierByModel: { "gpt-6.1-sol": "pre-existing", "grok-4.7": "nit" } });
    try {
      await f.advance(f.delivery);
      expect(checkedFinding(f).verification?.verdict).toBe("nit");
      expect(checkedFinding(f).severity).toBe("suggestion");
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      expect(f.fakes.openings("builder")).toHaveLength(1);
    } finally { await f.engine.shutdown(); }
  });

  for (const modelOnly of [false, true]) it(`retains a selected seat whose ${modelOnly ? "model" : "tool"} is limited after its peer finishes, without borrowing the peer's vote`, async () => {
    // Grok is out before selection, so the pair is Codex and Claude Code with no independent replacement.
    const f = await voting({ limited: [{ model: "opus", role: "verifier", ...(modelOnly ? { type: "seven_day_opus" } : { spendCap: true }) }] }, 3, ["grok"]);
    try {
      if (!modelOnly) {
        await f.advance(() => f.delivery() || (checkedFinding(f)?.votes?.length === 1 && f.task().state === "waiting" && f.fakes.received("verifier").length === 2));
        expect(f.delivery()).toBe(false);
        expect(checkedFinding(f).verification).toBeUndefined();
        expect(f.task().hunt?.panel?.seats.map((seat) => seat.toolId)).toEqual(["codex", "claude-code"]);
        expect(f.task().hunt?.panel?.usable).toEqual(["claude-code", "codex"]);
        const accepted = structuredClone(checkedFinding(f).votes!);
        await f.restart();
        expect(checkedFinding(f).votes).toEqual(accepted);
        expect(checkedFinding(f).verification).toBeUndefined();
        f.fakes.scenario({ controlled: true, builder: "plain", reviewer: "important" });
        for (const limit of f.engine.s.pool.limited ?? []) if (limit.toolId === "claude-code") limit.until = Date.now() - 1;
        for (const report of f.engine.s.pool.usage ?? []) if (report.toolId === "claude-code") report.resetsAt = Date.now() - 1;
        f.engine.schedule();
      }
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      const finished = f.engine.tracking.log.turns({ taskId: f.task().id }).filter((turn) => turn.roleId === "verifier" && turn.end === "finished");
      expect(finished).toHaveLength(2);
      expect(new Set(finished.map((turn) => turn.toolId)).size).toBe(finished.length);
      expect(finding.votes).toHaveLength(finished.length);
      expect(finding.votes?.some((vote) => vote.by === "opus-high")).toBe(!modelOnly);
      if (modelOnly) expect(finding.votes?.find((vote) => vote.toolId === "claude-code")?.by).toBe("sonnet-high");
      expect(finding.verification?.verdict).toBe("real");
    } finally { await f.engine.shutdown(); }
  });

  it("replaces a selected seat limited after its peer finishes with an independent usable tool", async () => {
    const f = await voting({ limited: [{ model: "grok-4.7", role: "verifier", spendCap: true }] }, 3, []);
    try {
      await f.advance(f.delivery);
      const finding = checkedFinding(f);
      expect(new Set(plain(finding.votes)!.map((vote) => vote.toolId))).toEqual(new Set(["codex", "claude-code"]));
      expect(finding.votes!.find((vote) => vote.toolId === "claude-code")!.ballot!.seat).toBe("grok-high");
      const replacement = f.task().journey!.flatMap((step) => step.agentInputs ?? []).find((input) => input.selectionReason?.includes("takes its required seat"));
      expect(replacement?.profileId).toBe("opus-high");
      expect(finding.verification?.verdict).toBe("real");
    } finally { await f.engine.shutdown(); }
  });

  it("waits for a capped tool instead of duplicating its partner", async () => {
    const f = await voting();
    // A local stand-in for a different task holding Grok's one seat.
    const occupied = { ...structuredClone(f.engine.s.tasks.find((entry) => entry.id === f.task().id)!), id: "occupied", state: "paused" as const, holdsSlot: true, helpers: [], agent: { roleId: "builder", profileId: "grok-high", since: Date.now(), step: 0 } };
    f.engine.s.tasks.push(occupied);
    try {
      await f.advance(() => checkedFinding(f)?.votes?.length === 1 && f.task().state === "waiting");
      expect(f.models("verifier")).toEqual(["gpt-6.1-sol"]);
      // A full slot is not a usage block: Grok keeps its saved place.
      expect(f.task().hunt?.panel?.usable).toEqual(["codex", "grok"]);
      expect(f.task().hunt?.panel?.seats.map((seat) => seat.toolId)).toEqual(["codex", "grok"]);
      expect(checkedFinding(f).verification).toBeUndefined();
      expect(f.delivery()).toBe(false);
      f.engine.s.tasks = f.engine.s.tasks.filter((entry) => entry.id !== occupied.id);
      f.engine.schedule();
      await f.advance(f.delivery);
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      expect(new Set(checkedFinding(f).votes?.map((vote) => vote.toolId))).toEqual(new Set(["codex", "grok"]));
    } finally { await f.engine.shutdown(); }
  });

  it("retains a finished tool's vote across restart while its partner is unfinished", async () => {
    const f = await voting({ verifier: "not-a-bug" });
    try {
      await f.advance(() => checkedFinding(f)?.votes?.length === 1, (role, session) => role !== "verifier" || f.model(session) === "gpt-6.1-sol");
      const saved = structuredClone(checkedFinding(f).votes![0]!);
      await f.restart();
      await f.advance(f.delivery);
      expect(f.fakes.received("verifier").filter((entry) => f.model(entry.session) === "gpt-6.1-sol")).toHaveLength(1);
      expect(checkedFinding(f).votes?.find((vote) => vote.toolId === "codex")).toEqual(saved);
      expect(checkedFinding(f).votes).toHaveLength(2);
      expect(checkedFinding(f).status).toBe("dismissed");
    } finally { await f.engine.shutdown(); }
  });

  it("keeps the first pair's answers and its third place through a pause and a restart", async () => {
    const f = await voting({ verifier: "not-a-bug" }, 3, []);
    try {
      await f.advance(() => f.fakes.received("verifier").length === 2, (role) => role !== "verifier");
      // Pausing admits no new conversation: the pair finishes, and the third answer waits for resume.
      f.engine.setPoolPaused(true);
      for (const entry of f.fakes.received("verifier")) f.release(entry.session);
      await waitFor(() => independentVotes(checkedFinding(f).votes).length === 2 && !f.engine.drivers.has(f.task().id), "the first pair's answers");
      expect(f.fakes.received("verifier")).toHaveLength(2);
      expect(f.task().hunt?.panel?.seats).toHaveLength(2);
      f.engine.setPoolPaused(false);
      await f.advance(() => f.fakes.received("verifier").length === 3, (role) => role !== "verifier");
      const saved = f.task().hunt!.panel!;
      expect(saved.seats.map((seat) => seat.key)).toEqual(["sol-high", "grok-high", "third:opus-high"]);
      expect(saved.escalatedAt).toBeDefined();
      await f.restart();
      expect(f.task().hunt?.panel).toEqual(saved);
      await f.advance(f.delivery);
      const received = f.fakes.received("verifier");
      expect(received.filter((entry) => f.model(entry.session) === "gpt-6.1-sol")).toHaveLength(1);
      expect(received.filter((entry) => f.model(entry.session) === "grok-4.7")).toHaveLength(1);
      expect(new Set(received.filter((entry) => f.model(entry.session) === "opus").map((entry) => entry.session)).size).toBe(2);
      expect(checkedFinding(f).verification?.verdict).toBe("not-a-bug");
      expect(independentVotes(checkedFinding(f).votes)).toHaveLength(3);
    } finally { await f.engine.shutdown(); }
  });

  it("stops owned verifier work when the task is cancelled mid-vote, and admits no third answer", async () => {
    const f = await voting({ verifier: "not-a-bug" }, 3, []);
    try {
      await f.advance(() => f.fakes.received("verifier").length === 2, (role) => role !== "verifier");
      f.engine.cancel(f.task().id);
      await waitFor(() => f.task().state === "cancelled" && !f.engine.drivers.has(f.task().id) && !f.engine.settling.has(f.task().id), "the cancelled vote to stop");
      expect(slotUses(f.engine.getState()).filter((use) => use.taskId === f.task().id)).toEqual([]);
      f.engine.schedule();
      expect(f.fakes.received("verifier")).toHaveLength(2);
      expect(checkedFinding(f).verification).toBeUndefined();
      expect(verifierSteps(f).every((step) => step.endedAt !== undefined)).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

  it("saves partial reports before repair and restarts only the missing verdicts", async () => {
    const f = await voting({ partialVerification: true, verifier: "not-a-bug" }, 1, ["claude-code", "grok"]);
    try {
      inject(f, "second", "opus-high");
      await f.advance(() => f.fakes.marked("partial-verification"));
      const partial = structuredClone(f.task().findings.find((finding) => finding.votes?.length)!);
      expect(partial.votes).toHaveLength(1);
      expect(f.delivery()).toBe(false);
      f.fakes.scenario({ controlled: true, builder: "plain", reviewer: "important", verifier: "not-a-bug" });
      await f.restart();
      await f.advance(f.delivery);
      const opening = f.fakes.openings("verifier").at(-1)!;
      expect(opening.slice(opening.indexOf("## Important findings to check"))).not.toContain(`- [${partial.id}]`);
      expect(f.task().findings.find((finding) => finding.id === partial.id)?.votes).toEqual(partial.votes);
      expect(f.task().findings.filter((finding) => finding.votes?.length).every((finding) => finding.votes?.length === 1 && finding.status === "dismissed")).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

  it("keeps a voter's starting role and partial work when its model changes before restart", async () => {
    const f = await voting({ partialVerification: true, verifier: "not-a-bug" }, 3, ["codex", "grok"]);
    try {
      inject(f, "second", "opus-high");
      await f.advance(() => f.fakes.marked("partial-verification"));
      const partial = structuredClone(f.task().findings.find((finding) => finding.votes?.length)!);
      const original = f.engine.role("verifier")!;
      f.engine.saveRole(original.id, { ...draftOf(original), purpose: "Use the new voting instructions next round.", instructions: `${original.instructions}\nNew wording for the next voting round.` });
      f.engine.s.pool.limited!.push({ toolId: "claude-code", model: "opus", until: Date.now() + 3_600_000, reason: "Claude Code's weekly Opus limit" });
      f.fakes.scenario({ controlled: true, builder: "plain", reviewer: "important", verifier: "not-a-bug" });
      await f.restart();
      await f.advance(f.delivery);
      expect(f.models("verifier")).toEqual(["opus", "sonnet"]);
      const opening = f.fakes.openings("verifier").at(-1)!;
      expect(opening).toContain(`Your role: ${original.purpose}`);
      expect(opening).not.toContain("New wording for the next voting round.");
      expect(opening).not.toContain("Use the new voting instructions next round.");
      expect(opening.slice(opening.indexOf("## Important findings to check"))).not.toContain(`- [${partial.id}]`);
      expect(f.task().findings.find((finding) => finding.id === partial.id)?.votes).toEqual(partial.votes);
      const remaining = f.task().findings.find((finding) => finding.id !== partial.id && finding.votes?.length)!;
      expect(plain(remaining.votes)).toEqual([{ by: "sonnet-high", toolId: "claude-code", plannedProfileId: "opus-high", verdict: "not-a-bug", reason: "The welcome page shows the greeting already." }]);
      expect(f.engine.role("verifier")?.purpose).toBe("Use the new voting instructions next round.");
    } finally { await f.engine.shutdown(); }
  });

  for (const [initial, corrected, restart] of [
    ["not-a-bug", "real", false],
    ["real", "not-a-bug", false],
    ["not-a-bug", "real", true],
  ] as const) it(`counts a corrected ${corrected} verdict after an incomplete ${initial} answer${restart ? ", retaining it through restart" : ""}`, async () => {
    const f = await voting({ partialVerification: true, verifier: initial, correctPartialVerification: corrected }, 3, restart ? ["claude-code"] : ["claude-code", "grok"]);
    try {
      // First on the ballot: its initial verdict must be revised by the completed answer.
      inject(f, "second", "opus-high");
      let saved;
      if (restart) {
        await f.advance(() => !!f.task().hunt?.voted?.["sol-high"], (role, session) => role !== "verifier" || f.model(session) === "gpt-6.1-sol");
        saved = structuredClone(f.task().findings.find((finding) => finding.id === "second")!.votes);
        expect(f.delivery()).toBe(false);
        expect(f.task().findings.every((finding) => !finding.verification)).toBe(true);
        f.fakes.scenario({ controlled: true, builder: "plain", reviewer: "important", verifier: "not-a-bug" });
        await f.restart();
      }
      // Hold a fix until we have checked whether the corrected ballot sends the work back.
      await f.advance(() => f.delivery() || f.fakes.openings("builder").length === 2, (role) => role !== "builder");
      const finding = f.task().findings.find((entry) => entry.id === "second")!;
      const votes = independentVotes(finding.votes);
      const reason = `After checking every finding, this one ${corrected === "real" ? "is a real problem" : "is not a bug"}.`;
      expect(finding.verification?.verdict).toBe(corrected);
      expect(plain(votes)!.find((vote) => vote.toolId === "codex")).toEqual({ by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: corrected, reason });
      expect(votes).toHaveLength(restart ? 2 : 1);
      expect(plain(finding.votes?.filter((vote) => vote.toolId === "codex"))).toEqual([
        { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: initial, reason: initial === "real" ? "The welcome page has no greeting: confirmed by opening it." : "The welcome page shows the greeting already." },
        { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: corrected, reason },
      ]);
      if (saved) expect(finding.votes?.filter((vote) => vote.toolId === "codex")).toEqual([...saved]);
      expect(f.fakes.received("verifier").filter((entry) => f.model(entry.session) === "gpt-6.1-sol")).toHaveLength(2);
      if (corrected === "real") {
        expect(f.delivery()).toBe(false);
        expect(finding.status).toBe("open");
        expect(f.task().fixing).toBe(true);
      } else {
        expect(finding.status).toBe("dismissed");
        expect(f.fakes.openings("builder")).toHaveLength(1);
      }
      await f.advance(f.delivery);
    } finally { await f.engine.shutdown(); }
  });

  it("keeps unknown legacy reasons without counting their nominal profiles as actual tools", async () => {
    const f = await voting({ verifier: "not-a-bug" });
    try {
      await f.advance(() => checkedFinding(f) !== undefined, (role) => role !== "verifier");
      const task = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      const finding = task.findings.find((finding) => finding.id === checkedFinding(f).id)!;
      const legacy = { by: "opus-high", verdict: "real" as const, reason: "An older recorded reason with no proven actual identity." };
      finding.votes = [legacy];
      task.hunt!.voted = { "opus-high": true };
      await f.advance(f.delivery);
      expect(checkedFinding(f).votes).toContainEqual(legacy);
      expect(checkedFinding(f).votes?.filter((vote) => vote.toolId)).toHaveLength(2);
      expect(checkedFinding(f).verification?.verdict).toBe("not-a-bug");
      expect(legacy).not.toHaveProperty("toolId");
    } finally { await f.engine.shutdown(); }
  });

  it("keeps partial votes through a usage limit and waits until every finding has a verdict", async () => {
    const f = await voting({ partialVerification: true, limitAfterPartial: true, verifier: "not-a-bug" }, 3, ["claude-code", "grok"]);
    try {
      inject(f, "second", "opus-high");
      await f.advance(() => f.task().state === "waiting" && f.task().statusLine.startsWith("Waiting for usage") && f.fakes.received("verifier").length === 2);
      const partial = structuredClone(f.task().findings.find((finding) => finding.votes?.length)!);
      expect(partial.votes).toHaveLength(1);
      expect(f.task().findings.every((finding) => !finding.verification)).toBe(true);
      expect(f.delivery()).toBe(false);
      f.fakes.scenario({ controlled: true, builder: "plain", reviewer: "important", verifier: "not-a-bug" });
      f.engine.s.pool.limited = f.engine.s.pool.limited!.filter((limit) => limit.toolId !== "grok");
      f.engine.schedule();
      await f.advance(f.delivery);
      expect(f.task().findings.find((finding) => finding.id === partial.id)?.votes).toContainEqual(partial.votes![0]);
      const replacement = f.task().journey!.flatMap(step => step.agentInputs ?? []).find(input => input.selectionReason?.includes("takes its required seat"));
      expect(replacement?.selectionReason).toContain("saved votes remain");
      expect(replacement?.profileId).toBe("grok-high");
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      // The replacement answered only what its place still owed, under the same place.
      const replacementOpening = f.fakes.openings("verifier").at(-1)!;
      expect(replacementOpening.slice(replacementOpening.indexOf("## Important findings to check"))).not.toContain(`- [${partial.id}]`);
      expect(f.task().findings.filter((finding) => finding.votes?.length).every((finding) => finding.status === "dismissed" && finding.votes!.every((vote) => vote.ballot?.seat === "sol-high"))).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

  it("keeps an older round's admitted one-per-tool panel and its majority rule until it finishes", async () => {
    const f = await voting({ verifierByModel: { "grok-4.7": "nit", "gemini-4-argon": "nit" } }, 4, [], true);
    try {
      // Pausing lets the admitted reviewers finish and admits no voter, so no bounded panel is saved yet.
      f.engine.setPoolPaused(true);
      await f.advance(() => Object.keys(f.task().hunt?.reported ?? {}).length === 2 && !f.engine.drivers.has(f.task().id) && !f.engine.settling.has(f.task().id));
      const task = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      expect(task.hunt!.panel).toBeUndefined();
      // An earlier release saved one voter per ready tool and two of their answers.
      task.hunt!.voterProfiles = ["opus-high", "sol-high", "grok-high", "argon-high"];
      task.findings.find((entry) => entry.text === "The greeting is missing on the welcome page.")!.votes = [
        { by: "opus-high", toolId: "claude-code", plannedProfileId: "opus-high", verdict: "real", reason: "An older ballot's real answer." },
        { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "nit", reason: "An older ballot's nit answer." },
      ];
      await f.restart();
      f.engine.setPoolPaused(false);
      await f.advance(f.delivery);
      expect(new Set(f.models("verifier"))).toEqual(new Set(["grok-4.7", "gemini-4-argon"]));
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      // One real answer of four does not reach that panel's half; a bounded panel would have kept it Important.
      expect(checkedFinding(f).verification?.verdict).toBe("nit");
      expect(independentVotes(checkedFinding(f).votes)).toHaveLength(4);
    } finally { await f.engine.shutdown(); }
  });

  it("waits with no usable voter and resumes on the one tool that recovers", async () => {
    const f = await voting({ verifier: "not-a-bug" }, 3, ["claude-code", "codex", "grok"]);
    try {
      await f.advance(() => Object.keys(f.task().hunt?.reported ?? {}).length === 2 && f.task().state === "waiting");
      expect(f.fakes.openings("verifier")).toHaveLength(0);
      // Nothing is saved as a completed or empty panel while nobody can vote.
      expect(f.task().hunt?.panel).toBeUndefined();
      expect(checkedFinding(f).verification).toBeUndefined();
      expect(f.delivery()).toBe(false);
      f.engine.s.pool.limited = f.engine.s.pool.limited!.filter((limit) => limit.toolId !== "codex");
      f.engine.schedule();
      await f.advance(f.delivery);
      expect(f.fakes.openings("verifier")).toHaveLength(1);
      expect(checkedFinding(f).votes?.map((vote) => vote.toolId)).toEqual(["codex"]);
    } finally { await f.engine.shutdown(); }
  });

  for (const proven of [true, false]) it(`${proven ? "counts this ballot's saved answers before choosing more work" : "keeps answers of unproven provenance as history"} when no panel was saved`, async () => {
    const f = await voting({ verifier: "not-a-bug" }, 3, ["claude-code", "codex", "grok"]);
    try {
      inject(f, "second", "opus-high");
      const task = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      await f.advance(() => Object.keys(f.task().hunt?.reported ?? {}).length === 2 && f.task().state === "waiting");
      const findings = task.findings.filter((finding) => finding.severity === "blocking");
      const hunt = task.hunt!;
      const provenance = (seat: string) => (proven ? { ballot: { stageId: hunt.stageId, round: hunt.round, seat, versions: { ...hunt.input!.heads } } } : {});
      const first = { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "not-a-bug" as const, reason: "Codex's finished verdict before its limit.", ...provenance("sol-high") };
      const second = { by: "grok-xhigh", toolId: "grok", plannedProfileId: "grok-high", verdict: "not-a-bug" as const, reason: "Grok's finished verdict before its limit.", ...provenance("grok-high") };
      findings[0]!.votes = [first];
      findings[1]!.votes = [second];
      await f.restart();
      await f.advance(() => f.task().state === "waiting");
      expect(f.delivery()).toBe(false);
      expect(f.task().findings.every((finding) => !finding.verification)).toBe(true);
      expect(f.fakes.openings("verifier")).toHaveLength(0);
      // Only Codex recovers. Complementary partial answers never close the ballot by themselves.
      f.engine.s.pool.limited = f.engine.s.pool.limited!.filter((limit) => limit.toolId !== "codex");
      f.engine.schedule();
      if (proven) {
        await f.advance(() => f.fakes.openings("verifier").length === 1 && f.task().state === "waiting" && !!f.task().findings.find((finding) => finding.id === findings[1]!.id)?.votes?.some((vote) => vote.toolId === "codex"));
        expect(f.task().hunt?.panel?.seats.map((seat) => [seat.key, seat.toolId])).toEqual([["sol-high", "codex"], ["grok-high", "grok"]]);
        expect(f.delivery()).toBe(false);
        // Grok's evidenced place still owes the first finding.
        f.engine.s.pool.limited = f.engine.s.pool.limited!.filter((limit) => limit.toolId !== "grok");
        f.engine.schedule();
      }
      await f.advance(f.delivery);
      const openings = f.fakes.openings("verifier");
      expect(openings).toHaveLength(proven ? 2 : 1);
      const codex = openings[0]!.slice(openings[0]!.indexOf("## Important findings to check"));
      expect(codex.includes(`- [${findings[0]!.id}]`)).toBe(!proven);
      expect(f.task().findings.find((finding) => finding.id === findings[0]!.id)?.votes).toContainEqual(first);
      expect(f.task().findings.find((finding) => finding.id === findings[1]!.id)?.votes).toContainEqual(second);
      expect(f.task().findings.filter((finding) => finding.votes?.length).every((finding) => finding.status === "dismissed")).toBe(true);
    } finally { await f.engine.shutdown(); }
  });
});
