import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { fakeAgentSessions } from "../../fixtures/fake-agent-sessions.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { executionFor } from "@petrina/orchestrator";
import { coordinator, Fakes, itemOf, makeProduct, until } from "../../support.js";
import { commandInputText, type CheckCommandExecutor } from "../../../src/checks.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


it("keeps the early decision through restart, then runs changed checks and acceptance before a separate approval", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const root = mkdtempSync(join(owner.root, "petrina-review-final-verification-"));
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "tester-after", builder: "plain", reviewer: "important" });
    const log = join(root, "check-runs");
    const check = join(root, "check.ts");
    const runCheckCommand: CheckCommandExecutor = (req) => {
      if (req.argv[0] !== process.execPath || req.argv[1] !== check) return undefined;
      appendFileSync(req.argv[2]!, `${req.argv[3]!}\n`);
      return { code: 0 };
    };
    const options = {
      agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir],
      startAgentSession: fakeAgentSessions(fakes),
      toolProbe: privateAgentToolProbe(),
      runCheckCommand,
    };
    let engine = installSharedWorkflowFastPaths(owner.open(join(root, "data"), options));
    writeFileSync(check, `import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], process.argv[3] + "\\n");`);
    const definitions = (name: string) => [{ name: "Tests", command: commandInputText([process.execPath, check, log, name]) }];
    try {
      const productId = await owner.run(engine, async () => {
        const repo = await makeProduct(root);
        await engine.waitUntilReady(); owner.check(); engine.stopRequested.signal.throwIfAborted();
        return installPreparedProduct(engine, privateCloneProduct(repo));
      });
      engine.setProductDelivery(productId, "local", true);
      engine.setProductChecks(productId, definitions("before decision"));
      const id = engine.addTask({ productId, title: "A reviewed greeting", description: "[no-check]" });
      const first = await until(engine, state => !!itemOf(state, id, "delivery"), coordinator(["plan"]));
      const item = itemOf(first, id, "delivery")!;
      expect(engine.task(id)!.reviewDecision?.accepted).toBe(false);
      expect(fakes.openings("tester")).toHaveLength(0);
      expect(readFileSync(log, "utf8")).toBe("before decision\n");
      engine.setPoolPaused(true);
      await owner.stop(engine);
      engine = installSharedWorkflowFastPaths(owner.open(join(root, "data"), options));
      expect(engine.task(id)!.reviewDecision?.accepted).toBe(false);
      expect(engine.s.inbox.find(entry => entry.id === item.id)).toBeDefined();
      engine.setProductChecks(productId, definitions("after decision"));
      appendFileSync(log, "decision\n");
      engine.approve(item.id);
      expect(executionFor(engine.task(id)!).work.approvedSha).toBeUndefined();
      engine.setPoolPaused(false);
      const final = await until(engine, state => !!itemOf(state, id, "delivery"));
      expect(itemOf(final, id, "delivery")!.id).not.toBe(item.id);
      expect(readFileSync(log, "utf8")).toBe("before decision\ndecision\nafter decision\n");
      expect(fakes.openings("tester")).toHaveLength(1);
      expect(engine.task(id)!.acceptancePassed).toBe(true);
      expect(engine.task(id)!.findings.some(finding => finding.severity === "blocking" && finding.status === "open")).toBe(true);
      expect(executionFor(engine.task(id)!).work.approvedSha).toBeUndefined();
      engine.requestChanges(itemOf(final, id, "delivery")!.id, "Repair the confirmed defect and review it again");
      engine.setPoolPaused(true);
      expect(engine.task(id)!.reviewDecision).toBeUndefined();
      expect(engine.task(id)!.fixing).toBe(true);
      expect(engine.task(id)!.plan!.stages[engine.task(id)!.stageIndex]!.roleId).toBe("builder");
    } finally { await owner.stop(engine); }

  });
});
