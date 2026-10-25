import { expect, it } from "vitest";
import { queueBacklogTask, editBacklogRequest } from "@petrina/core";
import { followUpLinksFixture, older, groupByBug } from "../../fixtures/follow-up-links.js";

it("adds a product while the card waits, and only records one named after work has started", async () => {
  const f = followUpLinksFixture(groupByBug, true);

  try {
    const shared = f.taskOf(f.shop, "Both products", [older("shared", "bug-shared: The footer fails for both products.", { productIds: [f.shop, f.notes] })]);
    await f.finish(shared);
    expect(f.cardFor("shared")[0]!.selectedProducts?.map((choice) => choice.productId)).toEqual([f.shop, f.notes]);
    expect(f.cardFor("shared")[0]!.approvePlan).toBe(true);
    Object.assign(f.products.find(product => product.id === f.shop)!, { delivery: "local", approveDelivery: false });
    Object.assign(f.products.find(product => product.id === f.notes)!, { delivery: "local", approveDelivery: true });
    const first = f.taskOf(f.shop, "Shop footer", [older("shop", "bug-wide: The footer opens a retired page.", { productIds: [f.shop] })]);
    await f.finish(first);
    const card = f.cardFor("wide")[0]!;
    expect(card.selectedProducts?.map((choice) => choice.productId)).toEqual([f.shop]);
    expect(card.approveDelivery).toBe(false);
    const edited = "Coordinator wording for the footer.";
    editBacklogRequest(card, { title: card.title, description: edited });
    const extra = f.taskOf(f.notes, "Notes footer", [older("notes", "bug-wide: Notes has the same retired footer page.", { productIds: [f.shop, f.notes] })]);
    await f.finish(extra);
    expect(card.selectedProducts?.map((choice) => choice.productId)).toEqual([f.shop, f.notes]);
    expect(card.approvePlan).toBe(true);
    expect(card.followUp!.alsoReported).toBeUndefined();
    expect(card.approveDelivery).toBe(true);
    expect(card.description).toBe(edited);
    expect(f.cardFor("wide")).toHaveLength(1);
    expect(f.cards()).toHaveLength(2);

    const queued = f.taskOf(f.shop, "Queued footer", [older("queued", "bug-queued: The footer opens a retired page.", { productIds: [f.shop] })]);
    await f.finish(queued);
    const queuedCard = f.cardFor("queued")[0]!;
    queueBacklogTask(f.task(queuedCard.id)!, f.state.tasks.length);
    expect(queuedCard.state).toBe("queued");
    expect(queuedCard.startedAt).toBeUndefined();
    const after = f.taskOf(f.notes, "After start", [older("after", "bug-queued: Notes shows the same retired page.", { productIds: [f.shop, f.notes] })]);
    await f.finish(after);
    expect(queuedCard.selectedProducts?.map((choice) => choice.productId)).toEqual([f.shop]);
    expect(queuedCard.followUp!.alsoReported).toEqual([f.notes]);
    expect(queuedCard.approveDelivery).toBe(false);
    expect(f.cardFor("queued")).toHaveLength(1);

    queuedCard.state = "done";
    const returned = f.taskOf(f.shop, "Returned", [older("returned", "bug-queued: The retired footer page is back.")]);
    await f.finish(returned);
    const fresh = f.cardFor("queued").filter((task) => task.id !== queuedCard.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.state).toBe("backlog");
    expect(fresh[0]!.followUp!.reports.map((report) => report.findingId)).toEqual(["returned"]);
    expect(queuedCard.followUp!.reports.map((report) => report.findingId)).not.toContain("returned");
  } finally { await f.stop(); }
});
