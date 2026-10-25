import { emptyState, task, runUntil } from "../../fixtures/simulator.js";
import { describe, expect, it } from "vitest";

import { CLEANUP_WORDS } from "../../../src/cleanup.js";

import type { Task } from "../../../src/model.js";

import { Simulator } from "../../../src/sim.js";

import { MemoryWorkLog } from "../../../src/worklog.js";

describe("Removing the working copies of finished tasks", () => {
  const texts = (entry: Task) => entry.timeline.map((line) => line.text);

  it("keeps simulated GitHub progress outside tasks when handing the demo to another simulator", () => {
    const sim = new Simulator(emptyState(), { prMergeAfter: 10 });
    const id = sim.addTask({ productId: "p", title: "Tidy the footer", kind: "chore", delivery: "pull-request" });
    runUntil(sim, () => task(sim, id).state === "pr-open");
    sim.tick(); sim.tick();
    const open = sim.openWork();
    expect(open.pullRequests.find(([taskId]) => taskId === id)?.[1]).toBeGreaterThanOrEqual(2);
    expect("prAge" in task(sim, id)).toBe(false);
    const resumed = new Simulator(sim.getState(), { prMergeAfter: 10, open, log: sim.workLog });
    for (let tick = open.pullRequests.find(([taskId]) => taskId === id)![1]; tick <= 10; tick++) resumed.tick();
    expect(task(resumed, id).pr?.state).toBe("merged");
    expect(resumed.openWork().pullRequests.some(([taskId]) => taskId === id)).toBe(false);
  });

  it("removes a delivered task's copy right after the delivery, and keeps one with an open pull request until it is merged", () => {
    const log = new MemoryWorkLog(0);
    const sim = new Simulator(emptyState(), { prMergeAfter: 3, log });
    const local = sim.addTask({ productId: "p", title: "Tidy the footer", kind: "chore", delivery: "local" });
    const pr = sim.addTask({ productId: "p", title: "Fix the broken link", kind: "bug", delivery: "pull-request" });

    runUntil(sim, () => task(sim, local).state === "done" && task(sim, pr).state === "pr-open");
    expect(task(sim, local).cleanup?.removedAt).toBeDefined();
    expect(texts(task(sim, local)).indexOf(CLEANUP_WORDS.removed)).toBeGreaterThan(texts(task(sim, local)).findIndex((text) => text.startsWith("Petrina moved")));
    expect(task(sim, pr).cleanup).toBeUndefined();
    expect(texts(task(sim, pr))).not.toContain(CLEANUP_WORDS.removed);

    runUntil(sim, () => task(sim, pr).state === "done");
    expect(task(sim, pr).cleanup?.removedAt).toBeDefined();
    expect(texts(task(sim, pr)).indexOf(CLEANUP_WORDS.removed)).toBeGreaterThan(texts(task(sim, pr)).findIndex((text) => text.startsWith("Merged on GitHub")));
    expect(log.moments({ taskId: pr, kinds: ["task-end"] }).map((entry) => entry.outcome)).toEqual(["delivered", "merged"]);
  });

  it("keeps a cancelled task's copy while its pull request is open, and says nothing for a task that never started", () => {
    const sim = new Simulator({ ...emptyState(1), pool: { limit: 1, paused: false, toolCaps: {} } }, { prMergeAfter: 1_000 });
    const pr = sim.addTask({ productId: "p", title: "Fix the broken link", kind: "bug" });
    const queued = sim.addTask({ productId: "p", title: "Not started", kind: "chore" });
    sim.cancel(queued);
    expect(task(sim, queued).cleanup).toBeUndefined();
    expect(texts(task(sim, queued)).some((text) => text.includes("working copy"))).toBe(false);

    runUntil(sim, () => task(sim, pr).state === "pr-open");
    sim.cancel(pr);
    sim.tick();
    expect(task(sim, pr).state).toBe("cancelled");
    expect(task(sim, pr).cleanup).toBeUndefined();
    for (let tick = 0; tick < 1_000; tick += 1) sim.tick();
    expect(task(sim, pr).state).toBe("cancelled");
    expect(task(sim, pr).pr?.state).toBe("merged");
    expect(task(sim, pr).cleanup?.removedAt).toBeDefined();
  });

  it("removes a running task's copy when it is cancelled", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Search", kind: "chore" });
    sim.tick();
    sim.cancel(id);
    expect(task(sim, id).cleanup?.removedAt).toBeDefined();
    expect(texts(task(sim, id)).slice(-2)).toEqual(["You cancelled it", CLEANUP_WORDS.removed]);
  });

  it("says once that a locked copy could not be removed, and removes it at the next try", () => {
    const seed = new Simulator(emptyState());
    const id = seed.addTask({ productId: "p", title: "Tidy the footer", kind: "chore", delivery: "local" });
    const sim = new Simulator(seed.getState(), { lockedCopies: [id] });
    runUntil(sim, () => task(sim, id).state === "done");
    expect(task(sim, id).cleanup).toEqual({ error: CLEANUP_WORDS.locked });
    expect(texts(task(sim, id)).at(-1)).toBe(CLEANUP_WORDS.failed(CLEANUP_WORDS.locked));

    sim.tick();
    expect(task(sim, id).cleanup?.removedAt).toBeDefined();
    expect(texts(task(sim, id)).slice(-2)).toEqual([CLEANUP_WORDS.failed(CLEANUP_WORDS.locked), CLEANUP_WORDS.removed]);
    sim.tick();
    expect(texts(task(sim, id)).filter((text) => text === CLEANUP_WORDS.removed)).toHaveLength(1);
  });
});
