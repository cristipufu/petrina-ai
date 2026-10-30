import { expect, it } from "bun:test";
import { join } from "node:path";
import type { ConversationNote } from "@petrina/core";
import { executionFor, type AgentSessionOptions, type StartAgentSession } from "@petrina/orchestrator";
import { createProductRepository, tempDir } from "../../fixtures.js";
import { ScriptedAgents, scriptedResult } from "../../scripted-agents.js";
import { NotesResult, ReviewResult } from "../../../src/roles.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { directDrivers } from "../../fixtures/direct-drivers.js";

// Real prompt preparation, Git and durable journey recording compose with a scripted provider.
// Transport, sandbox and accounting behavior remain covered by the native ACP contracts.
for (const parallel of [false, true]) it(`opens and resumes a ${parallel ? "parallel reviewer" : "main participant"} through the portable session contract`, async () => {
  const root = tempDir("petrina-session-port-");
  const owner = directDrivers(root);
  await setupWithCleanup(() => owner.prepare(async () => {
    const { path: repo, initialSha: baseSha } = await createProductRepository(root);
    const roleId = parallel ? "code-reviewer" : "researcher";
    const agents = new ScriptedAgents(prompt => {
      expect(prompt.roleId).toBe(roleId);
      return scriptedResult(parallel ? { verdict: "pass", findings: [], confirms: [], disputes: [] }
        : { summary: "Investigated the contract.", notes: ["The session kept its conversation."] });
    });
    const openings: { reopen?: string; roleId: string; sessionId: string }[] = [];
    const start: StartAgentSession = async (options, role) => {
      // The host must not pass credentials, native handles or native launch settings across this port.
      const expected: (keyof AgentSessionOptions)[] = ["profile", "cwd", "callbacks", "signal", "browser", "startTimeoutMs", "onGone"];
      if (options.reopen) expected.push("reopen", "reopenTimeoutMs");
      expect(Object.keys(options).sort()).toEqual(expected.sort());
      expect(Object.keys(options.callbacks).sort()).toEqual(["onMessage", "onActivity", "onToolActivity", "onPlanStep", "onRetrying", "onPermission", "onCleanupIncomplete"].sort());
      expect(options.startTimeoutMs).toBe(1800);
      expect(options.onGone).toBeFunction();
      expect(options.browser).toBe(false);
      expect(options.cwd).toBe(repo);
      expect(options.profile.id).toBe("opus-high");
      if (options.reopen) expect(options.reopenTimeoutMs).toBe(1900);
      const opening = { reopen: options.reopen, roleId: role.id, sessionId: "" };
      openings.push(opening);
      const session = await agents.start(options, role);
      opening.sessionId = session.sessionId;
      return session;
    };
    const engine = owner.open(join(root, "data"), { startAgentSession: start, startTimeoutMs: 1800, reopenTimeoutMs: 1900,
      agentCommand: () => { throw new Error("A scripted session must not resolve a native command"); } });
    engine.schedule = () => {};
    await engine.waitUntilReady();
    engine.s.products.push({ id: "product", name: "Product", repo: "local/product", path: repo, tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "product", title: "Continue a participant", backlog: true }))!;
    task.plan = { rationale: "Only the participant under test", plannerProfileId: "opus-high", stages: [
      { id: "step", title: "Inspect the session contract", kind: parallel ? "review-chain" : "do", roleId, profileIds: ["opus-high"] },
    ] };
    task.stageIndex = 0;
    engine.s.pool.paused = false;
    const scope = executionFor(task);
    Object.assign(scope.work, { worktree: repo, branch: "main", base: "main", baseSha });
    if (parallel) task.hunt = { stageId: "step", round: 1, reported: {}, findings: 0 };
    const run = (resume?: ConversationNote) => owner.run(engine, async () => {
      delete scope.work.conversation;
      task.state = "running";
      let completed: ConversationNote | undefined;
      const options = { resume, completed: (note: ConversationNote) => { completed = structuredClone(note); }, reviewerKey: parallel ? "0" : undefined };
      if (parallel) await engine!["turns"].parallel(scope, roleId, "opus-high", repo, () => [], ReviewResult, new AbortController().signal, options);
      else await engine!["turns"].turn(scope, roleId, "opus-high", () => [], NotesResult, new AbortController().signal, options);
      expect(completed).toBeDefined();
      return completed!;
    });
    const first = await run();
    const second = await run(first);
    const fresh = await run({ ...second, sessionId: "unavailable-conversation" });
    expect(second.sessionId).toBe(first.sessionId);
    expect(fresh.sessionId).not.toBe(first.sessionId);
    expect(openings.map(opening => opening.reopen)).toEqual([undefined, first.sessionId, "unavailable-conversation", undefined]);
    expect(openings.every(opening => opening.roleId === roleId)).toBe(true);
    expect(agents.received().map(prompt => prompt.turn)).toEqual([1, 2, 1]);
    expect(task.journey!.flatMap(step => step.agentInputs ?? []).map(input => input.mode)).toEqual(["fresh", "continued", "fresh"]);
  }), () => owner.close());
  await owner.close();
});
