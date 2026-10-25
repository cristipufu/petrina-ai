import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";

import { followUpSnapshot, noteReviewTag, takesFollowUps } from "../../../src/follow-ups.js";
import type { RunState, Task } from "../../../src/model.js";

function boardTask(id: string, extra: Partial<Task> = {}): Task {
  const base = taskFixture(stateFixture({ now: 1_000_000_000 }));
  return { ...base, id, title: id, description: `The coordinator's request for ${id}`, kind: "bug", state: "backlog", productId: "shop", repositories: undefined, selectedProducts: [{ productId: "shop", startFrom: { kind: "default" }, delivery: "pull-request" }], findings: [], session: [], journey: [], followUp: undefined, ...extra };
}

describe("confirmed older bugs", () => {
  it("shows a card's current request rather than an immutable obsolete report", () => {
    const original = taskFixture(stateFixture({ now: 1_000_000_000 }));
    const task = JSON.parse(JSON.stringify(original)) as typeof original;
    Object.assign(task, { state: "backlog", kind: "bug", title: "Current remaining defect", description: "The coordinator's current reproduction", followUp: { reports: [{ taskId: "source", findingId: "old", text: "The already repaired original defect", productIds: [task.productId] }] } });
    const snapshot = followUpSnapshot([task]);
    expect(snapshot.cards[0]?.problem).toBe("The coordinator's current reproduction");
    expect(snapshot.cards[0]?.reportKeys).toEqual(["source::old"]);
  });

  it("lists unfinished coordinator bugs in every open state, keeping features, closed work and report-bearing cards to their own rules", () => {
    const states: RunState[] = ["backlog", "queued", "waiting", "running", "needs-you", "paused", "failed", "pr-open"];
    const open = states.map(state => boardTask(`manual-${state}`, { state }));
    const closed = (["done", "cancelled"] as const).map(state => boardTask(`closed-${state}`, { state }));
    const feature = boardTask("feature", { kind: "feature", state: "running" });
    const scopeless = boardTask("scopeless", { productId: "", selectedProducts: [], state: "queued" });
    const credit = { taskId: "older", findingId: "1", sourceTitle: "Older", text: "An older bug", steps: "Look", evidence: "Old", raisedBy: "opus-high", productIds: ["notes"], at: 1 };
    const automatic = boardTask("automatic", { state: "running", followUp: { reports: [credit] } });
    const combined = boardTask("combined", { kind: "feature", followUp: { reports: [credit] } });
    const cards = followUpSnapshot([...open, ...closed, feature, scopeless, automatic, combined]).cards;
    expect(cards.map(card => card.id)).toEqual([...open.map(task => task.id), "automatic", "combined"]);
    expect(cards.filter(card => card.id.startsWith("manual-")).every(card => card.fixedProducts && card.productIds.join() === "shop")).toBe(true);
    expect(cards.map(card => card.phase)).toEqual(["backlog", ...states.slice(1).map(() => "started"), "started", "backlog"]);
    expect(cards.find(card => card.id === "manual-running")!.problem).toBe("The coordinator's request for manual-running");
    expect(cards.find(card => card.id === "combined")).toMatchObject({ productIds: ["shop", "notes"], reportKeys: ["older::1"] });
    // One decision for saving a link: open, and exactly the products of a coordinator's request.
    const later = (productIds: string[]) => [{ taskId: "later", findingId: "1", productIds }];
    for (const task of open) {
      expect(takesFollowUps(task, later(["shop"]))).toBe(true);
      expect(takesFollowUps(task, later(["shop", "notes"]))).toBe(false);
      expect(takesFollowUps(task, later([]))).toBe(false);
    }
    for (const task of [...closed, feature, scopeless]) expect(takesFollowUps(task, later(["shop"]))).toBe(false);
    expect(takesFollowUps(combined, later(["notes", "site"]))).toBe(true);
    expect(takesFollowUps({ ...automatic, state: "done" }, later(["shop"]))).toBe(false);
    // A report already credited on a coordinator's request keeps it after the request's products change.
    const credited = boardTask("credited", { state: "queued", productId: "notes", selectedProducts: [{ productId: "notes", startFrom: { kind: "default" }, delivery: "pull-request" }], followUp: { preserveRequest: true, reports: [{ ...credit, taskId: "later", productIds: ["shop"] }] } });
    expect([takesFollowUps(credited, later(["shop"])), takesFollowUps(credited, [{ taskId: "other", findingId: "1", productIds: ["shop"] }])]).toEqual([true, false]);
  });

  it("keeps an Important tag and an older tag together until the usual vote", async () => {
    const older = noteReviewTag(undefined, "pre-existing", "opus-high", 1);
    expect(older).toMatchObject({ severity: "pre-existing", clearVote: false });
    const caused = noteReviewTag(older, "blocking", "sol-high", 2);
    expect(caused.severity).toBe("blocking");
    expect(caused.clearVote).toBe(true);
    expect(caused.judgments.map((entry) => entry.severity)).toEqual(["pre-existing", "blocking"]);
    const first = noteReviewTag(undefined, "blocking", "opus-high", 1);
    const later = noteReviewTag({ ...first, verification: { by: "voter", verdict: "real", reason: "It fails now.", at: 2 } }, "pre-existing", "sol-high", 3);
    expect(later.severity).toBe("blocking");
    expect(later.clearVote).toBe(false);
    expect(later.judgments.map((entry) => entry.severity)).toEqual(["blocking", "pre-existing"]);
    expect(noteReviewTag({ severity: "pre-existing", judgments: [] }, "suggestion", "sol-high", 4).severity).toBe("pre-existing");
  });
});
