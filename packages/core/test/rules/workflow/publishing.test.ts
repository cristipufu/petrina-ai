import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";
import { publishingResult, publishingWords, workflowEvents, workflowFacts, type InboxItem, type JourneyStep, type TaskRepository, type TaskState, type WorkflowContext } from "../../../src/index.js";

const state = stateFixture({ now: 1_000_000, products: [{ id: "shop", name: "Shop", repo: "local/shop", tone: "blue" }, { id: "notes", name: "Notes", repo: "local/notes", tone: "green" }, { id: "billing", name: "Billing", repo: "local/billing", tone: "blue" }] });

const ctx = (inbox: InboxItem[] = [], now = 5_000): WorkflowContext => ({ roles: state.roles, profiles: state.profiles, inbox, products: state.products.map(({ id, name }) => ({ id, name })), now });

const pr = { number: 7, url: "https://github.com/acme/shop/pull/7", state: "open" as const, openedAt: 1 };

const release = { tag: "v1.2.0", url: "https://github.com/acme/shop/releases/tag/v1.2.0" };

const landed = { branch: "main", sha: "abc1234" };

function task(changes: Partial<TaskState> = {}, work: Partial<TaskRepository> = {}): TaskState {
  const base = taskFixture(state, { id: "h1", title: "Workflow event fixture", kind: "bug", state: "running", delivery: "pull-request", stageIndex: 0, selectedProducts: undefined });
  const { pr: _pr, release: _release, landed: _landed, localUpdate: _local, shipping: _shipping, cleanup: _cleanup, ...rest } = base;
  const repository = { productId: base.productId, delivery: base.delivery, ...work };
  return { ...rest, repository, journey: [], findings: [], state: "running", statusLine: "Working", ...changes } as unknown as TaskState;
}

const diff = (before: TaskState | undefined, after: TaskState, inbox: InboxItem[] = []) => {
  const context = ctx(inbox);
  const baselines = new Map();
  return workflowEvents(before ? workflowFacts(before, ctx()) : undefined, workflowFacts(after, context), context, baselines);
};

describe("publishing results follow the existing delivery and landing rules", () => {
  const cases: [string, Partial<TaskState>, Partial<TaskRepository>, boolean, Record<string, unknown>][] = [
    ["a published release", { state: "done" }, { release }, false, { kind: "released", landed: true, tag: "v1.2.0" }],
    ["a confirmed commit", { state: "done" }, { landed, localUpdate: { ...landed, pushed: true } }, false, { kind: "committed", landed: true, branch: "main" }],
    ["a merged pull request", { state: "done" }, { pr: { ...pr, state: "merged" } }, false, { kind: "merged", landed: true, number: 7 }],
    ["an unfinished push", { state: "running" }, { landed, localUpdate: { ...landed, pushed: false } }, false, { kind: "local-unpushed", landed: false }],
    ["an open pull request", { state: "pr-open" }, { pr }, false, { kind: "pull-request-open", landed: false }],
    ["an updated pull request", { state: "pr-open" }, { pr, source: { start: { kind: "pull-request", number: 3, url: "u", branch: "feature" }, destination: { kind: "update-pr", repo: "acme/shop", branch: "feature" }, product: { id: "shop", name: "Shop", repo: "acme/shop" }, confirmed: true } as never }, false, { kind: "pull-request-open", updated: true }],
    ["a closed pull request on a single product", { state: "done" }, { pr: { ...pr, state: "closed" } }, false, { kind: "pull-request-closed", landed: false, decision: "none" }],
    ["publishing in progress", { state: "running" }, { shipping: { step: "push", moves: 0, failures: 0 } }, false, { kind: "publishing", landed: false, step: "push" }],
    ["interrupted shipping", { state: "needs-you" }, { shipping: { step: "push", moves: 0, failures: 0 } }, true, { kind: "interrupted", decision: "needed" }],
    ["a delivery saved by an older Petrina", { state: "needs-you" }, { shipping: { moves: 0, failures: 0, carriedOver: true } }, true, { kind: "unknown" }],
    ["marked done without confirmation", { state: "done" }, { cleanup: { pullRequest: "unconfirmed" } }, false, { kind: "unconfirmed", pullRequestCheck: "unconfirmed" }],
    ["marked done, no pull request found later", { state: "done" }, { cleanup: { pullRequest: "none" } }, false, { kind: "unconfirmed", pullRequestCheck: "none" }],
    ["nothing published yet", { state: "running" }, {}, false, { kind: "pending" }],
  ];

  for (const [name, changes, work, interrupted, expected] of cases) it(`reports ${name}`, () => {
    const built = task(changes, work);
    const result = publishingResult(built, built.repository!, interrupted);
    expect(result).toMatchObject(expected);
    expect(publishingWords(result).length).toBeGreaterThan(5);
  });

  it("treats no product changes as its own result and a general delivered marker as no evidence", () => {
    const shared = task({ state: "done", deliveryRecorded: true, repositories: [{ productId: "shop", delivery: "local", completedStages: [], nothingToPublish: true }] as never });
    expect(publishingResult(shared, shared.repositories![0]!, false)).toEqual({ kind: "no-changes", landed: null });
    const maintenance = task({ state: "done", maintenance: { noProductChanges: true } as never });
    expect(publishingResult(maintenance, maintenance.repository!, false)).toEqual({ kind: "no-changes", landed: null });
    const marked = task({ state: "done", deliveryRecorded: true });
    expect(publishingResult(marked, marked.repository!, false).kind).toBe("unconfirmed");
  });

  it("applies a shipping question only to the product it names, leaving the other products' own results", () => {
    const works: TaskRepository[] = [
      { productId: "shop", delivery: "pull-request", completedStages: [], pr: { ...pr, state: "closed" } },
      { productId: "billing", delivery: "pull-request", completedStages: [] },
      { productId: "notes", delivery: "local", completedStages: [], shipping: { step: "push", moves: 0, failures: 0 } },
    ];
    const shared = task({ state: "needs-you", repositories: works });
    const question: InboxItem = { id: "s1", taskId: shared.id, kind: "shipping", productId: "shop", title: "Shop: pull request closed without merging. Your decision is needed", at: 3, blocking: false };
    const facts = workflowFacts(shared, ctx([question]));
    expect(facts.works.map((work) => work.result.kind)).toEqual(["pull-request-closed", "pending", "publishing"]);
    expect(facts.works[0]!.result).toMatchObject({ decision: "needed" });
    expect(facts.shared).toBe("decision");
    // Only the named product's own unfinished shipping is interrupted.
    const stopped = workflowFacts(shared, ctx([{ ...question, productId: "notes", title: "Shipping was interrupted" }]));
    expect(stopped.works.map((work) => work.result.kind)).toEqual(["pull-request-closed", "pending", "interrupted"]);
    // A question without a product (a single product, or an older record) still applies to every product.
    expect(workflowFacts(shared, ctx([{ ...question, productId: undefined }])).works.map((work) => work.result.kind)).toEqual(["pull-request-closed", "interrupted", "interrupted"]);
    const single = task({ state: "needs-you" }, { shipping: { step: "push", moves: 0, failures: 0 } });
    expect(workflowFacts(single, ctx([{ ...question, productId: undefined, taskId: single.id }])).works[0]!.result.kind).toBe("interrupted");
  });

  it("keeps a multi-product closed pull request as an open decision until resolved, and lands only when every product has landed", () => {
    const works = (closedAccepted: boolean, secondLanded: boolean): TaskRepository[] => [
      { productId: "shop", delivery: "pull-request", completedStages: [], pr: { ...pr, state: "closed" }, ...(closedAccepted ? { landingAccepted: { at: 2 } } : {}) },
      { productId: "billing", delivery: "pull-request", completedStages: [], pr: secondLanded ? { ...pr, number: 8, state: "merged" } : { ...pr, number: 8 } },
    ];
    const open = task({ state: "needs-you", repositories: works(false, false) });
    const facts = workflowFacts(open, ctx());
    expect(facts.works.map((work) => work.result.kind)).toEqual(["pull-request-closed", "pull-request-open"]);
    expect(facts.works[0]!.result).toMatchObject({ decision: "needed" });
    expect(facts.shared).toBe("decision");
    const waiting = workflowFacts(task({ state: "pr-open", repositories: works(true, false) }), ctx());
    expect(waiting.shared).toBe("waiting");
    const done = workflowFacts(task({ state: "done", repositories: works(true, true) }), ctx());
    expect(done.shared).toBe("landed");
    expect(done.works.map((work) => work.result.landed)).toEqual([false, true]);
  });
});

describe("delivery and handoff evidence regressions", () => {
  it("keeps unfinished pushes and shared partial landing out of the landed label, and names only confirmed pushes", () => {
    const pending = task({ state: "cancelled" }, { landed, localUpdate: { ...landed, pushed: false } });
    expect(workflowFacts(pending, ctx()).landing).toBe("cancelled");
    expect(workflowFacts(task({}, { landed, localUpdate: { ...landed, pushed: false } }), ctx()).landing).toBe("open");
    const cancelled = diff(task(), pending).find(event => event.kind === "task.finished")!;
    expect(cancelled.summary).not.toContain("already out");
    expect(cancelled.products).toEqual([expect.objectContaining({ result: { kind: "local-unpushed", landed: false, ...landed } })]);
    const local = publishingResult(task(), { productId: "shop", delivery: "local", ...{ landed } }, false);
    expect(local.kind).toBe("committed");
    expect(publishingWords(local)).not.toContain("and pushed");
    const pushed = publishingResult(task(), { productId: "shop", delivery: "local", landed, localUpdate: { ...landed, pushed: true } }, false);
    expect(publishingWords(pushed)).toContain("and pushed");
    const first = { productId: "shop", delivery: "release" as const, completedStages: [], release };
    const second = { productId: "api", delivery: "pull-request" as const, completedStages: [], pr };
    const waiting = task({ repositories: [first, second] });
    expect(workflowFacts(waiting, ctx())).toMatchObject({ shared: "waiting", landing: "awaiting-merge" });
    const merged = task({ repositories: [first, { ...second, pr: { ...pr, state: "merged" } }] });
    expect(workflowFacts(merged, ctx())).toMatchObject({ shared: "landed", landing: "landed" });
    const published = diff(task(), task({ state: "cancelled" }, { release })).find(event => event.kind === "task.finished")!;
    expect(published.summary).toContain("already out");
    expect(published.summary).toContain("published release");
  });

  it("retains an unconfirmed mark-done result alongside later open, merged and closed lookups", () => {
    const marked = task({ state: "done" }, { delivery: "pull-request", cleanup: { markedDone: true, pullRequest: "unconfirmed" } });
    for (const state of ["open", "merged", "closed"] as const) {
      const found = task({ state: "done" }, { delivery: "pull-request", cleanup: { markedDone: true, pullRequest: "none" }, pr: { ...pr, state } });
      const update = diff(marked, found).find(event => event.kind === "publishing.result")!;
      expect(update).toMatchObject({ landing: "marked-done", result: { kind: "unconfirmed", landed: false, pullRequestCheck: "found", lookup: { number: pr.number, state } } });
      expect(update.summary).toContain("marked done without a confirmed delivery");
    }
    const none = task({ state: "done" }, { cleanup: { pullRequest: "none" } });
    expect(workflowFacts(none, ctx()).works[0]!.result).toMatchObject({ kind: "unconfirmed", pullRequestCheck: "none" });
    expect(workflowFacts(task({ state: "done" }, { pr: { ...pr, state: "merged" } }), ctx()).works[0]!.result.kind).toBe("merged");
  });

  it("uses the product and versions recorded on each handoff, and leaves missing shared ownership unavailable", () => {
    const step: JourneyStep = { id: "j1", kind: "agent", roleId: "builder", profileId: "sol-high", round: 1, sub: 0, startedAt: 1, agentInputs: [{ roleId: "builder", profileId: "sol-high", taskTitle: "Shared", mode: "fresh", sections: [], productId: "api", stepAttempts: 7, versions: { base: "api-base" } }] };
    const shared = task({ productId: "shop", repositories: [{ productId: "shop", delivery: "local", completedStages: [], baseSha: "shop-base", stepAttempts: 1 }, { productId: "api", delivery: "local", completedStages: [], baseSha: "api-base", stepAttempts: 7 }], journey: [step] });
    const start = diff(task({ ...shared, journey: [] }), shared).find(event => event.kind === "seat.started")!;
    expect(start).toMatchObject({ productId: "api", stepAttempts: 7, versions: { base: "api-base" } });
    const legacy = JSON.parse(JSON.stringify(shared)) as TaskState;
    delete legacy.journey![0]!.agentInputs![0]!.productId;
    delete legacy.journey![0]!.agentInputs![0]!.versions;
    delete legacy.journey![0]!.agentInputs![0]!.stepAttempts;
    const unknown = diff(task({ ...shared, journey: [] }), legacy).find(event => event.kind === "seat.started")!;
    expect(unknown.versions).toBeNull();
    expect(unknown.stepAttempts).toBeUndefined();
  });
});
