import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";
import { WorkflowObserver, type InboxItem, type TaskRepository, type TaskState, type WorkflowContext } from "../../../src/index.js";

const state = stateFixture({ now: 1_000_000, products: [{ id: "shop", name: "Shop", repo: "local/shop", tone: "blue" }, { id: "notes", name: "Notes", repo: "local/notes", tone: "green" }, { id: "billing", name: "Billing", repo: "local/billing", tone: "blue" }] });

const ctx = (inbox: InboxItem[] = [], now = 5_000): WorkflowContext => ({ roles: state.roles, profiles: state.profiles, inbox, products: state.products.map(({ id, name }) => ({ id, name })), now });

const pr = { number: 7, url: "https://github.com/acme/shop/pull/7", state: "open" as const, openedAt: 1 };

const landed = { branch: "main", sha: "abc1234" };

function task(changes: Partial<TaskState> = {}, work: Partial<TaskRepository> = {}): TaskState {
  const base = taskFixture(state, { id: "h1", title: "Workflow event fixture", kind: "bug", state: "running", delivery: "pull-request", stageIndex: 0, selectedProducts: undefined });
  const { pr: _pr, release: _release, landed: _landed, localUpdate: _local, shipping: _shipping, cleanup: _cleanup, ...rest } = base;
  const repository = { productId: base.productId, delivery: base.delivery, ...work };
  return { ...rest, repository, journey: [], findings: [], state: "running", statusLine: "Working", ...changes } as unknown as TaskState;
}

const kinds = (events: readonly { kind: string }[]) => events.map((event) => event.kind);

describe("compact facts become ordered events", () => {
  it("baselines loaded work silently and never invents events for finished tasks it first sees in the archive", () => {
    const observer = new WorkflowObserver(2);
    const live = task({ state: "running" });
    observer.baseline(live, ctx());
    expect(observer.observe(live, ctx())).toEqual([]);
    expect(observer.observe(task({ state: "needs-you" }), ctx())).toEqual([expect.objectContaining({ kind: "task.state", to: "needs-you" })]);
    const archived = task({ id: "old", state: "done", finishedAt: 1 }, { pr: { ...pr, state: "merged" } });
    expect(observer.observe(archived, ctx())).toEqual([]);
    expect(observer.known("old")).toBe(true);
    const merged = task({ id: "old", state: "done", finishedAt: 1 }, { pr: { ...pr, state: "closed" } });
    expect(kinds(observer.observe(merged, ctx()))).toEqual(["publishing.result"]);
    const fresh = task({ id: "new", state: "queued" });
    expect(kinds(observer.observe(fresh, ctx()))).toEqual(["task.created"]);
  });
});

describe("delivery and handoff evidence regressions", () => {
  it("keeps cancelled open pull requests observable after 201 other completions", () => {
    for (const state of ["merged", "closed"] as const) {
      const observer = new WorkflowObserver();
      const waiting = task({ id: "late", state: "cancelled" }, { pr });
      observer.baseline(task({ id: "late", state: "cancelled" }), ctx());
      observer.observe(waiting, ctx());
      for (let index = 0; index < 201; index++) observer.baseline(task({ id: `finished-${index}`, state: "done" }, { landed }), ctx());
      expect(observer.known("late")).toBe(true);
      const events = observer.observe(task({ id: "late", state: "cancelled" }, { pr: { ...pr, state } }), ctx());
      expect(events).toContainEqual(expect.objectContaining({ kind: "publishing.result", result: expect.objectContaining({ kind: state === "merged" ? "merged" : "pull-request-closed" }) }));
    }
  });
});
