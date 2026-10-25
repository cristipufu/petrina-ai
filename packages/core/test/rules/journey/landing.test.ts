import { stateFixture, taskFixture } from "../../fixtures/state.js";

import { describe, expect, it } from "vitest";

import { journeyView, dependencyLanding, landingOf, syncWait, taskLanding, type JourneyTask } from "../../../src/journey.js";

import type { State, Task } from "../../../src/model.js";

import { blocksDependents, repositoryTaskView } from "../../../src/repositories.js";
import { historyItem, historyStatus } from "../../../src/history.js";

const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });

describe("unusual endings", () => {
  const state = stateFixture({ now: 0 });
  const open = taskFixture(state, { state: "pr-open", selectedProducts: undefined, pr: { number: 7, url: "https://example.test/7", state: "open", openedAt: 1 } });
  const ending = (task: Task) => journeyView(task, contextOf(state)).end;

  it("a pull request closed without merging is not awaiting merge, and did not land", () => {
    const number = open.pr!.number;
    expect(ending(open)).toEqual({ text: `Pull request #${number} · awaiting merge`, state: "pending" });
    const closed: Task = { ...open, state: "done", pr: { ...open.pr!, state: "closed" } };
    expect(landingOf(closed)).toBe("closed");
    expect(ending(closed)).toEqual({ text: `Pull request #${number} closed without merging`, state: "unconfirmed" });
    // Recorded before "closed" was: a finished task whose pull request never merged.
    expect(landingOf({ ...open, state: "done" })).toBe("closed");
    expect(landingOf({ ...open, state: "done", pr: { ...open.pr!, state: "merged" } })).toBe("landed");
  });

  it("Mark as done does not confirm a delivery", () => {
    const { pr: _none, ...marked } = { ...open, state: "done" as const };
    expect(landingOf(marked)).toBe("marked-done");
    expect(ending(marked)).toEqual({ text: "Marked as done · delivery not confirmed", state: "unconfirmed" });
  });

  it("a prerequisite that did not land says so", () => {
    const others: Record<string, Pick<Task, "state" | "title" | "pr" | "release" | "landed">> = {
      a: { state: "done", title: "A", landed: { branch: "main", sha: "abc1234" } },
      b: { state: "done", title: "B", pr: { number: 7, url: "https://github.com/acme/p/pull/7", state: "closed", openedAt: 0 } },
      c: { state: "done", title: "C" },
      d: { state: "cancelled", title: "D" },
    };
    const reasonFor = (after: string[]) => {
      const waiting: JourneyTask & Pick<Task, "after"> = { stageIndex: -1, rounds: {}, sub: 0, fixing: false, after, journey: [] };
      syncWait(waiting, after.map((id) => ({ id, title: others[id]!.title })), (id) => others[id], 0);
      syncWait(waiting, [], (id) => others[id], 10);
      return waiting.journey![0]!.reason;
    };
    expect(reasonFor(["a"])).toBe("“A” landed");
    expect(reasonFor(["b"])).toBe("“B” did not land: closed without merging");
    expect(reasonFor(["c"])).toBe("“C” marked as done, delivery not confirmed");
    expect(reasonFor(["d"])).toBe("“D” did not land: cancelled");
    expect(reasonFor(["a", "d"])).toBe("“A” landed; “D” did not land: cancelled");
  });
});

describe("shared task endings keep the displayed product's evidence", () => {
  const state = stateFixture({ now: 1_000_000_000_000 });

  const base = taskFixture(state, { state: 'done', selectedProducts: undefined });

  const pr = { number: 44, url: "https://example.test/44", state: "open" as const, openedAt: 1 };

  const context = { roles: state.roles, profiles: state.profiles, tasks: [], inbox: [] };

  it.each([["local", "open"], ["local", "closed"], ["release", "open"], ["release", "closed"]] as const)("keeps a displayed %s delivery separate from a %s companion pull request", (delivery, prState) => {
    const work = delivery === "local" ? { landed: { branch: "main", sha: "abc" } } : { release: { tag: "v1.2.3", url: "https://example.test/v1.2.3" } };
    const companion = { ...pr, state: prState };
    const task: Task = { ...base, ...work, pr: undefined, state: prState === "open" ? "pr-open" : "done", repositories: [
      { productId: "pr-product", delivery: "pull-request", pr: companion, ...(prState === "closed" ? { landingAccepted: { at: 1 } } : {}), completedStages: [] },
      { productId: base.productId, delivery, ...work, completedStages: [] },
    ] };
    expect(journeyView(task, context).end).toEqual({ text: delivery === "local" ? "Delivered locally to main" : "Released v1.2.3", state: "done" });
    const displayedPr: Task = { ...task, release: undefined, landed: undefined, pr: companion };
    expect(journeyView(displayedPr, context).end).toEqual(prState === "open" ? { text: "Pull request #44 · awaiting merge", state: "pending" } : { text: "Pull request #44 closed without merging", state: "unconfirmed" });
  });

  it("does not attach a companion's closed outcome to a merged pull request", () => {
    const merged = { ...pr, state: "merged" as const };
    const closed = { ...pr, number: 55, state: "closed" as const };
    const task: Task = { ...base, state: "done", pr: merged, release: undefined, landed: undefined, repositories: [
      { productId: base.productId, delivery: "pull-request", pr: merged, completedStages: [] },
      { productId: "other", delivery: "pull-request", pr: closed, completedStages: [] },
    ] };
    expect(journeyView(task, context).end).toEqual({ text: "Merged #44", state: "done" });
    expect(journeyView({ ...task, pr: closed }, context).end).toEqual({ text: "Pull request #55 closed without merging", state: "unconfirmed" });
  });
});

describe("whole-task prerequisite landing", () => {
  const state = stateFixture({ now: 1_000_000_000_000 });

  const base = taskFixture(state, { state: 'done', selectedProducts: undefined });

  const pr = { number: 44, url: "https://example.test/44", openedAt: 1 };

  it.each(["open", "closed"] as const)("keeps waiting for a %s companion until it merges", (prState) => {
    const displayed = prState === "open"
      ? { productId: base.productId, delivery: "local" as const, completedStages: [], landed: { branch: "main", sha: "abc" } }
      : { productId: base.productId, delivery: "pull-request" as const, completedStages: [], pr: { ...pr, state: "merged" as const } };
    const companion = { productId: "companion", delivery: "pull-request" as const, completedStages: [], pr: { ...pr, number: 55, state: prState } };
    let prerequisite = repositoryTaskView({ ...base, state: "pr-open", repositories: [displayed, companion] }, displayed);
    const waiting: JourneyTask & Pick<Task, "after"> = { stageIndex: -1, rounds: {}, sub: 0, fixing: false, after: [prerequisite.id], journey: [] };
    const sync = (at: number) => syncWait(waiting, blocksDependents(prerequisite) ? [prerequisite] : [], () => prerequisite, at);

    expect(landingOf(prerequisite)).toBe("landed");
    expect(dependencyLanding(prerequisite)).toBe(prState === "open" ? "awaiting-merge" : "closed");
    expect(dependencyLanding(historyItem(prerequisite))).toBe(dependencyLanding(prerequisite));
    sync(0);
    sync(10);
    expect(waiting.journey).toHaveLength(1);
    expect(waiting.journey![0]!.endedAt).toBeUndefined();

    prerequisite = { ...prerequisite, state: "done", repositories: [displayed, { ...companion, pr: { ...companion.pr, state: "merged" } }] };
    expect(blocksDependents(prerequisite)).toBe(false);
    expect(dependencyLanding(prerequisite)).toBe("landed");
    sync(20);
    expect(waiting.journey![0]).toMatchObject({ endedAt: 20, reason: `“${prerequisite.title}” landed` });
  });

  it("ends an accepted closed companion without claiming it landed", () => {
    const prerequisite: Task = { ...base, state: "done", repositories: [
      { productId: base.productId, delivery: "pull-request", completedStages: [], pr: { ...pr, state: "merged" } },
      { productId: "companion", delivery: "pull-request", completedStages: [], pr: { ...pr, number: 55, state: "closed" }, landingAccepted: { at: 1 } },
    ] };
    const waiting: JourneyTask & Pick<Task, "after"> = { stageIndex: -1, rounds: {}, sub: 0, fixing: false, after: [prerequisite.id], journey: [] };
    syncWait(waiting, [prerequisite], () => prerequisite, 0);
    expect(blocksDependents(prerequisite)).toBe(false);
    syncWait(waiting, [], () => prerequisite, 10);
    expect(waiting.journey![0]!.reason).toBe(`“${prerequisite.title}” did not land: closed without merging`);
  });

  it.each([false, true])("keeps waiting for a done task's unpushed local commit (unpushed first: %s)", (swapped) => {
    const merged = { productId: base.productId, delivery: "pull-request" as const, completedStages: [], pr: { ...pr, state: "merged" as const } };
    const landed = { branch: "main", sha: "abc" };
    const unpushed = { productId: "companion", delivery: "local" as const, completedStages: [], landed, localUpdate: { ...landed, pushed: false } };
    const shared = (local: typeof unpushed) => swapped ? [local, merged] : [merged, local];
    let prerequisite = repositoryTaskView({ ...base, state: "done", repositories: shared(unpushed) }, shared(unpushed)[0]!);
    const waiting: JourneyTask & Pick<Task, "after"> = { stageIndex: -1, rounds: {}, sub: 0, fixing: false, after: [prerequisite.id], journey: [] };
    const sync = (at: number) => syncWait(waiting, blocksDependents(prerequisite) ? [prerequisite] : [], () => prerequisite, at);

    expect(blocksDependents(prerequisite)).toBe(true);
    expect(dependencyLanding(prerequisite)).toBe("open");
    expect(dependencyLanding(historyItem(prerequisite))).toBe("open");
    sync(0);
    sync(10);
    expect(waiting.journey![0]!.endedAt).toBeUndefined();

    // Once the push finishes, the scheduler and the waiting details agree it landed.
    prerequisite = { ...prerequisite, repositories: shared({ ...unpushed, localUpdate: { ...landed, pushed: true } }) };
    expect(blocksDependents(prerequisite)).toBe(false);
    expect(dependencyLanding(prerequisite)).toBe("landed");
    expect(dependencyLanding(historyItem(prerequisite))).toBe("landed");
    sync(20);
    expect(waiting.journey![0]).toMatchObject({ endedAt: 20, reason: `“${prerequisite.title}” landed` });
  });

  it("keeps single-product records and no-change outcomes distinct", () => {
    const open = { state: "done" as const, pr: { ...pr, state: "open" as const } };
    expect(dependencyLanding(open)).toBe("awaiting-merge");
    expect(landingOf(open)).toBe("closed"); // Older displayed-product summaries keep their contract.
    expect(dependencyLanding({ state: "done", repository: { productId: "p", delivery: "pull-request", pr: open.pr } })).toBe("awaiting-merge");
    expect(dependencyLanding({ state: "done", maintenance: { noProductChanges: true } })).toBe("no-changes");
    expect(dependencyLanding({ state: "done" })).toBe("marked-done");
    expect(dependencyLanding({ state: "cancelled", landed: { branch: "main", sha: "abc" } })).toBe("cancelled");
  });

  it.each([
    ["without a recorded commit", undefined, "marked-done", "marked as done, delivery not confirmed"],
    ["with a recorded commit", { branch: "main", sha: "abc" }, "landed", "landed"],
  ] as const)("ends the wait for a one-product task marked done after its push failed, %s", (_, landed, landing, words) => {
    // Mark as done records your decision on the work; older records lack it.
    for (const cleanup of [undefined, { markedDone: true }]) {
      const repository = { productId: base.productId, delivery: "local" as const, landed, localUpdate: { branch: "main", sha: "abc", pushed: false }, cleanup };
      const prerequisite = repositoryTaskView({ ...base, state: "done", repositories: undefined, repository }, repository);
      const waiting: JourneyTask & Pick<Task, "after"> = { stageIndex: -1, rounds: {}, sub: 0, fixing: false, after: [prerequisite.id], journey: [] };
      syncWait(waiting, [prerequisite], () => prerequisite, 0);

      expect(blocksDependents(prerequisite)).toBe(false);
      expect(dependencyLanding(prerequisite)).toBe(landing);
      expect(dependencyLanding({ ...prerequisite, repository })).toBe(landing);
      expect(dependencyLanding(historyItem(prerequisite))).toBe(landing);
      expect(taskLanding(historyItem(prerequisite))).toBe(landing);
      syncWait(waiting, [], () => prerequisite, 10);
      expect(waiting.journey![0]).toMatchObject({ endedAt: 10, reason: `“${prerequisite.title}” ${words}` });
    }
  });
});

describe("whole-task delivery for coordinator reads", () => {
  const base = taskFixture(stateFixture(), { state: 'done', selectedProducts: undefined });

  const pr = { number: 44, url: "https://example.test/44", openedAt: 1 };

  const linked = { text: "Part of a change across both", state: "done" as const };

  const merged = { productId: base.productId, delivery: "pull-request" as const, completedStages: [], pr: { ...pr, state: "merged" as const }, companion: linked };

  const open = { productId: "companion", delivery: "pull-request" as const, completedStages: [], pr: { ...pr, number: 55, state: "open" as const }, companion: linked };

  const shared = (state: Task["state"], repositories: NonNullable<Task["repositories"]>, shown = 0): Task => repositoryTaskView({ ...base, state, repositories, leadProductId: repositories[shown]!.productId, activeProductId: repositories[shown]!.productId }, repositories[shown]!);

  it.each([0, 1])("reads a merged lead and an open companion as awaiting merge, with product %i shown", (shown) => {
    const task = shared("pr-open", [merged, open], shown);
    expect(taskLanding(task)).toBe("awaiting-merge");
    expect(taskLanding(shared("pr-open", [open, merged], shown))).toBe("awaiting-merge");
    // Once the companion merges, the whole delivery has landed.
    expect(taskLanding(shared("done", [merged, { ...open, pr: { ...open.pr, state: "merged" } }], shown))).toBe("landed");
  });

  it("keeps a published lead from standing in for an unfinished companion", () => {
    const leadOpen = { ...merged, pr: { ...merged.pr, state: "open" as const } };
    const publishing = { productId: "companion", delivery: "pull-request" as const, completedStages: [], shipping: { moves: 0, failures: 0, step: "push" as const } };
    // The prerequisite reading stops at the open pull request; the whole delivery has not finished.
    expect(dependencyLanding(shared("needs-you", [leadOpen, publishing]))).toBe("awaiting-merge");
    expect(taskLanding(shared("needs-you", [leadOpen, publishing]))).toBe("open");
    expect(taskLanding(shared("needs-you", [leadOpen, { ...open, companion: { ...linked, state: "pending" } }]))).toBe("open");
    const landed = { branch: "main", sha: "abc" };
    const local = { productId: "companion", delivery: "local" as const, completedStages: [], landed, localUpdate: { ...landed, pushed: false } };
    expect(taskLanding(shared("done", [merged, local]))).toBe("open");
    expect(taskLanding(shared("done", [merged, { ...local, localUpdate: { ...landed, pushed: true } }]))).toBe("landed");
    // Older committed records carry no separate push report.
    expect(taskLanding(shared("done", [merged, { ...local, localUpdate: undefined }]))).toBe("landed");
  });

  it("keeps closed, cancelled and no-change outcomes from counting as delivered", () => {
    const closed = { ...open, pr: { ...open.pr, state: "closed" as const } };
    for (const task of [shared("needs-you", [merged, closed]), shared("done", [merged, { ...closed, landingAccepted: { at: 1 } }])]) {
      expect(taskLanding(task)).toBe("closed");
      expect(taskLanding(historyItem(task))).toBe("closed");
    }
    expect(taskLanding(shared("cancelled", [merged, open]))).toBe("cancelled");
    const nothing = { productId: "companion", delivery: "pull-request" as const, completedStages: [], nothingToPublish: true };
    expect(taskLanding(shared("done", [{ ...nothing, productId: base.productId }, nothing]))).toBe("no-changes");
    expect(taskLanding({ ...shared("done", [merged, open]), maintenance: { noProductChanges: true } })).toBe("no-changes");
    // A product with nothing to publish leaves its companion's outcome intact.
    expect(taskLanding(shared("pr-open", [nothing, open]))).toBe("awaiting-merge");
    expect(taskLanding(shared("done", [merged, nothing]))).toBe("landed");
    expect(taskLanding(historyItem(shared("done", [merged, nothing])))).toBe("landed");
  });

  it("keeps one product's own outcomes, saved or displayed", () => {
    const repository = { productId: base.productId, delivery: "pull-request" as const, pr: { ...pr, state: "open" as const } };
    for (const [state, landing] of [["pr-open", "awaiting-merge"], ["done", "closed"], ["running", "open"]] as const) {
      const task = { ...base, state, repositories: undefined, repository };
      expect(taskLanding(task)).toBe(landing);
      expect(taskLanding(repositoryTaskView(task, repository))).toBe(landingOf(repositoryTaskView(task, repository)));
    }
    expect(taskLanding({ state: "done" })).toBe("marked-done");
    expect(taskLanding(historyItem({ ...base, state: "done", repositories: undefined, repository: { ...repository, pr: { ...pr, state: "merged" } } }))).toBe("landed");
  });

  it.each([
    ["marked done now", { markedDone: true, pullRequest: "none" as const }],
    ["marked done in an older version", { pullRequest: "none" as const }],
  ])("keeps one product's work %s unconfirmed after a later lookup finds its pull request", (_, cleanup) => {
    for (const state of ["open", "merged", "closed"] as const) {
      const repository = { productId: base.productId, delivery: "pull-request" as const, pr: { ...pr, state }, cleanup };
      const task = { ...base, state: "done" as const, repositories: undefined, repository };
      const shown = repositoryTaskView(task, repository);
      const saved = historyItem(shown);
      for (const read of [task, shown, saved]) {
        expect(taskLanding(read)).toBe("marked-done");
        expect(dependencyLanding(read)).toBe("marked-done");
      }
      expect(landingOf(shown)).toBe("marked-done");
      expect(saved.cleanup).toEqual({ markedDone: true });
      expect(historyStatus(saved)).toBe("marked-done");
      expect(historyStatus(JSON.parse(JSON.stringify(saved)))).toBe("marked-done");
      // A task waiting for it says how it really ended.
      const waiting: JourneyTask & Pick<Task, "after"> = { stageIndex: -1, rounds: {}, sub: 0, fixing: false, after: [shown.id], journey: [] };
      syncWait(waiting, [shown], () => shown, 0);
      syncWait(waiting, [], () => shown, 10);
      expect(waiting.journey![0]).toMatchObject({ endedAt: 10, reason: `“${shown.title}” marked as done, delivery not confirmed` });
    }
    // The same merged pull request, delivered by Petrina, has landed; one Petrina reported closed did not.
    for (const [state, landing, status] of [["merged", "landed", "merged"], ["closed", "closed", "closed"]] as const) {
      const repository = { productId: base.productId, delivery: "pull-request" as const, pr: { ...pr, state } };
      const task = { ...base, state: "done" as const, repositories: undefined, repository };
      const saved = historyItem(repositoryTaskView(task, repository));
      expect([taskLanding(task), taskLanding(saved), dependencyLanding(task)]).toEqual([landing, landing, landing]);
      expect(saved.cleanup).toBeUndefined();
      expect(historyStatus(saved)).toBe(status);
    }
    // A shared task's accepted closed companion stays closed, without the one-product decision.
    const closed = { productId: "companion", delivery: "pull-request" as const, completedStages: [], pr: { ...pr, number: 55, state: "closed" as const }, landingAccepted: { at: 1 } };
    const merged = { productId: base.productId, delivery: "pull-request" as const, completedStages: [], pr: { ...pr, state: "merged" as const } };
    const shared = repositoryTaskView({ ...base, state: "done", repositories: [merged, closed], activeProductId: "companion" }, closed);
    expect([taskLanding(shared), taskLanding(historyItem(shared))]).toEqual(["closed", "closed"]);
    expect(historyItem(shared).cleanup).toBeUndefined();
  });
});
