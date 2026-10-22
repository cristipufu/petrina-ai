import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findingCount, reviewStats, ROLE_STARTS, type Task } from "@petrina/core";
import { Engine } from "./engine.js";
import { Store } from "../src/store.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

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
    if (scenario.planner === "mixed-review") engine.addRole(ROLE_STARTS.find((entry) => entry.id === "security")!.draft);
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
        else if (item.kind === "screen") engine.allowScreen(taskId);
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
  it("rechecks a dismissed finding against fresh proof without counting its historical raiser as current support", async () => {
    const run = await untilDelivery({ reviewer: "important", verifier: "not-a-bug", builder: "plain" });
    const old = run.task.findings.find((finding) => finding.severity === "blocking")!;
    expect(old.status).toBe("dismissed");
    expect(old.verification?.verdict).toBe("not-a-bug");
    const stageIndex = run.task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");
    const stage = run.task.plan!.stages[stageIndex]!;
    const data = join(run.root, "data");
    const store = new Store(join(data, "petrina.db"));
    try {
      const state = store.load()!;
      store.save({ ...state, inbox: [], tasks: state.tasks.map((task) => task.id !== run.task.id ? task : { ...task, state: "waiting", stageIndex, sub: 0, rounds: { ...task.rounds, [stage.id]: 2 }, hunt: undefined }) });
    } finally { store.close(); }
    const evidence = "On current code, the guest greeting disappears after signing out; signed-in visitors still see it. Expected both states to retain the greeting.";
    run.fakes.scenario({ builder: "plain", reviewer: "confirm-dismissed", reopenedEvidence: evidence, verifier: "real" });
    const engine = new Engine(data, { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), run.fakes.dir] });
    try {
      const task = await waitFor(() => {
        const state = engine.getState();
        const task = state.tasks.find((entry) => entry.id === run.task.id)!;
        if (task.state === "failed") throw new Error(task.error);
        return state.inbox.some((item) => item.taskId === task.id && item.kind === "delivery") && task;
      }, "new proof of the dismissed finding to receive a fresh ballot");
      const reopened = task.findings.find((finding) => finding.id === old.id)!;
      expect(reopened.status).toBe("open");
      expect(reopened.evidence).toBe(evidence);
      expect(reopened.confirmedBy).toEqual([stage.profileIds[1]!]);
      expect(reopened.verification?.verdict).toBe("real");
      expect(reopened.votes).toHaveLength(run.voters);
      expect(reopened.earlierReviews).toHaveLength(1);
      expect(reopened.earlierReviews![0]!.evidence).toBe(old.evidence);
      expect(reopened.earlierReviews![0]!.verification?.verdict).toBe("not-a-bug");
      expect(reopened.earlierReviews![0]!.votes).toEqual(old.votes);
      expect(run.fakes.openings("verifier")).toHaveLength(run.voters * 2);
      const corrections = run.fakes.received("code reviewer").filter((entry) => entry.text.startsWith("Your result block could not be used: Current evidence is required"));
      expect(corrections).toHaveLength(1);
      expect(run.fakes.received("code reviewer").find((entry) => entry.session === corrections[0]!.session)!.text).toContain("(dismissed)");
      expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(true);
    } finally { await engine.shutdown(); }
    const restored = new Engine(data, { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), run.fakes.dir] });
    try {
      const saved = restored.task(run.task.id)!.findings.find((finding) => finding.id === old.id)!;
      expect(saved.status).toBe("open");
      expect(saved.evidence).toBe(evidence);
      expect(saved.verification?.verdict).toBe("real");
      expect(saved.earlierReviews![0]!.verification?.verdict).toBe("not-a-bug");
      expect(saved.earlierReviews![0]!.votes).toEqual(old.votes?.map((vote) => ({ ...vote })));
      expect(run.fakes.openings("verifier")).toHaveLength(run.voters * 2);
    } finally { await restored.shutdown(); }
  });

  for (const [name, scenario, role, corrections] of [
    ["single code review", { planner: "short", reviewRounds: 2 }, "code reviewer", 1],
    ["parallel code review", {}, "code reviewer", 2],
    ["resumed parallel code review after screen permission", { screenRoles: ["code reviewer"] }, "code reviewer", 2],
    ["security review", { risk: "high" }, "security reviewer", 1],
    ["added findings role", { planner: "mixed-review" }, "security specialist", 1],
  ] as [string, Scenario, string, number][]) {
    it(`requires current reopening evidence in ${name}, then accepts a correction in the same conversation`, async () => {
      const { task, fakes } = await untilDelivery({ ...scenario, builder: "plain", reviewer: "important", reviewConfirmation: { role, correction: "omit" } });
      const findings = task.findings.filter((finding) => finding.severity === "blocking");
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.status).toBe("fixed");
        expect(finding.answer?.fixed).toBe(true);
        expect(finding.earlierReviews).toBeUndefined();
      }
      const correctionsSent = fakes.received(role).filter((entry) => entry.text.startsWith("Your result block could not be used: Current evidence is required"));
      expect(correctionsSent).toHaveLength(corrections);
      for (const correction of correctionsSent) {
        const opening = fakes.received(role).find((entry) => entry.session === correction.session)!;
        expect(opening.text).toContain("(fixed)");
        expect(opening.text).toContain(findings[0]!.id);
      }
      expect(fakes.openings("builder")).toHaveLength(2);
      expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(false);
    });
  }

  it("passes a fresh failing reproduction to the next builder and saves the original evidence in history", async () => {
    const evidence = "On current code, send an explicit dispute before an independent confirmation: the finding stays dismissed. Reverse the order: it stays open. Expected both orders to keep independently confirmed findings open.";
    const { task, fakes, root } = await untilDelivery({ builder: "plain", reviewer: "confirm-fixed", reviewRounds: 3, reopenedEvidence: evidence });
    const finding = task.findings.find((entry) => entry.severity === "blocking")!;
    expect(task.findings.filter((entry) => entry.id === finding.id)).toHaveLength(1);
    expect(task.findings.filter((entry) => entry.severity === "blocking")).toHaveLength(2);
    expect(finding.status).toBe("open");
    expect(finding.evidence).toBe(evidence);
    expect(finding.earlierReviews).toHaveLength(2);
    expect(finding.earlierReviews![0]!.evidence).toBe("Opened the welcome page");
    expect(finding.earlierReviews![1]!.evidence).toBe(evidence);
    const builders = fakes.openings("builder");
    expect(builders).toHaveLength(3);
    expect(builders[1]).toContain("Opened the welcome page");
    expect(builders[1]).not.toContain(evidence);
    expect(builders[2]).toContain(evidence);
    // Complete handoffs retain earlier proof, clearly labelled as historical rather than current support.
    expect(builders[2]).toContain("Earlier decisions below are historical, not current support.");
    expect(builders[2]).toContain("Opened the welcome page");
    expect(builders[2]!.indexOf(evidence)).toBeLessThan(builders[2]!.indexOf("Opened the welcome page"));
    const original = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!.result!.findings!.find((entry) => entry.id === finding.id)!;
    expect(original.evidence).toBe("Opened the welcome page");
    const store = new Store(join(root, "data", "petrina.db"));
    try {
      const saved = store.load()!.tasks.find((entry) => entry.id === task.id)!.findings.find((entry) => entry.id === finding.id)!;
      expect(saved.evidence).toBe(evidence);
      expect(saved.earlierReviews![0]!.evidence).toBe("Opened the welcome page");
    } finally { store.close(); }
    expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(true);
  });

  it("keeps new reports separate from earlier fixed findings even when their wording repeats", async () => {
    const { task, fakes } = await untilDelivery({ builder: "plain", reviewer: "important-twice", reviewRounds: 3, reviewConfirmation: { role: "code reviewer", correction: "evidence", duplicate: true } });
    const rounds = task.journey!.filter((step) => step.roleId === "code-reviewer" && step.endedAt !== undefined).length;
    expect(rounds).toBeGreaterThanOrEqual(3);
    expect(task.findings).toHaveLength(rounds * 2);
    expect(new Set(task.findings.map((finding) => finding.id)).size).toBe(rounds * 2);
    expect(task.findings.filter((finding) => finding.status === "fixed")).toHaveLength((rounds - 1) * 2);
    expect(task.findings.filter((finding) => finding.status === "open")).toHaveLength(2);
    expect(task.findings.every((finding) => !finding.earlierReviews?.length && !finding.confirmedBy.length)).toBe(true);
    expect(fakes.received("code reviewer").filter((entry) => entry.text.startsWith("Your result block could not be used: Current evidence is required"))).toHaveLength(0);
    const builders = fakes.openings("builder");
    expect(builders).toHaveLength(rounds);
    for (const finding of task.findings.slice(2, 4)) expect(builders[2]).toContain(`[${finding.id}]`);
    expect(builders[2]).toContain("fix it once");
    expect(lines(task).some((line) => line.startsWith("Review rounds used up"))).toBe(true);
  });

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
      expect(reviewStats([task]).findings).toMatchObject({ fixed: 2, notABug: 0 });
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
    expect(task.findings.filter((finding) => finding.text === "Consider a friendlier greeting.")).toHaveLength(3);

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
  it("keeps blind reports separate and verifies each claim without inferring agreement from prose", async () => {
    const { task, fakes, voters } = await untilDelivery({ reviewer: "important-twice" });
    const important = task.findings.filter((finding) => finding.text.toLowerCase().includes("greeting is missing"));
    expect(important).toHaveLength(2);
    expect(new Set(important.map((finding) => finding.id)).size).toBe(2);
    for (const finding of important) {
      expect(finding.status).toBe("fixed"); expect(finding.confirmedBy).toEqual([]);
      expect(finding.verification?.verdict).toBe("real");
      expect(fakes.openings("verifier")[0]).toContain(`[${finding.id}]`);
    }
    expect(fakes.openings("verifier")).toHaveLength(voters);
    expect(lines(task)).toContain("Sent back to the builder: 2 important");
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
      expect(task.findings.filter((finding) => finding.text === "Consider a friendlier greeting.")).toHaveLength(2);
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
