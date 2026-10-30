import { contextStageFixtures } from "../../fixtures/context-stage.js";
import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { draftOf } from "@petrina/core";
import type { Engine } from "../../engine.js";
import { git, waitFor } from "../../fixtures.js";


const prepared = contextStageFixtures();
afterAll(() => prepared.close());



const later = () => Date.now() + 3_600_000;

function roomierAlternative(engine: Engine) {
  engine.s.pool.usage = [
    { toolId: "codex", kind: "weekly", status: "allowed", utilization: 0.33, at: Date.now(), resetsAt: later() },
    { toolId: "grok", kind: "weekly", status: "allowed", utilization: 0.01, at: Date.now(), resetsAt: later() },
  ];
}

describe.concurrent("the Builder's saved fallback conversation", () => {
it("keeps Codex at 33% for review fixes, with actual attribution and independent reviews", async () => {
    const f = await prepared.builderRun({ reviewer: "important-twice", learnings: true });
    return f.use(async () => {
      try {
        f.engine.setPoolPaused(false);
        await f.advance(() => f.fakes.received("builder").some((entry) => f.model(entry.session) === "gpt-6.1-sol"), (role) => role !== "builder");
        const review = f.engine.s.tasks.find((task) => task.id === f.task().id)!.plan!.stages.find((stage) => stage.kind === "review-chain")!;
        review.profileIds = ["sol-high", "grok-high"];
        review.maxRounds = 3;
        await f.advance(() => f.fakes.received("code reviewer").length > 0, (role) => role !== "code reviewer");
        expect(f.task().lessons?.filter((lesson) => lesson.roleId === "builder")).toEqual([
          expect.objectContaining({ profileId: "sol-high", text: "Run the tests with bun test: they take a second." }),
          expect.objectContaining({ profileId: "sol-high", text: "Greetings live at the repository root." }),
        ]);
        const original = f.fakes.received("builder").find((entry) => f.model(entry.session) === "gpt-6.1-sol")!;
        roomierAlternative(f.engine);
        await f.advance(f.delivery);
        const builders = f.fakes.received("builder").filter((entry) => f.model(entry.session) === "gpt-6.1-sol");
        expect(builders).toHaveLength(2);
        expect(builders.every((entry) => entry.session === original.session)).toBe(true);
        expect(builders[1]!.text).toStartWith("Petrina is back with more work on this task");
        expect(f.fakes.received("builder").some((entry) => f.model(entry.session) === "grok-4.7")).toBe(false);
        expect(f.task().builderSession).toEqual(expect.objectContaining({ profileId: "sol-high", plannedProfileId: "opus-high", toolId: "codex", sessionId: original.session }));
        const returns = f.task().journey!.filter((step) => step.builderReturn);
        expect(returns).toHaveLength(2);
        expect(returns.map((step) => f.task().timeline.find((entry) => entry.step === step.id && entry.text.startsWith(step.builderReturn!.outcome))?.profileId)).toEqual(["sol-high", "sol-high"]);
        expect(f.task().findings.filter((finding) => finding.severity === "blocking").every((finding) => finding.answer?.fixed)).toBe(true);
        const verdicts = f.engine.tracking.log.moments({ taskId: f.task().id, kinds: ["verdict"] });
        expect(new Set(verdicts.filter((entry) => entry.round === 2).map((entry) => f.engine.profile(entry.profileId!)?.toolId))).toEqual(new Set(["codex", "grok"]));
      } finally { await f.engine.shutdown(); }
    });
  });
});

describe.concurrent("the Builder's saved fallback conversation", () => {
it("reopens the saved Codex conversation for a real main conflict and keeps the port review on Grok", async () => {
    const f = await prepared.builderRun();
    return f.use(async () => {
    try {
      f.engine.setPoolPaused(false);
      await f.advance(f.delivery);
      const original = f.task().builderSession!;
      expect(original.toolId).toBe("codex");
      roomierAlternative(f.engine);
      writeFileSync(join(f.repo, "greeting.txt"), "Hello from main\n");
      await git(f.repo, "add", "greeting.txt");
      await git(f.repo, "commit", "-q", "-m", "A greeting on main");
      f.engine.approve(f.engine.getState().inbox.find((item) => item.kind === "delivery")!.id);
      await f.advance(() => f.fakes.received("code reviewer").some((entry) => entry.text.includes("Review only the port")), (role) => role !== "code reviewer");
      const port = f.fakes.received("code reviewer").find((entry) => entry.text.includes("Review only the port"))!;
      expect(f.model(port.session)).toBe("grok-4.7");
      expect(f.task().builderSession?.sessionId).toBe(original.sessionId);
      expect(f.fakes.received("builder").at(-1)).toEqual(expect.objectContaining({ session: original.sessionId, text: expect.stringContaining("Petrina is back with more work on this task") }));
      await f.advance(f.delivery);
      expect(f.task().timeline.find((entry) => entry.text.startsWith("Brought up to date with main"))?.profileId).toBe("sol-high");
    } finally { await f.engine.shutdown(); }

  });
});
});

describe.concurrent("the Builder's saved fallback conversation", () => {
for (const check of ["ready", "logged-out", "timeout"] as const) it(`recovers an active legacy Grok Builder when its startup check is ${check}`, async () => {
    const f = await prepared.builderRun({ builder: "work" }, { nativeRechecks: true });
    const hold = join(f.root, "hold-check");
    return f.use(async () => {
      try {
        f.engine.s.pool.limited = [{ toolId: "codex", until: later(), reason: "Codex is out" }];
        f.engine.setPoolPaused(false);
        // The fake marks itself working before Petrina hears the step. Wait until this conversation is briefed.
        await f.advance(() => {
          const task = f.task();
          const conversation = task.conversation;
          return !!conversation
            && f.fakes.marked("builder-working")
            && conversation.toolId === "grok"
            && conversation.briefed === true
            && task.timeline.some((entry) => entry.text === "Drafting the greeting" && entry.at >= conversation.startedAt);
        });
        const saved = f.engine.s.tasks.find((task) => task.id === f.task().id)!;
        const original = executionFor(saved).work.conversation!;
        expect(original.toolId).toBe("grok");
        expect(original.briefed).toBe(true);
        const startingRole = structuredClone(original.role!);
        const newInstructions = "Use the next Builder's updated instructions.";
        f.engine.saveRole("builder", { ...draftOf(startingRole), instructions: newInstructions });
        // The incident predates the planned-profile note. Codex is now Ready with 34% used.
        delete original.plannedProfileId;
        f.engine.s.pool.limited = f.engine.s.pool.limited!.filter((limit) => limit.toolId !== "codex");
        f.engine.s.pool.usage = [{ toolId: "codex", kind: "weekly", status: "allowed", utilization: 0.34, at: Date.now(), resetsAt: later() }];
        f.engine.s.setup!.checks = [{ id: "codex", status: "ready" }, { id: "grok", status: "unchecked" }, { id: "claude-code", status: "ready" }];
        const before = f.fakes.received("builder").length;
        if (check === "ready") writeFileSync(hold, "");
        await f.restart(check === "ready" ? `--hold-open=${hold}` : check === "logged-out" ? "--logged-out" : "--hang");
        expect(f.task().state).toBe("waiting");
        expect(f.task().holdsSlot).toBe(false);
        expect(f.task().statusLine).toBe("Checking Grok before the Builder returns");
        expect(f.task().conversation?.role).toEqual(startingRole);
        expect(f.fakes.received("builder")).toHaveLength(before);
        if (check === "ready") {
          await waitFor(() => existsSync(`${hold}.reached`), "Grok's short readiness check");
          expect(f.task().conversation?.sessionId).toBe(original.sessionId);
          rmSync(hold);
        }
        await f.advance(f.delivery);
        const last = f.fakes.received("builder").at(-1)!;
        expect(f.model(last.session)).toBe(check === "ready" ? "grok-4.7" : "gpt-6.1-sol");
        expect(last.session === original.sessionId).toBe(check === "ready");
        expect(existsSync(join(f.task().worktree!, "notes.txt"))).toBe(true);
        expect(f.engine.role("builder")?.instructions).toBe(newInstructions);
        expect(f.fakes.received("builder").every((entry) => !entry.text.includes(newInstructions))).toBe(true);
        if (check !== "ready") expect(last.text).toContain(startingRole.instructions);
        if (check === "ready") {
          expect(f.fakes.opens().filter((open) => open.session === original.sessionId).map((open) => open.how)).toEqual(["new", "resume"]);
          expect(f.task().timeline.some((entry) => entry.text === "Picked up where it left off")).toBe(true);
          expect(f.task().timeline.some((entry) => entry.text.includes("different tool or model"))).toBe(false);
        }
      } finally { rmSync(hold, { force: true }); await f.engine.shutdown(); }
    });
  });
});
