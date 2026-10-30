import { expect, it } from "vitest";
import { pauseTaskState, slotUses, slotWait } from "@petrina/core";
import { participantReadinessFixture } from "../../fixtures/participant-readiness.js";

/** The saved conversation is declared input; actual admission, selection and shared probes own its return. */
function builderReadiness() {
  const f = participantReadinessFixture(), task = f.current;
  task.plan = { rationale: "Return to the saved Builder", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
  ] };
  Object.assign(task, { stageIndex: 0, startedAt: f.clock.now(), fixing: true, state: "running", holdsSlot: true,
    agent: { roleId: "code-reviewer", profileId: "opus-high", since: f.clock.now(), step: 0 } });
  f.scope.work.builderSession = { stageId: "build", profileId: "sol-high", plannedProfileId: "opus-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "supplied:saved-builder" };
  f.scope.work.delivery = "local";
  Object.assign(f.queued, { state: "running", holdsSlot: true,
    agent: { roleId: "builder", profileId: "grok-high", since: f.clock.now(), step: 0 } });
  f.prerequisite.title = "Fix the capacity tests";
  f.uncertain("codex");
  return { ...f, task, ours: () => slotUses(f.snapshot()).filter(use => use.taskId === task.id),
    reserve: () => f.workflow["reserveAgent"](task),
    admit: (signal = f.stop.signal) => f.own(() => f.workflow["admitNext"](task, signal)),
    choose: () => f.selection.selection.choose("opus-high", f.scope, "builder", () => true),
  };
}

it("starts no returning Builder probe under a prerequisite hold, then admits the saved profile after the one answer", async () => {
  const f = builderReadiness(), held = f.holdProbe("codex");
  try {
    const saved = structuredClone(f.scope.work.builderSession!);
    f.hold();
    expect(f.reserve()).toBe(false); expect(await f.admit()).toBe(false);
    expect(f.probes).toEqual([]); expect(f.scope.work.builderSession!.readinessWait).toBeUndefined();
    expect(f.task.state).toBe("waiting"); expect(f.task.statusLine).toBe("Waiting for “Fix the capacity tests” to land");
    expect(f.ours()).toEqual([]);
    f.clear();
    Object.assign(f.task, { state: "running", holdsSlot: true,
      agent: { roleId: "builder", profileId: "sol-high", since: f.clock.now(), step: 0 } });
    const admitted = f.admit(); await held.entered(admitted); held.answer();
    expect(await admitted).toBe(true);
    expect(f.task.agent).toMatchObject({ roleId: "builder", profileId: saved.profileId });
    expect(f.scope.work.builderSession!.sessionId).toBe(saved.sessionId);
    expect(f.choose()).toMatchObject({ profile: { id: saved.profileId }, readiness: { outcome: "ready" } });
    expect(f.probes.map(probe => probe.id)).toEqual(["codex"]);
  } finally { await f.close(); }
});

it("yields a returning Builder's unused place when a prerequisite interrupts readiness without spending another probe", async () => {
  const f = builderReadiness(), held = f.holdProbe("codex");
  try {
    const saved = structuredClone(f.scope.work.builderSession!);
    const admitted = f.admit(); await held.entered(admitted);
    const wait = structuredClone(f.scope.work.builderSession!.readinessWait!);
    f.hold();
    expect(await admitted).toBe(false);
    expect(f.task.state).toBe("waiting"); expect(f.task.statusLine).toBe("Waiting for “Fix the capacity tests” to land");
    expect(f.ours()).toEqual([]); expect(f.agents.received()).toEqual([]);
    expect(f.scope.work.builderSession!.readinessWait).toEqual(wait);
    expect(f.scope.work.builderSession!.sessionId).toBe(saved.sessionId);
    const checking = f.checks.running("codex"); expect(checking).toBeDefined();
    held.answer(); await checking;
    f.clear();
    expect(await f.admit()).toBe(true);
    expect(f.task.agent).toMatchObject({ roleId: "builder", profileId: saved.profileId });
    expect(f.scope.work.builderSession!.readinessWait).toEqual(wait);
    expect(f.scope.work.builderSession!.sessionId).toBe(saved.sessionId);
    expect(f.probes.map(probe => probe.id)).toEqual(["codex"]);
  } finally { await f.close(); }
});

it("keeps one Builder place charged to the saved tool through the recheck and its actual next admission", async () => {
  const f = builderReadiness(), held = f.holdProbe("codex");
  try {
    const admitted = f.admit(); await held.entered(admitted);
    expect(f.task.statusLine).toBe("Checking Codex before the Builder returns");
    expect(f.ours()).toEqual([expect.objectContaining({ toolId: "codex", roleId: "builder", profileId: "sol-high" })]);
    expect(slotWait(f.snapshot(), { taskId: "next-in-queue", toolId: "claude-code" })).toBe("Waiting for a free slot");
    held.answer(); expect(await admitted).toBe(true);
    expect(f.task.agent).toMatchObject({ roleId: "builder", profileId: "sol-high" });
    expect(f.choose()).toMatchObject({ profile: { id: "sol-high" }, readiness: { outcome: "ready", check: "started" } });
  } finally { await f.close(); }
});

it("rechecks the Builder's actual admission after readiness so a newly lowered cap still applies", async () => {
  const f = builderReadiness(), held = f.holdProbe("codex");
  try {
    const admitted = f.admit(); await held.entered(admitted);
    f.state.pool.toolCaps.codex = 0; held.answer();
    expect(await admitted).toBe(true); expect(f.check("codex").status).toBe("ready");
    expect(f.catalog.profile(f.task.agent!.profileId)!.toolId).not.toBe("codex");
    expect(f.ours()).toEqual([expect.objectContaining({ roleId: "builder" })]);
  } finally { await f.close(); }
});

it("takes no place for a waiting Builder and ends a retained readiness wait on pause despite the later ready answer", async () => {
  const f = builderReadiness(), held = f.holdProbe("codex"), stop = new AbortController();
  try {
    Object.assign(f.task, { state: "waiting", holdsSlot: false }); delete f.task.agent;
    expect(f.reserve()).toBe(false);
    const checking = f.checks.running("codex")!; await held.entered(checking);
    expect(f.task.holdsSlot).toBe(false); expect(f.task.statusLine).toBe("Checking Codex before the Builder returns");
    expect(f.scope.work.builderSession!.readinessWait).toMatchObject({ check: "started" });
    Object.assign(f.task, { state: "running", holdsSlot: true });
    const admitted = f.admit(stop.signal);
    await f.waitFor(() => f.task.agent?.profileId === "sol-high", admitted, "the Builder's retained readiness place");
    stop.abort(); pauseTaskState(f.task, f.scope.work, f.clock.now());
    await expect(admitted.catch(error => f.errors.classify(error))).resolves.toMatchObject({ kind: "abort" });
    held.answer(); await checking;
    expect(f.check("codex").status).toBe("ready"); expect(f.task.state).toBe("paused");
    expect(f.task.holdsSlot).toBe(false); expect(f.probes.map(probe => probe.id)).toEqual(["codex"]);
  } finally { await f.close(); }
});
