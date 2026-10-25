import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../../fake-agent.js";
import { executionFor } from "@petrina/orchestrator";
import { runtimeWaitView, slotUses, type Task } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Fakes, FAKE_AGENT, git, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** Admit only the workflow under test; every fake turn has an explicit release signal. */
async function fixture(parallel = false, scenario: Partial<Scenario> = {}) {
  const root = tempDir("petrina-runtime-wait-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ controlled: true, planner: parallel ? "parallel" : "short", builder: "plain", reopen: "resume", ...scenario });
  // Voter selection uses installed tools, independently of the scripted agent command.
  const options = { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir], toolPath: () => process.execPath, remote: join(root, "origin.git") };
  const home = join(root, "data");
  const engine = new Engine(home, options);
  const clone = await makeProduct(root);
  const productId = await engine.addProduct(clone);
  engine.setProductDelivery(productId, "local", true);
  engine.setProductChecks(productId, [{ name: "Version", command: "git --version" }]);
  const prerequisite = engine.addTask({ productId, title: "Fix capacity", backlog: true });
  const id = engine.addTask({ productId, title: "Keep current progress", description: "[no-check]" });
  const release = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
  const task = (owner = engine): Task => owner.taskDetails(id)!;
  const answer = (owner = engine) => {
    for (const item of owner.getState().inbox) {
      if (item.taskId !== id) continue;
      if (item.kind === "plan") owner.approve(item.id);
      else if (item.kind === "permission") owner.allow(item.id, "once");
      else if (item.kind === "question") owner.answer(item.id, item.options?.[0] ?? "Yes");
    }
  };
  /** What decides the task's next admission, bounded. */
  const admission = (owner = engine) => {
    const current = task(owner), view = runtimeWaitView(current, other => owner.taskDetails(other)), active = owner.activeState();
    return JSON.stringify({
      state: current.state, status: current.statusLine, holdsSlot: current.holdsSlot, agent: current.agent?.roleId,
      driver: owner.drivers.has(id), settling: owner.settling.has(id),
      wait: view && { held: view.held, phase: view.phase, releaseReason: view.releaseReason, refreshPending: current.runtimeWait?.refreshPending, prerequisites: view.prerequisites.map(entry => ({ id: entry.id, state: entry.state })) },
      pool: { limit: active.pool.limit, paused: active.pool.paused, slots: slotUses(active).map(use => ({ taskId: use.taskId, roleId: use.roleId })) },
      inbox: active.inbox.filter(item => item.taskId === id).map(item => ({ kind: item.kind, title: item.title })),
    });
  };
  // A wait that cannot finish prints what still decides admission on its own line, which a saved Tests log keeps.
  const until = <T>(read: () => T | undefined | false, words: string, owner = engine) => waitFor(() => {
    answer(owner);
    if (task(owner).state === "failed") throw new Error(task(owner).error);
    return read();
  }, words, 60_000).catch((error: unknown) => {
    try { console.warn(`Admission state after waiting for ${words}: ${admission(owner)}`); } catch { /* Diagnostics never replace the test's result. */ }
    throw error;
  });
  const builder = await until(() => {
    for (const p of fakes.received()) if (p.role !== "builder") release(p.session);
    return fakes.received("builder")[0];
  }, "the Builder to start");
  const hold = (owner = engine) => { owner.setRuntimeWait(id, [prerequisite], "The Linux checks need the capacity fix", "hold"); owner.schedule(); };
  const settled = (owner = engine) => until(() => task(owner).state === "waiting" && !owner.settling.has(id) && task(owner), "the held task to settle", owner);
  return { engine, fakes, clone, productId, prerequisite, id, release, task, answer, until, builder, hold, settled, home, options };
}

describe.concurrent("runtime prerequisites", () => {
  it("accepts the admitted Builder once, frees its slot, survives restart and keeps non-landing prerequisites held", async () => {
    const r = await fixture(); let owner = r.engine;
    try {
      const rounds = structuredClone(r.task().rounds);
      r.hold();
      expect(runtimeWaitView(r.task(), id => owner.taskDetails(id))?.phase).toBe("after-current-work");
      expect(r.fakes.received("code reviewer")).toHaveLength(0);
      r.release(r.builder.session);
      const held = await r.settled();
      expect(held.holdsSlot).toBe(false);
      expect(held.rounds).toEqual(rounds);
      expect(held.checks).toBeUndefined();
      expect(held.journey?.flatMap(step => step.agentResults ?? []).filter(result => result.roleId === "builder")).toHaveLength(1);
      expect(held.timeline.some(entry => /rethink|rounds used up|fresh.*wait/i.test(entry.text))).toBe(false);
      const opens = r.fakes.opens().length;
      owner.setPoolPaused(true); owner.setPoolPaused(false);
      expect(r.task().runtimeWait?.changes).toHaveLength(1);
      await owner.shutdown();
      owner = new Engine(r.home, r.options);
      expect(owner.taskDetails(r.id)?.runtimeWait).toMatchObject({ reason: "The Linux checks need the capacity fix", after: [r.prerequisite] });
      owner.schedule();
      expect(owner.taskDetails(r.id)?.holdsSlot).toBe(false);
      expect(r.fakes.opens()).toHaveLength(opens);
      owner.cancel(r.prerequisite);
      expect(runtimeWaitView(owner.taskDetails(r.id)!, id => owner.taskDetails(id))).toMatchObject({ held: true, decisionNeeded: true, prerequisites: [{ id: r.prerequisite, state: "cancelled" }] });
      expect(owner.taskDetails(r.id)?.statusLine).toContain("Waiting for your decision");
      expect(r.fakes.opens()).toHaveLength(opens);
      owner.cancel(r.id);
      expect(owner.taskDetails(r.id)?.runtimeWait?.releaseReason).toBe("The task was cancelled");
    } finally { await owner.shutdown(); }
  });

  it("keeps an unfinished review on its saved version, then updates before the next new step", async () => {
    const r = await fixture(true);
    try {
      // One pool seat admits the first reviewer; the other seat remains unstarted.
      r.engine.setPoolLimit(1);
      r.release(r.builder.session);
      const reviewer = await r.until(() => r.fakes.received("code reviewer")[0], "one reviewer to start");
      r.hold();
      r.release(reviewer.session);
      const held = await r.settled();
      expect(r.fakes.received("code reviewer")).toHaveLength(1);
      expect(Object.keys(held.hunt!.reported)).toHaveLength(1);
      const stage = held.plan!.stages[held.stageIndex]!;
      expect(held.rounds[stage.id] ?? 1).toBe(1);
      const partial = held.journey?.findLast(step => step.roleId === "code-reviewer");
      expect(partial?.endedAt).toBeUndefined();
      expect(partial?.agentResults).toHaveLength(1);
      expect(partial?.result?.findingsSettled).toBeUndefined();
      const firstReport = structuredClone(partial!.agentResults![0]);
      const base = held.baseSha;
      r.engine.sendMessage(r.id, "Keep the final Linux validation report", "queue");
      writeFileSync(join(r.clone, "incoming.txt"), "A fix on the starting branch");
      await git(r.clone, "add", "incoming.txt"); await git(r.clone, "commit", "-qm", "Fix capacity");
      await git(r.clone, "push", "-q", "origin", "main");
      const latest = await git(r.clone, "rev-parse", "HEAD");
      r.engine.setRuntimeWait(r.id, [], "The coordinator resolved the prerequisite", "clear"); r.engine.schedule();
      const second = await r.until(() => r.fakes.received("code reviewer")[1], "the missing reviewer to start");
      expect(r.task().baseSha).toBe(base);
      expect(r.fakes.received("code reviewer").filter(p => p.session === reviewer.session)).toHaveLength(1);
      r.release(second.session);
      const final = await r.until(() => {
        for (const p of r.fakes.received()) r.release(p.session);
        return r.engine.getState().inbox.some(item => item.taskId === r.id && item.kind === "delivery") && r.task();
      }, "the original review to settle and delivery to update");
      expect(final.baseSha).toBe(latest);
      expect(r.fakes.received("code reviewer")).toHaveLength(2);
      expect(final.journey?.flatMap(step => step.agentResults ?? []).filter(result => result.roleId === "code-reviewer")).toHaveLength(2);
      expect(final.timeline.some(entry => /rethink|rounds used up/.test(entry.text))).toBe(false);
      expect(r.fakes.received("code reviewer").filter(p => p.text.includes("Keep the final Linux validation report"))).toHaveLength(1);
      expect(final.queued).toEqual([]);
      const completed = final.journey?.findLast(step => step.roleId === "code-reviewer");
      expect(completed?.result?.findingsSettled).toBe(true);
      expect(completed?.agentResults?.[0]).toEqual(firstReport);
    } finally { await r.engine.shutdown(); }
  });

  it("releases only on confirmed landing and lets another task on the same product use the free seat", async () => {
    const r = await fixture();
    try {
      r.engine.setPoolLimit(1); r.hold(); r.release(r.builder.session); await r.settled();
      const other = r.engine.addTask({ productId: r.productId, title: "Unrelated work" });
      await r.until(() => r.engine.taskDetails(other)?.agent?.roleId === "planner", "another task to use the seat");
      expect(r.task().holdsSlot).toBe(false);
      r.engine.cancel(other);
      // The cancelled task's seat is free at once, but nothing has landed: the hold still keeps the reviewer out.
      expect(slotUses(r.engine.activeState())).toEqual([]);
      expect(runtimeWaitView(r.task(), id => r.engine.taskDetails(id))).toMatchObject({ held: true, phase: "active", decisionNeeded: false });
      expect(r.fakes.received("code reviewer")).toHaveLength(0);
      const sha = await git(r.clone, "rev-parse", "HEAD");
      // Any save, including the engine's own timed one, moves a finished task without a working copy to History. Marked done
      // before a slow read and given its landing after it, the prerequisite was archived as done without a confirmed delivery,
      // and the wait rightly held for a decision. This save makes that order fail every time; the finish and landing go together.
      r.engine.commitNow();
      const required = r.engine.task(r.prerequisite)!;
      required.state = "done";
      required.repository!.landed = { branch: "main", sha };
      required.repository!.localUpdate = { ...required.repository!.landed, pushed: true };
      r.engine.commitNow(required); r.engine.schedule();
      await r.until(() => r.fakes.received("code reviewer")[0], "normal admission after landing");
      expect(r.task().runtimeWait).toMatchObject({ releaseReason: "All required tasks landed" });
      expect(r.task().runtimeWait?.refreshPending).toBeUndefined();
    } finally { await r.engine.shutdown(); }
  });

  it("stops rather than using an older GitHub source when release cannot fetch", async () => {
    const r = await fixture();
    try {
      r.hold(); r.release(r.builder.session); await r.settled();
      const current = r.engine.task(r.id)!;
      executionFor(current).work.delivery = "pull-request";
      const fetch = r.engine["connections"].fetchDefault.bind(r.engine["connections"]);
      r.engine["connections"].fetchDefault = async () => ({ ok: false, missing: true, error: "The approved source could not be reached" });
      r.engine.setRuntimeWait(r.id, [], "Continue on the approved source", "clear"); r.engine.schedule();
      const failed = await waitFor(() => r.task().state === "failed" && r.task(), "the unavailable latest source to stop the task");
      expect(failed.error).toContain("could not get the latest starting code");
      expect(r.fakes.received("code reviewer")).toHaveLength(0);
      expect(failed.runtimeWait?.refreshPending).toBe(true);
      // Retry uses the saved release intent and still obtains the current source before any reviewer.
      executionFor(current).work.delivery = "local";
      r.engine["connections"].fetchDefault = fetch;
      const item = r.engine.getState().inbox.find(item => item.taskId === r.id && item.kind === "stuck")!;
      await r.engine.retry(item.id);
      const resumed = await r.until(() => {
        for (const p of r.fakes.received()) r.release(p.session);
        return r.engine.getState().inbox.some(item => item.taskId === r.id && item.kind === "delivery") && r.task();
      }, "the saved release to recover through ordinary review");
      expect(resumed.runtimeWait?.refreshPending).toBeUndefined();
      expect(r.fakes.received("code reviewer")).toHaveLength(1);
    } finally { await r.engine.shutdown(); }
  });

  it("keeps an admitted vote and blocks its missing voter until release", async () => {
    const r = await fixture();
    try {
      r.fakes.scenario({ controlled: true, planner: "short", builder: "plain", reviewer: "important", verifier: "not-a-bug", reopen: "resume" });
      r.engine.setPoolLimit(1);
      r.release(r.builder.session);
      const voter = await r.until(() => {
        for (const p of r.fakes.received()) if (p.role !== "verifier") r.release(p.session);
        return r.fakes.received("verifier")[0];
      }, "one voter to start");
      r.hold(); r.release(voter.session);
      const held = await r.settled();
      expect(r.fakes.received("verifier")).toHaveLength(1);
      expect(held.findings.flatMap(f => f.votes ?? [])).toHaveLength(1);
      expect(held.findings.some(f => f.verification)).toBe(false);
      const partialVote = held.journey?.findLast(step => step.roleId === "verifier");
      expect(partialVote?.result?.findingsSettled).toBeUndefined();
      const firstVote = structuredClone(partialVote!.agentResults![0]);
      const stage = held.plan!.stages[held.stageIndex]!;
      expect(held.rounds[stage.id] ?? 1).toBe(1);
      r.engine.setRuntimeWait(r.id, [], "The vote can finish", "clear"); r.engine.schedule();
      const final = await r.until(() => {
        for (const p of r.fakes.received()) r.release(p.session);
        return r.engine.getState().inbox.some(item => item.taskId === r.id && item.kind === "delivery") && r.task();
      }, "the saved vote to finish");
      expect(r.fakes.received("verifier").filter(p => p.session === voter.session)).toHaveLength(1);
      expect(final.findings.flatMap(f => f.votes ?? []).length).toBeGreaterThanOrEqual(2);
      expect(final.journey?.flatMap(s => s.agentResults ?? []).filter(a => a.roleId === "verifier")).toHaveLength(r.fakes.received("verifier").length);
      expect(final.journey?.filter(step => step.roleId === "verifier").some(step => step.result?.findingsSettled)).toBe(true);
      expect(final.journey?.flatMap(step => step.agentResults ?? []).filter(result => result.roleId === "verifier")[0]).toEqual(firstVote);
    } finally { await r.engine.shutdown(); }
  });

  it("keeps a refused admitted agent's conversation without admitting its replacement", async () => {
    const r = await fixture(false, { capacity: [{ model: "gpt-6.1-sol", role: "builder", times: 1, waitFor: "capacity-release" }] });
    try {
      r.hold(); writeFileSync(join(r.fakes.dir, "capacity-release"), "go");
      const held = await r.settled();
      expect(r.fakes.received("builder")).toHaveLength(1);
      expect(held.conversation?.sessionId).toBe(r.builder.session);
      expect(held.rounds).toEqual({});
      expect(held.timeline.some(entry => entry.text.includes("Started a fresh conversation"))).toBe(false);
      expect(held.runtimeWait?.refreshAfterStep).toBeDefined();
    } finally { await r.engine.shutdown(); }
  });

  it("uses the existing Builder port when incoming fixes conflict", async () => {
    const r = await fixture();
    try {
      r.hold(); r.release(r.builder.session); await r.settled();
      writeFileSync(join(r.clone, "greeting.txt"), "A different greeting from main\n");
      await git(r.clone, "add", "greeting.txt"); await git(r.clone, "commit", "-qm", "Update the shared greeting");
      await git(r.clone, "push", "-q", "origin", "main");
      const latest = await git(r.clone, "rev-parse", "HEAD");
      r.engine.setRuntimeWait(r.id, [], "Continue with the approved fixes", "clear"); r.engine.schedule();
      const final = await r.until(() => {
        for (const p of r.fakes.received()) r.release(p.session);
        return r.engine.getState().inbox.some(item => item.taskId === r.id && item.kind === "delivery") && r.task();
      }, "the ordinary Builder port and review to finish");
      expect(final.baseSha).toBe(latest);
      expect(final.updating).toBeUndefined();
      expect(r.fakes.received("builder")).toHaveLength(2);
      expect(final.timeline.some(entry => entry.text.includes("builder brings it up to date"))).toBe(true);
      expect(final.timeline.some(entry => /rethink|rounds used up/.test(entry.text))).toBe(false);
      expect(final.runtimeWait?.refreshPending).toBeUndefined();
    } finally { await r.engine.shutdown(); }
  });

  it("keeps the normal no-wait workflow unchanged", async () => {
    const r = await fixture();
    try {
      const final = await r.until(() => {
        for (const p of r.fakes.received()) r.release(p.session);
        return r.engine.getState().inbox.some(item => item.taskId === r.id && item.kind === "delivery") && r.task();
      }, "the normal delivery checkpoint");
      expect(final.runtimeWait).toBeUndefined();
      expect(final.journey?.some(step => step.runtimeWait === true)).toBe(false);
      expect(r.fakes.received("builder")).toHaveLength(1);
    } finally { await r.engine.shutdown(); }
  });
});
