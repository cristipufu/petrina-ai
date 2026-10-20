import { executionFor } from "../src/repository-context.js";
import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { draftOf, journeyProblems, JOURNEY_WORDS as W, type Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { MAY_CHANGE } from "../src/prompts.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("the tester tries the change once, and the final code once more", () => {
  it("repairs an omitted acceptance report in the same conversation before accepting the pass", async () => {
    const root = tempDir("petrina-acceptance-coverage-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "tester-with-design", builder: "plain", tester: "omit-once" });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
    try {
      const productId = await engine.addProduct(makeProduct(root));
      engine.setProductDelivery(productId, "local", true);
      const id = engine.addTask({ productId, title: "Try the greeting", description: "[no-check]" });
      const task = await waitFor(() => {
        const state = engine.getState();
        const plan = state.inbox.find((item) => item.taskId === id && item.kind === "plan");
        if (plan) engine.approve(plan.id);
        const question = state.inbox.find((item) => item.taskId === id && item.kind === "question");
        if (question) engine.answer(question.id, question.options?.[0] ?? "Yes");
        const found = state.tasks.find((task) => task.id === id)!;
        if (found.state === "failed") throw new Error(found.error);
        return state.inbox.some((item) => item.taskId === id && item.kind === "delivery") && found;
      }, "a complete acceptance report", 120_000);
      expect(fakes.prompts("tester")).toHaveLength(2);
      expect(fakes.prompts("tester")[1]).toContain("Report pass, fail, or blocked");
      expect(fakes.openings("tester")).toHaveLength(1);
      expect(task.brief!.acceptance.every((item) => item.met)).toBe(true);
      expect(task.acceptancePassed).toBe(true);
      expect(task.journey!.find((step) => step.roleId === "tester")!.acceptanceChecks![0]!.evidence).toBe("The scripted greeting check returned the expected result.");
    } finally { await engine.shutdown(); }
  });

  it.each(["blocked", "no-evidence"] as const)("keeps %s acceptance checks unverified and prevents an unchanged retry or low-risk auto-ship", async (tester) => {
    const root = tempDir("petrina-acceptance-blocked-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "tester-with-design", builder: "plain", tester, risk: "low" });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
    try {
      const productId = await engine.addProduct(makeProduct(root));
      engine.updateProduct(productId, { name: "Shop", delivery: "local", approveDelivery: true, shipLowRisk: true });
      const id = engine.addTask({ productId, title: "Try the greeting", description: "[no-check]" });
      const task = await waitFor(() => {
        const state = engine.getState();
        const plan = state.inbox.find((item) => item.taskId === id && item.kind === "plan");
        if (plan) engine.approve(plan.id);
        const question = state.inbox.find((item) => item.taskId === id && item.kind === "question");
        if (question) engine.answer(question.id, question.options?.[0] ?? "Yes");
        const found = state.tasks.find((task) => task.id === id)!;
        if (found.state === "failed") throw new Error(found.error);
        return state.inbox.some((item) => item.taskId === id && item.kind === "delivery") && found;
      }, "the coordinator to receive an unverified acceptance result", 120_000);
      const delivery = engine.getState().inbox.find((item) => item.taskId === id && item.kind === "delivery")!;
      expect(task.state).toBe("needs-you");
      expect(task.acceptancePassed).toBe(false);
      expect(task.acceptanceUnverified).toBe(true);
      const reason = tester === "blocked" ? "The Claude Code weekly limit prevents opening a live session." : "The agent did not record how it verified this item.";
      expect(task.brief!.acceptance[0]).toMatchObject({ verification: "blocked", reason });
      expect(task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking")).toHaveLength(0);
      expect(delivery.title).toContain("1 acceptance check could not be verified");
      expect(delivery.body).toContain(reason);
      expect(fakes.openings("tester")).toHaveLength(1);
      expect(task.journey!.filter((step) => step.roleId === "tester")).toHaveLength(1);
      expect(task.landed).toBeUndefined();
    } finally { await engine.shutdown(); }
  });

  it.each([false, true])("bounds failing acceptance with changed code %s, keeps one finding, and saves the decision across restart", async (changes) => {
    const root = tempDir("petrina-acceptance-bound-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "tester-first", builder: "plain", tester: "always-fail", ...(changes ? { fixes: "change" as const } : {}) });
    const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] };
    const data = join(root, "data");
    let engine = new Engine(data, options);
    try {
      const productId = await engine.addProduct(makeProduct(root));
      engine.setProductDelivery(productId, "local", true);
      const id = engine.addTask({ productId, title: "Try the greeting", description: "[no-check]" });
      const task = await waitFor(() => {
        const state = engine.getState();
        const plan = state.inbox.find((item) => item.taskId === id && item.kind === "plan");
        if (plan) engine.approve(plan.id);
        const found = state.tasks.find((task) => task.id === id)!;
        if (found.state === "failed") throw new Error(found.error);
        return state.inbox.some((item) => item.taskId === id && item.kind === "delivery") && found;
      }, "bounded acceptance reaches the coordinator", 120_000);
      expect(task.acceptancePassed).toBe(false);
      expect(task.acceptanceReturns).toBe(2);
      expect(fakes.openings("tester")).toHaveLength(4);
      const findings = task.findings.filter((finding) => finding.text.startsWith("Failed acceptance check"));
      expect(findings).toHaveLength(1);
      expect(findings[0]!.status).toBe("open");
      const testerSteps = task.journey!.filter((step) => step.roleId === "tester");
      expect(testerSteps).toHaveLength(4);
      // The delivery gate clears the temporary design brief. The journey is the durable evidence
      // for each tester pass, so compare the recorded failures with each other instead of reading
      // the brief after it has been discarded.
      const failedChecks = testerSteps.flatMap((step) => step.acceptanceChecks ?? []).filter((check) => check.result === "fail");
      expect(failedChecks).toHaveLength(4);
      expect(new Set(failedChecks.map((check) => check.text)).size).toBe(1);
      expect(journeyProblems(task)).toEqual([]);
      engine.setPoolPaused(true);
      await engine.shutdown();
      engine = new Engine(data, options);
      expect(engine.getState().tasks.find((task) => task.id === id)?.acceptanceReturns).toBe(2);
      const gate = engine.getState().inbox.find((item) => item.taskId === id && item.kind === "delivery")!;
      expect(gate).toBeDefined();
      engine.requestChanges(gate.id, "Try another approach to make the greeting visible");
      expect((engine.task(id) ? executionFor(engine.task(id)!).work.acceptanceReturns : undefined)).toBeUndefined();
    } finally { await engine.shutdown(); }
  });

  it("keeps a tester's permitted edits before review and undoes its edits and commits on the final acceptance pass", async () => {
    const root = tempDir("petrina-tester-edits-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "tester-first", builder: "plain", reviewer: "important", fixes: "change", tester: "writes" });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
    try {
      const tester = engine.getState().roles.find((role) => role.id === "tester")!;
      engine.saveRole(tester.id, { ...draftOf(tester), canEdit: true });
      const repo = makeProduct(root);
      // Exercise Git's Windows checkout conversion on every platform.
      git(repo, "config", "core.autocrlf", "true");
      const productId = await engine.addProduct(repo);
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Try the greeting", description: "[no-check]" });
      const task = await waitFor(() => {
        const state = engine.getState();
        for (const item of state.inbox.filter((item) => item.taskId === taskId)) {
          if (item.kind === "plan") engine.approve(item.id);
          else if (item.kind === "permission") engine.allow(item.id, "once");
          else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        }
        const found = state.tasks.find((entry) => entry.id === taskId)!;
        if (found.state === "failed") throw new Error(found.error);
        return state.inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
      }, "the final tester pass and delivery check", 120_000);
      const openings = fakes.openings("tester");
      expect(openings).toHaveLength(2);
      expect(openings[0]).toContain(MAY_CHANGE.canEdit);
      expect(openings[1]).toContain(MAY_CHANGE.afterReview);
      expect(readFileSync(join(task.worktree!, "tester-edit.txt"), "utf8")).toBe("Before the review\r\n");
      expect(task.timeline.some((entry) => entry.text === "Saved the changes from the Tester on the task's branch")).toBe(true);
      expect(task.timeline.some((entry) => entry.text === "Undid commits from Tester, which is read-only")).toBe(true);
      expect(engine.getState().roles.find((role) => role.id === tester.id)!.canEdit).toBe(true);
    } finally {
      engine.shutdown();
    }
  });

  for (const handoff of [false, true]) it(`skips the tester in fix rounds, tries the final code before the delivery check, and sends a failure there back to the builder${handoff ? ", crediting the stand-in" : ""}`, async () => {
    const root = tempDir("petrina-tester-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    // Build, try it, two reviewers; the first review raises an Important finding; the fix changes the code; the
    // tester's pass on the final code fails once.
    fakes.scenario({ planner: "tester-first", reviewer: handoff ? "important-twice" : "important", fixes: "change", tester: "fail-once", ...(handoff ? { learnings: "tester", limited: [{ model: "opus", role: "tester" }] } : {}) });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
    let roundTwoReviewHead: string | undefined;
    let unsubscribe = () => {};
    try {
      const productId = await engine.addProduct(makeProduct(root));
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
      unsubscribe = engine.subscribe(() => {
        const current = engine.task(taskId);
        const reviewStage = current?.plan?.stages.find((stage) => stage.kind === "review-chain");
        if (!roundTwoReviewHead && current && executionFor(current).work.worktree && reviewStage && current.stageIndex > current.plan!.stages.indexOf(reviewStage)
          && current.journey?.some((step) => step.roleId === "code-reviewer" && step.round === 2 && step.reason === "review passed")) {
          roundTwoReviewHead = git(executionFor(current).work.worktree!, "rev-parse", "HEAD");
        }
      });
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
        return state.inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
      }, "the delivery check", 120_000);
      const lines = task.timeline.map((entry) => entry.text);
      // Once before the first review; not after the review's fix; once on the final code (failed); once more after that fix.
      expect(lines.filter((line) => line === "Tester started")).toHaveLength(3);
      expect(lines).toContain("Acceptance will be tried once more on the final code, right before your delivery check");
      expect(lines.filter((line) => line === "Trying the acceptance list once more on the final code")).toHaveLength(2);
      expect(lines).toContain("Sent back to the builder: 1 acceptance check failed on the final code");
      // The later acceptance failure returns to the builder after round two passed. The next review
      // should start from the code round two actually examined, while retaining the fixed finding.
      expect(roundTwoReviewHead).toMatch(/^[0-9a-f]{40}$/);
      const repeatedReview = fakes.openings("code reviewer").filter((text) => text.includes("This is review round 2")).at(-1)!;
      expect(repeatedReview).toContain(`git diff ${roundTwoReviewHead}..HEAD`);
      expect(repeatedReview.toLowerCase()).toContain("greeting is missing on the welcome page");
      expect(repeatedReview).toContain("The builder: fixed. Fixed it.");
      // The failure on the final code was fixed, and the tester saw the code that ships.
      const acceptance = task.findings.filter((finding) => finding.text.startsWith("Failed acceptance check"));
      expect(acceptance).toHaveLength(1);
      expect(acceptance[0]!.status).toBe("fixed");
      if (handoff) {
        const actual = acceptance[0]!.raisedBy;
        expect(engine.profile(actual)!.toolId).toBe("codex");
        expect(task.timeline.find((entry) => entry.text === "1 acceptance check failed")!.profileId).toBe(actual);
        expect(task.timeline.filter((entry) => entry.text === "Tried it: it works.").every((entry) => entry.profileId === actual)).toBe(true);
        expect(engine.getState().inbox.find((entry) => entry.taskId === taskId && entry.kind === "learnings")!.profileId).toBe(actual);
      }
      expect(task.testedPatch).toBeDefined();
      expect(task.retest).toBeUndefined();
      // Every pass stays on the journey; a handoff keeps the interrupted tool's box too.
      const attempts = task.journey!.filter((step) => step.roleId === "tester");
      expect(attempts).toHaveLength(handoff ? 4 : 3);
      if (handoff) {
        expect(attempts[0]).toEqual(expect.objectContaining({ reason: W.agentChanged, outcome: W.handedOn }));
        expect(engine.profile(attempts[0]!.profileId!)!.toolId).toBe("claude-code");
      }
      const testers = attempts.filter((step) => step.reason !== W.agentChanged);
      expect(testers).toHaveLength(3);
      for (const tester of testers.slice(1)) {
        expect(tester.trigger?.reason).toContain("Final acceptance testing after review");
        expect(tester.agentInputs?.[0]?.instructions).toContain("final acceptance testing after review");
        expect(tester.agentInputs?.[0]?.sections.some((section) => section.title === "Why acceptance testing runs again")).toBe(true);
        expect(tester.agentInputs?.[0]?.sections.some((section) => section.title === "Earlier implementation and verification evidence")).toBe(true);
        expect(tester.agentResults?.at(-1)?.versions?.[task.productId]).toMatch(/^[0-9a-f]{40}$/);
      }
      expect(new Set(testers.map((step) => step.id)).size).toBe(3);
      expect(testers.map((step) => step.reason)).toEqual(["checks passed", "1 check failed", "checks passed"]);
      expect(task.timeline.filter((entry) => entry.text === "Tester started").map((entry) => entry.step)).toEqual([attempts[0]!.id, ...testers.slice(1).map((step) => step.id)]);
      expect(journeyProblems(task)).toEqual([]);
    } finally {
      unsubscribe();
      engine.shutdown();
    }
  });
});
