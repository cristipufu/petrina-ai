import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { slotUses } from "@petrina/core";
import { Engine } from "../src/engine.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture(scenario: Scenario, limit = 3, reviewers?: string[], builderProfile?: string) {
  const root = tempDir("petrina-independence-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ builder: "plain", ...scenario });
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], toolPath: () => "/bin/true", codexCommand: null };
  let engine = new Engine(join(root, "data"), options);
  engine.setPoolPaused(true);
  engine.setPoolLimit(limit);
  for (const tool of ["claude-code", "codex", "grok"]) engine.setToolCap(tool, 1);
  const repo = makeProduct(root);
  const productId = await engine.addProduct(repo);
  engine.setProductDelivery(productId, "local", true);
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]", approvePlan: true });
  const task = () => engine.getState().tasks.find((entry) => entry.id === taskId)!;
  const model = (session: string) => fakes.settings(session).find((setting) => setting.startsWith("model="))?.slice(6);
  const models = (role: string) => [...new Set(fakes.received(role).map((entry) => entry.session))].map(model);
  const release = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
  const advance = (done: () => boolean, allow: (role: string, session: string) => boolean = () => true) => waitFor(() => {
    for (const prompt of fakes.received()) if (allow(prompt.role, prompt.session)) release(prompt.session);
    for (const item of engine.getState().inbox) {
      if (item.kind === "plan") {
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
  const restart = () => { engine.shutdown(); engine = new Engine(join(root, "data"), options); };
  engine.setPoolPaused(false);
  return { get engine() { return engine; }, fakes, task, model, models, release, advance, delivery, restart, repo };
}

describe.concurrent("reviews after a usage handoff", () => {
  for (const limit of [1, 2]) it(`keeps a real reviewer handoff independent with ${limit} pool slots and one slot per tool`, async () => {
    // With two seats it is the helper that hands over, while the pool is full.
    const f = await fixture({ limited: [{ model: "opus", role: "code reviewer", spendCap: true }], reviewer: "important-twice" }, limit, limit === 2 ? ["sol-high", "opus-high"] : undefined);
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
      expect(f.fakes.openings("verifier")).toHaveLength(0);
      expect(violations).toEqual([]);
      expect(peak).toBe(limit === 1 ? 1 : 2);
    } finally { unsub(); f.engine.shutdown(); }
  });

  it("keeps a design review away from the replacement that actually wrote the brief", async () => {
    const f = await fixture({ limited: [{ model: "opus", role: "architect", spendCap: true }] }, 1);
    try {
      await f.advance(f.delivery);
      expect(f.models("architect")).toEqual(["opus", "gpt-6.1-sol"]);
      expect(f.models("design reviewer")).toEqual(["grok-4.7"]);
      expect(f.task().brief?.summary).toBe("A greeting file.");
    } finally { f.engine.shutdown(); }
  });

  it("hands a design reviewer to another tool when its own usage runs out", async () => {
    const f = await fixture({ limited: [{ model: "gpt-6.1-sol", role: "design reviewer" }] }, 1);
    try {
      await f.advance(f.delivery);
      expect(f.models("architect")).toEqual(["opus"]);
      expect(f.models("design reviewer")).toEqual(["gpt-6.1-sol", "grok-4.7"]);
    } finally { f.engine.shutdown(); }
  });

  it("retains a reported review after a restart of a saved legacy pair", async () => {
    const f = await fixture({ controlled: true }, 1);
    try {
      // Save the legacy Sol + Opus plan with Claude already out before the review starts.
      await f.advance(() => f.fakes.received("builder").length === 1, (role) => role !== "builder");
      const stage = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!.plan!.stages.find((stage) => stage.kind === "review-chain")!;
      stage.profileIds = ["sol-high", "opus-high"];
      f.engine.s.pool.limited = [{ toolId: "claude-code", until: Date.now() + 3_600_000, reason: "Claude Code's usage limit" }];
      await f.advance(() => Object.keys(f.task().hunt?.reported ?? {}).length === 1, (role, session) => role !== "code reviewer" || f.model(session) === "gpt-6.1-sol");
      expect(f.task().hunt?.profiles?.["0"]).toBe("sol-high");
      f.restart();
      await f.advance(f.delivery);
      const reviewers = f.fakes.received("code reviewer");
      expect(reviewers.filter((entry) => f.model(entry.session) === "gpt-6.1-sol")).toHaveLength(1);
      expect(reviewers.filter((entry) => f.model(entry.session) === "grok-4.7").length).toBeGreaterThanOrEqual(1);
      expect(f.task().hunt).toBeUndefined();
      expect(f.task().brief?.summary).toBe("A greeting file.");
    } finally { f.engine.shutdown(); }
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
      f.restart();
      f.engine.setPoolPaused(false);
      await f.advance(f.delivery);
      const verdicts = f.engine.tracking.log.moments({ taskId: f.task().id, kinds: ["verdict"] });
      expect(verdicts.map((entry) => entry.profileId)).toEqual(["sol-high", "opus-high"]);
      expect(f.fakes.openings("builder")).toHaveLength(1);
    } finally { f.engine.shutdown(); }
  });

  it("reviews a real conflict port away from its latest builder, even when neither planned reviewer can do that", async () => {
    const f = await fixture({ controlled: true }, 3, ["sol-high", "opus-high"], "opus-high");
    try {
      // The usage stand-in writes notes.txt. Include it in the reviewed feature so its handoff later
      // remains a genuine port, rather than adding an unreviewed file alongside the conflict.
      await f.advance(() => f.fakes.received("builder").length === 1, (role) => role !== "builder");
      writeFileSync(join(f.task().worktree!, "notes.txt"), "A first draft\n");
      await f.advance(f.delivery);
      expect(git(f.task().worktree!, "show", "HEAD:notes.txt")).toBe("A first draft");
      // The original build and review finished. A conflicting change lands before delivery.
      expect(f.task().builderSession?.toolId).toBe("claude-code");
      writeFileSync(join(f.repo, "greeting.txt"), "Hi from main\n");
      git(f.repo, "add", "greeting.txt");
      git(f.repo, "commit", "-q", "-m", "A greeting on main");
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
      f.restart();
      await f.advance(f.delivery);
      expect(f.fakes.received("code reviewer").filter((entry) => entry.text.includes("Review only the port")).every((entry) => f.model(entry.session) === "grok-4.7")).toBe(true);
      const completed = f.task().journey!.filter((entry) => entry.roleId === "code-reviewer" && entry.port);
      expect(completed).toHaveLength(1);
      expect(completed[0]).toEqual(expect.objectContaining({ id: step.id, team: ["grok-high"], end: "done", reason: "review passed" }));
    } finally { f.engine.shutdown(); }
  });

  it("finishes both reviews on the remaining tool when independence is unavailable", async () => {
    const f = await fixture({ limited: [{ model: "opus", role: "code reviewer", spendCap: true }] }, 1);
    try {
      f.engine.s.pool.limited = [{ toolId: "grok", until: Date.now() + 3_600_000, reason: "Grok's usage limit" }];
      await f.advance(f.delivery);
      const verdicts = f.engine.tracking.log.moments({ taskId: f.task().id, kinds: ["verdict"] });
      expect(verdicts).toHaveLength(2);
      expect(verdicts.every((entry) => f.engine.s.profiles.find((profile) => profile.id === entry.profileId)?.toolId === "codex")).toBe(true);
    } finally { f.engine.shutdown(); }
  });

  it("restores the full planned review when an older saved port has no proof of completed feature review", async () => {
    const f = await fixture({ controlled: true }, 3);
    try {
      await f.advance(f.delivery);
      writeFileSync(join(f.repo, "greeting.txt"), "Hi from main\n");
      git(f.repo, "add", "greeting.txt");
      git(f.repo, "commit", "-q", "-m", "A greeting on main");
      f.engine.approve(f.engine.getState().inbox.find((item) => item.kind === "delivery")!.id);
      await f.advance(() => f.fakes.received("code reviewer").some((entry) => entry.text.includes("Review only the port")), (role) => role !== "code reviewer");
      // Older releases saved this mark even for an unreviewed feature. A restart must not trust it.
      f.engine.setPoolPaused(true);
      const saved = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      delete saved.reviewedTree;
      // Even a report already saved under that narrower scope cannot replace an ordinary review.
      const key = Object.keys(saved.hunt!.profiles!)[0]!;
      saved.hunt!.reported[key] = true;
      const before = f.fakes.received("code reviewer").length;
      f.restart();
      f.engine.setPoolPaused(false);
      await f.advance(f.delivery);
      const reviews = f.fakes.received("code reviewer").slice(before);
      expect(reviews).toHaveLength(2);
      for (const review of reviews) {
        expect(review.text).not.toContain("Review only the port");
        expect(review.text).toContain(`git diff ${f.task().baseSha}...HEAD`);
      }
      expect(f.task().portReview).toBeUndefined();
      expect(f.task().reviewedTree).toBe(git(f.task().worktree!, "rev-parse", "HEAD^{tree}"));
    } finally { f.engine.shutdown(); }
  });

  for (const reopen of ["resume", "load"] as const) for (const legacy of [true, false]) {
    it(`${legacy ? "replaces a legacy port conversation with full instructions" : "keeps a genuine port conversation"} for a single reviewer after ${reopen}`, async () => {
      const f = await fixture({ planner: "short", controlled: true, reopen }, 1);
      try {
        await f.advance(f.delivery);
        expect(f.fakes.openings("code reviewer")).toHaveLength(1);
        writeFileSync(join(f.repo, "greeting.txt"), "Hi from main\n");
        git(f.repo, "add", "greeting.txt");
        git(f.repo, "commit", "-q", "-m", "A greeting on main");
        f.engine.approve(f.engine.getState().inbox.find((item) => item.kind === "delivery")!.id);
        await f.advance(() => f.fakes.received("code reviewer").length === 2 && !!f.task().conversation?.briefed, (role) => role !== "code reviewer");
        const port = f.fakes.received("code reviewer").at(-1)!;
        expect(port.text).toContain("Review only the port");
        expect(f.task().plan!.stages.find((stage) => stage.kind === "review-chain")!.profileIds).toHaveLength(1);
        f.engine.setPoolPaused(true);
        const saved = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
        expect(saved.conversation?.sessionId).toBe(port.session);
        if (legacy) delete saved.reviewedTree;
        f.engine.sendMessage(f.task().id, "Check the welcome page too.");
        f.restart();
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
        expect(f.task().reviewedTree).toBe(git(f.task().worktree!, "rev-parse", "HEAD^{tree}"));
      } finally { f.engine.shutdown(); }
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
    } finally { f.engine.shutdown(); }
  });
});
