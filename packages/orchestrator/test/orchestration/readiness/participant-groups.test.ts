import { expect, it } from "vitest";
import { slotUses, slotWait } from "@petrina/core";
import { ParallelAdmissionGroup } from "../../../src/parallel-admission-group.js";
import { readinessReviewersFixture } from "../../fixtures/readiness-reviewers.js";

for (const how of ["held", "clear", "landed", "none"] as const) it(`settles an idle group's readiness reservation and normal admission after ${how}`, async () => {
  const f = readinessReviewersFixture(), probe = f.holdProbe("grok");
  try {
    const drive = f.start();
    await f.waitFor(() => f.agents.received("findings").length === 1, drive, "the first reviewer");
    f.releases.release("opus-high");
    await probe.entered(drive);
    await f.waitFor(() => f.current.hunt?.reported["0"] && f.current.agent?.reviewKey === "reviewer:1", drive, "the idle group's reserved place");
    expect(f.ownership.drivers.has(f.current.id)).toBe(true);
    expect(f.ours()).toEqual([expect.objectContaining({ toolId: "grok" })]);
    const queued = f.enqueue();
    expect(queued.state).toBe("queued");
    if (how !== "none") {
      f.hold();
      expect(f.ours()).toEqual([]); expect(f.current.state).toBe("waiting"); expect(f.current.agent).toBeUndefined();
      expect(f.checks.running("grok")).toBeDefined();
      await drive;
      const queuedWork = f.ownership.settling.get(queued.id)!;
      await f.waitFor(() => f.agents.received("plan").length === 1, queuedWork, "queued work in the released place");
      expect(slotUses(f.snapshot()).map(use => use.taskId)).toEqual([queued.id]);
      if (how === "clear") f.clear();
      else if (how === "landed") {
        f.prerequisite.repository!.delivery = "local";
        f.prerequisite.repository!.landed = { branch: "main", sha: "supplied:confirmed-landing" };
        f.prerequisite.state = "done"; f.workflow.syncRuntimeWaits();
      }
    }
    const checking = f.checks.running("grok")!;
    probe.answer(); await checking;
    expect(f.check("grok").status).toBe("ready");
    if (how !== "none") {
      f.workflow.schedule();
      expect(f.ours()).toEqual([]); expect(f.current.hunt?.reported).toEqual({ "0": true });
      expect(f.agents.received("findings").map(prompt => prompt.profileId)).toEqual(["opus-high"]);
      if (how === "held") f.clear();
      await f.pauseQueued();
    }
    f.releases.release("grok-high"); f.workflow.schedule();
    const finishing = f.ownership.settling.get(f.current.id) ?? drive;
    await finishing;
    expect(f.current.error).toBeUndefined();
    expect(f.current.stageIndex).toBe(1);
    expect(f.current.rounds.review).toBe(2);
    expect(f.agents.received("findings").map(prompt => prompt.profileId)).toEqual(["opus-high", "grok-high"]);
    expect(f.current.hunt?.reported).toEqual({ "0": true, "1": true });
    expect(f.current.runtimeWait?.refreshPending).toBeUndefined();
    expect(f.probes.map(probe => probe.id)).toEqual(["grok"]);
  } finally { probe.answer(); await f.close(); }
});

it("starts neither a probe nor a reviewer for an already-held group", async () => {
  const f = readinessReviewersFixture();
  try {
    f.prerequisite.title = "Finish the required fix";
    f.current.state = "waiting"; f.current.held = false; f.hold(); f.workflow.schedule();
    const group = new ParallelAdmissionGroup(f.groupHost, { ownership: f.ownership, catalog: f.catalog, readiness: f.readiness, errors: f.errors });
    const unexpected = (): never => { throw new Error("A held group must not prepare or start a member"); };
    const round = f.own(() => group.run({ scope: f.scope, signal: f.stop.signal, status: () => "Waiting for reviewers",
      members: f.stage.profileIds.map((profileId, index) => ({ key: `review-${index}`, reviewKey: `reviewer:${index}`, reviewerKey: String(index), roleId: f.stage.roleId, profileId, work: unexpected })),
      workspaces: { reference: unexpected, prepare: unexpected, stopHelpers() {}, closeTaskRun() {}, releasedStops: async () => {}, finish: async () => {} },
    }));
    const failure = await round.then(() => { throw new Error("The held group unexpectedly ran"); }, error => error);
    expect(f.errors.classify(failure).kind).toBe("usage");
    expect(f.current.state).toBe("waiting"); expect(f.current.holdsSlot).toBe(false);
    expect(f.current.statusLine).toBe("Waiting for “Finish the required fix” to land");
    expect(f.probes).toEqual([]); expect(f.agents.received()).toEqual([]);
    expect(f.saved.readinessWait).toBeUndefined(); expect(f.ours()).toEqual([]);
    expect(f.current.hunt?.reported).toEqual({});
  } finally { await f.close(); }
});

for (const when of ["before", "after"] as const) it(`charges one place to the saved tool when the working peer finishes ${when} the check starts`, async () => {
  const f = readinessReviewersFixture(when === "before" ? 2 : 3), probe = f.holdProbe("grok");
  try {
    Object.assign(f.prerequisite, { state: "running", holdsSlot: true, agent: { roleId: "builder", profileId: "sol-high", since: f.clock.now(), step: 0 } });
    const drive = f.start();
    await f.waitFor(() => f.agents.received("findings").length === 1, drive, "the first reviewer");
    if (when === "after") {
      await probe.entered(drive); expect(f.ours().map(use => use.toolId)).toEqual(["claude-code"]);
      Object.assign(f.queued, { state: "running", holdsSlot: true, agent: { roleId: "builder", profileId: "astra-xhigh", since: f.clock.now(), step: 0 } });
    } else expect(f.probes).toEqual([]);
    f.releases.release("opus-high"); await probe.entered(drive);
    await f.waitFor(() => f.current.agent?.reviewKey === "reviewer:1", drive, "the remaining readiness reservation");
    expect(f.ours()).toEqual([expect.objectContaining({ toolId: "grok" })]);
    expect(f.current.helpers).toBeUndefined(); expect(f.current.holdsSlot).toBe(true);
    expect(f.current.statusLine).toBe("Checking Grok before returning to its saved conversation");
    expect(slotWait(f.snapshot(), { taskId: "next-in-queue", toolId: "codex" })).toBe("Waiting for a free slot");
    const since = f.seen.length;
    expect(f.seen.every(uses => uses.length <= 1)).toBe(true);
    f.releases.release("grok-high"); probe.answer(); await drive;
    expect(f.current.stageIndex).toBe(1); expect(f.probes).toHaveLength(1);
    expect(f.seen.slice(since).some(uses => uses.length > 0)).toBe(true);
    expect(f.seen.slice(since).every(uses => uses.length <= 1 && uses.every(tool => tool === "grok"))).toBe(true);
    expect(f.agents.received("findings").map(prompt => prompt.profileId)).toEqual(["opus-high", "grok-high"]);
  } finally { probe.answer(); await f.close(); }
});

it("does not recheck a saved tool that would break reviewer independence", async () => {
  const f = readinessReviewersFixture();
  try {
    f.current.hunt = { stageId: "review", round: 2, reported: { "0": true }, profiles: { "0": "grok-high" } };
    const choice = f.selection.selection.choose("grok-high", f.scope, "code-reviewer", () => true, "1");
    expect(choice).toEqual(expect.objectContaining({ freshReason: expect.stringContaining("independent") }));
    expect(choice?.kind === "none" ? undefined : choice?.profile.toolId).not.toBe("grok");
    expect(f.saved.readinessWait).toBeUndefined(); expect(f.probes).toEqual([]);
  } finally { await f.close(); }
});

it("releases the group's last place when an inconclusive reply leaves no eligible reviewer", async () => {
  const f = readinessReviewersFixture(), probe = f.holdProbe("grok");
  try {
    const drive = f.start(); f.releases.release("opus-high");
    await probe.entered(drive);
    f.state.pool.limited = f.state.tools.filter(tool => tool.id !== "grok").map(tool => ({ toolId: tool.id, until: f.clock.now() + 3_600_000, reason: "Supplied usage limit" }));
    probe.answer("unknown"); await drive;
    expect(f.check("grok").status).toBe("unknown"); expect(f.current.statusLine).toMatch(/^Waiting for usage/);
    expect(f.current.holdsSlot).toBe(false); expect(f.current.agent).toBeUndefined(); expect(f.current.state).toBe("waiting");
    expect(f.probes).toHaveLength(1); expect(f.agents.received("findings")).toHaveLength(1);
  } finally { probe.answer(); await f.close(); }
});
