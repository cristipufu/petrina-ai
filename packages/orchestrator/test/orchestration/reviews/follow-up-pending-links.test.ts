import { expect, it } from "vitest";
import { followUpKey } from "@petrina/core";
import { followUpLinksFixture, older } from "../../fixtures/follow-up-links.js";

it("does not open a second card when a link is saved only part-way", async () => {
  const f = followUpLinksFixture();

  try {
    const task = f.taskOf(f.shop, "Pending", [older("one", "bug-pending: The footer opens a retired page.")]);
    task.state = "done";
    const key = followUpKey(task.id, "one");
    const before = f.prompts.length;
    f.state.followUpPending = [{ keys: [key] }];
    await f.links.catchUp();
    expect(f.prompts.length).toBe(before);
    expect(f.cardFor("pending")).toHaveLength(1);
    expect(f.task(task.id)!.findings[0]!.tracking).toEqual({ taskId: f.cardFor("pending")[0]!.id });

    const other = f.taskOf(f.shop, "Pending too", [older("two", "bug-pending: About in the footer is retired.")]);
    other.state = "done";
    const card = f.cardFor("pending")[0]!;
    f.state.followUpPending = [{ keys: [key, followUpKey(other.id, "two")], cardId: card.id }];
    await f.links.catchUp();
    expect(f.prompts.length).toBe(before);
    expect(f.cardFor("pending")).toHaveLength(1);
    expect(f.task(other.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    expect(card.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["one", "two"]);

    await Promise.all([f.links.noteDone(task), f.links.noteDone(other)]);
    expect(f.cardFor("pending")).toHaveLength(1);
  } finally { await f.stop(); }
});
