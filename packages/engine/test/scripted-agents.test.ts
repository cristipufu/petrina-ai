import { describe, expect, it } from "bun:test";
import { BUILT_IN_ROLES, DEFAULT_PROFILES } from "@petrina/core";
import type { AgentSessionOptions } from "../src/agent-session.js";
import { ReopenFailed } from "../src/agent-session.js";
import { parseResult } from "../src/prompts.js";
import { BuildResult } from "../src/roles.js";
import { ScriptedAgents, scriptedResult } from "./scripted-agents.js";
import { nativeAgentProcess } from "./native-agent.js";
import { rejectionOf } from "./rejections.js";

const role = BUILT_IN_ROLES.find(role => role.result === "build")!;
function options(signal = new AbortController().signal): AgentSessionOptions {
  return { profile: { ...DEFAULT_PROFILES.find(profile => profile.id === "sol-high")! }, cwd: import.meta.dir, signal, browser: false,
    callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" } };
}

describe.concurrent("scripted workflow sessions", () => {
  it("keeps conversation identity across engines without accepting another participant or owner", async () => {
    const agents = new ScriptedAgents(prompt => scriptedResult({ summary: prompt.text, changes: [] }));
    const launch = options(), first = await agents.start(launch, role);
    await first.prompt("first turn"); await first.stop();
    const next = await agents.start({ ...options(), reopen: first.sessionId }, role);
    try {
      expect(next.reopened).toBe("resume");
      expect(next.sessionId).toBe(first.sessionId);
      expect(parseResult((await next.prompt("repair")).text, BuildResult)).toMatchObject({ ok: true, value: { summary: "repair" } });
      expect(agents.received("build").map(prompt => prompt.turn)).toEqual([1, 2]);
      expect(agents.received()[0]).toMatchObject({ profileId: launch.profile.id, toolId: launch.profile.toolId, model: launch.profile.modelId ?? launch.profile.model });
      for (const [owner, launchOptions, participant] of [
        [new ScriptedAgents(() => ""), { ...options(), reopen: first.sessionId }, role],
        [agents, { ...options(), reopen: first.sessionId, profile: { ...launch.profile, modelId: "different-model" } }, role],
        [agents, { ...options(), reopen: first.sessionId }, { ...role, id: "another-builder" }],
      ] as const) expect(await rejectionOf(owner.start(launchOptions, participant))).toBeInstanceOf(ReopenFailed);
      expect(() => nativeAgentProcess(next)).toThrow("requires a native ACP agent process");
    } finally { await next.stop(); }
  });

  it("never calls the script after a pre-start abort, a pre-prompt stop or a startup callback abort", async () => {
    let calls = 0;
    const agents = new ScriptedAgents(() => { calls++; return "unused"; });
    const controller = new AbortController(); controller.abort();
    expect(String(await rejectionOf(agents.start(options(controller.signal), role)))).toContain("before the scripted session started");
    const closed = await agents.start(options(), role); await closed.stop();
    expect(String(await rejectionOf(closed.prompt("too late")))).toContain("stopped");
    const queued = await agents.start(options(), role);
    const reply = rejectionOf(queued.prompt("stop before the script runs"));
    await queued.stop();
    expect(String(await reply)).toContain("stopped");
    const active = new AbortController(), session = await agents.start(options(active.signal), role);
    session.onPromptStarted = () => active.abort();
    try { expect(String(await rejectionOf(session.prompt("cancel at admission")))).toContain("stopped"); }
    finally { await session.stop(); }
    expect(calls).toBe(0);
    expect(agents.received("build")).toHaveLength(0);
  });

  it("waits for a cancelled callback's effects to end before confirming stop", async () => {
    let enter!: () => void, release!: () => void, ended = false, signal: AbortSignal | undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const agents = new ScriptedAgents(async (_prompt, current) => { signal = current; enter(); await gate; ended = true; return "late reply"; });
    const session = await agents.start(options(), role);
    const reply = rejectionOf(session.prompt("hold"));
    let stopped: Promise<boolean> | undefined;
    try {
      await entered;
      expect(session.prompting).toBe(true);
      expect(String(await rejectionOf(session.prompt("overlap")))).toContain("already has a turn");
      stopped = session.stop();
      expect(signal?.aborted).toBe(true);
      expect(ended).toBe(false);
      release();
      expect(await stopped).toBe(true);
      expect(ended).toBe(true);
      expect(String(await reply)).toContain("stopped");
      expect(session.prompting).toBe(false);
    } finally { release(); await stopped; await reply; await session.stop(); }
  });

  it("keeps independent seats separate and passes invalid replies through to the real result parser", async () => {
    const agents = new ScriptedAgents(prompt => prompt.turn === 1 ? "not a result" : scriptedResult({ summary: prompt.text, changes: [] }));
    const sessions = await Promise.all([agents.start(options(), role), agents.start(options(), role)]);
    try {
      const first = await Promise.all(sessions.map(session => session.prompt("first")));
      expect(first.every(reply => parseResult(reply.text, BuildResult).ok === false)).toBe(true);
      const fixed = await Promise.all(sessions.map(session => session.prompt("corrected")));
      expect(fixed.every(reply => parseResult(reply.text, BuildResult).ok === true)).toBe(true);
      expect(new Set(agents.received("build").map(prompt => prompt.sessionId)).size).toBe(2);
      expect(agents.received("build").map(prompt => prompt.turn)).toEqual([1, 1, 2, 2]);
    } finally { await Promise.all(sessions.map(session => session.stop())); }
  });

  it("rejects browser coverage rather than silently pretending to launch it", async () => {
    const agents = new ScriptedAgents(() => "unused");
    expect(String(await rejectionOf(agents.start({ ...options(), browser: true }, role)))).toContain("require the native fake agent");
    expect(agents.received("build")).toHaveLength(0);
  });
});
