import { afterAll, expect, it } from "bun:test";
import { ReviewResult } from "../../../src/roles.js";
import { checkReviewEvidence } from "@petrina/core";
import { createFollowUpFixtures, STEPS, EVIDENCE, older, taskOf, cardFor, plant } from "../../fixtures/follow-up-native.js";

const { open, reopen, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("recovers a skipped choice after the shown card finishes, preserving votes, pictures and one card through restart", async () => {
  const world = await open();
  try {
    const { engine } = world;
    const shown = engine.addTask({ productId: world.shop, kind: "bug", title: "Already finished", backlog: true });
    engine.task(shown)!.state = "done";
    const text = "bug-silent: An accepted confirmed unrelated bug";
    const accepted = ReviewResult.parse({ verdict: "pass", findings: [{ text, severity: "pre-existing", steps: STEPS, evidence: EVIDENCE }] });
    expect(checkReviewEvidence([], accepted)).toBeUndefined();
    const source = taskOf(engine, world.shop, "Finished source", [older("old", text, {
      cardsShown: [shown], tracking: { reason: "no-choice" },
      verification: { by: "sol-high", verdict: "pre-existing", reason: "Three independent voters confirmed base", at: 1 },
      votes: [{ by: "sol-high", toolId: "codex", verdict: "pre-existing", reason: "Base reproduction confirmed" }],
    })]);
    plant(engine, source.id, text);
    const release = engine.holdFollowUp(source.id);
    try {
      source.state = "done";
      source.column = "done";
      engine.save();
      expect(engine.s.tasks.some(task => task.id === source.id)).toBe(true);
      await engine["followUps"].catchUp();
    } finally { release(); }
    const card = cardFor(engine, "silent")[0]!;
    expect(card.state).toBe("backlog");
    expect(card.description).toContain(STEPS);
    expect(card.description).toContain("Three independent voters confirmed base");
    expect(card.description).toContain("Base reproduction confirmed");
    expect(card.followUp!.reports[0]).toMatchObject({ taskId: source.id, findingId: "old", text });
    expect(card.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    expect(world.prompts).toEqual([]);
    await reopen(world);
    await world.engine["followUps"].catchUp();
    expect(cardFor(world.engine, "silent")).toHaveLength(1);
    expect(world.engine.task(card.id)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
  } finally { await shutdown(world.engine); }
});
