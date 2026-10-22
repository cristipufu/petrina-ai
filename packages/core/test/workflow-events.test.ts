import { describe, expect, it } from "vitest";
import { beginAgentStep, endAgentStep, JOURNEY_WORDS as W, BUILT_IN_ROLES, createDemoState, publishingResult, publishingWords, seatOf, workflowEvents, workflowFacts, WorkflowObserver, type Finding, type InboxItem, type JourneyStep, type Task, type TaskRepository, type TaskState, type WorkflowContext, type WorkflowEvent } from "../src/index.js";

const state = createDemoState(1_000_000);
const ctx = (inbox: InboxItem[] = [], now = 5_000): WorkflowContext => ({ roles: state.roles, profiles: state.profiles, inbox, products: state.products.map(({ id, name }) => ({ id, name })), now });
const pr = { number: 7, url: "https://github.com/acme/shop/pull/7", state: "open" as const, openedAt: 1 };
const release = { tag: "v1.2.0", url: "https://github.com/acme/shop/releases/tag/v1.2.0" };
const landed = { branch: "main", sha: "abc1234" };

/** A compact single-product task in the runtime shape: execution fields live on its repository record. */
function task(changes: Partial<TaskState> = {}, work: Partial<TaskRepository> = {}): TaskState {
  const base = JSON.parse(JSON.stringify(state.tasks[0]!)) as Task;
  const { pr: _pr, release: _release, landed: _landed, localUpdate: _local, shipping: _shipping, cleanup: _cleanup, ...rest } = base;
  const repository = { productId: base.productId, delivery: base.delivery, ...work };
  return { ...rest, repository, journey: [], findings: [], state: "running", statusLine: "Working", ...changes } as unknown as TaskState;
}
const kinds = (events: readonly { kind: string }[]) => events.map((event) => event.kind);
/** The step's seats received instructions: one input per seat, as the engine records them. */
const seated = (step: JourneyStep, seats: readonly (readonly [key: string, profileId: string])[] = [["0", step.profileId!]]): JourneyStep => ({ ...step, agentInputs: [...(step.agentInputs ?? []), ...seats.map(([reviewerKey, profileId]) => ({ at: step.startedAt, roleId: step.roleId!, profileId, reviewerKey, requestedProfileId: profileId, taskTitle: "T", sections: [], mode: "fresh" as const }))] });
/** Every seat handed back an accepted result, which is what makes a review a completed examination. */
const handedBack = (step: JourneyStep, at = (step.endedAt ?? step.startedAt) - 1): JourneyStep => ({ ...step, agentResults: (step.agentInputs ?? []).map((input, inputIndex) => ({ roleId: input.roleId, profileId: input.profileId, at, value: { findings: [], verdict: "pass" }, inputIndex, findings: [] })) });
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

describe("compact facts become ordered events", () => {
  it("follows successive lone-agent replacements across their recorded handoff nodes without treating later work as a replacement", () => {
    const current = task();
    const mutable = current as unknown as Task & { journey: JourneyStep[] };
    const snapshot = () => JSON.parse(JSON.stringify(current)) as TaskState;
    const start = (profileId: string, at: number) => {
      const step = beginAgentStep(mutable, "builder", profileId, at, state.roles);
      step.agentInputs = [{ at, productId: current.repository!.productId, roleId: "builder", profileId, requestedProfileId: "opus-high", selectionReason: `${profileId} selected after a usage limit`, taskTitle: "T", sections: [], mode: "fresh", sessionId: `session-${profileId}` }];
      return step;
    };
    start("opus-high", 1);
    for (const [previous, selected, at] of [["opus-high", "sol-high", 3], ["sol-high", "grok-xhigh", 5]] as const) {
      const before = snapshot();
      const previousId = current.journey!.at(-1)!.id;
      endAgentStep(mutable, { outcome: W.handedOn, reason: W.agentChanged, tone: "back" }, at - 1);
      const step = start(selected, at);
      const events = diff(before, current);
      expect(events.find(event => event.kind === "profile.replaced")).toMatchObject({ nodeId: step.id, previousProfileId: previous, profileId: selected, reason: `${selected} selected after a usage limit`, previousNodeId: previousId });
      expect(events.find(event => event.kind === "seat.started")).toMatchObject({ replaced: { previousProfileId: previous, nodeId: previousId, conversation: `session-${previous}` } });
      expect(diff(current, snapshot())).toEqual([]);
    }
    const before = snapshot();
    endAgentStep(mutable, { reason: W.checksPassed }, 6);
    start("opus-high", 7);
    expect(diff(before, current).some(event => event.kind === "profile.replaced")).toBe(false);
  });

  it("never borrows another check attempt's versions when matching evidence is unavailable", () => {
    const node: JourneyStep = { id: "notes", kind: "agent", roleId: "release-manager", round: 1, sub: 0, startedAt: 1, checkAttempts: [{ id: "old", productId: "shop", commands: ["bun test"], sha: "old-code", definition: "old-checks", passed: true }], productChecks: [{ id: "new-check", attemptId: "new", productId: "shop", name: "Tests", result: "running", startedAt: 3 }] };
    const before = task({ journey: [node] });
    const after = task({ journey: [{ ...node, productChecks: [{ ...node.productChecks![0]!, result: "fail", endedAt: 4 }] }] });
    expect(diff(before, after).find(event => event.kind === "check.finished")).toMatchObject({ result: "fail", versions: null });
    const matching = { id: "new", productId: "shop", commands: ["bun test"], sha: "new-code", definition: "new-checks", passed: false };
    after.journey![0]!.checkAttempts = [...node.checkAttempts!, matching];
    expect(diff(before, after).find(event => event.kind === "check.finished")).toMatchObject({ result: "fail", versions: { attemptId: matching.id, sha: matching.sha, definition: matching.definition, passed: false } });
  });

  it("records creation, state transitions, terminal delivery and a combined backlog card", () => {
    const created = task({ state: "backlog" });
    expect(kinds(diff(undefined, created))).toEqual(["task.created"]);
    const queued = task({ state: "queued" });
    expect(diff(created, queued)).toEqual([expect.objectContaining({ kind: "task.state", from: "backlog", to: "queued" })]);
    const combined = task({ state: "cancelled", finishedAt: 9, combinedInto: "task-99" });
    const events = diff(queued, combined);
    expect(kinds(events)).toEqual(["task.state", "task.finished"]);
    expect(events[1]).toMatchObject({ combinedInto: "task-99", state: "cancelled" });
    const cancelledWithWork = task({ state: "cancelled", finishedAt: 9 }, { pr });
    const out = diff(task({ state: "running" }, { pr }), cancelledWithWork);
    expect(out.find((event) => event.kind === "task.finished")!.summary).toContain("pull request #7");
    expect(out.find((event) => event.kind === "task.finished")!.products).toEqual([expect.objectContaining({ result: expect.objectContaining({ kind: "pull-request-open" }) })]);
  });

  it("emits per-product publishing results for each landed kind and reports what still needs a decision", () => {
    const before = task({ state: "running", repositories: [{ productId: "shop", delivery: "release", completedStages: [] }, { productId: "billing", delivery: "local", completedStages: [] }] });
    const after = task({ state: "running", repositories: [{ productId: "shop", delivery: "release", completedStages: [], release }, { productId: "billing", delivery: "local", completedStages: [], landed, localUpdate: { ...landed, pushed: false } }] });
    const events = diff(before, after);
    expect(kinds(events)).toEqual(["publishing.result", "publishing.result"]);
    expect(events[0]).toMatchObject({ productId: "shop", result: { kind: "released", landed: true }, shared: "unfinished" });
    expect(events[1]).toMatchObject({ productId: "billing", result: { kind: "local-unpushed", landed: false } });
    expect(events[1]!.summary).toContain("push has not finished");
    const unchanged = diff(after, JSON.parse(JSON.stringify(after)));
    expect(unchanged).toEqual([]);
  });

  it("ignores progress wording, clocks and tool activity, and reports a waiting kind only when it changes", () => {
    const base = task({ state: "running", statusLine: "Builder is starting", stepClock: { roleId: "builder", repeat: false, worked: 0, since: 1 }, toolActivity: { actionCount: 1, lastActivity: "Read a file" } });
    const churn = task({ state: "running", statusLine: "Running checks: Tests", stepClock: { roleId: "builder", repeat: false, worked: 500, since: 2 }, toolActivity: { actionCount: 9, lastActivity: "Ran a command", runningTool: { id: "t", description: "Ran a command", startedAt: 3 } }, todo: "Writing the change" });
    expect(diff(base, churn)).toEqual([]);
    const waiting = task({ state: "waiting", statusLine: "Waiting for a free Claude Code slot" });
    const events = diff(churn, waiting);
    expect(events).toEqual([expect.objectContaining({ kind: "task.state", to: "waiting", wait: "slot" })]);
    const usage = task({ state: "waiting", statusLine: "Waiting for usage: Claude Code's weekly limit resets in an hour" });
    expect(diff(waiting, usage)).toEqual([expect.objectContaining({ kind: "task.waiting", wait: "usage" })]);
    const capacity = task({ state: "waiting", statusLine: "The selected model is at capacity", capacityPaused: [{ toolId: "codex", modelId: "sol", profileId: "sol-high", roleId: "builder" }] });
    expect(diff(usage, capacity)).toEqual([expect.objectContaining({ kind: "task.waiting", wait: "capacity" })]);
    expect(diff(capacity, task({ state: "waiting", statusLine: "Still at capacity", capacityPaused: capacity.capacityPaused }))).toEqual([]);
  });

  it("names a saved conversation's readiness wait and keeps its recheck with the seat that started", () => {
    const waiting = task({ state: "waiting", statusLine: "Checking Grok before returning to its saved conversation" });
    expect(diff(task({ state: "waiting", statusLine: "Waiting for a free slot" }), waiting)).toEqual([expect.objectContaining({ kind: "task.waiting", wait: "readiness" })]);
    expect(workflowFacts(task({ state: "waiting", statusLine: "Checking Codex before the Builder returns" }), ctx()).waitKind).toBe("readiness");
    const readiness = { at: 10, toolId: "grok", previous: { status: "unknown" as const, at: 1 }, check: "started" as const, outcome: "ready" as const };
    const step: JourneyStep = { id: "j1", kind: "agent", roleId: "code-reviewer", profileId: "grok-high", round: 2, sub: 0, startedAt: 20, agentInputs: [{ at: 20, roleId: "code-reviewer", profileId: "grok-high", requestedProfileId: "opus-high", reviewerKey: "1", taskTitle: "T", sections: [], mode: "continued", readiness }] };
    const seat = diff(task({ state: "running" }), task({ state: "running", journey: [step] })).find((event) => event.kind === "seat.started")!;
    expect(seat).toMatchObject({ mode: "continued", requestedProfileId: "opus-high", profileId: "grok-high", readiness });
    expect(seat.summary).toContain("continued its conversation; readiness recheck started, ready");
  });

  it("orders node, seat, check, decision and review events within one change, with causal references", () => {
    const builder: JourneyStep = { id: "j1", kind: "agent", roleId: "builder", profileId: "sol-xhigh", round: 1, sub: 0, startedAt: 100, trigger: { reason: "Task started" }, agentInputs: [{ at: 101, roleId: "builder", profileId: "sol-xhigh", requestedProfileId: "sol-xhigh", taskTitle: "T", sections: [{ title: "Design brief", body: "x" }], mode: "fresh", exact: { file: "/f", digest: "d".repeat(64), size: 1200 }, manifest: [{ name: "Role instructions", size: 10, digest: "a", kind: "instructions" }, { name: "Design brief", size: 1, digest: "b", kind: "text" }] }], agentResults: [{ roleId: "builder", profileId: "sol-xhigh", at: 200, value: { summary: "Built it", changes: ["A change"] } }], endedAt: 200, end: "done", outcome: "Change ready", reason: "ready for review" };
    const checks: JourneyStep = { id: "j2", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 201, trigger: { after: "j1", reason: "ready for review" }, productChecks: [{ id: "check-0", attemptId: "run-0", productId: "shop", name: "Tests", result: "fail", queuedAt: 201, startedAt: 202, endedAt: 250, run: { name: "Tests", command: "bun test", ok: false, ms: 48, output: "1 failed", logPath: "/log", logComplete: true }, detail: "(fail) a case" }], checkAttempts: [{ id: "run-0", productId: "shop", commands: ["bun test"], sha: "abc", tree: "tree", definition: "def", passed: false }], endedAt: 250, end: "done", outcome: "1 of 1 check failed", reason: "1 check failed", tone: "back" };
    const before = task({ state: "running", journey: [] });
    const after = task({ state: "running", fixing: true, journey: [builder, checks] }, { checkReturns: 1 });
    const events = diff(before, after);
    expect(kinds(events)).toEqual(["node.started", "seat.started", "seat.finished", "node.finished", "node.started", "check.queued", "check.started", "check.finished", "node.finished", "repair.returned"]);
    const seat = events[1]!;
    expect(seat).toMatchObject({ seat: "builder", attempt: 1, mode: "fresh", exact: { size: 1200 }, refs: { input: { nodeId: "j1", seat: "builder", index: 0 }, manifest: { section: "manifest" } } });
    expect(events[2]!.summary).toContain("automated checks are a separate step");
    expect(events[7]).toMatchObject({ kind: "check.finished", result: "fail", log: "complete", versions: { sha: "abc", definition: "def" }, refs: { check: { nodeId: "j2", index: 0 } } });
    expect(events[8]).toMatchObject({ kind: "node.finished", checks: { ran: 1, failed: 1, configured: 1 } });
    expect(events[9]).toMatchObject({ kind: "repair.returned", repairKind: "checks", cause: { nodeId: "j2" }, allowance: { checkReturns: 1, limit: 2 } });
  });

  it("describes only the latest attempt when a stopped check run was resumed on the same step", () => {
    const stopped = { id: "check-0", attemptId: "run-0", productId: "shop", name: "Tests", result: "stopped" as const, startedAt: 11, endedAt: 12, run: { name: "Tests", command: "bun test", ok: false, ms: 1, output: "", interrupted: true } };
    const rerun = { id: "run-1:check-0", attemptId: "run-1", productId: "shop", name: "Tests", result: "pass" as const, startedAt: 15, endedAt: 20, run: { name: "Tests", command: "bun test", ok: true, ms: 5, output: "" } };
    const attempts = [{ id: "run-0", productId: "shop", commands: ["bun test"], sha: "abc", definition: "def" }, { id: "run-1", productId: "shop", commands: ["bun test"], sha: "abc", definition: "def", passed: true }];
    const open: JourneyStep = { id: "j2", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 10, productChecks: [stopped, rerun], checkAttempts: attempts };
    const closed: JourneyStep = { ...open, endedAt: 20, end: "done", outcome: "The check passes", reason: "checks passed" };
    const review: JourneyStep = { id: "j3", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 30, trigger: { after: "j2", reason: "checks passed" } };
    const events = diff(task({ state: "running", journey: [open] }), task({ state: "running", journey: [closed, review] }));
    expect(kinds(events)).toEqual(["node.finished", "node.started"]);
    expect(events[0]).toMatchObject({ checks: { attemptId: "run-1", attempts: 2, configured: 1, ran: 1, passed: 1, failed: 0, unfinished: 0 }, versions: { attemptId: "run-1", passed: true }, refs: { checks: [{ nodeId: "j2", index: 1 }] } });
    expect(events[1]).toMatchObject({ checks: { basis: "ran", passed: true, attemptId: "run-1", attempts: 2, ran: 1, failed: 0, unfinished: 0, versions: { attemptId: "run-1" } } });
    // Control: the stopped attempt alone is unfinished and not passed, without borrowing the later attempt's versions.
    const interrupted = diff(task({ state: "running", journey: [{ ...open, productChecks: [stopped], checkAttempts: attempts.slice(0, 1) }] }), task({ state: "running", journey: [{ ...closed, productChecks: [stopped], checkAttempts: attempts.slice(0, 1), end: "failed" }, review] }));
    expect(interrupted[0]).toMatchObject({ checks: { attemptId: "run-0", attempts: 1, ran: 0, failed: 0, unfinished: 1 } });
    expect(interrupted[1]).toMatchObject({ checks: { basis: "unfinished", passed: false, unfinished: 1 } });
    expect((interrupted[1]!.checks as { versions: { passed?: boolean } }).versions).not.toHaveProperty("passed");
    // A resumed attempt with nothing left to run records versions only: it, not the stopped attempt, is the step's result.
    const emptied = [attempts[0]!, { id: "run-1", productId: "shop", commands: [], sha: "abc", tree: "tree", definition: "def2", passed: true }];
    const resumedEmpty = diff(task({ state: "running", journey: [{ ...open, productChecks: [stopped], checkAttempts: emptied }] }), task({ state: "running", journey: [{ ...closed, productChecks: [stopped], checkAttempts: emptied, outcome: W.checks(0, 0), reason: W.noChecks }, review] }));
    expect(resumedEmpty[0]).toMatchObject({ kind: "node.finished", checks: { attemptId: "run-1", attempts: 2, configured: 0, ran: 0, failed: 0, unfinished: 0 }, versions: { attemptId: "run-1", definition: "def2", passed: true }, refs: { checks: [] } });
    expect(resumedEmpty[1]).toMatchObject({ kind: "node.started", checks: { basis: "none-configured", passed: null, configured: 0, attemptId: "run-1", attempts: 2, versions: { attemptId: "run-1", definition: "def2" } } });
  });

  it("reports reused check evidence once, from the step that ran it, and never as a new execution on a handoff or decision step", () => {
    const run = { name: "Tests", command: "bun test", ok: true, ms: 5, output: "", source: { stepId: "j2", attemptId: "run-0", checkId: "check-0" } };
    const executed = { id: "check-0", attemptId: "run-0", productId: "shop", name: "Tests", result: "pass" as const, startedAt: 11, endedAt: 16, run };
    const checks: JourneyStep = { id: "j2", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 10, endedAt: 16, end: "done", outcome: "The check passes", reason: "checks passed", productChecks: [executed], checkAttempts: [{ id: "run-0", productId: "shop", commands: ["bun test"], sha: "abc", tree: "tree", definition: "def", passed: true }] };
    const builder: JourneyStep = { id: "j3", kind: "agent", roleId: "builder", profileId: "sol-high", round: 1, sub: 0, fixing: true, startedAt: 20, endedAt: 30, end: "done", outcome: "No code changes", reason: "fixes ready" };
    // The evidence handoff after the return copies the original entries with their reuse time; a delivery decision keeps a supporting snapshot too.
    const copy = { ...executed, reusedAt: 31 };
    const handoff: JourneyStep = { id: "j4", kind: "petrina", work: "check-reuse", round: 1, sub: 0, startedAt: 31, endedAt: 31, end: "done", outcome: "Previous checks reused — 1 passing", reason: "Previous checks reused — 1 passing", productChecks: [copy] };
    const reused: JourneyStep = { ...checks, reuses: [{ at: 31, purpose: "review", productId: "shop", attemptId: "run-0", basis: "same-tree", originalAt: 16, sha: "abc", tree: "tree", definition: "def", passed: true }] };
    const decision: JourneyStep = { id: "j5", kind: "you", waitsFor: "delivery", round: 1, sub: 0, startedAt: 40, productChecks: [copy] };
    const events = diff(task({ state: "running", journey: [checks, builder] }), task({ state: "needs-you", journey: [reused, builder, handoff, decision] }));
    expect(kinds(events)).toEqual(["node.started", "check.reused", "node.finished", "node.started", "task.state"]);
    expect(events[0]).toMatchObject({ nodeId: "j4", work: "check-reuse" });
    expect(events[1]).toMatchObject({ nodeId: "j2", purpose: "review", basis: "same-tree", passed: true, refs: { checks: [{ nodeId: "j2", index: 0 }] } });
    expect(events[3]).toMatchObject({ nodeId: "j5", nodeKind: "you" });
    // The original execution's events still carry their recorded positions, so a check reference reads the right entry.
    const ran = diff(task({ state: "running", journey: [{ ...checks, endedAt: undefined, end: undefined, productChecks: [{ ...executed, result: "running", endedAt: undefined }] }] }), task({ state: "running", journey: [checks] }));
    expect(kinds(ran)).toEqual(["check.finished", "node.finished"]);
    expect(ran[0]).toMatchObject({ nodeId: "j2", name: "Tests", result: "pass", refs: { check: { nodeId: "j2", index: 0 } } });
  });

  it("lists every product's latest check evidence when a reviewer or tester starts on a task spanning several products", () => {
    const works: TaskRepository[] = [{ productId: "shop", delivery: "local", completedStages: [] }, { productId: "notes", delivery: "local", completedStages: [] }];
    const pass = { id: "check-0", attemptId: "run-0", productId: "shop", name: "Tests", result: "pass" as const, startedAt: 11, endedAt: 20, run: { name: "Tests", command: "bun test", ok: true, ms: 9, output: "" } };
    const shopRan: JourneyStep = { id: "j1", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 10, endedAt: 20, end: "done", outcome: "All checks pass", reason: W.checksPassed, productChecks: [pass], checkAttempts: [{ id: "run-0", productId: "shop", commands: ["bun test"], sha: "abc", tree: "tree-a", definition: "def-a", passed: true }] };
    const notesNone: JourneyStep = { id: "j2", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 21, endedAt: 22, end: "done", outcome: W.checks(0, 0), reason: W.noChecks, productChecks: [], checkAttempts: [{ id: "run-0", productId: "notes", commands: [], sha: "def", tree: "tree-b", definition: "def-b", passed: true }] };
    const review: JourneyStep = { id: "j3", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 30, trigger: { after: "j2", reason: W.noChecks } };
    const shared = (journey: JourneyStep[]) => task({ state: "running", repositories: works, journey });
    const start = (journey: JourneyStep[]) => diff(shared(journey.slice(0, -1)), shared(journey)).find((event) => event.kind === "node.started")!;
    const shop = { productId: "shop", basis: "ran", passed: true, attemptId: "run-0", attempts: 1, ran: 1, failed: 0, configured: 1, versions: { attemptId: "run-0", tree: "tree-a", passed: true }, refs: { node: { nodeId: "j1" } } };
    const notes = { productId: "notes", basis: "none-configured", passed: null, configured: 0, versions: { attemptId: "run-0", tree: "tree-b" }, refs: { node: { nodeId: "j2" } } };
    const started = start([shopRan, notesNone, review]);
    expect(started.checks).toMatchObject({ basis: "mixed", passed: true, products: [{ ...shop, nodeId: "j1" }, { ...notes, nodeId: "j2" }], refs: { nodes: [{ nodeId: "j1" }, { nodeId: "j2" }] } });
    expect((started.checks as { summary: string }).summary).toBe(`Shop: checks ran and passed; Notes: ${W.noChecks}`);
    // In the other order too: the product whose checks finished last never stands for the whole task.
    const reversed = start([{ ...notesNone, id: "j1", startedAt: 10, endedAt: 11 }, { ...shopRan, id: "j2", startedAt: 12, endedAt: 20 }, review]);
    expect(reversed.checks).toMatchObject({ basis: "mixed", passed: true, products: [{ ...shop, nodeId: "j2", refs: { node: { nodeId: "j2" } } }, { ...notes, nodeId: "j1", refs: { node: { nodeId: "j1" } } }] });
    // Reusing Notes's empty run after Shop's reuse keeps both products' own evidence.
    const done: JourneyStep = { ...review, endedAt: 40, end: "done" };
    const tester: JourneyStep = { id: "j4", kind: "agent", roleId: "tester", profileId: "opus-high", round: 1, sub: 0, startedAt: 50 };
    const reusedShop: JourneyStep = { ...shopRan, reuses: [{ at: 44, purpose: "acceptance", attemptId: "run-0", productId: "shop", basis: "same-tree", originalAt: 20, tree: "tree-a", definition: "def-a", passed: true }] };
    const reusedNotes: JourneyStep = { ...notesNone, reuses: [{ at: 45, purpose: "acceptance", attemptId: "run-0", productId: "notes", basis: "same-tree", originalAt: 22, tree: "tree-b", definition: "def-b", passed: true }] };
    const testerStart = diff(shared([shopRan, notesNone, done]), shared([reusedShop, reusedNotes, done, tester])).find((event) => event.kind === "node.started")!;
    expect(testerStart.checks).toMatchObject({ basis: "mixed", passed: true, products: [{ productId: "shop", basis: "reused", reused: true, passed: true, purpose: "acceptance", versions: { tree: "tree-a" } }, { productId: "notes", basis: "none-configured", reused: true, passed: null, configured: 0 }] });
    expect((testerStart.checks as { summary: string }).summary).toBe(`Shop: checks reused (passing run); Notes: ${W.noChecks} (reused)`);
    // A failing product fails the combination; a product without any record leaves the combined pass unknown.
    const shopFailed: JourneyStep = { ...shopRan, productChecks: [{ ...pass, result: "fail", run: { ...pass.run, ok: false } }], checkAttempts: [{ ...shopRan.checkAttempts![0]!, passed: false }] };
    expect(start([shopFailed, notesNone, review]).checks).toMatchObject({ basis: "mixed", passed: false, products: [{ productId: "shop", basis: "ran", passed: false, failed: 1 }, { productId: "notes", basis: "none-configured" }] });
    const missing = start([shopRan, review]).checks as Record<string, unknown>;
    expect(missing).toMatchObject({ basis: "mixed", products: [{ productId: "shop", basis: "ran", passed: true }, { productId: "notes", basis: "unavailable" }] });
    expect(missing).not.toHaveProperty("passed");
    // Products with the same basis share it, and a single product still reads flat.
    expect(start([shopRan, { ...notesNone, productChecks: [{ ...pass, productId: "notes" }] }, review]).checks).toMatchObject({ basis: "ran", passed: true, products: [{ productId: "shop" }, { productId: "notes", ran: 1 }] });
    expect(diff(task({ state: "running", journey: [shopRan] }), task({ state: "running", journey: [shopRan, review] }))[0]).toMatchObject({ checks: { basis: "ran", passed: true, productId: "shop", nodeId: "j1" } });
  });

  it("does not count a lone reviewer's handover as a completed review, so the replacement keeps the Builder's claim under test", () => {
    const findings = (status: Finding["status"]): Finding[] => [{ id: "f1", text: "Ordinary", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status, answer: { fixed: true, text: "Fixed it", at: 40 } }];
    const fixRound: JourneyStep = { id: "j1", kind: "agent", roleId: "builder", profileId: "sol-high", round: 1, sub: 0, fixing: true, findingIds: ["f1"], startedAt: 20, endedAt: 41, end: "done", outcome: "Fixed 1 finding", reason: "fixes ready" };
    const first: JourneyStep = { id: "j2", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 2, sub: 0, startedAt: 50, trigger: { after: "j1", reason: "fixes ready" } };
    const handedOver: JourneyStep = { ...first, endedAt: 55, end: "done", outcome: W.handedOn, reason: W.agentChanged, tone: "back" };
    const replacement = seated({ id: "j3", kind: "agent", roleId: "code-reviewer", profileId: "sol-high", round: 2, sub: 0, startedAt: 56, trigger: { after: "j2", reason: W.agentChanged } });
    const context = ctx();
    const baselines = new Map();
    const at = (journey: JourneyStep[], status: Finding["status"] = "fixed") => workflowFacts(task({ state: "running", journey, findings: findings(status) }), context);
    expect(kinds(workflowEvents(at([fixRound]), at([fixRound, first]), context, baselines))).toEqual(["node.started"]);
    expect(baselines.get("j2")).toMatchObject({ claims: ["f1"] });
    // The handover ends the first step without a review summary; the replacement starts with the claim under test.
    const handover = workflowEvents(at([fixRound, first]), at([fixRound, handedOver, replacement]), context, baselines);
    expect(kinds(handover)).toEqual(["node.finished", "node.started", "seat.started"]);
    expect(handover[0]).toMatchObject({ nodeId: "j2", reason: W.agentChanged, review: { examined: false, acceptedResults: 0, seats: 1 } });
    expect(baselines.get("j3")).toMatchObject({ claims: ["f1"] });
    const standing = workflowEvents(at([fixRound, handedOver, replacement]), at([fixRound, handedOver, handedBack({ ...replacement, endedAt: 70, end: "done", outcome: "No findings", reason: "review passed" })]), context, new Map(baselines));
    expect(kinds(standing)).toEqual(["seat.finished", "node.finished", "review.finished"]);
    expect(standing[2]).toMatchObject({ nodeId: "j3", claimedFixed: ["f1"], fixed: ["f1"], reopened: [], stillOpen: [] });
    const reproduced = workflowEvents(at([fixRound, handedOver, replacement]), at([fixRound, handedOver, handedBack({ ...replacement, endedAt: 70, end: "done", outcome: "1 finding", reason: "sent back: 1 important" })], "open"), context, new Map(baselines)).find((event) => event.kind === "review.finished")!;
    expect(reproduced).toMatchObject({ nodeId: "j3", claimedFixed: ["f1"], fixed: [], stillOpen: ["f1"] });
    // Control: a review that completed normally examined the claim, so a later review does not take it up again.
    const completed = handedBack(seated({ ...first, endedAt: 55, end: "done", outcome: "No findings", reason: "review passed" }));
    const again = new Map();
    workflowEvents(at([fixRound, completed]), at([fixRound, completed, { ...replacement, trigger: { after: "j2", reason: "review passed" } }]), context, again);
    expect(again.get("j3")).toMatchObject({ claims: [] });
  });

  it("gives no review summary to a review that got stuck or was stopped by cancelling: its partial results stay seat evidence and the Builder's claim stays under test", () => {
    const findings = (status: Finding["status"] = "fixed"): Finding[] => [{ id: "f1", text: "Ordinary", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status, answer: { fixed: true, text: "Fixed it", at: 40 } }];
    const fixRound: JourneyStep = { id: "j1", kind: "agent", roleId: "builder", profileId: "sol-high", round: 1, sub: 0, fixing: true, findingIds: ["f1"], startedAt: 20, endedAt: 41, end: "done", outcome: "Fixed 1 finding", reason: "fixes ready" };
    const input = (reviewerKey: string, profileId: string): NonNullable<JourneyStep["agentInputs"]>[number] => ({ at: 50, roleId: "code-reviewer", profileId, reviewerKey, taskTitle: "T", sections: [], mode: "fresh" });
    const result = (profileId: string, inputIndex: number, at: number): NonNullable<JourneyStep["agentResults"]>[number] => ({ roleId: "code-reviewer", profileId, at, value: { findings: [], verdict: "pass" }, inputIndex, findings: [] });
    // What the engine records for a two-reviewer round in which only one reviewer could start: the step expects
    // both places (`seats`), while `team` and the inputs name only the participant that actually started.
    const seats = ["reviewer:0", "reviewer:1"];
    const review: JourneyStep = { id: "j2", kind: "agent", roleId: "code-reviewer", profileId: "sol-high", team: ["sol-high"], seats, round: 2, sub: 0, startedAt: 50, trigger: { after: "j1", reason: "fixes ready" }, agentInputs: [input("1", "sol-high")] };
    // The started seat handed back; the other was still waiting for usage when the step was interrupted.
    const partial: JourneyStep = { ...review, agentResults: [result("sol-high", 0, 52)] };
    const context = ctx();
    const at = (journey: JourneyStep[], state: TaskState["state"] = "running") => workflowFacts(task({ state, journey, findings: findings() }), context);
    const baselines = new Map();
    const started = workflowEvents(at([fixRound]), at([fixRound, review]), context, baselines);
    expect(kinds(started)).toEqual(["node.started", "seat.started"]);
    expect(started[0]).toMatchObject({ nodeId: "j2", team: ["sol-high"], seats });
    expect(baselines.get("j2")).toMatchObject({ claims: ["f1"] });
    expect(kinds(workflowEvents(at([fixRound, review]), at([fixRound, partial]), context, baselines))).toEqual(["seat.finished"]);
    const endings: [string, Partial<JourneyStep>, TaskState["state"]][] = [
      ["stuck", { endedAt: 60, end: "failed", outcome: W.stuck, reason: "The agent did not respond", tone: "stuck" }, "running"],
      ["cancelled", { endedAt: 60, end: "cancelled", outcome: W.stopped }, "cancelled"],
      // The ending's words decide nothing: a review closed as done before its seats reported (the restart after the
      // coordinator's own changes, or an older delivery's recovery closing whatever step was open) examined nothing either.
      ["hand-back restart", { endedAt: 60, end: "done", outcome: "No findings", reason: W.reviewAgain }, "running"],
      ["older delivery recovery", { endedAt: 60, end: "done", outcome: W.interrupted, reason: W.shippingInterrupted, tone: "back" }, "running"],
    ];
    for (const [name, end, state] of endings) {
      const ended: JourneyStep = { ...partial, ...end };
      const events = workflowEvents(at([fixRound, partial]), at([fixRound, ended], state), context, new Map(baselines));
      expect(kinds(events), name).not.toContain("review.finished");
      const finished = events.find((event) => event.kind === "node.finished")!;
      expect(finished, name).toMatchObject({ nodeId: "j2", end: end.end, review: { examined: false, acceptedResults: 1, seats: 2 }, refs: { results: [{ taskId: finished.taskId, nodeId: "j2", index: 0, seat: "reviewer:1", findingCopies: 0 }] } });
      expect(finished.summary, name).toContain("no completed review (1 of 2 accepted results)");
      // The next actual review takes the claim up again.
      const retry: JourneyStep = { id: "j3", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", team: ["opus-high"], seats, round: 2, sub: 0, startedAt: 61, trigger: { after: "j2", reason: end.reason ?? end.outcome! } };
      const again = new Map();
      expect(kinds(workflowEvents(at([fixRound, ended]), at([fixRound, ended, retry]), context, again)), name).toEqual(["node.started"]);
      expect(again.get("j3"), name).toMatchObject({ claims: ["f1"] });
    }
    // The waiting seat starts later on the same step (a usage replacement on its place is another attempt there, not a
    // third seat) and hands back: now every expected place reported, so the step is a completed examination.
    const joined: JourneyStep = { ...partial, team: ["sol-high", "grok-high"], agentInputs: [...review.agentInputs!, { ...input("0", "grok-high"), at: 55, requestedProfileId: "opus-high", selectionReason: "Opus is out of usage" }] };
    const afterJoin = workflowEvents(at([fixRound, partial]), at([fixRound, joined]), context, new Map(baselines));
    expect(kinds(afterJoin)).toEqual(["seat.started"]);
    expect(afterJoin[0]).toMatchObject({ seat: "reviewer:0", attempt: 1, profileId: "grok-high" });
    const completed: JourneyStep = { ...joined, agentResults: [...partial.agentResults!, { ...result("grok-high", 1, 58) }], endedAt: 60, end: "done", outcome: "No findings", reason: "review passed" };
    const done = workflowEvents(at([fixRound, joined]), at([fixRound, completed]), context, new Map(baselines));
    expect(kinds(done)).toEqual(["seat.finished", "node.finished", "review.finished"]);
    expect(done[1]).toMatchObject({ nodeId: "j2", end: "done", review: { examined: true, acceptedResults: 2, seats: 2 } });
    expect(done[1]!.refs).not.toHaveProperty("results");
    expect(done[2]).toMatchObject({ nodeId: "j2", claimedFixed: ["f1"], fixed: ["f1"], reopened: [], stillOpen: [], refs: { results: [{ seat: "reviewer:1", index: 0 }, { seat: "reviewer:0", index: 1 }] } });
    const later = new Map();
    workflowEvents(at([fixRound, completed]), at([fixRound, completed, { id: "j3", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 3, sub: 0, startedAt: 70, trigger: { after: "j2", reason: "review passed" } }]), context, later);
    expect(later.get("j3")).toMatchObject({ claims: [] });
    // The engine restarts a review after a hand back only once every pending reviewer has handed back: that ending is a completed examination.
    const restarted: JourneyStep = { ...completed, reason: W.reviewAgain };
    const restart = workflowEvents(at([fixRound, joined]), at([fixRound, restarted]), context, new Map(baselines));
    expect(kinds(restart)).toEqual(["seat.finished", "node.finished", "review.finished"]);
    expect(restart[1]).toMatchObject({ nodeId: "j2", reason: W.reviewAgain, review: { examined: true, acceptedResults: 2, seats: 2 } });
    // Stopped after both seats started but before one reported: still an incomplete examination with its one seat's evidence.
    const swapped: JourneyStep = { ...joined, endedAt: 60, end: "cancelled", outcome: W.stopped };
    const afterSwap = workflowEvents(at([fixRound, joined]), at([fixRound, swapped], "cancelled"), context, new Map(baselines));
    expect(afterSwap.find((event) => event.kind === "node.finished")).toMatchObject({ review: { examined: false, acceptedResults: 1, seats: 2 } });
    expect(afterSwap.find((event) => event.kind === "node.finished")!.summary).toContain("no completed review (1 of 2 accepted results)");
    // A result a later assignment edit cannot rewrite: an extra reported place beyond the recorded roster is more evidence, never less.
    const extra: JourneyStep = { ...completed, seats: ["reviewer:1"] };
    expect(workflowEvents(at([fixRound, joined]), at([fixRound, extra]), context, new Map(baselines)).find((event) => event.kind === "node.finished")).toMatchObject({ review: { examined: true, acceptedResults: 2, seats: 1 } });
  });

  it("reads an older record without expected seats from the inputs and team it holds", () => {
    const findings: Finding[] = [{ id: "f1", text: "Ordinary", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "fixed", answer: { fixed: true, text: "Fixed it", at: 40 } }];
    const fixRound: JourneyStep = { id: "j1", kind: "agent", roleId: "builder", profileId: "sol-high", round: 1, sub: 0, fixing: true, findingIds: ["f1"], startedAt: 20, endedAt: 41, end: "done", outcome: "Fixed 1 finding", reason: "fixes ready" };
    const input = (reviewerKey: string, profileId: string): NonNullable<JourneyStep["agentInputs"]>[number] => ({ at: 50, roleId: "code-reviewer", profileId, reviewerKey, taskTitle: "T", sections: [], mode: "fresh" });
    const result = (profileId: string, inputIndex: number, at: number): NonNullable<JourneyStep["agentResults"]>[number] => ({ roleId: "code-reviewer", profileId, at, value: { findings: [], verdict: "pass" }, inputIndex, findings: [] });
    const review: JourneyStep = { id: "j2", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", team: ["opus-high", "sol-high"], round: 2, sub: 0, startedAt: 50, trigger: { after: "j1", reason: "fixes ready" }, agentInputs: [input("0", "opus-high"), input("1", "sol-high")] };
    const partial: JourneyStep = { ...review, agentResults: [result("sol-high", 1, 52)] };
    const context = ctx();
    const at = (journey: JourneyStep[], state: TaskState["state"] = "running") => workflowFacts(task({ state, journey, findings }), context);
    const baselines = new Map();
    workflowEvents(at([fixRound]), at([fixRound, review]), context, baselines);
    workflowEvents(at([fixRound, review]), at([fixRound, partial]), context, baselines);
    const stuck = workflowEvents(at([fixRound, partial]), at([fixRound, { ...partial, endedAt: 60, end: "failed", outcome: W.stuck, reason: "The agent did not respond", tone: "stuck" }]), context, new Map(baselines));
    expect(kinds(stuck)).toEqual(["node.finished"]);
    expect(stuck[0]).toMatchObject({ review: { examined: false, acceptedResults: 1, seats: 2 } });
    // A replacement on seat 0 is another attempt there, not a third seat; a planned member whose tool never delivered instructions still counts.
    const swapped: JourneyStep = { ...partial, team: ["opus-high", "sol-high", "grok-high"], agentInputs: [...review.agentInputs!, { ...input("0", "grok-high"), at: 55, requestedProfileId: "opus-high", selectionReason: "Opus is out of usage" }], endedAt: 60, end: "cancelled", outcome: W.stopped };
    expect(workflowEvents(at([fixRound, partial]), at([fixRound, swapped], "cancelled"), context, new Map(baselines)).find((event) => event.kind === "node.finished")).toMatchObject({ review: { examined: false, acceptedResults: 1, seats: 2 } });
    const lone: JourneyStep = { ...review, agentInputs: [input("1", "sol-high")], agentResults: [result("sol-high", 0, 52)], endedAt: 60, end: "failed", outcome: W.stuck, reason: "The agent did not respond", tone: "stuck" };
    expect(workflowEvents(at([fixRound, { ...lone, agentResults: [], endedAt: undefined, end: undefined }]), at([fixRound, lone]), context, new Map(baselines)).find((event) => event.kind === "node.finished")).toMatchObject({ review: { examined: false, acceptedResults: 1, seats: 2 } });
    // Control: every recorded seat reported.
    const completed: JourneyStep = { ...partial, agentResults: [...partial.agentResults!, result("opus-high", 0, 58)], endedAt: 60, end: "done", outcome: "No findings", reason: "review passed" };
    const done = workflowEvents(at([fixRound, partial]), at([fixRound, completed]), context, new Map(baselines));
    expect(kinds(done)).toEqual(["seat.finished", "node.finished", "review.finished"]);
    expect(done[1]).toMatchObject({ review: { examined: true, acceptedResults: 2, seats: 2 } });
  });

  it("tells a product with nothing to run from missing evidence, through the recorded run and through its reuse", () => {
    const none: JourneyStep = { id: "j2", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 10, endedAt: 11, end: "done", outcome: W.checks(0, 0), reason: W.noChecks, productChecks: [], checkAttempts: [{ id: "run-0", productId: "shop", commands: [], sha: "abc", tree: "tree", definition: "def", passed: true }] };
    const review: JourneyStep = { id: "j3", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 30, trigger: { after: "j2", reason: W.noChecks } };
    const events = diff(task({ state: "running", journey: [none] }), task({ state: "running", journey: [none, review] }));
    expect(events).toEqual([expect.objectContaining({ kind: "node.started", checks: expect.objectContaining({ basis: "none-configured", passed: null, configured: 0, nodeId: "j2", versions: expect.objectContaining({ attemptId: "run-0" }) }) })]);
    expect(events[0]!.summary).toContain(W.noChecks);
    const reused: JourneyStep = { ...none, reuses: [{ at: 40, purpose: "acceptance", attemptId: "run-0", productId: "shop", basis: "same-tree", originalAt: 11, sha: "abc", tree: "tree", definition: "def", passed: true }] };
    const tester: JourneyStep = { id: "j4", kind: "agent", roleId: "tester", profileId: "opus-high", round: 1, sub: 0, startedAt: 41 };
    const later = diff(task({ state: "running", journey: [none, { ...review, endedAt: 35, end: "done" }] }), task({ state: "running", journey: [reused, { ...review, endedAt: 35, end: "done" }, tester] }));
    expect(kinds(later)).toEqual(["check.reused", "node.started"]);
    expect(later[1]).toMatchObject({ checks: { basis: "none-configured", reused: true, passed: null, configured: 0, purpose: "acceptance", attemptId: "run-0" } });
    // Controls: a passing check is a pass; an older reconstructed step without entries says nothing; no step at all is unavailable.
    const ran: JourneyStep = { ...none, productChecks: [{ id: "check-0", attemptId: "run-0", productId: "shop", name: "Tests", result: "pass", startedAt: 10, endedAt: 11, run: { name: "Tests", command: "bun test", ok: true, ms: 1, output: "" } }] };
    expect(diff(task({ state: "running", journey: [ran] }), task({ state: "running", journey: [ran, review] }))[0]).toMatchObject({ checks: { basis: "ran", passed: true, configured: 1 } });
    const legacy: JourneyStep = { id: "j2", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 10, endedAt: 11, end: "done", legacy: true };
    expect(diff(task({ state: "running", journey: [legacy] }), task({ state: "running", journey: [legacy, review] })).find((event) => event.kind === "node.started")).toMatchObject({ checks: { basis: "unavailable", nodeId: "j2" } });
    expect(diff(task({ state: "running" }), task({ state: "running", journey: [review] }))[0]).toMatchObject({ checks: { basis: "unavailable" } });
  });

  it("reconciles findings when a review node finishes and names the check basis when a reviewer starts", () => {
    const checks: JourneyStep = { id: "j2", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 10, endedAt: 20, end: "done", outcome: "All checks pass", reason: "checks passed", productChecks: [{ name: "Tests", result: "pass", startedAt: 11, endedAt: 20, run: { name: "Tests", command: "bun test", ok: true, ms: 9, output: "" } }], checkAttempts: [{ id: "run-0", productId: "shop", commands: ["bun test"], sha: "abc", definition: "def", passed: true }], reuses: [{ at: 25, purpose: "review", basis: "same-tree", originalAt: 20, tree: "tree", definition: "def", passed: true }] };
    const review = seated({ id: "j3", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", team: ["opus-high", "sol-high"], round: 1, sub: 0, startedAt: 30, trigger: { after: "j2", reason: "checks passed" } }, [["0", "opus-high"], ["1", "sol-high"]]);
    const started = task({ state: "running", journey: [checks, review], findings: [{ id: "f1", text: "Old", severity: "blocking", raisedBy: "sol-high", confirmedBy: [], status: "open", answer: { fixed: true, text: "Fixed it", at: 5 } }] });
    const baselines = new Map();
    const context = ctx();
    const firstEvents = workflowEvents(workflowFacts(task({ state: "running", journey: [{ ...checks, reuses: undefined }] }), context), workflowFacts(started, context), context, baselines);
    expect(kinds(firstEvents)).toEqual(["check.reused", "node.started", "seat.started", "seat.started"]);
    expect(firstEvents[1]).toMatchObject({ checks: { basis: "reused", passed: true, purpose: "review" } });
    const finished = task({ state: "running", journey: [checks, handedBack({ ...review, endedAt: 60, end: "done", outcome: "2 findings", reason: "review passed", result: { findings: [] } })], findings: [
      { id: "f1", text: "Old", severity: "blocking", raisedBy: "sol-high", confirmedBy: ["opus-high"], status: "open", answer: { fixed: true, text: "Fixed it", at: 5 }, reopenedAt: 50, evidence: "Still fails" },
      { id: "f2", text: "New", severity: "suggestion", raisedBy: "opus-high", confirmedBy: [], status: "open" },
      { id: "f3", text: "Disputed", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "dismissed" },
    ] });
    const events = workflowEvents(workflowFacts(started, context), workflowFacts(finished, context), context, baselines);
    expect(kinds(events)).toEqual(["seat.finished", "seat.finished", "node.finished", "review.finished"]);
    // The Builder's claim on f1 was under test; the review reproduced it, so it is reopened and not fixed.
    expect(events[3]).toMatchObject({ opening: 1, closing: 3, since: "node-start", raised: ["f2", "f3"], reopened: [{ id: "f1", evidence: true }], dismissed: ["f3"], stillOpen: ["f1"], openImportant: ["f1"], openNits: ["f2"], openPreExisting: [], reportCounts: { closing: { total: 3, open: { total: 2, important: 1, nits: 1, preExisting: 0 }, dismissed: 1 } }, claimedFixed: ["f1"], fixed: [] });
  });

  it("lists a repair claim the Builder already marked fixed as claimed and, when the review leaves it standing, as fixed", () => {
    const claim = { fixed: true, text: "Fixed it", at: 40 };
    const earlierReview = handedBack(seated({ id: "j1", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1, endedAt: 10, end: "done", outcome: "2 findings", reason: "sent back: 2 important" }));
    const fixRound: JourneyStep = { id: "j2", kind: "agent", roleId: "builder", profileId: "sol-high", round: 1, sub: 0, fixing: true, findingIds: ["f1", "f2"], startedAt: 20, endedAt: 41, end: "done", outcome: "Fixed 2 findings", reason: "fixes ready" };
    const review = seated({ id: "j3", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 2, sub: 0, startedAt: 50, trigger: { after: "j2", reason: "fixes ready" } });
    // An older claim (f0) was examined by the earlier review and stays fixed: it is not under test again.
    const findings = (f1: Partial<Finding>, f2: Partial<Finding>): Finding[] => [
      { id: "f0", text: "Older", severity: "blocking", raisedBy: "sol-high", confirmedBy: [], status: "fixed", answer: { fixed: true, text: "Done earlier", at: 5 } },
      { id: "f1", text: "Ordinary", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "fixed", answer: claim, ...f1 },
      { id: "f2", text: "Shared", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "open", answer: claim, productIds: ["shop", "api"], ...f2 },
    ];
    const started = task({ state: "running", journey: [earlierReview, fixRound, review], findings: findings({}, {}) });
    const context = ctx();
    const baselines = new Map();
    const startEvents = workflowEvents(workflowFacts(task({ state: "running", journey: [earlierReview, fixRound] }), context), workflowFacts(started, context), context, baselines);
    expect(kinds(startEvents)).toEqual(["node.started", "seat.started"]);
    expect(baselines.get("j3")).toMatchObject({ claims: ["f1", "f2"] });
    const standing = task({ state: "running", journey: [earlierReview, fixRound, handedBack({ ...review, endedAt: 70, end: "done", outcome: "No findings", reason: "review passed" })], findings: findings({}, { status: "fixed" }) });
    const passed = workflowEvents(workflowFacts(started, context), workflowFacts(standing, context), context, new Map(baselines)).find((event) => event.kind === "review.finished")!;
    expect(passed).toMatchObject({ opening: 3, closing: 3, claimedFixed: ["f1", "f2"], fixed: ["f1", "f2"], reopened: [], stillOpen: [] });
    const reproduced = task({ state: "running", journey: [earlierReview, fixRound, handedBack({ ...review, endedAt: 70, end: "done", outcome: "1 finding", reason: "sent back: 1 important" })], findings: findings({ status: "open", reopenedAt: 60, evidence: "Still fails" }, {}) });
    const failed = workflowEvents(workflowFacts(started, context), workflowFacts(reproduced, context), context, new Map(baselines)).find((event) => event.kind === "review.finished")!;
    expect(failed).toMatchObject({ claimedFixed: ["f1", "f2"], fixed: [], reopened: [{ id: "f1", evidence: true }], stillOpen: ["f1", "f2"] });
    // Control: a finding closed during the review without a claim is fixed, not claimed.
    const closedDuring = task({ state: "running", journey: [earlierReview, fixRound, handedBack({ ...review, endedAt: 70, end: "done" })], findings: [...findings({}, {}), { id: "f3", text: "Petrina's", severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "fixed" }] });
    const openBefore = task({ ...started, findings: [...started.findings, { id: "f3", text: "Petrina's", severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" }] });
    const during = workflowEvents(workflowFacts(openBefore, context), workflowFacts(closedDuring, context), context, new Map([["j3", { findings: workflowFacts(openBefore, context).findings, since: "node-start", claims: ["f1", "f2"] }]])).find((event) => event.kind === "review.finished")!;
    expect(during).toMatchObject({ claimedFixed: ["f1", "f2"], fixed: ["f1", "f3"], stillOpen: ["f2"] });
  });

  it("carries a removed request to the next observation so its recorded decision names it, and reports an unrecorded removal as handled", () => {
    const step: JourneyStep = { id: "j1", kind: "you", waitsFor: "delivery", round: 1, sub: 0, startedAt: 1 };
    const item: InboxItem = { id: "d1", taskId: "h1", kind: "delivery", title: "Ready to ship", at: 2, blocking: false };
    const context = ctx();
    const deferred = new Map();
    const waiting = task({ state: "needs-you", journey: [step] });
    const removed = task({ state: "needs-you", journey: [step] });
    const first = workflowEvents(workflowFacts(waiting, ctx([item])), workflowFacts(removed, context), context, new Map(), deferred);
    expect(first).toEqual([]);
    expect(deferred.size).toBe(1);
    const decided = task({ state: "waiting", journey: [{ ...step, endedAt: 3, end: "done", outcome: "Approved", reason: "you approved" }] });
    const second = workflowEvents(workflowFacts(removed, context), workflowFacts(decided, context), context, new Map(), deferred);
    expect(kinds(second)).toEqual(["node.finished", "coordinator.decision", "task.state"]);
    expect(second[1]).toMatchObject({ requestKind: "delivery", itemId: "d1", how: "Approved", reason: "you approved" });
    expect(deferred.size).toBe(0);
    const stale = new Map();
    workflowEvents(workflowFacts(waiting, ctx([item])), workflowFacts(removed, context), context, new Map(), stale);
    const unrecorded = workflowEvents(workflowFacts(removed, context), workflowFacts(removed, context), context, new Map(), stale);
    expect(unrecorded).toEqual([expect.objectContaining({ kind: "coordinator.decision", itemId: "d1", how: "handled" })]);
  });

  it("records coordinator requests and decisions, including questions settled on the journey and replaced profiles", () => {
    const step: JourneyStep = { id: "j1", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", round: 1, sub: 0, startedAt: 1, asks: [{ id: "q1", kind: "question", title: "Which colour?", at: 2 }], agentInputs: [{ at: 1, roleId: "code-reviewer", profileId: "opus-high", reviewerKey: "0", requestedProfileId: "opus-high", taskTitle: "T", sections: [], mode: "fresh" }] };
    const asked = task({ state: "needs-you", journey: [step] });
    const inbox: InboxItem[] = [{ id: "q1", taskId: asked.id, kind: "question", title: "Which colour?", at: 2, blocking: true }];
    const requested = diff(task({ state: "running", journey: [{ ...step, asks: [] }] }), asked, inbox);
    expect(kinds(requested)).toEqual(["coordinator.request", "task.state"]);
    expect(requested[0]).toMatchObject({ requestKind: "question", itemId: "q1", nodeId: "j1", blocking: true });
    const replaced = { ...step, asks: [{ id: "q1", kind: "question" as const, title: "Which colour?", at: 2, endedAt: 3, how: "answered" as const, answer: "Blue" }], agentInputs: [...step.agentInputs!, { at: 4, roleId: "code-reviewer", profileId: "sol-high", reviewerKey: "0", requestedProfileId: "opus-high", selectionReason: "Opus is out of usage", taskTitle: "T", sections: [], mode: "fresh" as const }] };
    const context = { ...ctx(), limited: [{ toolId: "claude-code", model: "opus", until: 9, reason: "Claude Code's weekly Opus limit" }] };
    const events = workflowEvents(workflowFacts(asked, ctx(inbox)), workflowFacts(task({ state: "running", journey: [replaced] }), context), context, new Map());
    expect(kinds(events)).toEqual(["coordinator.decision", "seat.started", "profile.replaced", "task.state"]);
    expect(events[0]).toMatchObject({ how: "answered", answer: "Blue", itemId: "q1" });
    expect(events[1]).toMatchObject({ seat: "reviewer:0", attempt: 2, replaced: { previousProfileId: "opus-high", reason: "Claude Code's weekly Opus limit" } });
    expect(events[2]).toMatchObject({ previousProfileId: "opus-high", profileId: "sol-high", reason: "Claude Code's weekly Opus limit" });
    expect(seatOf({ roleId: "verifier", profileId: "sol-high", requestedProfileId: "opus-high" }, BUILT_IN_ROLES)).toBe("verifier:opus-high");
    // A vote place keeps its own seat through a replacement, and a reused tool in a later place gets another.
    expect(seatOf({ roleId: "verifier", profileId: "sol-high", requestedProfileId: "sol-high", place: "opus-high" }, BUILT_IN_ROLES)).toBe("verifier:opus-high");
    expect(seatOf({ roleId: "verifier", profileId: "argon-high", requestedProfileId: "argon-high", place: "third:sol-high" }, BUILT_IN_ROLES)).toBe("verifier:third:sol-high");
  });

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

  it("keeps every event within its byte bound through explicit shortening", () => {
    const manifest = Array.from({ length: 12 }, (_, index) => ({ name: `Section ${index} ${"x".repeat(400)}`, size: 1, digest: "d", kind: "text" as const }));
    const step: JourneyStep = { id: "j1", kind: "agent", roleId: "builder", profileId: "sol-xhigh", round: 1, sub: 0, startedAt: 1, agentInputs: [{ at: 1, roleId: "builder", profileId: "sol-xhigh", taskTitle: "T", sections: [], mode: "fresh", manifest }] };
    const events = diff(task({ state: "running" }), task({ state: "running", journey: [step] })) as WorkflowEvent[];
    const seat = events.find((event) => event.kind === "seat.started")!;
    expect(JSON.stringify(seat).length).toBeGreaterThan(4000);
    expect((seat.manifest as unknown[]).length).toBe(12);
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

describe("review reports name the populations they count", () => {
  const report = (id: string, severity: Finding["severity"], status: Finding["status"] = "open"): Finding => ({ id, text: "Two blind reports may describe the same bug", severity, status, raisedBy: "opus-high", confirmedBy: [], productIds: ["shop", "api"] });
  function reviewEvent(opening: Finding[], closing: Finding[], shared = true) {
    const scope = shared ? { productId: "shop", repositories: [{ productId: "shop", delivery: "local" as const, completedStages: [] }, { productId: "api", delivery: "local" as const, completedStages: [] }] } : { productId: "shop" };
    const review = seated({ id: "review", kind: "agent", roleId: "code-reviewer", profileId: "opus-high", startedAt: 10, round: 1, sub: 0 });
    const done = handedBack({ ...review, endedAt: 20 });
    done.result = { findings: closing };
    const context = ctx();
    const baselines = new Map();
    const started = workflowFacts(task({ ...scope, findings: opening, journey: [review] }), context);
    workflowEvents(workflowFacts(task({ ...scope, findings: opening }), context), started, context, baselines);
    return workflowEvents(started, workflowFacts(task({ ...scope, findings: closing, journey: [done] }), context), context, baselines).find((event) => event.kind === "review.finished")!;
  }

  it("reports the two-open-report example as zero Important, one nit and one pre-existing follow-up", () => {
    const closing = [report("old", "pre-existing"), report("nit", "suggestion")];
    closing[0]!.tracking = { taskId: "follow-up" };
    const event = reviewEvent([], closing);
    expect(event).toMatchObject({ opening: 0, closing: 2, raised: ["old", "nit"], stillOpen: [], stillOpenPopulation: "open-important", openImportant: [], openNits: ["nit"], openPreExisting: ["old"], reportCounts: { opening: { total: 0 }, closing: { total: 2, open: { total: 2, important: 0, nits: 1, preExisting: 1 }, fixed: 0, dismissed: 0, unverified: 0 } } });
    expect(event.summary).toContain("2 open reports (0 Important, 1 nit, 1 pre-existing follow-up)");
    expect(event.reports).toEqual([closing[1]!, closing[0]!].map((finding) => expect.objectContaining({ id: finding.id, severity: finding.severity, status: "open", productIds: ["shop", "api"], evidence: { read: { taskId: event.taskId, nodeId: "review", findingId: finding.id } } })));
    expect((event.reports as any[])[1].tracking).toEqual({ taskId: "follow-up" });
  });

  for (const severity of ["suggestion", "pre-existing"] as const) it(`keeps all ${severity} reports open without implying Important work remains`, () => {
    const reports = [report("one", severity), report("two", severity), report("three", severity)];
    const event = reviewEvent([], reports);
    expect(event.reportCounts).toMatchObject({ closing: { total: 3, open: { total: 3, important: 0, nits: severity === "suggestion" ? 3 : 0, preExisting: severity === "pre-existing" ? 3 : 0 } } });
    expect(event.stillOpen).toEqual([]);
    expect(event.raised).toEqual(["one", "two", "three"]);
    expect(event.summary).toContain("3 open reports (0 Important");
  });

  it("includes settled reports in the total and separates status totals from overlapping review changes", () => {
    const opening = [report("important", "blocking"), report("nit", "suggestion"), report("fixed", "blocking", "fixed")];
    const closing = [...opening, report("old", "pre-existing"), report("dismissed", "blocking", "dismissed"), report("uncertain", "blocking", "unverified")];
    const event = reviewEvent(opening, closing);
    expect(event).toMatchObject({ opening: 3, closing: 6, raised: ["old", "dismissed", "uncertain"], openImportant: ["important"], openNits: ["nit"], openPreExisting: ["old"], reportCounts: { opening: { total: 3, fixed: 1 }, closing: { total: 6, open: { total: 3, important: 1, nits: 1, preExisting: 1 }, fixed: 1, dismissed: 1, unverified: 1 } } });
    expect(event.fixed).toEqual([]); // Already fixed before the review, with no new claim.
    expect(event.dismissed).toEqual(["dismissed"]); // Also raised: these are not an equation.
    expect(event.unverified).toEqual(["uncertain"]);
    expect(event.summary).toContain("1 Important");
  });

  it("uses singular report wording and keeps reproduced nits outside the Important-only list", () => {
    const before = { ...report("nit", "suggestion", "fixed"), answer: { fixed: true, text: "Fixed", at: 5 } };
    const after = { ...before, status: "open" as const, reopenedAt: 15, evidence: "Still happens" };
    const event = reviewEvent([before], [after]);
    expect(event.summary).toContain("1 report before, 1 after; 1 open report (0 Important, 1 nit");
    expect(event).toMatchObject({ claimedFixed: ["nit"], reopened: [{ id: "nit", evidence: true }], stillOpen: [], openImportant: [], openNits: ["nit"] });
  });

  for (const shared of [false, true]) it(`uses the existing product assignment rule in ${shared ? "shared" : "single-product"} report entries`, () => {
    const reports = [
      { ...report("missing", "blocking"), productIds: undefined },
      { ...report("empty", "blocking"), productIds: [] },
      { ...report("named", "blocking"), productIds: ["shop"] },
      { ...report("invalid", "blocking"), productIds: ["shop", "unknown"] },
    ];
    const event = reviewEvent([], reports, shared);
    expect((event.reports as any[]).map((entry) => entry.productIds)).toEqual(shared ? [[], [], ["shop"], []] : [["shop"], ["shop"], ["shop"], ["shop"]]);
    expect(reports[0]!.productIds).toBeUndefined();
  });

});
