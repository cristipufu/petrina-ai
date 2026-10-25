import { afterAll, expect, it } from "bun:test";
import { createFollowUpFixtures, older, taskOf, finish, cards, cardFor } from "../../fixtures/follow-up-native.js";

const { open, reopen, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("credits every matching report on one card, in either order, and again after a restart", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const savedFirst = taskOf(engine, world.shop, "First wording", [older("one", "bug-saved: The footer opens a retired page.", { raisedBy: "opus-high", roleId: "code-reviewer" })]);
    const savedSecond = taskOf(engine, world.shop, "Second wording", [older("two", "bug-saved: Choosing About still lands on the old page.", { raisedBy: "sol-high", roleId: "security-reviewer" })]);
    await finish(engine, savedFirst);
    expect(cardFor(engine, "saved")).toHaveLength(1);
    expect(cardFor(engine, "saved")[0]!.followUp!.reports.map((report) => report.taskId).sort()).toEqual([savedFirst.id, savedSecond.id].sort());
    expect(savedSecond.findings[0]!.tracking).toEqual({ taskId: cardFor(engine, "saved")[0]!.id });
    await finish(engine, savedSecond);
    expect(cardFor(engine, "saved")).toHaveLength(1);
    expect(savedSecond.findings[0]!.roleId).toBe("security-reviewer");

    const later = taskOf(engine, world.shop, "Later wording", []);
    const early = taskOf(engine, world.shop, "Early wording", [older("early", "bug-later: The footer opens a retired page.", { roleId: "layout-reviewer" })]);
    await finish(engine, early);
    expect(cardFor(engine, "later")[0]!.followUp!.reports).toHaveLength(1);
    later.findings = [older("late", "bug-later: The about page in the footer is retired.")];
    await finish(engine, later);
    expect(cardFor(engine, "later")).toHaveLength(1);
    expect(cardFor(engine, "later")[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["early", "late"]);
    expect(later.findings[0]!.tracking).toEqual({ taskId: cardFor(engine, "later")[0]!.id });
    expect(early.findings[0]!.tracking).toEqual({ taskId: cardFor(engine, "later")[0]!.id });

    const left = taskOf(engine, world.shop, "Left wording", [older("left", "bug-both: The footer opens a retired page.")]);
    const right = taskOf(engine, world.shop, "Right wording", [older("right", "bug-both: About in the footer is the old page.")]);
    left.state = "done";
    right.state = "done";
    await Promise.all([engine["followUps"].noteDone(left), engine["followUps"].noteDone(right)]);
    expect(cardFor(engine, "both")).toHaveLength(1);
    expect(cardFor(engine, "both")[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["left", "right"]);

    const lone = taskOf(engine, world.shop, "Lone cancelled", [older("lone", "bug-alone: The footer opens a retired page.")]);
    lone.state = "cancelled";
    await engine["followUps"].catchUp();
    expect(cardFor(engine, "alone")).toHaveLength(0);
    const cancelled = taskOf(engine, world.shop, "Cancelled wording", [older("gone", "bug-cancel: The footer opens a retired page.")]);
    const other = taskOf(engine, world.shop, "Other wording", [older("other", "bug-cancel: About in the footer is retired.")]);
    cancelled.state = "cancelled";
    await finish(engine, other);
    expect(cardFor(engine, "cancel")).toHaveLength(1);
    expect(cardFor(engine, "cancel")[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["gone", "other"]);

    const count = cards(engine).length;
    const ids = cards(engine).map((task) => task.id).sort();
    await reopen(world);
    expect(cards(world.engine).map((task) => task.id).sort()).toEqual(ids);
    expect(cards(world.engine)).toHaveLength(count);
    expect(world.engine.task(savedFirst.id)!.findings[0]!.tracking).toEqual({ taskId: cardFor(world.engine, "saved")[0]!.id });
  } finally { await shutdown(world.engine); }
});
