import { afterAll, expect, it } from "bun:test";
import { followUpKey, type Finding } from "@petrina/core";
import { Coordination } from "../../../src/coordination.js";
import { createFollowUpFixtures, settledSource } from "../../fixtures/follow-up-native.js";
const { open, close, use } = createFollowUpFixtures();
afterAll(close);
it("refuses incomplete, unsettled and ineligible manual links with plain reasons and no changes", async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner, undefined, true);
  try {
    const { engine } = world;
    const c = new Coordination(engine);
    const variants: { name: string; finding?: Partial<Finding>; sourceState?: "running" | "cancelled"; target?: "missing" | "cancelled" | "combined" | "feature" | "self" | "product"; pending?: boolean }[] = [
      { name: "fixed", finding: { status: "fixed" } },
      { name: "dismissed", finding: { status: "dismissed" } },
      ...(["not-a-bug", "nit", "real"] as const).map(verdict => ({ name: `judged-${verdict}`, finding: { verification: { by: "sol-high", verdict, reason: "Not confirmed older", at: 1 } } })),
      { name: "nit", finding: { severity: "suggestion" } },
      { name: "Important", finding: { severity: "blocking" } },
      { name: "check", finding: { raisedBy: "petrina", text: "Check failed: tests" } },
      { name: "acceptance", finding: { text: "Failed acceptance check: page" } },
      { name: "steps", finding: { steps: " " } },
      { name: "evidence", finding: { evidence: " " } },
      { name: "elsewhere", finding: { tracking: { taskId: "another-task" } } },
      { name: "no-outcome", finding: { tracking: undefined } },
      { name: "unfinished", sourceState: "running" },
      { name: "cancelled-source", sourceState: "cancelled" },
      { name: "pending", pending: true },
      ...(["missing", "cancelled", "combined", "feature", "self", "product"] as const).map(target => ({ name: target, target })),
      { name: "all-products", finding: { productIds: [world.shop, world.notes] } },
    ];
    for (const variant of variants) {
      const source = settledSource(engine, world.shop, variant.finding);
      if (variant.sourceState) source.state = variant.sourceState;
      const targetId = engine.addTask({ productId: variant.target === "product" ? world.notes : world.shop, kind: variant.target === "feature" ? "feature" : "bug", title: variant.name, backlog: true });
      const target = engine.task(targetId)!;
      if (variant.target === "cancelled" || variant.target === "combined") target.state = "cancelled";
      if (variant.target === "combined") target.combinedInto = "replacement";
      engine.s.followUpPending = variant.pending ? [{ keys: [followUpKey(source.id, "old")], cardId: targetId }] : [];
      engine.save();
      const before = structuredClone([engine.task(source.id), engine.task(targetId), engine.s.followUpPending]);
      const result = await c.call("task.track-finding", { taskId: source.id, findingId: "old", targetTaskId: variant.target === "missing" ? "missing" : variant.target === "self" ? source.id : targetId, requestId: `refuse-${variant.name}` });
      expect(result.outcome, variant.name).toBe("invalid");
      expect(typeof result.message, variant.name).toBe("string");
      expect([engine.task(source.id), engine.task(targetId), engine.s.followUpPending], variant.name).toEqual(before);
    }
    expect(world.prompts).toEqual([]);
  } finally { await caseOwner.stop(world.engine); }
  });
});
