import { deferred } from "../../fixtures/tool-checks.js";
import type { MatchAnswer } from "@petrina/core";
import { expect, it } from "vitest";
import { queueBacklogTask, cancelTaskState } from "@petrina/core";
import { executionFor } from "../../../src/repository-context.js";
import { followUpLinksFixture, older, groupByBug } from "../../fixtures/follow-up-links.js";

it("keeps a manual bug queued while matching as the destination, without changing its request", async () => {
  let queue = () => {};
  const f = followUpLinksFixture(prompt => { queue(); return groupByBug(prompt); });
  try {

    const id = f.newTask({ productId: f.shop, kind: "bug", title: "bug-race: Existing manual bug", description: "Do not change this queued request", backlog: true }).id;
    queue = () => { queue = () => {}; queueBacklogTask(f.task(id)!, f.state.tasks.length); };
    const source = f.taskOf(f.shop, "New sighting", [older("race", "bug-race: The same underlying bug")]);
    await f.finish(source);
    const manual = f.task(id)!;
    expect(manual.state).toBe("queued");
    expect(manual.followUp).toMatchObject({ preserveRequest: true, reports: [{ taskId: source.id, findingId: "race" }] });
    expect(manual.description).toBe("Do not change this queued request");
    expect(source.findings[0]!.tracking).toEqual({ taskId: id });
    expect(f.cards().map(task => task.id)).toEqual([id]);
  } finally { await f.stop(); }
});

it("leaves a manual fix untouched and opens a card when it finishes, is cancelled, changes products or leaves the board during matching", async () => {
  let during = () => {};
  const f = followUpLinksFixture(prompt => { during(); during = () => {}; return groupByBug(prompt); }, true);

  try {
    for (const variant of ["finish", "cancel", "scope", "gone"] as const) {
      const fixId = f.newTask({ productId: f.shop, kind: "bug", title: `bug-${variant}: The coordinator's fix`, description: "The unchanged request", backlog: true }).id;
      queueBacklogTask(f.task(fixId)!, f.state.tasks.length);
      const fix = f.task(fixId)!;
      const release = variant === "gone" ? () => {} : f.host.hold(fixId);
      during = () => {
        if (variant === "finish" || variant === "gone") Object.assign(fix, { state: "done", column: "done", finishedAt: f.now() });
        if (variant === "gone") f.archiveObservation(fix);
        if (variant === "cancel") cancelTaskState(f.task(fixId)!, executionFor(f.task(fixId)!).work, f.now());
        if (variant === "scope") fix.selectedProducts = [...fix.selectedProducts!, { productId: f.notes, startFrom: { kind: "default" }, delivery: "pull-request" }];
      };
      const before = structuredClone({ title: fix.title, description: fix.description, products: fix.selectedProducts });
      const source = f.taskOf(f.shop, `Matched while the fix ${variant}`, [older("old", `bug-${variant}: A later sighting`)]);
      await f.finish(source);
      expect(f.prompts.at(-1), variant).toContain(`Card [${fixId}]`);
      expect(f.state.tasks.some(task => task.id === fixId), variant).toBe(variant !== "gone");
      const after = f.task(fixId)!;
      expect([after.followUp, after.title, after.description], variant).toEqual([undefined, before.title, before.description]);
      const opened = f.cardFor(variant).filter(task => task.id !== fixId);
      expect(opened.map(task => task.followUp!.reports.map(report => report.findingId)), variant).toEqual([["old"]]);
      expect(opened[0]!.state, variant).toBe("backlog");
      expect(source.findings[0]!.tracking, variant).toEqual({ taskId: opened[0]!.id });
      release();
    }
  } finally { await f.stop(); }
});

it("uses the card's state when the match returns, so a cancel or a queue is not lost", async () => {
  let entered = deferred<void>();
  let waiting: { prompt: string; resolve: (answer: MatchAnswer) => void } | undefined;
  const f = followUpLinksFixture((prompt) => new Promise((resolve) => { waiting = { prompt, resolve }; entered.resolve(); }), true);

  try {
    const known = f.taskOf(f.shop, "Open card", [older("known", "bug-live: The footer opens a retired page.", { productIds: [f.shop] })]);
    await f.finish(known);
    const card = f.cardFor("live")[0]!;

    const queued = f.taskOf(f.notes, "Queued during the match", [older("queued", "bug-live: Notes shows the same retired page.", { productIds: [f.shop, f.notes] })]);
    waiting = undefined; entered = deferred<void>();
    const queueing = f.finish(queued);
    await Promise.race([entered.promise, queueing.then(() => { throw new Error("The match completed before it requested an identity answer"); })]);
    queueBacklogTask(f.task(card.id)!, f.state.tasks.length);
    expect(card.state).toBe("queued");
    waiting!.resolve(groupByBug(waiting!.prompt));
    await queueing;
    expect(card.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["known", "queued"]);
    expect(card.selectedProducts?.map((choice) => choice.productId)).toEqual([f.shop]);
    expect(card.followUp!.alsoReported).toEqual([f.notes]);
    expect(queued.findings[0]!.tracking).toEqual({ taskId: card.id });

    const cancelled = f.taskOf(f.shop, "Cancelled during the match", [older("cancelled", "bug-live: The footer page is still retired.")]);
    waiting = undefined; entered = deferred<void>();
    const cancelling = f.finish(cancelled);
    await Promise.race([entered.promise, cancelling.then(() => { throw new Error("The match completed before it requested an identity answer"); })]);
    cancelTaskState(f.task(card.id)!, executionFor(f.task(card.id)!).work, f.now());
    expect(card.state).toBe("cancelled");
    waiting!.resolve(groupByBug(waiting!.prompt));
    await cancelling;
    expect(cancelled.findings[0]!.tracking && "taskId" in cancelled.findings[0]!.tracking && cancelled.findings[0]!.tracking.taskId).not.toBe(card.id);
    expect(card.followUp!.reports.map((report) => report.findingId)).not.toContain("cancelled");
    const fresh = f.cardFor("live").filter((task) => task.id !== card.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.state).toBe("backlog");
    expect(fresh[0]!.followUp!.reports.map((report) => report.findingId)).toEqual(["cancelled"]);
    expect(cancelled.findings[0]!.tracking).toEqual({ taskId: fresh[0]!.id });
  } finally { await f.stop(); }
});

it("does not mark a report tracked when it becomes Important while the match is running", async () => {
  let entered = deferred<void>();
  let waiting: { prompt: string; resolve: (answer: MatchAnswer) => void } | undefined;
  const f = followUpLinksFixture((prompt) => new Promise((resolve) => { waiting = { prompt, resolve }; entered.resolve(); }));

  try {
    const first = f.taskOf(f.shop, "Already tracked", [older("first", "bug-flip: The footer opens a retired page.")]);
    await f.finish(first);
    const card = f.cardFor("flip")[0]!;
    expect(waiting).toBeUndefined();
    const second = f.taskOf(f.shop, "Flipped during the match", [older("second", "bug-flip: About in the footer is the old page.", { judgments: [{ by: "opus-high", severity: "pre-existing", at: 1 }, { by: "sol-high", severity: "pre-existing", at: 2 }] })]);
    waiting = undefined; entered = deferred<void>();
    const finishing = f.finish(second);
    await Promise.race([entered.promise, finishing.then(() => { throw new Error("The match completed before it requested an identity answer"); })]);
    second.findings[0]!.severity = "blocking";
    waiting!.resolve(groupByBug(waiting!.prompt));
    await finishing;
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["first"]);
    expect(f.task(second.id)!.findings[0]!.severity).toBe("blocking");
    expect(f.task(second.id)!.findings[0]!.judgments?.map((entry) => entry.severity)).toEqual(["pre-existing", "pre-existing"]);
    expect(f.task(second.id)!.findings[0]!.tracking).toBeUndefined();
  } finally { await f.stop(); }
});
