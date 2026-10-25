import { emptyState, task, runUntil } from "../../fixtures/simulator.js";
import { describe, expect, it } from "vitest";

import { Simulator } from "../../../src/sim.js";

describe("delivery in the demo, as the engine does it", () => {
  it("commits to main with no agent: Petrina moves main forward itself", () => {
    const sim = new Simulator(emptyState(4), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Small fix", kind: "chore", delivery: "local" });
    runUntil(sim, () => task(sim, id).state === "done");
    const done = task(sim, id);
    expect(done.landed?.branch).toBe("main");
    const lines = done.timeline.map((entry) => entry.text);
    expect(lines).not.toContain("Release Manager started");
    expect(lines.some((line) => line.startsWith("Petrina moved main forward to it"))).toBe(true);
  });

  it("opens a pull request with no agent: Petrina opens it with the builder's text, each step said once", () => {
    const sim = new Simulator(emptyState(4), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Small fix", kind: "chore", delivery: "pull-request" });
    runUntil(sim, () => task(sim, id).state === "pr-open");
    const lines = task(sim, id).timeline.map((entry) => entry.text);
    expect(lines).not.toContain("Release Manager started");
    expect(lines.filter((line) => line === "Petrina pushed the branch")).toHaveLength(1);
  });

  it("has the Release Manager write a release's notes, then Petrina publishes it", () => {
    const sim = new Simulator(emptyState(4), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Small fix", kind: "chore", delivery: "release" });
    runUntil(sim, () => task(sim, id).state === "done");
    const done = task(sim, id);
    const lines = done.timeline.map((entry) => entry.text);
    expect(done.release?.tag).toBeDefined();
    expect(lines.filter((line) => line === "Ready to publish")).toHaveLength(1);
    expect(lines.indexOf("Release Manager started")).toBeGreaterThan(-1);
    expect(lines.findIndex((line) => line.startsWith("Petrina pushed main and the tag"))).toBeGreaterThan(lines.indexOf("Ready to publish"));
  });
});
