import { expect, it } from "vitest";
import { onScreen, screenOn } from "@petrina/core";
import { savedScreenTurn, screenFixture, screenGroup } from "../../fixtures/screen.js";
import { executionFor } from "../../../src/repository-context.js";

const REASON = "Check that the quick note window opens from the menu bar";
const NEEDS = `Needs the screen for: ${REASON}`;

it("saves the member's own copy and a detached conversation, checkpointing its repository scope", () => {
  const f = screenFixture(1), task = f.task(), scope = executionFor(task);
  const note = savedScreenTurn(task, "first", 12).conversation;
  delete task.hunt!.screenTurns;
  f.state.pool.screen = { mode: "on" };
  let checkpoint: unknown;
  f.host.checkpoint = target => { checkpoint = target; };
  expect(f.controller.saveTurn(scope, "code-reviewer", "first", "first", "opaque:copy", note, REASON)).toBe(true);
  const saved = task.hunt!.screenTurns!.first!;
  expect(saved).toEqual({ reason: REASON, at: f.clock.now(), copy: "opaque:copy", conversation: note });
  expect(saved.conversation).not.toBe(note); expect(scope.work.conversation).toBe(saved.conversation);
  note.sessionId = "mutated-after-save";
  expect(saved.conversation.sessionId).toBe("session-first"); expect(checkpoint).toBe(scope);
  expect(task.screen).toMatchObject({ member: "first", granted: true });
});

it("does not save a screen turn without a conversation or after its review has disappeared", () => {
  const f = screenFixture(1), task = f.task(), scope = executionFor(task);
  const note = savedScreenTurn(task, "first", 12).conversation;
  delete task.hunt!.screenTurns;
  expect(f.controller.saveTurn(scope, "reviewer", "first", "first", "copy", undefined, REASON)).toBe(false);
  expect(task.hunt!.screenTurns).toBeUndefined();
  delete task.hunt;
  expect(f.controller.saveTurn(scope, "reviewer", "first", "first", "copy", note, REASON)).toBe(false);
  expect(task.screen).toBeUndefined(); expect(f.checkpoints).toEqual([]);
});

it("constructs without reading a state the host may not have loaded yet", () => {
  const f = screenFixture(); expect(f.reads()).toBe(0);
  f.controller.syncScreen(); expect(f.reads()).toBeGreaterThan(0);
});

it("waits without a slot and publishes exactly one quiet, fully attributed permission request", () => {
  const f = screenFixture(1), task = f.task(); f.column.value = "reviewing";
  expect(f.controller.askScreen(task, "builder", "profile", REASON)).toBe(false);
  expect(task.state).toBe("waiting"); expect(task.holdsSlot).toBe(false); expect(task.agent).toBeUndefined();
  expect(task.column).toBe("reviewing"); expect(f.columns).toEqual([task.id]); expect(task.statusLine).toBe(NEEDS);
  expect(task.screen).toEqual({ reason: REASON, roleId: "builder", profileId: "profile", at: 100 });
  expect(f.screenItems()).toEqual([expect.objectContaining({ id: "screen-1", taskId: task.id, kind: "screen", blocking: false, title: NEEDS, roleId: "builder", profileId: "profile" })]);
  f.controller.syncScreen(); expect(f.screenItems()).toHaveLength(1);
  expect(f.checkpoints).toHaveLength(1); expect(f.checkpoints[0]!.tasks[0]!.state).toBe("waiting");
  expect(f.records).toEqual([{ taskId: task.id, tone: "status", text: `Asked for the screen: ${REASON}`, roleId: "builder", profileId: "profile" }]);
});

it("grants the free allowed screen live without releasing the current seat or creating an Inbox item", () => {
  const f = screenFixture(1), task = f.task(); f.controller.setScreenUse("on");
  expect(f.controller.askScreen(task, "builder", "profile", REASON)).toBe(true);
  expect(task.state).toBe("running"); expect(task.holdsSlot).toBe(true); expect(task.agent).toBeDefined();
  expect(task.screen?.granted).toBe(true); expect(f.state.inbox).toEqual([]); expect(f.checkpoints).toEqual([]);
  expect(f.records.at(-1)).toMatchObject({ tone: "milestone", text: `Using the screen for: ${REASON}` });
  const recorded = f.records.length, scheduled = f.scheduled(); f.controller.allowScreen(task.id);
  expect(f.records).toHaveLength(recorded); expect(f.scheduled()).toBe(scheduled);
});

it("does not let a new request jump an earlier allowed waiter, while an unallowed waiter does not block it", () => {
  const f = screenFixture(3), first = f.task(), second = f.task(1), newest = f.task(2);
  f.controller.askScreen(first, "builder", "profile", REASON); f.clock.advance(10);
  f.controller.setTaskScreen(second.id, true);
  expect(f.controller.askScreen(second, "builder", "profile", REASON)).toBe(true);
  f.controller.allowScreen(first.id); expect(first.statusLine).toBe("Waiting its turn on the screen");
  f.controller.releaseScreen(second); f.controller.setTaskScreen(newest.id, true);
  expect(f.controller.askScreen(newest, "builder", "profile", REASON)).toBe(false);
  expect(first.statusLine).toBe("Waiting for a free slot"); expect(newest.statusLine).toBe("Waiting its turn on the screen");
});

it("distinguishes permission for one request from a persistent task allowance", () => {
  const f = screenFixture(1), task = f.task();
  f.controller.askScreen(task, "builder", "profile", REASON); f.controller.allowScreen(task.id);
  expect(task.screen?.allowed).toBe(true); expect(task.screenAllowed).toBeUndefined(); expect(f.screenItems()).toEqual([]);
  const before = f.scheduled(); f.controller.allowScreen(task.id); f.controller.allowScreen("missing"); expect(f.scheduled()).toBe(before);
  f.controller.releaseScreen(task);
  expect(f.controller.askScreen(task, "builder", "profile", REASON)).toBe(false);
  f.controller.setTaskScreen(task.id, true); f.controller.releaseScreen(task);
  expect(f.controller.askScreen(task, "builder", "profile", REASON)).toBe(true);
  f.controller.releaseScreen(task); expect(f.controller.askScreen(task, "builder", "profile", REASON)).toBe(true);
  f.controller.setTaskScreen(task.id, false); expect(task.screen?.granted).toBe(true);
  f.controller.releaseScreen(task); expect(f.controller.askScreen(task, "builder", "profile", REASON)).toBe(false);
});

it.each(["done", "cancelled"] as const)("does not change an allowance for a %s task", state => {
  const f = screenFixture(1); f.task().state = state;
  f.controller.setTaskScreen(f.task().id, true); f.controller.setTaskScreen("missing", true);
  expect(f.task().screenAllowed).toBeUndefined(); expect(f.records).toEqual([]); expect(f.scheduled()).toBe(0);
});

it("turning Off preserves the live holder and asks for permission before any other task starts", () => {
  const f = screenFixture(); f.controller.setScreenUse("on");
  f.controller.askScreen(f.task(), "builder", "profile", REASON);
  f.controller.askScreen(f.task(1), "builder", "profile", REASON);
  f.controller.setScreenUse("off");
  expect(f.task().screen?.granted).toBe(true); expect(f.task(1).screen?.granted).not.toBe(true);
  expect(f.task(1).statusLine).toBe(NEEDS); expect(f.screenItems().map(item => item.taskId)).toEqual([f.task(1).id]);
});

it("is Off again once For an hour runs out, without anyone touching it", () => {
  const f = screenFixture(); f.controller.setScreenUse("on");
  const first = f.task(), other = f.task(1);
  f.controller.askScreen(first, "builder", "profile", REASON); f.controller.askScreen(other, "builder", "profile", REASON);
  f.controller.setScreenUse("hour", 800);
  expect(f.state.pool.screen).toEqual({ mode: "hour", until: 900 });
  expect(f.state.pool.screen!.until! - f.clock.now()).toBe(800);
  expect(other.statusLine).toBe("Waiting its turn on the screen");
  f.clock.advance(819); expect(f.state.pool.screen?.mode).toBe("hour");
  f.clock.advance(1); expect(f.state.pool.screen?.mode).toBe("off");
  expect(other.statusLine).toBe(NEEDS); expect(f.screenItems().map(item => item.taskId)).toEqual([other.id]);
  expect(onScreen(f.state.tasks)?.screen?.granted).toBe(true);
  f.controller.releaseScreen(first); f.clock.advance(600);
  expect(other.state).toBe("waiting"); expect(other.screen?.granted).not.toBe(true); expect(screenOn(f.state.pool, f.clock.now())).toBe(false);
});

it("replaces the hour deadline and cancels it on Off or stop without leaving future callbacks", () => {
  const f = screenFixture(1); f.controller.setScreenUse("hour", 800); f.clock.advance(400);
  f.controller.setScreenUse("hour", 800); expect(f.clock.pending.size).toBe(1);
  f.clock.advance(420); expect(f.state.pool.screen?.mode).toBe("hour");
  f.controller.setScreenUse("off"); expect(f.clock.pending.size).toBe(0);
  f.controller.setScreenUse("hour", 800); f.controller.askScreen(f.task(), "builder", "profile", REASON);
  f.controller.releaseScreen(f.task()); expect(f.clock.pending.size).toBe(2);
  f.controller.stop(); expect(f.clock.pending.size).toBe(0);
  const before = f.scheduled(); f.clock.advance(10_000); expect(f.scheduled()).toBe(before);
  f.stopHost(); f.controller.armScreenTimer(); expect(f.clock.pending.size).toBe(0);
});

it("uses an hour by default and leaves modes without an expiry unarmed", () => {
  const f = screenFixture(1); f.controller.setScreenUse("hour");
  expect(f.state.pool.screen!.until! - f.clock.now()).toBe(3_600_000);
  f.state.pool.screen = { mode: "hour" }; f.controller.armScreenTimer(); expect(f.clock.pending.size).toBe(0);
  f.controller.setScreenUse("on"); expect(f.clock.pending.size).toBe(0);
});

it("does not schedule through a stopped host even if already queued callbacks reach delivery", () => {
  const f = screenFixture(1); f.controller.setScreenUse("hour", 800);
  f.controller.askScreen(f.task(), "builder", "profile", REASON); f.controller.releaseScreen(f.task());
  expect(f.clock.pending.size).toBe(2); f.stopHost();
  const before = f.scheduled(); f.clock.advance(1_000);
  expect(f.scheduled()).toBe(before); expect(f.clock.pending.size).toBe(0);
});

it("an earlier shutdown cancels a later screen deadline even when both become due in one advance", () => {
  const f = screenFixture(1); f.controller.setScreenUse("hour", 800);
  f.clock.after(0, () => { f.stopHost(); f.controller.stop(); });
  const before = f.scheduled(); f.clock.advance(1_000);
  expect(f.scheduled()).toBe(before); expect(f.clock.pending.size).toBe(0);
});

it("coalesces screen-release scheduling until after the current operation and preserves unrelated Inbox items", () => {
  const f = screenFixture(); f.controller.setScreenUse("on");
  f.state.inbox.push({ id: "question", taskId: f.task().id, kind: "question", title: "Keep this", at: 100, blocking: true });
  const before = f.scheduled();
  for (const task of f.state.tasks) { f.controller.askScreen(task, "builder", "profile", REASON); f.controller.releaseScreen(task); }
  expect(f.clock.pending.size).toBe(1); expect(f.scheduled()).toBe(before); expect(f.state.inbox.map(item => item.id)).toEqual(["question"]);
  f.clock.advance(0); expect(f.scheduled()).toBe(before + 1); expect(f.clock.pending.size).toBe(0);
});

it("leaves a waiting member's active peer and group reservation intact until that group yields the member", () => {
  const f = screenFixture(1), task = f.task(), yielded: string[] = [];
  f.controller.groups.set(task.id, screenGroup(new Set(["peer"]), yielded));
  expect(f.controller.askScreen(task, "code-reviewer", "reviewer", REASON, "seat")).toBe(false);
  expect(task.state).toBe("running"); expect(task.holdsSlot).toBe(true); expect(task.agent).toBeDefined(); expect(f.checkpoints).toEqual([]);
  const saved = savedScreenTurn(task, "seat", 100); task.screen!.granted = true; task.screen!.heard = true;
  f.clock.advance(20); f.controller.waitForScreen(task);
  expect(yielded).toEqual(["seat"]); expect(task.state).toBe("running"); expect(task.holdsSlot).toBe(true);
  expect(task.screen).toMatchObject({ granted: false, heard: false, at: 120 }); expect(saved.at).toBe(120); expect(f.checkpoints).toHaveLength(1);
});

it.each([
  { name: "no active session", owned: false, group: undefined, driving: false, keeps: false },
  { name: "closing driver", owned: true, group: undefined, driving: false, keeps: true },
  { name: "active member", owned: false, group: true, driving: false, keeps: true },
  { name: "inactive member beside a live peer", owned: true, group: false, driving: false, keeps: false },
  { name: "terminal takeover", owned: false, group: false, driving: true, keeps: true },
])("a prerequisite-held grant follows its actual owner: $name", entry => {
  const f = screenFixture(1), task = f.task(); f.controller.setScreenUse("on");
  f.controller.askScreen(task, "builder", "profile", REASON); task.screen!.member = "seat";
  task.runtimeWait = { after: ["prerequisite"], reason: "Wait", changes: [] }; task.state = "waiting";
  if (entry.owned) f.owned.add(task.id);
  if (entry.group !== undefined) f.controller.groups.set(task.id, screenGroup(new Set(entry.group ? ["seat"] : ["peer"])));
  if (entry.driving) task.driving = { since: 100, roleId: "builder", profileId: "profile", toolId: "codex", head: "commit" };
  f.controller.syncScreen(); expect(task.screen?.granted).toBe(entry.keeps); expect(task.statusLine).toBe("Waiting for the prerequisite to land");
});

it("keeps held permission answerable while excluding the task from screen admission", () => {
  const f = screenFixture(), task = f.task(); task.runtimeWait = { after: ["prerequisite"], reason: "Wait", changes: [] };
  f.controller.askScreen(task, "builder", "profile", REASON);
  expect(f.screenItems().map(item => item.taskId)).toEqual([task.id]); expect(task.statusLine).toBe("Waiting for the prerequisite to land");
  f.controller.setTaskScreen(f.task(1).id, true);
  expect(f.controller.askScreen(f.task(1), "builder", "profile", REASON)).toBe(true);
  f.controller.allowScreen(task.id); expect(task.screen?.allowed).toBe(true); expect(task.screen?.granted).not.toBe(true); expect(f.screenItems()).toEqual([]);
});

it("chooses an allowed saved member before an unallowed peer, excluding already running members", () => {
  const f = screenFixture(1), task = f.task(); task.state = "waiting";
  const earlier = savedScreenTurn(task, "earlier", 100), allowed = savedScreenTurn(task, "allowed", 110, true);
  task.screen = { member: "earlier", reason: earlier.reason, at: 100, roleId: "code-reviewer", profileId: "earlier" };
  f.controller.selectScreen(task); expect(task.screen?.member).toBe("allowed"); expect(task.repository!.conversation).toBe(allowed.conversation);
  task.screen!.granted = false; delete task.screen!.allowed;
  f.controller.groups.set(task.id, screenGroup(new Set(["allowed"])));
  f.controller.selectScreen(task); expect(task.screen?.member).toBe("earlier"); expect(task.repository!.conversation).toBe(earlier.conversation);
});

it("persists Allow now on the saved request and binds the chosen conversation only to the active repository", () => {
  const f = screenFixture(1), task = f.task(); task.state = "waiting";
  task.repositories = [{ productId: "p", delivery: "local", completedStages: [] }, { productId: "companion", delivery: "local", completedStages: [] }]; task.activeProductId = "companion";
  const earlier = savedScreenTurn(task, "earlier", 100), current = savedScreenTurn(task, "current", 110);
  task.screen = { member: "current", reason: current.reason, at: 110, roleId: "code-reviewer", profileId: "current", allowed: true };
  f.controller.selectScreen(task); expect(current.allowed).toBe(true); expect(task.screen.member).toBe("current");
  f.controller.setScreenUse("on"); expect(task.screen.member).toBe("earlier");
  expect(task.repositories[1]!.conversation).toBe(earlier.conversation); expect(task.repositories[0]!.conversation).toBeUndefined(); expect(task.activeProductId).toBe("companion");
});

it("propagates checkpoint failures instead of treating an unpersisted wait as a successful operation", () => {
  const f = screenFixture(1), failure = new Error("The checkpoint failed"); f.host.checkpoint = () => { throw failure; };
  expect(() => f.controller.askScreen(f.task(), "builder", "profile", REASON)).toThrow(failure);
  expect(f.task().state).toBe("waiting"); expect(f.screenItems()).toHaveLength(1);
});
