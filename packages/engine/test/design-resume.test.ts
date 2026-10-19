import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ROLES, createDemoState } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { designConversationScope } from "../src/design.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

async function fixture(reopen: Scenario["reopen"], limited?: Scenario["limited"]) {
  const root = tempDir("petrina-design-resume-"); roots.push(root);
  const data = join(root, "data");
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "limits", builder: "plain", controlled: true, reviseBrief: true, reopen, limited });
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], toolPath: () => "/bin/true" };
  let engine = new Engine(data, options);
  const productId = await engine.addProduct(makeProduct(root));
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
  return { fakes, task, tick, done, engine: () => engine, restart: async () => { await engine.shutdown(); engine = new Engine(data, options); } };
}

describe.concurrent("design participants' own conversations", () => {
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
      await waitFor(() => { run.tick(true); return run.fakes.received("design reviewer").length && run.task().conversation?.briefed; }, "the first reviewer to start");
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
