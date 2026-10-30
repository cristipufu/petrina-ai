import { installSharedWorkflowFastPaths, prepareSharedDelivery } from "../../fixtures/shared-preparation.js";
import { commandInputText, checkDecisionLabel, decisionEvidence } from "@petrina/core";
import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coordinator, itemOf, taskOf, until } from "../../support.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());

describe.concurrent("shared delivery and hand-back regressions", () => {
  it("attributes both products' reused failures after a shared unchanged repair", async () => {
    await fixtures.world("unchanged-shared-check-repair", async ({ shop, api, engine: withEngine, fakes }) => {
    const log = join(shop.dir, "checks-ran.txt"), script = join(shop.dir, "fails.cjs");

    await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipUpToDate: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCleanup: true });
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      const products = [first, second];
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", affectedProducts: products });
      writeFileSync(script, 'require("node:fs").appendFileSync(process.argv[2], process.argv[3] + "\\n"); process.exit(1);');
      const check = (productId: string) => [{ name: "Tests", command: commandInputText([process.execPath, script, log, productId]) }];
      for (const productId of products) engine.setProductChecks(productId, check(productId));
      const id = engine.addTask({ backlog: true, productId: first, worksOn: products.map(productId => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Investigate both products' failed checks" });
      await prepareSharedDelivery(engine, id);
      // One earlier repair is saved input. This contract exercises one unchanged repair per owner.
      engine.task(id)!.repositories!.forEach(work => { work.checkReturns = 1; });
      engine.schedule();
      const state = await until(engine, state => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan"]));
      const task = taskOf(state, id);
      expect(task.error).toBeUndefined();
      expect(fakes.received("builder")).toHaveLength(2);
      expect(readFileSync(log, "utf8").trim().split("\n").sort()).toEqual([...products].sort());
      expect(task.repositories!.map(work => work.checkReturns)).toEqual([2, 2]);
      const evidence = decisionEvidence(task);
      expect(evidence.map(check => [check.productId, check.result, check.reusedAt !== undefined])).toEqual([[first, "fail", true], [second, "fail", true]]);
      for (const check of evidence) expect(task.journey!.find(step => step.id === check.run!.source!.stepId)?.work).toBe("checks");
      expect(itemOf(state, id, "delivery")!.body!.match(/Previous check evidence reused; no new execution\./g)).toHaveLength(2);
      // Editing a definition leaves these unresolved results and their coordinator actions intact.
      engine.setProductChecks(first, check(first));
      expect(checkDecisionLabel(taskOf(engine.getState(), id))).toBe("Your call: checks still failing");
      expect(taskOf(engine.getState(), id).statusLine).toBe("Checks still fail. Your call");
      expect(task.findings.filter(finding => finding.text.startsWith("Check failed"))).toHaveLength(2);

    }, {
      runCheckCommand: (req) => {
        if (req.argv[0] !== process.execPath || req.argv[1] !== script) return undefined;
        appendFileSync(req.argv[2]!, `${req.argv[3]!}\n`);
        return { code: 1 };
      },
    });
    });
  });

  it("returns a shared check repair started right before shipping through review, acceptance and the delivery check", async () => {
    await fixtures.world("check-repair-before-shipping", async ({ shop, api, engine: withEngine, fakes, builtChecks }) => {
    const passesPath = join(api.dir, "welcome-passes.cjs"), filePath = join(api.dir, "welcome-file.cjs");

    await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipUpToDate: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCleanup: true });
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      const pFirst = engine.s.products.find(p => p.id === first)!;
      pFirst.checks = [];
      pFirst.checksBy = "coordinator";
      const products = [first, second];
      fakes.scenario({ planner: "tester-first", builder: "plain", reopen: "resume", affectedProducts: products, fixes: "change" });
      const script = (name: string, body: string) => { const path = join(api.dir, name); writeFileSync(path, body); return commandInputText([process.execPath, path]); };
      engine.setProductChecks(second, [{ name: "Welcome", command: script("welcome-passes.cjs", "process.exit(0)") }]);
      const id = await builtChecks(engine, { productId: first, worksOn: products.map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Welcome people in both products" });
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      expect(taskOf(ready, id).error).toBeUndefined();
      const reviewers = fakes.received("code reviewer").length, testers = fakes.openings("tester").length, builders = fakes.received("builder").length;
      expect(testers).toBe(1);
      // The API's checks change after approval and fail on what was about to ship.
      engine.setProductChecks(second, [{ name: "Welcome", command: script("welcome-file.cjs", "process.exit(require('node:fs').existsSync('welcome.txt') ? 0 : 1)") }]);
      const approved = itemOf(ready, id, "delivery")!.id;
      engine.approve(approved);
      const again = await until(engine, (state) => (!!itemOf(state, id, "delivery") && itemOf(state, id, "delivery")!.id !== approved) || !!taskOf(state, id).error || taskOf(state, id).state === "pr-open", coordinator(["plan", "design"]));
      const task = taskOf(again, id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("needs-you");
      const lines = task.timeline.map((line) => line.text);
      expect(lines.some((line) => line.startsWith("Checks: 1 of 1 failed (Welcome)"))).toBe(true);
      // Only the API's Builder repaired it; the fix was reviewed again and acceptance tried on the final code.
      expect(fakes.received("builder").length).toBeGreaterThan(builders);
      expect(fakes.received("code reviewer").length).toBeGreaterThan(reviewers);
      expect(fakes.openings("tester")).toHaveLength(2);
      const repaired = task.repositories!.find((work) => work.productId === second)!;
      expect(repaired.checks!.results.every((run) => run.ok)).toBe(true);
      expect(task.repositories!.map((work) => work.checkReturns)).toEqual([undefined, undefined]);
      expect(task.repositories!.every((work) => !work.pr && !work.approvedFor)).toBe(true);
      expect(itemOf(again, id, "delivery")!.title).toBe("Ready to ship “Welcome people in both products”");

    }, {
      runCheckCommand: (req) => {
        if (req.argv[0] !== process.execPath) return undefined;
        if (req.argv[1] === passesPath) return { code: 0 };
        if (req.argv[1] === filePath) return { code: existsSync(join(req.cwd, "welcome.txt")) ? 0 : 1 };
        return undefined;
      },
    });
    });
  });
});
