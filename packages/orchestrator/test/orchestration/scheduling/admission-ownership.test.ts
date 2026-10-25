import { describe, expect, it } from "vitest";
import { slotUses, stepKey } from "@petrina/core";
import { admissionFixture } from "../../fixtures/agent-workflow.js";
import { deferred } from "../../fixtures/tool-checks.js";
import { parallelFixture } from "../../fixtures/parallel-admission.js";

describe("selected participant admission", () => {
  it("retains the current reservation until the selected tool has room, then consumes the exact pending step", async () => {
    const f = admissionFixture(2, 1, 2), [task, peer] = f.ids.map(id => f.task(id)!);
    try {
      f.state.pool.paused = false; f.state.pool.toolCaps.codex = 1;
      task!.state = peer!.state = "running"; task!.holdsSlot = peer!.holdsSlot = true;
      task!.agent = { roleId: "planner", profileId: "opus-high", since: f.clock.now(), step: 0 };
      peer!.agent = { roleId: "builder", profileId: "sol-high", since: f.clock.now(), step: 0 };
      const request = { task: task!, profile: f.catalog.profile("sol-high")!, roleId: "builder", step: stepKey(task!) };
      let rejected: unknown;
      try { f.workflow.qualify(request, new AbortController().signal); } catch (error) { rejected = error; }
      expect(f.errors.classify(rejected)).toMatchObject({ kind: "usage", words: "Waiting for a free Codex slot" });
      expect(f.ownership.pendingAdmissions.get(task!.id)).toEqual({ step: request.step, roleId: "builder", profileId: "sol-high" });
      expect(task!.agent?.profileId).toBe("opus-high");
      expect(slotUses(f.snapshot())).toHaveLength(2);
      peer!.holdsSlot = false; delete peer!.agent;
      f.workflow.qualify(request, new AbortController().signal);
      expect(f.ownership.pendingAdmissions.has(task!.id)).toBe(false);
      // Qualification has no checkpoint/activation side effect; the native caller still prepares its clock first.
      expect(task!.agent?.profileId).toBe("opus-high");
      const agent = f.workflow.activate(request);
      expect(task!.agent).toBe(agent);
      expect(slotUses(f.snapshot())).toEqual([expect.objectContaining({ taskId: task!.id, profileId: "sol-high", toolId: "codex" })]);
    } finally { await f.close(); }
  });

  it("throws the host's exact abort, source-refresh and admission-closed errors before activation", async () => {
    const f = admissionFixture(2, 1, 1), task = f.task(f.ids[0]!)!;
    try {
      const request = { task, profile: f.catalog.profile("opus-high")!, roleId: "planner", step: stepKey(task) };
      const aborted = new Error("owned abort"), refresh = new Error("owned source refresh"), closed = new Error("owned usage wait");
      f.errors.aborted = () => aborted; f.errors.sourceRefresh = () => refresh; f.errors.usage = () => closed;
      const signal = new AbortController(); signal.abort();
      const thrown = (run: () => void) => { try { run(); return { threw: false, error: undefined }; } catch (error) { return { threw: true, error }; } };
      const stopped = thrown(() => f.workflow.qualify(request, signal.signal));
      expect(stopped.threw).toBe(true); expect(stopped.error).toBe(aborted);
      const waiting = thrown(() => f.workflow.qualify(request, new AbortController().signal));
      expect(waiting.threw).toBe(true); expect(waiting.error).toBe(closed);
      f.state.pool.paused = false; f.host.sourceRefreshDue = () => true;
      const moved = thrown(() => f.workflow.qualify(request, new AbortController().signal));
      expect(moved.threw).toBe(true); expect(moved.error).toBe(refresh);
      expect(task.agent).toBeUndefined(); expect(task.holdsSlot).toBe(false);
      expect(f.ownership.pendingAdmissions.size).toBe(0);
    } finally { await f.close(); }
  });
});

describe("parallel admission ownership", () => {
  it("publishes each reservation before a reentrant profile checkpoint and native preparation", async () => {
    const f = parallelFixture(), release = deferred<void>(), started: string[] = [];
    let done: Promise<void> | undefined;
    try {
      const remember = f.groupHost.rememberReviewer;
      f.groupHost.rememberReviewer = (task, key, profile) => {
        expect(f.ownership.groups.get(task.id)?.running(`review-${key}`)).toBe(true);
        const uses = slotUses(f.snapshot());
        expect(uses.some(use => use.profileId === profile)).toBe(true);
        expect(uses.length).toBeLessThanOrEqual(2);
        // Actual reentrant group entry sees the same running map, rather than another admission counter.
        f.ownership.groups.get(task.id)!.rejoin!();
        remember(task, key, profile);
      };
      f.workspaces.prepare = async member => {
        expect(f.ownership.groups.get(f.current.id)?.running(member.key)).toBe(true);
        started.push(member.key);
        return { activate() {}, finish() { f.effects.push(`finish:${member.key}`); } };
      };
      const members = [f.member("0", async () => { await release.promise; }), f.member("1", async () => { await release.promise; })];
      done = f.group.run(f.request(members));
      await f.waitFor(() => started.length === 2, "both prepared members", 1_000, done);
      expect(started).toEqual(["review-0", "review-1"]);
      expect(slotUses(f.snapshot())).toHaveLength(2);
      release.resolve(); await done;
      expect(f.effects).toContain("finish:review-0"); expect(f.effects).toContain("finish:review-1");
      expect(f.ownership.groups.size).toBe(0);
    } finally { release.resolve(); f.stop.abort(); await done?.catch(() => undefined); await f.close(); }
  });

  it("keeps ownership through member result and workspace finally, then observes released stops before read-only cleanup", async () => {
    const f = parallelFixture(), release = deferred<void>();
    let done: Promise<void> | undefined, released = false, workEnded = false, entered = false;
    try {
      const role = f.catalog.role;
      f.catalog.role = (id, task) => { if (released) f.effects.push("readOnlyRole"); return role(id, task); };
      f.workspaces.prepare = async member => ({ activate() {}, finish() {
        expect(workEnded).toBe(true); expect(f.ownership.groups.get(f.current.id)?.running(member.key)).toBe(true);
        f.effects.push("workspaceFinally");
      } });
      f.workspaces.releasedStops = async () => { expect(f.ownership.groups.size).toBe(0); released = true; f.effects.push("releasedStops"); };
      f.workspaces.finish = async () => { expect(f.effects).toContain("workspaceFinally"); expect(released).toBe(true); f.effects.push("finishCopies"); };
      done = f.group.run(f.request([f.member("0", async () => { entered = true; await release.promise; workEnded = true; })]));
      await f.waitFor(() => entered, "the working member", 1_000, done);
      expect(f.ownership.groups.get(f.current.id)?.running("review-0")).toBe(true);
      expect(f.scheduled).toHaveLength(0);
      release.resolve(); await done;
      expect(f.effects.indexOf("workspaceFinally")).toBeLessThan(f.effects.indexOf("releasedStops"));
      expect(f.effects.indexOf("releasedStops")).toBeLessThan(f.effects.indexOf("readOnlyRole"));
      expect(f.effects.at(-1)).toBe("finishCopies");
    } finally { release.resolve(); f.stop.abort(); await done?.catch(() => undefined); await f.close(); }
  });

  it("settles actual prepared member ownership when cancelled, without admitting pending peers", async () => {
    const f = parallelFixture();
    let done: Promise<void> | undefined, entered = false, ended = false;
    try {
      f.state.pool.limit = 1;
      const work = f.member("0", async (_copy, _room, _seat, _used, _agent, _continuing, signal) => {
        entered = true; await new Promise<void>(resolve => { signal.addEventListener("abort", () => { ended = true; resolve(); }, { once: true }); });
      });
      done = f.group.run(f.request([work, f.member("1", async () => { throw new Error("Cancelled peer must not start"); })]));
      await f.waitFor(() => entered, "the cancellable member", 1_000, done); f.stop.abort(); await done;
      expect(ended).toBe(true);
      expect(f.effects.filter(value => value.startsWith("prepare:"))).toEqual(["prepare:review-0"]);
      expect(f.effects).toContain("finish:review-0"); expect(f.effects).toContain("closeTaskRun");
      expect(f.ownership.groups.size).toBe(0);
    } finally { f.stop.abort(); await done?.catch(() => undefined); await f.close(); }
  });

  for (const rejected of [new Error("member failed"), undefined]) {
    it(`preserves ${rejected === undefined ? "undefined" : "Error"} rejection as failure after settling prepared copies`, async () => {
      const f = parallelFixture(); let done: Promise<void> | undefined;
      try {
        done = f.group.run(f.request([f.member("0", async () => { throw rejected; })]));
        const outcome = await done.then(() => ({ failed: false, error: undefined }), error => ({ failed: true, error }));
        expect(outcome.failed).toBe(true); expect(outcome.error).toBe(rejected);
        expect(f.effects).toContain("finish:review-0"); expect(f.effects).toContain("closeTaskRun");
        expect(f.effects.at(-1)).toBe("finishCopies:true");
        expect(f.ownership.groups.size).toBe(0);
      } finally { f.stop.abort(); await done?.catch(() => undefined); await f.close(); }
    });
  }
});
