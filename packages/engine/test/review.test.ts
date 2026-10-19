import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findingCount, reviewStats, type Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/**
 * One task through design, build and two reviewers, with the coordinator approving as it goes, up to the
 * delivery check. `atOnce` is the most agents that ever worked on it at the same time.
 */
async function untilDelivery(scenario: Scenario, poolLimit?: number, ship = false) {
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
    const repo = makeProduct(root);
    const before = git(repo, "rev-parse", "HEAD");
    const productId = await engine.addProduct(repo);
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
      if (ship) {
        const delivery = state.inbox.find((item) => item.taskId === taskId && item.kind === "delivery");
        if (delivery) engine.approve(delivery.id);
        return found?.state === "done" && found;
      }
      return found && state.inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
    }, ship ? "the work to ship" : "the delivery check", 60_000);
    // One fresh voter per tool that can run here. With none installed, the two tools the reviewers were planned on.
    const voters = engine.getState().tools.filter((tool) => tool.status === "ready").length || 2;
    return { task, fakes, atOnce, repo, before, voters, root };
  } finally {
    unsubscribe();
    await engine.shutdown();
  }
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("reviews that converge", () => {
  it("keeps an older saved verified fix after a new ballot rejects its reopening", async () => {
    const run = await untilDelivery({ reviewer: "important" });
    const data = join(run.root, "data");
    const store = new Store(join(data, "petrina.db"));
    const stageIndex = run.task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");
    const stage = run.task.plan!.stages[stageIndex]!;
    try {
      const state = store.load()!;
      store.save({ ...state, inbox: [], tasks: state.tasks.map((task) => task.id !== run.task.id ? task : {
        ...task, state: "waiting", stageIndex, sub: 0,
        hunt: { stageId: stage.id, round: 2, reported: { "0": true, "1": true }, findings: task.findings.length },
        findings: task.findings.map((finding) => finding.severity !== "blocking" ? finding : { ...finding, status: "open", confirmedBy: [finding.raisedBy] }),
      }) });
    } finally { store.close(); }
    run.fakes.scenario({ builder: "plain", verifier: "not-a-bug" });
    const engine = new Engine(data, { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), run.fakes.dir] });
    try {
      const task = await waitFor(() => {
        const state = engine.getState();
        return state.inbox.some((item) => item.taskId === run.task.id && item.kind === "delivery") && state.tasks.find((task) => task.id === run.task.id);
      }, "the reopened saved finding to be verified again");
      const finding = task.findings.find((entry) => entry.severity === "blocking")!;
      expect(finding.status).toBe("fixed");
      expect(finding.verification?.verdict).toBe("not-a-bug");
      expect(finding.earlierReviews?.[0]?.verification?.verdict).toBe("real");
      expect(reviewStats([task]).findings).toMatchObject({ fixed: 1, notABug: 0 });
      expect(run.fakes.openings("builder")).toHaveLength(2);
    } finally { await engine.shutdown(); }
    const saved = new Store(join(data, "petrina.db"));
    try { expect(saved.load()!.tasks.find((task) => task.id === run.task.id)!.findings.find((finding) => finding.severity === "blocking")!.earlierReviews).toHaveLength(1); }
    finally { saved.close(); }
  });

  it("keeps a previously real, builder-fixed finding fixed when fresh voters reject a false reopening", async () => {
    const { task, fakes, voters } = await untilDelivery({ reviewer: "confirm-fixed-one-tool", verifier: "after-fix-not-a-bug" });
    const finding = task.findings.find((entry) => entry.severity === "blocking")!;
    expect(finding.answer?.fixed).toBe(true);
    expect(finding.status).toBe("fixed");
    expect(finding.verification?.verdict).toBe("not-a-bug");
    expect(finding.votes?.map((vote) => vote.verdict)).toEqual(Array(voters).fill("not-a-bug"));
    expect(finding.earlierReviews).toHaveLength(1);
    expect(finding.earlierReviews![0]!.verification?.verdict).toBe("real");
    expect(finding.earlierReviews![0]!.votes?.map((vote) => vote.verdict)).toEqual(Array(voters).fill("real"));
    expect(reviewStats([task]).findings).toMatchObject({ fixed: 1, notABug: 0 });
    expect(fakes.openings("verifier")).toHaveLength(voters * 2);
    expect(fakes.openings("builder")).toHaveLength(2);
  });

  it("keeps a finding open when reviewers confirm that the claimed fix is still broken", async () => {
    const { task, fakes } = await untilDelivery({ reviewer: "confirm-fixed" });
    const finding = task.findings.find((entry) => entry.text.toLowerCase().replace(/!$/, ".") === "the greeting is missing on the welcome page.")!;
    expect(finding.answer?.fixed).toBe(true);
    expect(finding.status).toBe("open");
    expect(task.findings.filter((entry) => entry.text === finding.text)).toHaveLength(1);
    expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(true);
    expect(fakes.openings("builder").length).toBeLessThanOrEqual(3);
  });

  it("has fresh agents vote on an Important finding, the builder answer it, and reviews only what changed next round", async () => {
    const { task, fakes, atOnce, voters } = await untilDelivery({ reviewer: "important" });

    const important = task.findings.filter((finding) => finding.severity === "blocking");
    expect(important.map((finding) => finding.text)).toEqual(["The greeting is missing on the welcome page."]);
    // Raised on one tool only, so one fresh agent per ready tool voted on it, and each said it is real.
    expect(important[0]!.votes?.map((vote) => vote.verdict)).toEqual(Array(voters).fill("real"));
    expect(important[0]!.verification).toMatchObject({ verdict: "real" });
    expect(important[0]!.answer).toMatchObject({ fixed: true, text: "Fixed it." });
    expect(important[0]!.status).toBe("fixed");
    const firstReview = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!;
    const reported = firstReview.result?.findings?.find((finding) => finding.id === important[0]!.id);
    expect(reported?.text).toBe("The greeting is missing on the welcome page.");
    expect(reported?.status).toBe("open");
    expect(reported?.answer).toBeUndefined();
    expect(task.findings.filter((finding) => finding.text === "Consider a friendlier greeting.")).toHaveLength(1);

    expect(fakes.openings("verifier")).toHaveLength(voters);
    // The two reviewers looked at the change at once, and so did the voters, up to the pool of three.
    expect(atOnce).toBe(Math.max(2, Math.min(3, voters)));
    // Each worked in a copy of its own, never the task's, and every copy is gone afterwards.
    const copies = [...fakes.openings("code reviewer").slice(0, 2), ...fakes.openings("verifier")].map((text) => /Your working copy is (.+?), on branch/.exec(text)?.[1]);
    expect(new Set(copies).size).toBe(2 + voters);
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
    const secondReview = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!;
    expect(secondReview.result?.findings?.some((finding) => finding.id === important[0]!.id)).toBe(false);
    expect(important[0]!.status).toBe("fixed");
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
    await engine.shutdown();

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
    const { task, fakes, atOnce, voters } = await untilDelivery({ reviewer: "important" }, 1);
    expect(atOnce).toBe(1);
    expect(fakes.openings("verifier")).toHaveLength(voters);
    expect(task.findings.find((finding) => finding.severity === "blocking" || finding.status === "fixed")?.verification).toMatchObject({ verdict: "real" });
  });
});

describe("a clean history", () => {
  it("ships the task as one commit on top of main, however many commits its branch had", async () => {
    const { task, repo, before } = await untilDelivery({ reviewer: "important", fixes: "change" }, undefined, true);
    // A build and a round of review fixes, kept as one commit all along.
    expect(task.timeline.map((entry) => entry.text)).toContain("Sent back to the builder: 1 important");
    expect(git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting");
    expect(git(repo, "log", "-1", "--format=%B", "main")).toContain("Built by Petrina");
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
