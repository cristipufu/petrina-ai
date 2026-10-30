import { contextStageFixtures } from "../../fixtures/context-stage.js";
import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { waitFor } from "../../fixtures.js";

const prepared = contextStageFixtures();
afterAll(() => prepared.close());

describe.concurrent("design participants' own conversations", () => {
for (const side of ["author", "reviewer", "planned reviewer"] as const) it(`rechecks the ${side}'s old uncertain tool once in the step's place, then continues its conversation`, async () => {
    const run = await prepared.designRun("resume", undefined, side === "planned reviewer" ? undefined : side, { nativeRechecks: true });
    return run.use(async () => {
      try {
        await waitFor(() => { run.tick(true); return run.fakes.received("design reviewer").length && Object.keys(run.task().designSessions ?? {}).length; }, "the first design reviewer to hold the round");
        const roleId = side === "author" ? "architect" : "design-reviewer";
        const first = run.task().journey!.find((step) => step.round === 1 && step.roleId === roleId)!.agentInputs![0]!;
        const toolId = run.engine().profile(first.profileId)!.toolId;
        const name = run.engine().s.tools.find((tool) => tool.id === toolId)!.name;
        run.engine().s.pool.limited = [];
        // Its last answer was Couldn't check, ten minutes ago, while other tools are Ready.
        const old = Date.now() - 10 * 60_000;
        Object.assign(run.engine().s.setup!.checks.find((check) => check.id === toolId)!, { status: "unknown", at: old });
        const task = await run.done();
        const input = task.journey!.find((step) => step.round === 2 && step.roleId === roleId)!.agentInputs![0]!;
        expect(input).toEqual(expect.objectContaining({ mode: "continued", profileId: first.profileId, sessionId: first.sessionId }));
        expect(input.readiness).toEqual({ at: expect.any(Number), toolId, previous: { status: "unknown", at: old }, check: "started", outcome: "ready" });
        expect(input.selectionReason).toContain(`${name} passed its readiness recheck`);
        const line = task.timeline.find((entry) => entry.text.startsWith(`Checking ${name} before returning to its saved conversation (`));
        expect(line?.text).toContain("so Petrina started one recheck");
        expect(line?.roleId).toBeUndefined();
        expect(run.engine().s.setup!.checks.find((check) => check.id === toolId)!.status).toBe("ready");
      } finally { await run.engine().shutdown(); }
    });
  });
});

describe.concurrent("design participants' own conversations", () => {
for (const failure of ["context", "native"] as const) it(`reselects the planned author with full context after a late ${failure} failure`, async () => {
    const run = await prepared.designRun("resume", undefined, "author");
    return run.use(async () => {
      try {
        await waitFor(() => { run.tick(true); return run.fakes.received("design reviewer").length && Object.keys(run.task().designSessions ?? {}).length; }, "the stand-in author to finish");
        const prior = Object.values(run.task().designSessions!)[0]!;
        const heard = run.fakes.received("architect").filter((entry) => entry.session === prior.sessionId).length;
        run.engine().s.pool.limited = [];
        if (failure === "context") rmSync(prior.context!.file);
        else rmSync(join(run.fakes.dir, "conversations", `${prior.sessionId}.json`));
        const task = await run.done();
        const input = task.journey!.find((step) => step.round === 2 && step.roleId === "architect" && step.agentInputs?.length)!.agentInputs![0]!;
        expect(input.mode).toBe("fresh");
        expect(input.profileId).toBe("opus-xhigh");
        expect(input.taskDescription).toContain("ORIGINAL-DESIGN-REQUEST");
        expect(input.selectionReason).toContain(failure === "context" ? "saved context is unavailable" : "could not reopen");
        expect(run.fakes.received("architect").filter((entry) => entry.session === prior.sessionId)).toHaveLength(heard);
      } finally { await run.engine().shutdown(); }
    });
  });
});

describe.concurrent("design participants' own conversations", () => {
for (const reopen of ["resume", "load"] as const) {
    it(`uses ${reopen} for both participants, passes only new context, and records the exact round inputs`, async () => {
      const run = await prepared.designRun(reopen);
      return run.use(async () => {
        try {
          const task = await run.done();
          const rounds = task.journey!.filter((step) => ["architect", "design-reviewer"].includes(step.roleId ?? "") && step.endedAt);
          expect(rounds).toHaveLength(4);
          expect(rounds.map((step) => step.agentInputs![0]!.mode)).toEqual(["fresh", "fresh", "continued", "continued"]);
          for (const role of ["architect", "design reviewer"]) {
            const ids = new Set(run.fakes.received(role).map((entry) => entry.session));
            expect(ids.size).toBe(1);
            expect(run.fakes.opens().filter((entry) => ids.has(entry.session)).map((entry) => entry.how)).toEqual(["new", reopen]);
          }
          const sessions = Object.values(task.designSessions!);
          expect(sessions).toHaveLength(2);
          expect(new Set(sessions.map((entry) => entry.sessionId)).size).toBe(2);
          for (const step of rounds.slice(2)) {
            const input = step.agentInputs![0]!;
            expect(input.taskDescription).toBeUndefined();
            expect(input.sections.some((section) => section.title === "What earlier agents on this task handed back")).toBe(false);
            expect(input.sections.some((section) => section.title === "Objections so far")).toBe(true);
            expect(input.sections.some((section) => section.title === "Current authoritative task context")).toBe(true);
          }
          expect(rounds[2]!.agentInputs![0]!.sections.some((section) => section.title === "Design brief")).toBe(false);
          expect(rounds[3]!.agentInputs![0]!.sections.find((section) => section.title === "Design brief")!.body).toContain("visible to everyone after the review");
          for (const entry of sessions) expect(readFileSync(entry.context!.file, "utf8")).toContain("ORIGINAL-DESIGN-REQUEST");
          const authorSession = sessions.find((entry) => entry.profileId === "opus-xhigh")!;
          expect(run.fakes.received("design reviewer").every((entry) => !entry.text.includes(authorSession.context!.file))).toBe(true);
        } finally { await run.shutdown(); }
      });
    });
  }
});

describe.concurrent("design participants' own conversations", () => {
it("retains both participant identities across an engine restart during the first review", async () => {
    const run = await prepared.designRun("resume");
    return run.use(async () => {
      try {
        await waitFor(() => { run.tick(true); return run.fakes.received("design reviewer").length && executionFor(run.task()).work.conversation?.briefed; }, "the first reviewer to start");
        const authorId = run.fakes.received("architect")[0]!.session;
        const reviewerId = run.fakes.received("design reviewer")[0]!.session;
        await run.restart();
        const task = await run.done();
        expect(new Set(run.fakes.received("architect").map((entry) => entry.session))).toEqual(new Set([authorId]));
        expect(new Set(run.fakes.received("design reviewer").map((entry) => entry.session))).toEqual(new Set([reviewerId]));
        expect(Object.values(task.designSessions!).map((entry) => entry.sessionId).sort()).toEqual([authorId, reviewerId].sort());
      } finally { await run.shutdown(); }
    });
});
});

describe.concurrent("design participants' own conversations", () => {
it("starts fresh with complete context when the tool cannot reopen", async () => {
    const run = await prepared.designRun(undefined);
    return run.use(async () => {
      try {
        const task = await run.done();
        for (const role of ["architect", "design reviewer"]) expect(new Set(run.fakes.received(role).map((entry) => entry.session)).size).toBe(2);
        const later = task.journey!.filter((step) => step.round === 2 && ["architect", "design-reviewer"].includes(step.roleId ?? ""));
        expect(later.every((step) => step.agentInputs![0]!.mode === "fresh")).toBe(true);
        expect(later.every((step) => step.agentInputs![0]!.taskDescription!.includes("ORIGINAL-DESIGN-REQUEST"))).toBe(true);
        expect(task.timeline.some((line) => line.text.includes("Could not go back to its own conversation"))).toBe(true);
      } finally { await run.engine().shutdown(); }
    });
  });
});
