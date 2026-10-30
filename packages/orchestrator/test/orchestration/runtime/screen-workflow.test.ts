import { expect, it } from "vitest";
import { onScreen, screenOn, slotUses } from "@petrina/core";
import { screenWorkflowFixture } from "../../fixtures/screen-workflow.js";

it("admits only one screen user and gives the next task its turn without leaving stale waiting words", async () => {
  const f = screenWorkflowFixture(), first = f.gate(), second = f.gate(), entered: string[] = [];
  let most = 0, stale = false;
  const unsubscribe = f.subscribe(() => {
    most = Math.max(most, f.state.tasks.filter(task => task.screen?.granted).length);
    stale ||= !onScreen(f.state.tasks) && f.state.tasks.some(task => task.statusLine === "Waiting its turn on the screen");
  });
  try {
    f.screen.setScreenUse("on");
    f.startMain(f.current, async signal => { entered.push(f.current.id); await f.wait(first, signal); });
    await f.waitFor(() => entered.length === 1, "first screen effect");
    f.clock.advance(1);
    f.startMain(f.later, async signal => { entered.push(f.later.id); await f.wait(second, signal); });
    await f.waitFor(() => f.later.screen && !f.later.holdsSlot, "second request to yield its seat");
    expect(f.current.holdsSlot).toBe(true);
    expect(f.later.statusLine).toBe("Waiting its turn on the screen");
    expect(f.state.inbox.filter(item => item.kind === "screen")).toEqual([]);
    expect(entered).toEqual([f.current.id]);
    expect(f.state.tasks.filter(task => task.screen?.granted)).toEqual([f.current]);
    first.resolve();
    await f.waitFor(() => entered.length === 2, "second screen effect");
    expect(f.state.tasks.filter(task => task.screen?.granted)).toEqual([f.later]);
    expect(f.current.screen).toBeUndefined();
    expect(f.later.statusLine).not.toBe("Waiting its turn on the screen");
    second.resolve();
    await f.waitFor(() => !f.later.screen, "last screen request to finish");
    expect(f.state.tasks.some(task => task.statusLine === "Waiting its turn on the screen")).toBe(false);
    expect(most).toBe(1); expect(stale).toBe(false);
  } finally { unsubscribe(); await f.close(); }
});

it("allows one task while Off and keeps other tasks waiting for their own permission", async () => {
  const f = screenWorkflowFixture(), first = f.gate(), second = f.gate(), entered: string[] = [];
  try {
    f.screen.setScreenUse("off");
    f.screen.setTaskScreen(f.current.id, true);
    f.startMain(f.current, async signal => { entered.push(f.current.id); await f.wait(first, signal); });
    f.startMain(f.later, async signal => { entered.push(f.later.id); await f.wait(second, signal); });
    await f.waitFor(() => entered.length === 1 && f.state.inbox.some(item => item.kind === "screen"), "task allowance beside an unallowed request");
    expect(entered).toEqual([f.current.id]); expect(screenOn(f.state.pool, f.clock.now())).toBe(false);
    expect(f.state.inbox.filter(item => item.kind === "screen").map(item => item.taskId)).toEqual([f.later.id]);
    expect(f.records.filter(record => record.taskId === f.current.id).map(record => record.text)).toEqual(expect.arrayContaining(["You allowed the screen for this task", `Using the screen for: Inspect ${f.current.id}`]));
    expect(f.later.statusLine).toBe(`Needs the screen for: Inspect ${f.later.id}`);
    first.resolve(); await f.waitFor(() => !f.current.screen, "allowed task result");
    f.screen.setTaskScreen(f.current.id, false); expect(f.current.screenAllowed).toBeUndefined();
    f.screen.setTaskScreen(f.later.id, true);
    await f.waitFor(() => entered.length === 2, "second task allowance");
    second.resolve(); await f.waitFor(() => !f.later.screen, "second task result");
    expect(f.state.inbox.filter(item => item.kind === "screen")).toEqual([]);
  } finally { await f.close(); }
});

it("switching Off preserves the current screen effect and holds the next until Allow now", async () => {
  const f = screenWorkflowFixture(), first = f.gate(), second = f.gate(), entered: string[] = [];
  try {
    f.screen.setScreenUse("on");
    f.startMain(f.current, async signal => { entered.push(f.current.id); await f.wait(first, signal); });
    await f.waitFor(() => entered.length === 1, "live holder");
    f.startMain(f.later, async signal => { entered.push(f.later.id); await f.wait(second, signal); });
    await f.waitFor(() => f.later.screen && !f.later.holdsSlot, "next waiting request");
    f.screen.setScreenUse("off");
    expect(f.current.screen?.granted).toBe(true); expect(f.current.state).toBe("running");
    expect(f.later.statusLine).toBe(`Needs the screen for: Inspect ${f.later.id}`);
    expect(entered).toEqual([f.current.id]);
    expect(f.state.inbox.filter(item => item.kind === "screen").map(item => item.taskId)).toEqual([f.later.id]);
    first.resolve(); await f.waitFor(() => !f.current.screen, "holder result");
    expect(entered).toEqual([f.current.id]); expect(f.later.screen?.granted).not.toBe(true);
    f.screen.allowScreen(f.later.id); await f.waitFor(() => entered.length === 2, "one-time permission");
    expect(f.later.screen?.granted).toBe(true);
  } finally { await f.close(); }
});

it.each(["code-reviewer", "verifier"])("keeps the final %s reservation until ordinary group cleanup settles", async role => {
  const f = screenWorkflowFixture(2, role), cleanup = f.gate(); let cleaning = false;
  try {
    f.workflow.setPoolLimit(1);
    f.cleanups.set(f.current.id, async () => { cleaning = true; await cleanup.promise; });
    f.start(f.current, [f.member(f.current, 0, async () => {}), f.member(f.current, 1, async () => {})]);
    await f.waitFor(() => cleaning, "group cleanup");
    expect(f.current.holdsSlot).toBe(true); expect(slotUses(f.snapshot())).toHaveLength(1);
    f.later.state = "queued"; f.later.held = false; f.workflow.schedule();
    expect(f.later.state).toBe("queued"); expect(f.ownership.drivers.has(f.later.id)).toBe(false);
    f.later.held = true;
    cleanup.resolve(); await f.waitFor(() => f.current.state === "needs-you", "group result after cleanup");
    expect(f.completed).toEqual([`${f.current.id}:review-0`, `${f.current.id}:review-1`]);
  } finally { await f.close(); }
});

it.each([false, true])("keeps an earlier peer ahead of a later task across result I/O (live grant: %s)", async live => {
  const f = screenWorkflowFixture(), result = f.gate(), finish = f.gate(), peer = f.gate(), screenUsers: string[] = []; let saving = false;
  try {
    f.screen.setScreenUse(live ? "on" : "off");
    f.start(f.current, [f.member(f.current, 0, async ({ continuing, ask, signal }) => { if (!continuing) ask(); screenUsers.push("first"); await f.wait(finish, signal); saving = true; await f.wait(result, signal); }),
      f.member(f.current, 1, async ({ continuing, ask, signal }) => { if (!continuing) { f.clock.advance(1); ask(); } screenUsers.push("peer"); await f.wait(peer, signal); })]);
    await f.waitFor(() => Object.keys(f.current.hunt?.screenTurns ?? {}).length === 2, "both peer requests");
    f.screen.setScreenUse("on"); await f.waitFor(() => screenUsers.length === 1, "first screen effect");
    f.clock.advance(1);
    f.startMain(f.later, async signal => { screenUsers.push("later"); await f.wait(peer, signal); });
    await f.waitFor(() => f.later.screen, "later task request");
    expect(f.current.hunt!.screenTurns!["review-1"]!.at).toBeLessThan(f.later.screen!.at);
    finish.resolve(); await f.waitFor(() => saving, "result I/O");
    f.screen.setScreenUse("on");
    expect(f.state.tasks.filter(task => task.screen?.granted).map(task => task.id)).toEqual([f.current.id]);
    expect(screenUsers).toEqual(["first"]);
    result.resolve(); await f.waitFor(() => screenUsers.length === 2, "next screen effect");
    expect(screenUsers).toEqual(["first", "peer"]); expect(f.later.screen?.granted).not.toBe(true);
  } finally { await f.close(); }
});

it.each([false, true])("keeps earlier peers ahead after usage requeues, retaining Allow now (request allowed: %s)", async allowed => {
  const f = screenWorkflowFixture(), peer = f.gate(), hold = f.gate(), users: string[] = []; let limited = false;
  try {
    f.screen.setScreenUse("off");
    f.start(f.current, [f.member(f.current, 0, async ({ continuing, ask, signal }) => {
      if (!continuing) ask();
      if (!limited) { limited = true; f.clock.advance(10); f.screen.waitForScreen(f.current); throw f.errors.screenWait(); }
      users.push("holder"); await f.wait(hold, signal);
    }), f.member(f.current, 1, async ({ continuing, ask, signal }) => { if (!continuing) { f.clock.advance(1); ask(); } users.push("peer"); await f.wait(peer, signal); })]);
    await f.waitFor(() => Object.keys(f.current.hunt?.screenTurns ?? {}).length === 2 && !f.ownership.drivers.has(f.current.id), "both saved requests");
    f.clock.advance(1);
    f.startMain(f.later, async signal => { users.push("later"); await f.wait(hold, signal); });
    await f.waitFor(() => f.later.screen, "later request");
    expect(f.current.hunt!.screenTurns!["review-1"]!.at).toBeLessThan(f.later.screen!.at);
    f.workflow.setPoolPaused(true);
    if (allowed) f.screen.allowScreen(f.current.id);
    f.screen.setScreenUse("on"); f.workflow.setPoolPaused(false);
    await f.waitFor(() => users.length > 0, "screen use after usage return");
    expect(limited).toBe(true); expect(users).toEqual(["peer"]); expect(f.current.screen?.granted).toBe(true);
    if (allowed) {
      expect(f.current.hunt!.screenTurns!["review-0"]!.allowed).toBe(true);
      f.screen.setScreenUse("off"); peer.resolve(); await f.waitFor(() => users.length === 2, "retained one-time permission");
      expect(users).toEqual(["peer", "holder"]);
      expect(f.current.screen).toMatchObject({ member: "review-0", allowed: true, granted: true });
      expect(f.later.screen?.granted).not.toBe(true);
    }
  } finally { await f.close(); }
});

it("keeps a peer's unanswered question visible while the other member waits, uses the screen and reports", async () => {
  const f = screenWorkflowFixture(1), answer = f.gate(), screenDone = f.gate(); let using = false;
  try {
    f.screen.setScreenUse("off");
    f.start(f.current, [f.member(f.current, 0, async ({ signal }) => {
      f.state.inbox.push({ id: "question", taskId: f.current.id, kind: "question", title: "Keep the change?", at: f.clock.now(), blocking: true });
      await f.wait(answer, signal);
    }), f.member(f.current, 1, async ({ continuing, ask, signal }) => { if (!continuing) ask(); using = true; await f.wait(screenDone, signal); })]);
    await f.waitFor(() => f.state.inbox.some(item => item.kind === "screen"), "quiet screen request beside question");
    expect(f.current.state).toBe("needs-you");
    f.screen.allowScreen(f.current.id); await f.waitFor(() => using, "other member screen effect");
    expect(f.current.state).toBe("needs-you");
    screenDone.resolve(); await f.waitFor(() => f.completed.length === 1, "screen member report");
    expect(f.current.state).toBe("needs-you"); expect(f.state.inbox.some(item => item.id === "question")).toBe(true);
    f.state.inbox = f.state.inbox.filter(item => item.id !== "question"); answer.resolve();
    await f.waitFor(() => f.completed.length === 2, "peer answer and report");
  } finally { await f.close(); }
});
