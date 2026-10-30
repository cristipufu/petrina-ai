import { expect, it, vi } from "vitest";
import { reviewBaseUpdates } from "../../../src/review-conversations.js";
import { reviewConversationsFixture } from "../../fixtures/review-conversations.js";
import { deferred } from "../../fixtures/tool-checks.js";

for (const single of [false, true]) it(`returns ${single ? "one reviewer" : "each parallel reviewer"} to only its own completed conversation across fix rounds`, async () => {
  const f = reviewConversationsFixture(single);
  try {
    for (const seat of f.seats()) {
      expect(f.prior(seat)).toBeUndefined();
      expect(f.choose(seat).freshReason).toBeUndefined();
      f.record(seat);
    }
    const saved = structuredClone(f.task.reviewSessions!.review!);
    f.round(2);
    for (const seat of f.seats()) {
      const choice = f.choose(seat);
      expect(choice.profile.id).toBe(saved[seat]!.profileId);
      expect(choice.freshReason).toBeUndefined();
      f.observeReturn(seat);
      const turn = f.participant(seat), returning = await turn.resume(choice.profile, f.role);
      expect(returning).toEqual({ ...saved[seat], reselect: true, continuedSections: [] });
      turn.started();
      expect(f.task.reviewSessions!.review![seat]).toBeUndefined();
      for (const peer of f.seats().filter(peer => Number(peer) > Number(seat))) expect(f.task.reviewSessions!.review![peer]).toEqual(saved[peer]);
      turn.completed(f.note(seat, choice.profile), choice.profile, f.role);
      expect(f.task.reviewSessions!.review![seat]!.round).toBe(2);
    }
    expect(new Set(Object.values(saved).map(prior => prior.sessionId)).size).toBe(single ? 1 : 2);
    expect(f.task.reviewFreshReasons).toBeUndefined(); expect(f.remaining()).toBe(0);
    expect(f.checkpoints).toHaveLength(f.seats().length * 3);
  } finally { await f.close(); }
});

for (const shared of [false, true]) it(`continues own reviewers after a forward base change${shared ? " in one shared product" : ""} with exact current and incremental context`, async () => {
  const f = reviewConversationsFixture(false, shared);
  try {
    for (const seat of f.seats()) f.record(seat);
    const saved = structuredClone(f.task.reviewSessions!.review!);
    f.round(2); const before = f.scope.work.baseSha!, base = "supplied:advanced-base", head = f.task.hunt!.input!.heads.shop!;
    f.scope.work.baseSha = base; f.scope.work.reviewedSha = "supplied:last-review";
    for (const seat of f.seats()) {
      f.observeReturn(seat);
      const choice = f.choose(seat), returning = await f.participant(seat).resume(choice.profile, f.role);
      expect(returning!.sessionId).toBe(saved[seat]!.sessionId);
      expect(returning!.continuedSections).toHaveLength(1);
      const section = returning!.continuedSections[0]!;
      expect(section.title).toBe("The review base advanced since your last review");
      for (const value of [before, base, head, "Main gained 1 commit.", "without an engine conflict port", "overlap.txt", "read their current versions again", "Main's incoming changes are not in the incremental comparison", "complete prepared comparison", "including beyond the files listed above"]) expect(section.body).toContain(value);
      expect(section.body.match(/^### /gm)).toHaveLength(1); expect(section.body).toContain("(shop)");
      expect(section.body).not.toContain("main-only.txt"); expect(section.body).not.toContain("task-only.txt");
      if (shared) expect(f.scopes()[1]!.work.baseSha).toBe(saved[seat]!.bases!.api);
    }
    expect(f.task.reviewSessions!.review).toEqual(saved);
    expect(f.task.reviewFreshReasons).toBeUndefined(); expect(f.remaining()).toBe(0);
  } finally { await f.close(); }
});

for (const single of [false, true]) it(`drops ${single ? "one completed reviewer" : "both completed reviewers"} after a conflict and consumes each next-start reason separately`, async () => {
  const f = reviewConversationsFixture(single);
  try {
    for (const seat of f.seats()) f.record(seat);
    await f.begin();
    const why = "main conflicted with the change, so the Builder had to port it";
    expect(f.task.reviewSessions).toBeUndefined();
    expect(f.task.reviewFreshReasons).toEqual({ review: Object.fromEntries(f.seats().map(seat => [seat, why])) });
    expect(f.notes).toContain("Reviewer conversations will start fresh because the Builder must port the change after conflicts");
    // Actual Builder/source-completion/admission owners finish the port before review selection.
    await f.drive();
    expect(f.builders).toHaveLength(1); expect(f.reached).toEqual([1]);
    expect(f.scope.work.updating).toBeUndefined();
    for (const seat of f.seats()) {
      const choice = f.choose(seat), turn = f.participant(seat);
      expect(choice.freshReason).toBe(why); expect(choice.reason).toContain(`Started a fresh conversation: ${why}.`);
      expect(await turn.resume(choice.profile, f.role)).toBeUndefined();
      turn.started();
      for (const peer of f.seats().filter(peer => Number(peer) > Number(seat))) expect(f.task.reviewFreshReasons!.review![peer]).toBe(why);
      turn.completed(f.note(seat, choice.profile), choice.profile, f.role);
    }
    expect(f.task.reviewFreshReasons).toBeUndefined(); expect(f.reads).toEqual([]);
    expect(f.remaining()).toBe(0);
  } finally { await f.close(); }
});

it("saves the actual replacement and keeps it when the planned reviewer's usage becomes available", async () => {
  const f = reviewConversationsFixture(true);
  try {
    f.scheduler.state.pool.limited = [{ toolId: "claude-code", until: f.scheduler.clock.now() + 60_000, reason: "Supplied account limit" }];
    const first = f.record("0"); expect(first.choice.profile.id).not.toBe("opus-high");
    f.scheduler.state.pool.limited = []; f.round(2);
    const choice = f.choose("0"); expect(choice.profile.id).toBe(first.choice.profile.id);
    f.observeReturn("0");
    expect((await f.participant("0").resume(choice.profile, f.role))!.sessionId).toBe(first.completed.sessionId);
    expect(f.remaining()).toBe(0);
  } finally { await f.close(); }
});

for (const changed of ["absent context", "profile", "source", "bases", "incomplete bases"] as const) it(`reselects only affected review seats after ${changed} changes while main advances`, async () => {
  const f = reviewConversationsFixture();
  try {
    f.scope.work.source = { product: { id: "shop", name: "Shop", repo: "local/shop" },
      start: { kind: "default", branch: "main" }, destination: { kind: "branch", mode: "local", repo: "local/shop", branch: "main" },
      initialSha: "supplied:approved-source", confirmed: true };
    for (const seat of f.seats()) f.record(seat);
    f.round(2); f.scope.work.baseSha = "supplied:advanced-base";
    const prior = f.task.reviewSessions!.review!["0"]!;
    if (changed === "absent context") {
      delete prior.context;
      f.contexts.push({ context: undefined, intact: false });
    } else if (changed === "profile") f.stage.profileIds[0] = "opus-xhigh";
    else if (changed === "source") f.scope.work.source.initialSha = "supplied:changed-approved-source";
    else if (changed === "bases") delete prior.bases;
    else {
      prior.bases = {};
      f.contexts.push({ context: prior.context, intact: true });
    }
    const reason = changed === "absent context" ? "its saved context is unavailable"
      : changed === "bases" || changed === "incomplete bases" ? "its saved repository bases are unavailable"
      : changed === "profile" ? "you changed who works on this seat" : "its role, profile, request or starting point changed";
    const first = await f.returnSeat("0");
    expect(first.returning).toBeUndefined();
    expect(first.selected.freshReason).toBe(reason);
    expect(first.selected.selectionReason).toContain(reason);
    expect(first.profile.id).toBe(changed === "profile" ? "opus-xhigh" : "opus-high");
    expect(f.attempts).toHaveLength(changed === "absent context" || changed === "bases" || changed === "incomplete bases" ? 2 : 1);
    expect(f.discarded).toEqual(changed === "absent context" || changed === "bases" || changed === "incomplete bases" ? [{ seat: "0", reason }] : []);
    // No provider or native input is fabricated: this is the actual recovery owner's requested return.
    if (changed !== "source") f.observeReturn("1");
    const peer = await f.returnSeat("1");
    expect(peer.selected.freshReason).toBe(changed === "source" ? reason : undefined);
    if (changed === "source") expect(peer.returning).toBeUndefined();
    else {
      expect(peer.returning!.sessionId).toBe(f.task.reviewSessions!.review!["1"]!.sessionId);
      expect(peer.returning!.continuedSections.map(section => section.title)).toEqual(["The review base advanced since your last review"]);
    }
    // Full fresh prompt wording/recording and physical packet absence remain in the paired native anchor.
    expect(f.task.description).toBe("ORIGINAL-REVIEW-REQUEST");
    expect(f.task.brief!.summary).toBe("ORIGINAL-DESIGN-BRIEF");
    f.participant("0").started();
    expect(f.task.reviewSessions!.review!["0"]).toBeUndefined();
    expect(f.remaining()).toBe(0);
  } finally { await f.close(); }
});

for (const failure of ["packet", "bases", "ancestry", "count"] as const) it(`refuses a saved return on unavailable ${failure} evidence without consuming its completed seat`, async () => {
  const f = reviewConversationsFixture(true);
  try {
    f.record("0"); f.round(2); const saved = f.task.reviewSessions!.review!["0"]!;
    if (failure === "bases") delete saved.bases;
    if (failure === "ancestry" || failure === "count") f.scope.work.baseSha = "supplied:advanced-base";
    const expected = failure === "packet" ? "its saved context is unavailable" : failure === "bases" ? "its saved repository bases are unavailable"
      : failure === "ancestry" ? "its starting branch's history was replaced or diverged" : "Could not count the starting branch's incoming commits for review.";
    if (failure !== "bases") f.observeReturn("0", { intact: failure !== "packet", contains: failure !== "ancestry", count: failure === "count" ? "not-a-count" : "1" });
    const before = structuredClone(saved);
    await expect(f.participant("0").resume(f.choose("0").profile, f.role)).rejects.toThrow(expected);
    expect(saved).toEqual(before); expect(f.checkpoints).toHaveLength(1); expect(f.remaining()).toBe(0);
  } finally { await f.close(); }
});

it("settles every base observation before propagating a peer failure", async () => {
  vi.useFakeTimers();
  const f = reviewConversationsFixture(true), held = deferred<readonly string[]>(), failed = new Error("Unavailable changed files");
  const order: string[] = [];
  let observed: Promise<unknown> | undefined;
  try {
    const before = f.scope.work.baseSha!; f.scope.work.baseSha = "supplied:advanced-base";
    const running = reviewBaseUpdates(f.scope, { shop: before }, f.task.hunt!.input!.heads, {
      contains: async () => true,
      changedFiles: async (_scope, from) => { if (from === before) throw failed; const files = await held.promise; order.push("peer finished"); return files; },
      count: async () => "1",
    });
    observed = running.catch(error => { order.push("failure propagated"); return error; });
    // A private virtual timer releases the outstanding effect after rejection continuations run.
    setTimeout(() => held.resolve([]), 1); await vi.runAllTimersAsync();
    expect(await observed).toBe(failed);
    expect(order).toEqual(["peer finished", "failure propagated"]);
  } finally { held.resolve([]); await observed; vi.useRealTimers(); await f.close(); }
});
