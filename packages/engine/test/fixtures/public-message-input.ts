import { createHash } from "node:crypto";
import { beginAgentStep, bindParticipantSessionLine, openStep, saySessionLine } from "@petrina/core";
import { ParticipantInputs, executionFor, type AgentSession } from "@petrina/orchestrator";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { profileSelectionFixture } from "../../../orchestrator/test/fixtures/profile-selection.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { inputManifest, numberInputManifest } from "../../src/input-manifest.js";

/** Actual input and session-line producers; messages and private artifact storage are explicit effects. */
export function publicMessageInput() {
  const f = profileSelectionFixture(), { task, state } = f, scope = executionFor(task);
  task.plan = { rationale: "Observe public updates", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"] },
  ] };
  task.stageIndex = 0;
  let sequence = 0, stopped = false, current = true;
  const calls = { commits: 0, updates: 0, briefed: 0 };
  const artifacts = new Map<string, string>(), pending = new Set<string>(), active = new Set<AgentSession>();
  const signal = new AbortController();
  const operations = new FixtureOperations({
    async stop() { signal.abort(); await Promise.all([...active].map(session => session.stop())); },
    dispose() { active.clear(); artifacts.clear(); pending.clear(); },
    arm(fire, ms) { const timer = setTimeout(fire, ms); return () => clearTimeout(timer); },
    allowanceMs: 5_000,
    label: "public message input fixture",
  });
  const agents = new ScriptedAgents(prompt => prompt.result === "build"
    ? { text: scriptedResult({ summary: "The change is ready.", changes: ["A greeting"] }), streamed: true }
    : { text: scriptedResult({ verdict: "pass", findings: [], confirms: [], disputes: [] }), streamed: true });
  const inputs = new ParticipantInputs({ now: f.now, current: () => current, stopped: () => stopped,
    status() {}, checkpoint() {}, commit() { calls.commits++; }, noteStream() { calls.updates++; },
    briefed() { calls.briefed++; },
    say(bound, text, roleId, profileId, reviewerKey) {
      saySessionLine(bound.task, bound.work.productId, "agent", text, roleId, profileId, undefined,
        { id: () => `line-${++sequence}`, now: f.now, pendingReportIds: pending });
      bindParticipantSessionLine(bound.task, "agent", roleId, profileId, reviewerKey);
    },
  }, { clone: structuredClone, manifest: inputManifest, numberManifest: numberInputManifest,
    async saveExact(taskId, text) {
      const digest = createHash("sha256").update(text).digest("hex");
      const file = `scripted:messages/${taskId}/${digest}.md`;
      artifacts.set(file, text);
      return { file, digest, size: Buffer.byteLength(text, "utf8") };
    },
  });
  async function start(roleId: "builder" | "code-reviewer", profileId: string, reviewerKey?: string) {
    return operations.run(async () => {
      const role = state.roles.find(role => role.id === roleId)!, profile = f.profile(profileId)!;
      task.stageIndex = roleId === "builder" ? 0 : 1;
      const group = openStep(task), team = group?.kind === "agent" && group.roleId === roleId ? group.team ?? (group.profileId ? [group.profileId] : []) : [];
      const step = beginAgentStep(task, roleId, profileId, f.now(), state.roles,
        reviewerKey !== undefined ? [...new Set([...team, profileId])] : [profileId], scope.work);
      const stream = inputs.stream(scope, roleId, profileId, reviewerKey, signal.signal, role.result === "build");
      const run = await agents.start({ profile, cwd: "scripted:product", signal: signal.signal,
        callbacks: { onMessage: stream, onActivity() {}, onPlanStep() {}, onPermission: async () => { throw new Error("Unexpected permission"); } } }, role);
      active.add(run);
      const prompt = `Declared public-message turn for ${roleId} (${profileId}${reviewerKey ? `#${reviewerKey}` : ""})`;
      const captured = inputs.capture({
        scope,
        roleId,
        profileId,
        sections: [],
        mode: "fresh",
        plannedId: profileId,
        reviewerKey,
        confirmedSettings: run.settings,
        instructions: prompt,
        extra: { sessionId: run.sessionId },
      });
      await inputs.attach(scope, captured, prompt);
      const inputIndex = step.agentInputs!.length - 1;
      return { step, inputIndex, input: step.agentInputs![inputIndex]!, sessionId: run.sessionId, stream };
    });
  }
  return { ...f, scope, calls, artifacts, inputs, agents, start, signal,
    stop() { stopped = true; }, detach() { current = false; }, close: () => operations.close(),
  };
}
