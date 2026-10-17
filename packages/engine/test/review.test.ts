import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { findingCount, type Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** One task through design, build and two reviewers, with the coordinator approving as it goes, up to the delivery check. */
async function untilDelivery(scenario: Scenario) {
  const root = tempDir("petrina-review-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
  try {
    const productId = await engine.addProduct(makeProduct(root));
    engine.setProductDelivery(productId, "local", true);
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
    const task = await waitFor(() => {
      const state = engine.getState();
      for (const item of state.inbox) {
        if (item.taskId !== taskId) continue;
        if (item.kind === "plan") engine.approve(item.id);
        else if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
      }
      const found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
      if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
      return found && state.inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
    }, "the delivery check", 60_000);
    return { task, fakes };
  } finally {
    engine.shutdown();
  }
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("reviews that converge", () => {
  it("checks an Important finding with a fresh agent, has the builder answer it, and reviews only what changed next round", async () => {
    const { task, fakes } = await untilDelivery({ reviewer: "important" });

    // The second reviewer said the same thing in other words: it is one finding.
    const important = task.findings.filter((finding) => finding.severity === "blocking");
    expect(important.map((finding) => finding.text)).toEqual(["The greeting is missing on the welcome page."]);
    expect(important[0]!.verification).toMatchObject({ verdict: "real" });
    expect(important[0]!.answer).toMatchObject({ fixed: true, text: "Fixed it." });
    expect(important[0]!.status).toBe("fixed");
    expect(task.findings.filter((finding) => finding.text === "Consider a friendlier greeting.")).toHaveLength(1);

    expect(fakes.openings("verifier")).toHaveLength(1);
    expect(lines(task)).toContain("Sent back to the builder: 1 important");
    expect(fakes.openings("builder")[1]).toContain("Review findings (answer every one by id; fix every Important one)");

    // Reviews compare against the base commit pinned when the working copy was made, not a ref an agent could move.
    expect(task.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fakes.openings("code reviewer")[0]).toContain(`git diff ${task.baseSha}...HEAD`);

    // Round two looks only at what changed since round one.
    expect(task.reviewedSha).toMatch(/^[0-9a-f]{40}$/);
    const second = fakes.openings("code reviewer").filter((text) => text.includes("This is review round 2"));
    expect(second.length).toBeGreaterThan(0);
    expect(second[0]).toContain(`git diff ${task.reviewedSha}..HEAD`);
    expect(lines(task).some((line) => line.startsWith("Review passed: "))).toBe(true);
  });

  it("never sends work back for a finding the fresh agent shows is not a bug", async () => {
    const { task, fakes } = await untilDelivery({ reviewer: "important", verifier: "not-a-bug" });

    const finding = task.findings.find((entry) => entry.text === "The greeting is missing on the welcome page.")!;
    expect(finding.status).toBe("dismissed");
    expect(finding.verification).toMatchObject({ verdict: "not-a-bug", reason: "The welcome page shows the greeting already." });
    expect(fakes.openings("builder")).toHaveLength(1);
    expect(lines(task).some((line) => line.startsWith("Sent back to the builder"))).toBe(false);
    expect(lines(task)).toContain("1 checked: 0 real, 1 not holding the work back");
  });
});

describe("summaries start with a count", () => {
  it("counts what is left to fix, or says there is nothing", () => {
    expect(findingCount([])).toBe("Nothing to fix");
    expect(findingCount([{ severity: "blocking" }, { severity: "blocking" }, { severity: "suggestion" }])).toBe("2 important, 1 nit");
    expect(findingCount([{ severity: "suggestion" }, { severity: "suggestion" }])).toBe("2 nits");
    expect(findingCount([{ severity: "pre-existing" }])).toBe("Nothing to fix · 1 follow-up");
  });
});
