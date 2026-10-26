import { executionFor } from "@petrina/orchestrator";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as gitOps from "@petrina/repositories/git";
import { removeDir, type World } from "../../support.js";
import { repositoryRecords, withRepositoryRecords, type RepositoryRecordOptions } from "../../fixtures/shared-records.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const fixture = (name: string, options: RepositoryRecordOptions = {}) => repositoryRecords(name, recordRoots, options);

describe.concurrent("one task across products", () => {
  it("previews companion repositories and their readers in the shared delivery check", async () => {
    const saved = await fixture("companion-wording");
    const { engine, task } = saved;
    try {
      const state = engine.s;
      state.products.push({ id: "third", name: "Third", repo: "acme/third", tone: "blue" });
      task.repositories = state.products.slice(0, 2).map((product, index) => ({ productId: product.id, delivery: "pull-request", completedStages: [], source: { product: { ...product, repo: index ? "private/api" : "acme/shop" }, start: { kind: "default", branch: "main" }, destination: { kind: "new-pr", mode: "pull-request", repo: index ? "private/api" : "acme/shop", branch: "main" }, confirmed: true } }));
      engine.gate(task, "delivery");
      const requests = engine.s.inbox.filter(item => item.taskId === task.id);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.kind).toBe("delivery");
      expect(requests[0]!.body).toContain("acme/shop; link pending");
      expect(requests[0]!.body).toContain("private/api; link pending");
      expect(requests[0]!.body).toContain("every companion pull request, visible to anyone who can read it.");
      expect(requests[0]!.body).toContain("Pending links will become the resulting pull request or release addresses in these approved repositories.");
    } finally { await engine.shutdown(); }
  });

  for (const mode of ["local", "release", "mixed", "unchanged-pr"] as const) it(`omits pull-request publication wording when ${mode} deliveries publish no pull requests`, async () => {
    const saved = await fixture("companion-wording");
    const { engine, task } = saved;
    try {
      const state = engine.s;
      state.products.push({ id: "third", name: "Third", repo: "acme/third", tone: "blue" });
      task.repositories = state.products.slice(0, mode === "unchanged-pr" ? 3 : 2).map((product, index) => {
        const delivery = mode === "unchanged-pr" && index === 2 ? "pull-request" : mode === "release" || (mode === "mixed" && index === 1) ? "release" : "local";
        return { productId: product.id, delivery, completedStages: [], ...(delivery === "pull-request" ? { nothingToPublish: true } : {}), source: { product, start: { kind: "default", branch: "main" }, destination: { kind: delivery === "pull-request" ? "new-pr" : delivery === "release" ? "release" : "branch", mode: delivery, repo: product.repo, branch: "main" }, confirmed: true } };
      });
      engine.gate(task, "delivery");
      const requests = engine.s.inbox.filter(item => item.taskId === task.id);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.kind).toBe("delivery");
      for (const work of task.repositories) expect(requests[0]!.body).toContain(work.source!.product.repo);
      // This remains a factual summary of the related deliveries; only PR-specific copy is omitted.
      expect(requests[0]!.body).toContain("Part of a change across:");
      expect(requests[0]!.body).not.toContain("every companion pull request");
      expect(requests[0]!.body).not.toContain("Pending links");
    } finally { await engine.shutdown(); }
  });

  for (const mode of ["local", "release"] as const) it(`previews companion wording on an existing pull request beside a ${mode} delivery`, async () => {
    const saved = await fixture("companion-wording");
    const { engine, task } = saved;
    try {
      const state = engine.s;
      state.products.push({ id: "third", name: "Third", repo: "acme/third", tone: "blue" });
      task.repositories = state.products.slice(0, 2).map((product, index) => ({ productId: product.id, delivery: index ? mode : "local", completedStages: [], source: { product, start: index ? { kind: "default", branch: "main" } : { kind: "pull-request", number: 7, url: `https://github.com/${product.repo}/pull/7`, headRepo: product.repo, branch: "feature" }, destination: { kind: index ? mode === "release" ? "release" : "branch" : "update-pr", mode: index ? mode : "local", repo: product.repo, branch: index ? "main" : "feature" }, confirmed: true } }));
      engine.gate(task, "delivery");
      const requests = engine.s.inbox.filter(item => item.taskId === task.id);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.kind).toBe("delivery");
      expect(requests[0]!.body).toContain("Part of a change across:");
      expect(requests[0]!.body).toContain("visible to anyone who can read it");
      expect(requests[0]!.body).toContain("Pending links will become");
    } finally { await engine.shutdown(); }
  });
});

describe("explicit repository execution contexts", () => {
  for (const variant of ["unchanged", "changed commit", "moved source", "failed checks"] as const) it(`keeps delivery approval and checks authoritative: ${variant}`, async () => {
    const { engine, task } = await fixture(`approval-${variant.replaceAll(" ", "-")}`);
    const scope = executionFor(task, "first"), sha = "b".repeat(40);
    scope.work.approvedSha = sha; scope.work.approvedPatch = "approved-patch";
    task.plan = { rationale: "Approval test", plannerProfileId: "sol-high", stages: [
      { id: "delivery-check", title: "Your delivery check", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
      { id: "delivery", title: "Deliver", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    task.stageIndex = 1;
    const shipping = engine["shipping"], back = shipping["backToWork"];
    shipping["backToWork"] = async () => {};
    const update = spyOn(engine["updates"], "upToDate").mockResolvedValue(variant === "moved source" ? "moved" : "current");
    const head = spyOn(gitOps, "head").mockResolvedValue(variant === "changed commit" ? "a".repeat(40) : sha);
    const patch = spyOn(engine["updates"], "patch").mockResolvedValue("different-patch");
    const checks = spyOn(engine["checks"], "checksBeforeShipping").mockResolvedValue(variant === "failed checks" ? "returned" : "passed");
    try {
      const changed = variant === "changed commit" || variant === "moved source";
      expect(await engine["shipping"]["readyToShip"](scope, new AbortController().signal)).toBe(variant === "unchanged" ? "ready" : "back");
      expect(patch).toHaveBeenCalledTimes(changed ? 1 : 0);
      expect(checks).toHaveBeenCalledTimes(changed ? 0 : 1);
      if (changed) { expect(task.stageIndex).toBe(0); expect(scope.work.approvedSha).toBeUndefined(); }
    } finally { checks.mockRestore(); patch.mockRestore(); head.mockRestore(); update.mockRestore(); shipping["backToWork"] = back; await engine.shutdown(); }
  });
});

describe("shared check repair episodes", () => {
  const plan = () => ({ rationale: "Shared checks", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] },
    { id: "test", title: "Try it", kind: "do" as const, roleId: "tester", profileIds: ["sol-high"] },
    { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 2 },
    { id: "delivery", title: "Your delivery check", kind: "gate" as const, gate: "delivery" as const, roleId: "release-manager", profileIds: [] },
    { id: "ship", title: "Commit to main", kind: "do" as const, roleId: "release-manager", profileIds: ["sol-high"] },
  ] });
  const command = (name: string, script: string) => ({ name, argv: [process.execPath, "-e", script] });
  const failing = command("Welcome page", "console.error('The welcome page is missing'); process.exit(1)");
  const setChecks = (engine: Awaited<ReturnType<typeof fixture>>["engine"], productId: string, commands: readonly { name: string; argv: string[] }[]) => {
    const product = engine.s.products.find((entry) => entry.id === productId)!;
    product.checks = [...commands];
    product.checksBy = "coordinator";
  };

  it("requests fresh checks only for unfinished products without approving or replenishing repairs", async () => {
    const { engine, task } = await fixture("check-explicit-partial");
    try {
      task.plan = plan(); task.stageIndex = 2;
      const first = executionFor(task, "first").work, second = executionFor(task, "second").work;
      first.landed = { branch: "main", sha: "delivered" };
      first.checks = { at: 1, current: true, sha: "delivered", tree: "first-tree", results: [{ name: "Tests", command: "tests", ok: true, execution: completeCheckExecution(0), ms: 1, output: "Passed" }] };
      second.checks = { at: 2, current: true, sha: "pending", tree: "second-tree", results: [{ name: "Tests", command: "tests", ok: false, execution: completeCheckExecution(7), ms: 1, output: "Failed" }] };
      second.checkReturns = 2;
      engine["checks"].blocked(task);
      const item = engine.s.inbox.find((item) => item.taskId === task.id && item.kind === "delivery")!;
      engine.rerunChecks(item.id);
      expect(first.checks).toEqual(expect.objectContaining({ current: true, sha: "delivered", tree: "first-tree" }));
      expect(second.checks.sha).toBeUndefined(); expect(second.checks.tree).toBeUndefined();
      expect(second.checkReturns).toBe(2); expect(second.approvedFor).toBeUndefined();
      expect(task.stageIndex).toBe(2); expect(task.state).toBe("waiting");
      expect(task.journey!.at(-1)!.outcome).toBe("Run checks again");
    } finally { await engine.shutdown(); }
  });

  it("returns a shared check repair from the delivery check or shipping through review, withdrawing approval", async () => {
    const { engine, task } = await fixture("check-routes");
    try {
      task.plan = plan();
      const second = executionFor(task, "second");
      task.findings = [{ id: "check", text: "Check failed: Tests (bun test)", productIds: ["second"], severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" }];
      const attempt = (from: number) => {
        for (const work of task.repositories!) {
          work.approvedSha = "approved"; work.approvedPatch = "patch"; work.approvedFor = { by: "coordinator", mode: "local", destination: "main" };
          delete work.checkReturns;
        }
        delete task.repair;
        task.stageIndex = from;
        expect(engine["checks"].backToBuilder(second, "in this test", new Set((second.task.repositories ?? [second.work]).map(work => work.productId)))).toBe(true);
        expect(task.stageIndex).toBe(0);
        expect(second.work.checkReturns).toBe(1);
        return [task.repair!.returnStage, task.repositories!.map((work) => work.approvedPatch ?? "withdrawn").join()];
      };
      // From the delivery check or shipping: through review, as one product walks forward, and the delivery check
      // asks again. Earlier gates return to themselves.
      expect([3, 4, 2, 1].map(attempt)).toEqual([[2, "withdrawn,withdrawn"], [2, "withdrawn,withdrawn"], [2, "patch,patch"], [1, "patch,patch"]]);
      expect(task.repair).toEqual({ products: ["second"], index: 0, returnStage: 1, kind: "checks" });
      // Once a product has published, the rest returns to shipping as before, keeping the approval it is compared with.
      task.repositories![0]!.landed = { branch: "main", sha: "a".repeat(40) };
      expect(attempt(4)).toEqual([4, "patch,patch"]);
    } finally { await engine.shutdown(); }
  });

  it("lists every product's failing checks, turns and answers at a shared check problem, and returns a change request there", async () => {
    await withRepositoryRecords("check-problem", { git: ["first","second"] }, async ({ engine, task, id, run }) => {
      engine.setPoolPaused(false);
      task.plan = plan();
      task.stageIndex = 1;
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const checks = engine["checks"], signal = engine.stopRequested.signal;
      const secondChecks = [command("Tests", "console.log('(fail) greeting > says hello'); console.error('error: expected Hello'); process.exit(1)")];
      setChecks(engine, "first", [failing]); setChecks(engine, "second", secondChecks);
      await run(() => checks.runProductChecks(first, [failing], signal));
      await run(() => checks.runProductChecks(second, secondChecks, signal));
      first.work.checkReturns = 2;
      second.work.checkReturns = 1;
      // Incomplete execution stays unverified in the same spent episode; a Builder explanation alone establishes no interruption.
      setChecks(engine, "first", [failing]);
      first.work.checks!.results = [{ ...first.work.checks!.results[0]!, timedOut: true }];
      expect((await run(() => checks.failing(first, signal))).kind).toBe("blocked");
      expect(first.work.checkReturns).toBe(2);
      const answered = task.findings.find((finding) => finding.productIds?.includes("second"))!;
      answered.answer = { fixed: false, text: "The suite timed out while the Mac slept.", at: Date.now() };
      answered.answers = { second: answered.answer };
      expect(checks.blocked(task)).toBe("stop");
      const item = engine.s.inbox.find((entry) => entry.taskId === id && entry.kind === "delivery")!;
      expect(item.title).toBe(`Your call on “${task.title}”: a check still fails (Second: Tests); unverified (First: Welcome page)`);
      expect(item.body).toContain("First: Checks unverified. Unavailable or incomplete execution does not use an automatic Builder turn.\n• Welcome page did not finish: The welcome page is missing");
      expect(item.body).toContain("Second: still failing after 1 automatic Builder turn.\n• Tests failed: (fail) greeting > says hello\nerror: expected Hello\n  The Builder's last answer: “The suite timed out while the Mac slept.”");
      expect(item.body).toContain("Stopped before acceptance testing.");
      expect(item.body).toContain("Approving does not ship while checks fail or remain unverified.");
      expect(task.statusLine).toBe("Checks still fail. Your call");
      expect(task.stageIndex).toBe(1);
      expect(task.timeline.map((line) => line.text)).toContain("Checks still fail after their automatic Builder turns (Second: Tests); unverified (First: Welcome page), so Petrina waits for you before acceptance testing");
      // Asking for changes repairs the reproduced failure, then returns through testing and review.
      // The incomplete product remains unverified and does not acquire another automatic repair.
      engine.requestChanges(item.id, "Fix both checks");
      expect(task.repair).toEqual({ products: ["second"], index: 0, returnStage: 1, kind: "review" });
      expect(task.findings.find(finding => finding.productIds?.includes("first"))?.status).toBe("unverified");
      expect(task.stageIndex).toBe(0);
      expect(first.work.checkReturns).toBe(2);
      expect(second.work.checkReturns).toBe(1);
    });
  });
});
