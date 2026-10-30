import { emptyState, task, runUntil } from "../../fixtures/simulator.js";
import { describe, expect, it } from "vitest";

import { beginYouStep, endAgentStep, JOURNEY_WORDS } from "../../../src/journey.js";
import { slotUses } from "../../../src/scheduler.js";

import { Simulator } from "../../../src/sim.js";

describe("Simulator", () => {
  it("takes a bug from the queue to an open pull request without ever merging it itself", () => {
    const sim = new Simulator(emptyState(), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Fix the broken link", kind: "bug" });

    runUntil(sim, () => task(sim, id).state === "pr-open");

    const done = task(sim, id);
    expect(done.state).toBe("pr-open");
    expect(done.column).toBe("ready");
    expect(done.pr?.state).toBe("open");
    // The first reviewer found a blocking issue, the builder fixed it, the second round passed.
    expect(done.findings.find((finding) => finding.severity === "blocking")?.status).toBe("fixed");
    expect(done.findings.find((finding) => finding.severity === "blocking")?.confirmedBy).toHaveLength(1);
  });

  it("waits at the delivery gate without holding a pool slot", () => {
    const sim = new Simulator(emptyState(1));
    const id = sim.addTask({ productId: "p", title: "Tidy the footer", kind: "chore" });
    for (let tick = 0; tick < 200 && !sim.getState().inbox.some((item) => item.kind === "delivery"); tick += 1) sim.tick();

    expect(task(sim, id).state).toBe("needs-you");
    expect(task(sim, id).holdsSlot).toBe(false);
    expect(slotUses(sim.getState())).toHaveLength(0);
  });

  it("settles a design only after the architect answers the blocking objection", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "feature" });
    for (let tick = 0; tick < 200 && !sim.getState().inbox.some((item) => item.kind === "design"); tick += 1) sim.tick();

    const designed = task(sim, id);
    expect(designed.brief).toBeDefined();
    expect(designed.objections.filter((objection) => objection.blocking).every((objection) => objection.status === "accepted")).toBe(true);
  });

  it("retries a stuck failed task back to completion while ignoring non-stuck gates", () => {
    const seeded = emptyState(1);
    const bootstrap = new Simulator(seeded);
    const id = bootstrap.addTask({ productId: "p", title: "Recover stuck build", kind: "bug" });
    bootstrap.tick();

    const state = JSON.parse(JSON.stringify(bootstrap.getState()));
    const failed = state.tasks.find((entry: { id: string }) => entry.id === id);
    failed.state = "failed";
    failed.holdsSlot = false;
    delete failed.agent;
    failed.error = "Agent disconnected";
    failed.statusLine = "Stuck: Agent disconnected";
    failed.checks = { at: state.now, current: true, sha: "abc1234", tree: "def5678", results: [] };
    endAgentStep(failed, { outcome: JOURNEY_WORDS.stuck, reason: JOURNEY_WORDS.stuckReason, tone: "stuck", end: "failed" }, state.now);
    beginYouStep(failed, "stuck", state.now);
    state.inbox.push(
      { id: "stuck-1", taskId: id, kind: "stuck", title: "“Recover stuck build” is stuck", body: "Agent disconnected", at: state.now, blocking: false },
      { id: "gate-1", taskId: id, kind: "delivery", title: "Approve delivery", at: state.now, blocking: false },
    );

    const sim = new Simulator(state, { log: bootstrap.workLog, open: bootstrap.openWork(), prMergeAfter: 1_000 });
    sim.retry("gate-1");
    expect(sim.getState().inbox.map((item) => item.id)).toEqual(["stuck-1", "gate-1"]);
    expect(task(sim, id).state).toBe("failed");

    sim.retry("stuck-1");
    const retried = task(sim, id);
    expect(sim.getState().inbox.map((item) => item.id)).toEqual(["gate-1"]);
    expect(retried.error).toBeUndefined();
    expect(retried.checks?.current).toBe(false);
    expect(retried.checks?.sha).toBeUndefined();
    expect(retried.checkSetupInvalidated?.kind).toBe("explicit-rerun");
    expect(retried.state).toBe("running");
    expect(retried.timeline.at(-2)?.text).toBe("You asked to try again");
    expect(sim.workLog.moments({ taskId: id }).some((moment) => moment.kind === "retry")).toBe(true);
  });
});
