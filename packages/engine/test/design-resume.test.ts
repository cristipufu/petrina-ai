import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ROLES, createDemoState } from "@petrina/core";
import { Engine } from "./engine.js";
import { designConversationScope } from "../src/design.js";
import { ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import type { Scenario } from "./fake-agent.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture(reopen: Scenario["reopen"], limited?: Scenario["limited"], standIn?: "author" | "reviewer") {
  const root = tempDir("petrina-design-resume-"); roots.push(root);
  const data = join(root, "data");
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "limits", builder: "plain", controlled: true, reviseBrief: true, reopen, limited });
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], toolPath: () => process.execPath };
  let engine = new Engine(data, options);
  engine.setPoolPaused(true); await engine.checkTools();
  const productId = await engine.addProduct(await makeProduct(root));
  const taskId = engine.addTask({ productId, title: "Agree on the greeting", description: "ORIGINAL-DESIGN-REQUEST: keep it welcoming." });
  const task = () => engine.task(taskId)!;
  const tick = (holdReviewer = false) => {
    for (const entry of fakes.received()) if (entry.role !== "builder" && (!holdReviewer || entry.role !== "design reviewer")) writeFileSync(join(fakes.dir, `release-${entry.session}`), "go");
    for (const item of engine.getState().inbox) {
      if (item.taskId !== taskId) continue;
      if (item.kind === "plan" || item.kind === "design") engine.approve(item.id);
      else if (item.kind === "question") engine.answer(item.id, "Yes");
      else if (item.kind === "permission") engine.allow(item.id, "once");
    }
    if (task().state === "failed") throw new Error(task().error);
  };
  const done = () => waitFor(() => {
    tick();
    return task().journey?.some((step) => step.roleId === "design-reviewer" && step.round === 2 && step.endedAt) && task();
  }, "both participants to finish their second design round");
  if (standIn) engine.s.pool.limited = [{ toolId: standIn === "author" ? "claude-code" : "codex", until: Date.now() + 3_600_000, reason: "Controlled usage limit" }];
  engine.setPoolPaused(false);
  return { fakes, task, tick, done, engine: () => engine, restart: async () => { await engine.shutdown(); engine = new Engine(data, options); } };
}

describe.concurrent("design participants' own conversations", () => {
  for (const side of ["author", "reviewer"] as const) it(`keeps the healthy ${side} stand-in after the planned tool recovers`, async () => {
    const run = await fixture("resume", undefined, side);
    try {
      await waitFor(() => { run.tick(true); return run.fakes.received("design reviewer").length && Object.keys(run.task().designSessions ?? {}).length; }, "the first design reviewer to hold the round");
      const first = run.fakes.received(side === "author" ? "architect" : "design reviewer")[0]!;
      run.engine().s.pool.limited = [];
      const task = await run.done();
      const input = task.journey!.find((step) => step.round === 2 && step.roleId === (side === "author" ? "architect" : "design-reviewer"))!.agentInputs![0]!;
      expect(input.mode).toBe("continued");
      expect(input.requestedProfileId).toBe(side === "author" ? "opus-xhigh" : "sol-xhigh");
      expect(input.profileId).toBe(side === "author" ? "sol-xhigh" : "grok-xhigh");
      expect(input.taskDescription).toBeUndefined();
      expect(input.selectionReason).toContain("while the planned");
      expect(input.selectionReason).toContain("is available");
      expect(run.fakes.opens().filter((entry) => entry.session === first.session).map((entry) => entry.how)).toEqual(["new", "resume"]);
      const prompt = run.fakes.received(side === "author" ? "architect" : "design reviewer").at(-1)!.text;
      expect(prompt).not.toContain("ORIGINAL-DESIGN-REQUEST");
      const author = task.journey!.find((step) => step.round === 2 && step.roleId === "architect")!.agentInputs![0]!;
      const reviewer = task.journey!.find((step) => step.round === 2 && step.roleId === "design-reviewer")!.agentInputs![0]!;
      expect(run.engine().profile(author.profileId)!.toolId).not.toBe(run.engine().profile(reviewer.profileId)!.toolId);
    } finally { await run.engine().shutdown(); }
  });

  for (const side of ["author", "reviewer", "planned reviewer"] as const) it(`rechecks the ${side}'s old uncertain tool once in the step's place, then continues its conversation`, async () => {
    const run = await fixture("resume", undefined, side === "planned reviewer" ? undefined : side);
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

  for (const side of ["author", "reviewer"] as const) it(`records the usual near-limit policy for the ${side} stand-in after the planned tool recovers`, async () => {
    const run = await fixture("resume", undefined, side);
    try {
      await waitFor(() => { run.tick(true); return run.fakes.received("design reviewer").length && Object.keys(run.task().designSessions ?? {}).length; }, "the first design reviewer to hold the round");
      const roleId = side === "author" ? "architect" : "design-reviewer";
      const earlier = run.fakes.received(side === "author" ? "architect" : "design reviewer");
      const first = earlier[0]!;
      const firstInput = run.task().journey!.find((step) => step.round === 1 && step.roleId === roleId)!.agentInputs![0]!;
      const previous = run.engine().profile(firstInput.profileId)!;
      run.engine().s.pool.limited = [];
      const now = Date.now();
      run.engine().s.pool.usage = [{ toolId: previous.toolId, kind: "seven_day", utilization: 0.9, status: "allowed", at: now, resetsAt: now + 3_600_000 }];
      const task = await run.done();
      const input = task.journey!.find((step) => step.round === 2 && step.roleId === roleId)!.agentInputs![0]!;
      expect(input.requestedProfileId).toBe(side === "author" ? "opus-xhigh" : "sol-xhigh");
      const prompt = run.fakes.received(side === "author" ? "architect" : "design reviewer")[earlier.length]!;
      if (side === "author") {
        expect(input.mode).toBe("fresh");
        expect(input.profileId).toBe("opus-xhigh");
        expect(input.taskDescription).toContain("ORIGINAL-DESIGN-REQUEST");
        expect(input.selectionReason).toContain("The saved profile is near a usage limit; selected another tool at the same effort with room available.");
        expect(input.selectionReason).not.toContain("independence");
        expect(prompt.session).not.toBe(first.session);
        expect(prompt.text).toContain("ORIGINAL-DESIGN-REQUEST");
        expect(run.fakes.opens().filter((entry) => entry.session === first.session).map((entry) => entry.how)).toEqual(["new"]);
      } else {
        expect(input.mode).toBe("continued");
        expect(input.profileId).toBe(previous.id);
        expect(input.taskDescription).toBeUndefined();
        expect(input.selectionReason).toContain("while the planned");
        expect(prompt.session).toBe(first.session);
        expect(prompt.text).not.toContain("ORIGINAL-DESIGN-REQUEST");
        expect(run.fakes.opens().filter((entry) => entry.session === first.session).map((entry) => entry.how)).toEqual(["new", "resume"]);
      }
      expect(task.timeline.some((entry) => entry.roleId === roleId && entry.text === input.selectionReason)).toBe(true);
    } finally { await run.engine().shutdown(); }
  });

  for (const failure of ["context", "native"] as const) it(`reselects the planned author with full context after a late ${failure} failure`, async () => {
    const run = await fixture("resume", undefined, "author");
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

  it("drops the saved reviewer stand-in when the new author now uses its tool", async () => {
    const run = await fixture("resume", undefined, "reviewer");
    try {
      await waitFor(() => { run.tick(true); return run.fakes.received("design reviewer").length; }, "the stand-in reviewer to hold the round");
      run.engine().s.pool.limited = [];
      run.task().plan!.stages.find((stage) => stage.kind === "converge")!.profileIds[0] = "grok-xhigh";
      const task = await run.done();
      const input = task.journey!.find((step) => step.round === 2 && step.roleId === "design-reviewer")!.agentInputs![0]!;
      expect(input.mode).toBe("fresh");
      expect(input.profileId).toBe("sol-xhigh");
      expect(input.taskDescription).toContain("ORIGINAL-DESIGN-REQUEST");
      expect(input.selectionReason).toContain("Selected a more independent tool or model for this review.");
    } finally { await run.engine().shutdown(); }
  });

  it("records a rejected design continuation's known reason while the unaffected participant continues", async () => {
    const run = await fixture("resume");
    try {
      await waitFor(() => { run.tick(true); return run.fakes.received("design reviewer").length && executionFor(run.task()).work.conversation?.briefed; }, "the first reviewer to receive the design");
      run.task().description += " A changed recorded request.";
      const task = await run.done();
      const author = task.journey!.find(step => step.roleId === "architect" && step.round === 2)!.agentInputs![0]!;
      expect(author).toMatchObject({ mode: "fresh", freshReason: "its role, profile, request or starting point changed" });
      const reviewer = task.journey!.find(step => step.roleId === "design-reviewer" && step.round === 2)!.agentInputs![0]!;
      expect(reviewer.mode).toBe("continued");
      expect(reviewer.freshReason).toBeUndefined();
    } finally { await run.engine().shutdown(); }
  });

  for (const reopen of ["resume", "load"] as const) {
    it(`uses ${reopen} for both participants, passes only new context, and records the exact round inputs`, async () => {
      const run = await fixture(reopen);
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
      } finally { await run.engine().shutdown(); }
    });
  }

  it("retains both participant identities across an engine restart during the first review", async () => {
    const run = await fixture("resume");
    try {
      await waitFor(() => { run.tick(true); return run.fakes.received("design reviewer").length && executionFor(run.task()).work.conversation?.briefed; }, "the first reviewer to start");
      const authorId = run.fakes.received("architect")[0]!.session;
      const reviewerId = run.fakes.received("design reviewer")[0]!.session;
      await run.restart();
      const task = await run.done();
      expect(new Set(run.fakes.received("architect").map((entry) => entry.session))).toEqual(new Set([authorId]));
      expect(new Set(run.fakes.received("design reviewer").map((entry) => entry.session))).toEqual(new Set([reviewerId]));
      expect(Object.values(task.designSessions!).map((entry) => entry.sessionId).sort()).toEqual([authorId, reviewerId].sort());
    } finally { await run.engine().shutdown(); }
  });

  it("starts fresh with complete context when the tool cannot reopen", async () => {
    const run = await fixture(undefined);
    try {
      const task = await run.done();
      for (const role of ["architect", "design reviewer"]) expect(new Set(run.fakes.received(role).map((entry) => entry.session)).size).toBe(2);
      const later = task.journey!.filter((step) => step.round === 2 && ["architect", "design-reviewer"].includes(step.roleId ?? ""));
      expect(later.every((step) => step.agentInputs![0]!.mode === "fresh")).toBe(true);
      expect(later.every((step) => step.agentInputs![0]!.taskDescription!.includes("ORIGINAL-DESIGN-REQUEST"))).toBe(true);
      expect(task.timeline.some((line) => line.text.includes("Could not go back to its own conversation"))).toBe(true);
    } finally { await run.engine().shutdown(); }
  });

  it("keeps the actual replacement reviewer's own conversation in the next round", async () => {
    const run = await fixture("resume", [{ model: "gpt-6.1-sol", role: "design reviewer" }]);
    try {
      const task = await run.done();
      const reviewer = Object.values(task.designSessions!).find((entry) => entry.plannedProfileId === "sol-xhigh")!;
      expect(reviewer.toolId).toBe("grok");
      expect(run.fakes.opens().filter((entry) => entry.session === reviewer.sessionId).map((entry) => entry.how)).toEqual(["new", "resume"]);
      const second = task.journey!.find((step) => step.roleId === "design-reviewer" && step.round === 2)!;
      expect(second.agentInputs!.find((entry) => entry.profileId === reviewer.profileId)!.mode).toBe("continued");
    } finally { await run.engine().shutdown(); }
  });
});

it("invalidates a design return when its role, planned or actual profile, request or source changes", () => {
  const task = createDemoState(1_000_000_000).tasks[0]!;
  const role = BUILT_IN_ROLES.find((entry) => entry.id === "architect")!;
  const planned = ENGINE_PROFILES[0]!;
  const original = designConversationScope(task, role, planned, planned);
  expect(designConversationScope(structuredClone(task), { ...role }, { ...planned }, { ...planned })).toBe(original);
  for (const value of [
    designConversationScope(task, { ...role, instructions: "A revised role" }, planned, planned),
    designConversationScope(task, role, { ...planned, effort: "low" }, planned),
    designConversationScope(task, role, planned, { ...planned, modelId: "another-model" }),
    designConversationScope({ ...task, baseSha: "new-source" }, role, planned, planned),
    designConversationScope({ ...task, description: "A revised request" }, role, planned, planned),
    designConversationScope({ ...task, productId: "another-product" }, role, planned, planned),
  ]) expect(value).not.toBe(original);
});
