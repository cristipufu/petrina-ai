import { expect, it } from "vitest";
import { followUpKey } from "@petrina/core";
import { followUpLinksFixture, older } from "../../fixtures/follow-up-links.js";
import { deferred } from "../../fixtures/tool-checks.js";

it("retains both actual link owners through the receipt and releases them after a rejected transaction", async () => {
  const f = followUpLinksFixture(), source = f.taskOf(f.shop, "Source", [older("bug", "bug-one: An older defect", { tracking: { reason: "no-choice" } })]);
  source.state = "done";
  const target = f.newTask({ productId: f.shop, title: "Manual bug", kind: "bug", backlog: true });
  const pending = [{ keys: [followUpKey(source.id, "bug")], retry: true }];
  f.state.followUpPending = pending;
  const session = target.session, failure = new Error("receipt save failed"), trace: string[] = [];
  f.host.atomic = function (work) {
    expect(this).toBe(f.host);
    trace.push("begin");
    try { return work(); } finally { trace.push("end"); }
  };
  await expect(f.links.trackFinding(source.id, "bug", target.id, link => {
    expect(f.holds).toEqual(new Map([[source.id, 1], [target.id, 1]]));
    expect(link).toEqual({ taskId: source.id, findingId: "bug", targetTaskId: target.id });
    expect(source.findings[0]!.tracking).toEqual({ taskId: target.id });
    expect(target.followUp?.reports.map(report => report.findingId)).toEqual(["bug"]);
    trace.push("receipt");
    throw failure;
  })).rejects.toBe(failure);
  expect(trace).toEqual(["begin", "receipt", "end"]);
  expect(source.findings[0]!.tracking).toEqual({ reason: "no-choice" });
  expect(target.session).toBe(session);
  expect(target.followUp).toBeUndefined();
  expect(f.state.followUpPending).toBe(pending);
  expect(f.holds.size).toBe(0);
  expect(f.effects).toEqual([]);
  await f.links.trackFinding(source.id, "bug", target.id, () => "saved");
  expect(source.findings[0]!.tracking).toEqual({ taskId: target.id });
  expect(target.followUp?.reports).toHaveLength(1);
  expect(f.holds.size).toBe(0);
});

it("keeps a finished source held while its serialized match is pending and stop awaits that operation", async () => {
  const matching = deferred<void>(), release = deferred<void>();
  const f = followUpLinksFixture(async () => { matching.resolve(); await release.promise; return { groups: [] }; });
  const source = f.taskOf(f.shop, "Source", [older("one", "bug-one: First wording"), older("two", "bug-one: Second wording")]);
  const work = f.finish(source);
  await Promise.race([matching.promise, work.then(() => { throw new Error("The match never started"); })]);
  expect(f.holds).toEqual(new Map([[source.id, 1]]));
  let settled = false;
  const stop = f.links.stop().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  release.resolve();
  await Promise.all([work, stop]);
  expect(settled).toBe(true);
  expect(f.holds.size).toBe(0);
});
