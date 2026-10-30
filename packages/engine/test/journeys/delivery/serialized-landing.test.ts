import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { installSharedWorkflowFastPaths, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import * as gitOps from "@petrina/repositories/git";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll as closeOwnedCases, expect, it } from "bun:test";
import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import { commandInputText } from "../../../src/checks.js";
import { createProductRepository } from "../../fixtures.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


// Two individually good changes are intentionally incompatible. The old pass must never authorize
// their combined tree, even when both publication calls begin together on the same approved base.
it("serializes concurrent local landings and checks the second integrated tree before moving main", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const root = mkdtempSync(join(owner.root, "petrina-landing-reliability-"));
    const log = join(root, "checks.jsonl");
    const script = join(root, "check.ts");
    const engine = installSharedWorkflowFastPaths(owner.open(join(root, "data"), {
      agentCommand: () => undefined,
      toolProbe: privateAgentToolProbe(),
      terminals: () => [],
      runCheckCommand: (req) => {
        if (req.argv[0] !== process.execPath || req.argv[1] !== script) return undefined;
        const ver = readWorktreeCommit(req.cwd)!;
        const ok = !(existsSync(join(req.cwd, "feature-a")) && existsSync(join(req.cwd, "feature-b")));
        appendFileSync(req.argv[2]!, `${JSON.stringify({ tree: ver.tree, ok })}\n`);
        return { code: ok ? 0 : 1 };
      },
    }), { skipDriverPrepare: false, skipUpToDate: true, fastCheckCapture: true });
    engine.schedule = () => {};
    engine.setPoolPaused(false);
    try {
      await owner.run(engine, async () => {
        const { path: repo, initialSha: base } = await createProductRepository(root, { origin: "none" });
        owner.check(); engine.stopRequested.signal.throwIfAborted();
        await engine.waitUntilReady();
        owner.check(); engine.stopRequested.signal.throwIfAborted();
        const productId = installPreparedProduct(engine, { ...privateCloneProduct(repo), remote: undefined });
        writeFileSync(script, `import { appendFileSync } from "node:fs";`);
        engine.setProductChecks(productId, [{ name: "Tests", command: commandInputText([process.execPath, script, log]) }]);
        const signal = owner.signal;
        const tasks: NonNullable<ReturnType<typeof engine.task>>[] = [];
        // These direct calls exercise the last ref-movement defense with two already-prepared candidates.
        // Return their delivery turns when an attempt ends, as the real task driver does in its cleanup.
        const attempt = async <T>(task: NonNullable<ReturnType<typeof engine.task>>, run: () => Promise<T>): Promise<T> => {
          try { return await run(); }
          finally { engine["shipping"].releaseDeliveryTurn(task.id); }
        };
        for (const name of ["a", "b"]) {
          const task = engine.task(engine.addTask({ productId, title: `Feature ${name}` }))!;
          const work = executionFor(task).work;
          work.delivery = "local"; work.base = "main"; work.baseSha = base;
          work.branch = `task-${name}`; work.worktree = join(root, `copy-${name}`);
          await gitOps.ensureWorktree(repo, work.worktree, work.branch, base);
          writeFileSync(join(work.worktree, `feature-${name}`), name);
          await gitOps.commitChanges(work.worktree, task.title);
          task.plan = { rationale: "Focused delivery fixture", plannerProfileId: "opus-high", stages: [
              { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
              { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["opus-high"] },
            ] };
          task.stageIndex = 1;
          tasks.push(task);
        }
        for (const task of tasks) {
          const scope = executionFor(task);
          expect((await engine["checks"].failing(scope, signal)).kind).toBe("passed");
          const tested = readWorktreeCommit(scope.work.worktree!)!.commit;
          scope.work.approvedSha = tested;
          scope.work.approvedPatch = await engine["updates"].patch(scope);
          scope.work.shipping = { moves: 0, failures: 0, base, start: tested, prepared: { tested, summary: task.title } };
        }
        const results = await Promise.all(tasks.map(task => attempt(task, () => engine["shipping"]["publishLocal"](executionFor(task), signal))));
        expect([...results].sort()).toEqual(["again", "done"]);
        expect(tasks.every(task => !engine["checks"].deliveryOrders.has(task.id))).toBe(true);
        const landed = tasks[results.indexOf("done")]!;
        const second = tasks[results.indexOf("again")]!;
        const firstTip = await gitOps.revParse(repo, "main");
        expect(firstTip).toBe(executionFor(landed).work.approvedSha!);
        expect(executionFor(second).work.shipping?.prepared).toBeUndefined();
        // Re-enter the real preparation boundary. Its integrated tree fails, so it cannot publish.
        expect(await attempt(second, () => engine["shipping"]["readyToShip"](executionFor(second), signal))).toBe("back");
        const evidence = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { tree: string; ok: boolean });
        expect(evidence.map(run => run.ok)).toEqual([true, true, false]);
        expect(evidence[2]!.tree).not.toBe(evidence[0]!.tree);
        expect(evidence[2]!.tree).not.toBe(evidence[1]!.tree);
        expect(executionFor(second).work.checks?.tree).toBe(evidence[2]!.tree);
        expect(executionFor(second).work.approvedSha).toBeUndefined();
        expect(await gitOps.revParse(repo, "main")).toBe(firstTip);
        expect(second.stageIndex).toBe(0);
        expect(engine["checks"].deliveryOrders.has(second.id)).toBe(false);

      });
    } finally { await owner.stop(engine); }

  });
});
