import { afterAll, expect, it } from "bun:test";
import { createFollowUpFixtures, STEPS, EVIDENCE, older, taskOf, finish, cards, cardFor } from "../../fixtures/follow-up-native.js";
const { open, close, use } = createFollowUpFixtures();
afterAll(close);
it("keeps one backlog card for a confirmed older bug and leaves everything else on the task", async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner);
  const { engine } = world;
  try {
    const inbox = engine.s.inbox.length;
    const kept = taskOf(engine, world.shop, "Footer links", [
      older("kept", "bug-kept: The footer opens a retired page."),
      older("nit", "A quieter footer would be nicer.", { severity: "suggestion" }),
      older("caused", "This change sends About to a missing page.", { severity: "blocking" }),
      older("dismissed", "bug-dismissed: An old footer note.", { status: "dismissed" }),
      older("check", "Check failed: the suite", { raisedBy: "petrina" }),
      older("acceptance", "Failed acceptance check: the footer still loads."),
      older("unverified", "Could not verify acceptance check: the footer", { status: "unverified" }),
      older("steps", "bug-steps: The footer has no steps.", { steps: undefined }),
      older("evidence", "bug-evidence: The footer has no evidence.", { evidence: undefined }),
    ]);
    const waiting = taskOf(engine, world.shop, "Still open", [older("pull", "bug-pull: The footer opens a retired page.")]);
    waiting.state = "pr-open";
    await engine["followUps"].noteDone(waiting);
    await engine["followUps"].catchUp();
    expect(cards(engine)).toHaveLength(0);
    await finish(caseOwner, engine, kept);
    const card = cardFor(engine, "kept");
    expect(card).toHaveLength(1);
    expect(card[0]!.state).toBe("backlog");
    expect(card[0]!.kind).toBe("bug");
    expect(card[0]!.startedAt).toBeUndefined();
    expect(card[0]!.approvePlan).toBe(false);
    expect(card[0]!.selectedProducts?.map((choice) => choice.productId)).toEqual([world.shop]);
    expect(card[0]!.description).toContain(STEPS);
    expect(card[0]!.description).toContain(EVIDENCE);
    expect(card[0]!.description).toContain("Found on Footer links.");
    expect(card[0]!.followUp!.reports.map((report) => report.findingId)).toEqual(["kept"]);
    expect(card[0]!.timeline.map((entry) => entry.text)).toContain("Kept as future work");
    const finding = kept.findings.find((entry) => entry.id === "kept")!;
    expect(finding.tracking).toEqual({ taskId: card[0]!.id });
    expect(kept.findings.find((entry) => entry.id === "steps")!.tracking).toEqual({ reason: "missing-steps" });
    expect(kept.findings.find((entry) => entry.id === "evidence")!.tracking).toEqual({ reason: "missing-evidence" });
    for (const id of ["nit", "caused", "dismissed", "check", "acceptance", "unverified"]) expect(kept.findings.find((entry) => entry.id === id)!.tracking).toBeUndefined();
    expect(kept.state).toBe("done");
    expect(kept.rounds).toEqual({ review: 1 });
    expect(engine.s.inbox.length).toBe(inbox);
    expect(waiting.findings[0]!.tracking).toBeUndefined();
    engine.setPoolPaused(false);
    engine.schedule();
    expect(card[0]!.state).toBe("backlog");
    expect(card[0]!.startedAt).toBeUndefined();
    expect(engine.drivers.size).toBe(0);
    engine.setPoolPaused(true);
    await engine["followUps"].catchUp();
    expect(cards(engine)).toHaveLength(1);
    expect(cardFor(engine, "pull")).toHaveLength(0);
    expect(waiting.findings[0]!.tracking).toBeUndefined();
  } finally { await caseOwner.stop(engine); }
  });
});
