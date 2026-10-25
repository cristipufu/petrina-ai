import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { coordinator, Fakes, itemOf, makeProduct, removeDir, tempDir, until } from "../../support.js";
import { commandText } from "../../../src/checks.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("keeps the early decision through restart, then runs changed checks and acceptance before a separate approval", async () => {
  const root = tempDir("petrina-review-final-verification-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "tester-after", builder: "plain", reviewer: "important" });
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir] };
  let engine = new Engine(join(root, "data"), options);
  const log = join(root, "check-runs");
  const check = join(root, "check.ts");
  writeFileSync(check, `import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], process.argv[3] + "\\n");`);
  const definitions = (name: string) => [{ name: "Tests", command: commandText([process.execPath, check, log, name]) }];
  try {
    const productId = await engine.addProduct(await makeProduct(root));
    engine.setProductDelivery(productId, "local", true);
    engine.setProductChecks(productId, definitions("before decision"));
    const id = engine.addTask({ productId, title: "A reviewed greeting", description: "[no-check]" });
    const first = await until(engine, state => !!itemOf(state, id, "delivery"), coordinator(["plan"]));
    const item = itemOf(first, id, "delivery")!;
    expect(engine.task(id)!.reviewDecision?.accepted).toBe(false);
    expect(fakes.openings("tester")).toHaveLength(0);
    expect(readFileSync(log, "utf8")).toBe("before decision\n");
    engine.setPoolPaused(true);
    await engine.shutdown();
    engine = new Engine(join(root, "data"), options);
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
  } finally { await engine.shutdown(); }
});
