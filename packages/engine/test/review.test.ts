import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findingCount, type Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/**
 * One task through design, build and two reviewers, with the coordinator approving as it goes, up to the
 * delivery check. `atOnce` is the most agents that ever worked on it at the same time.
 */
async function untilDelivery(scenario: Scenario, poolLimit?: number) {
  const root = tempDir("petrina-review-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
  let atOnce = 0;
  const unsubscribe = engine.subscribe(() => {
    for (const task of engine.getState().tasks) if (task.holdsSlot && task.agent) atOnce = Math.max(atOnce, 1 + (task.helpers?.length ?? 0));
  });
  try {
    if (poolLimit) engine.setPoolLimit(poolLimit);
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
    return { task, fakes, atOnce };
  } finally {
    unsubscribe();
    engine.shutdown();
  }
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("reviews that converge", () => {
  it("has fresh agents vote on an Important finding, the builder answer it, and reviews only what changed next round", async () => {
    const { task, fakes, atOnce } = await untilDelivery({ reviewer: "important" });

    const important = task.findings.filter((finding) => finding.severity === "blocking");
    expect(important.map((finding) => finding.text)).toEqual(["The greeting is missing on the welcome page."]);
    // Raised on one tool only, so one fresh agent per tool voted on it, and both said it is real.
    expect(important[0]!.votes?.map((vote) => vote.verdict)).toEqual(["real", "real"]);
    expect(important[0]!.verification).toMatchObject({ verdict: "real" });
    expect(important[0]!.answer).toMatchObject({ fixed: true, text: "Fixed it." });
    expect(important[0]!.status).toBe("fixed");
    expect(task.findings.filter((finding) => finding.text === "Consider a friendlier greeting.")).toHaveLength(1);

    expect(fakes.openings("verifier")).toHaveLength(2);
    // The two reviewers looked at the change at once, and so did the two voters.
    expect(atOnce).toBe(2);
    // Each worked in a copy of its own, never the task's, and every copy is gone afterwards.
    const copies = [...fakes.openings("code reviewer").slice(0, 2), ...fakes.openings("verifier")].map((text) => /Your working copy is (.+?), on branch/.exec(text)?.[1]);
    expect(new Set(copies).size).toBe(4);
    for (const copy of copies) {
      expect(copy).not.toBe(task.worktree);
      expect(existsSync(copy!)).toBe(false);
    }
    expect(fakes.openings("verifier")[0]).toContain("is yours alone");
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

describe.concurrent("reviewers at once, then a vote", () => {
  it("counts the same finding from a reviewer on another tool as backing it, so nobody needs to vote on it", async () => {
    const { task, fakes } = await untilDelivery({ reviewer: "important-twice" });
    const important = task.findings.filter((finding) => finding.text.toLowerCase().includes("greeting is missing"));
    expect(important).toHaveLength(1);
    expect(important[0]).toMatchObject({ raisedBy: expect.any(String), status: "fixed" });
    expect(important[0]!.confirmedBy).toHaveLength(1);
    expect(fakes.openings("verifier")).toHaveLength(0);
    expect(lines(task)).toContain("Sent back to the builder: 1 important");
  });

  it("after a restart, runs again only the reviewer that had not reported", async () => {
    const root = tempDir("petrina-review-restart-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ reviewer: "work" });
    const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] };
    let engine = new Engine(join(root, "data"), options);
    const productId = await engine.addProduct(makeProduct(root));
    engine.setProductDelivery(productId, "local", true);
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
    const coordinate = (current: Engine) => {
      for (const item of current.getState().inbox) {
        if (item.kind === "plan") current.approve(item.id);
        else if (item.kind === "permission") current.allow(item.id, "once");
        else if (item.kind === "question") current.answer(item.id, item.options?.[0] ?? "Yes");
      }
      return current.getState().tasks.find((entry) => entry.id === taskId) as Task | undefined;
    };
    // One reviewer reported; the other is still at work when Petrina stops.
    await waitFor(() => {
      const task = coordinate(engine);
      return fakes.marked("reviewer-working") && Object.keys(task?.hunt?.reported ?? {}).length === 1 && task;
    }, "one reviewer to report while the other works", 60_000);
    engine.shutdown();

    engine = new Engine(join(root, "data"), options);
    try {
      const task = await waitFor(() => {
        const found = coordinate(engine);
        if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
        return engine.getState().inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
      }, "the delivery check", 60_000);
      // Two reviewers at first, then only the one that had not reported.
      expect(fakes.openings("code reviewer")).toHaveLength(3);
      expect(task.findings.filter((finding) => finding.text === "Consider a friendlier greeting.")).toHaveLength(1);
      expect(task.hunt).toBeUndefined();
    } finally {
      engine.shutdown();
    }
  });

  it("puts the task's branch back when a reviewer moves it from its own copy", async () => {
    const { task, fakes } = await untilDelivery({ reviewer: "move-branch" });
    expect(fakes.marked("branch-moved")).toBe(true);
    expect(lines(task)).toContain("Undid commits from Code reviewer, which is read-only");
    // The work the builder committed is still what ships.
    expect(git(task.worktree!, "log", "-1", "--format=%s")).toBe("Add a greeting");
  });

  it("takes turns when the pool has one slot, and still gets every review and vote", async () => {
    const { task, fakes, atOnce } = await untilDelivery({ reviewer: "important" }, 1);
    expect(atOnce).toBe(1);
    expect(fakes.openings("verifier")).toHaveLength(2);
    expect(task.findings.find((finding) => finding.severity === "blocking" || finding.status === "fixed")?.verification).toMatchObject({ verdict: "real" });
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
