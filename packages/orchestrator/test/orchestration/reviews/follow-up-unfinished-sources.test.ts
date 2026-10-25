import { expect, it } from "vitest";
import { followUpKey, queueBacklogTask } from "@petrina/core";
import { followUpLinksFixture, older, groupByBug } from "../../fixtures/follow-up-links.js";

it("leaves an unfinished task's report waiting when the fix it matched finishes during matching, then places it once that task is done", async () => {
  let during = () => {};
  const f = followUpLinksFixture(prompt => { during(); during = () => {}; return groupByBug(prompt); });

  try {
    const fixId = f.newTask({ productId: f.shop, kind: "bug", title: "bug-early: The coordinator's fix", backlog: true }).id;
    queueBacklogTask(f.task(fixId)!, f.state.tasks.length);
    const fix = f.task(fixId)!;
    const release = f.host.hold(fixId);
    const running = f.taskOf(f.shop, "Still running", [older("early", "bug-early: Seen before its task finished")]);
    running.state = "running";
    const done = f.taskOf(f.shop, "Finished first", [older("other", "bug-other: A different bug")]);
    during = () => Object.assign(fix, { state: "done", column: "done", finishedAt: f.now() });
    await f.finish(done);
    expect(f.prompts[0]).toContain(`Card [${fixId}]`);
    expect([fix.followUp, running.findings[0]!.tracking, f.cardFor("early")]).toEqual([undefined, undefined, []]);
    expect(f.state.followUpPending?.some(group => group.keys.includes(followUpKey(running.id, "early")))).toBe(false);
    expect(f.cardFor("other")).toHaveLength(1);
    release();
    await f.finish(running);
    const card = f.cardFor("early");
    expect(card.map(task => task.followUp!.reports.map(report => report.findingId))).toEqual([["early"]]);
    expect(f.task(running.id)!.findings[0]!.tracking).toEqual({ taskId: card[0]!.id });
  } finally { await f.stop(); }
});
