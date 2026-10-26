import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { slotUses } from "@petrina/core";
import { git } from "../../fixtures.js";
import { independentReviewFixtures } from "../../fixtures/independence.js";

const { fixture, close } = independentReviewFixtures();
afterAll(close);
describe.concurrent("reviews after a usage handoff", () => {
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
      await f.run(async () => {
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
      });
    } finally { unsub(); await f.close(); }
  });

it("keeps a design review away from the replacement that actually wrote the brief", async () => {
    const f = await fixture({ limited: [{ model: "opus", role: "architect", spendCap: true }] }, 1, undefined, undefined, false);
    try {
      await f.run(async () => {
      await f.advance(f.delivery);
      expect(f.models("architect")).toEqual(["opus", "gpt-6.1-sol"]);
      expect(f.models("design reviewer")).toEqual(["grok-4.7"]);
      expect(f.task().brief?.summary).toBe("A greeting file.");
      });
    } finally { await f.close(); }
  });

it("hands a design reviewer to another tool when its own usage runs out", async () => {
    const f = await fixture({ limited: [{ model: "gpt-6.1-sol", role: "design reviewer" }] }, 1, undefined, undefined, false);
    try {
      await f.run(async () => {
      await f.advance(f.delivery);
      expect(f.models("architect")).toEqual(["opus"]);
      expect(f.models("design reviewer")).toEqual(["gpt-6.1-sol", "grok-4.7"]);
      });
    } finally { await f.close(); }
  });

it("reviews a real conflict port away from its latest builder, even when neither planned reviewer can do that", async () => {
    const f = await fixture({ controlled: true }, 3, ["sol-high", "opus-high"], "opus-high");
    try {
      await f.run(async () => {
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
      });
    } finally { await f.close(); }
  });

it("finishes both reviews on the remaining tool when independence is unavailable", async () => {
    const f = await fixture({ limited: [{ model: "opus", role: "code reviewer", spendCap: true }] }, 1);
    try {
      await f.run(async () => {
      f.engine.s.pool.limited = [{ toolId: "grok", until: Date.now() + 3_600_000, reason: "Grok's usage limit" }];
      await f.advance(f.delivery);
      const verdicts = f.engine.tracking.log.moments({ taskId: f.task().id, kinds: ["verdict"] });
      expect(verdicts).toHaveLength(2);
      expect(verdicts.every((entry) => f.engine.s.profiles.find((profile) => profile.id === entry.profileId)?.toolId === "codex")).toBe(true);
      });
    } finally { await f.close(); }
  });

});
