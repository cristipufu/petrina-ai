// @vitest-environment node
import { oneTaskFixture } from "../../fixtures/state";
import { afterEach, expect, it, vi } from "vitest";
import { type Task } from "@petrina/core";
import { lookup } from "../../../src/lib";
import { taskActions } from "../../../src/paletteActions";
import { taskCommands } from "../../../src/taskCommands";

const commands = vi.hoisted(() => ({ pause: vi.fn(), resume: vi.fn(), setHeld: vi.fn(), usage: vi.fn(async () => undefined) }));

vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: commands, useEngineStatus: () => ({ link: "live" }), useUnsent: () => [] }));

vi.mock("../../../src/keyboard", () => ({ mod: "Ctrl+", setSingleKeys() {} }));
afterEach(() => vi.clearAllMocks());

const initial = oneTaskFixture(1_000_000_000);

it("blocks the pause shortcut while driving and offers only applicable palette actions", async () => {
  const task: Task = { ...initial.tasks[0]!, state: "needs-you", driving: { since: initial.now, roleId: "builder", profileId: "opus-high", toolId: "claude-code", head: "abc" } };
  const toast = vi.fn(); const current = { ...initial, tasks: [task] };
  const actions = taskCommands({ state: current, find: lookup(current), live: () => true, visible: () => true, toast });
  actions.pause(task); await Promise.resolve();
  expect(commands.pause).not.toHaveBeenCalled(); expect(toast).toHaveBeenCalledOnce(); expect(toast.mock.calls[0]![0]).toBe("Hand back first");
  const menu = (task: Task) => taskActions({ task, state: current, sheetOpen: true, open: vi.fn(), message: vi.fn(), focusMessage: vi.fn(), pause: actions.pause, visible: () => true, sendAction: actions.sendAction });
  expect(menu(task).some(action => action.id.startsWith("pause-task"))).toBe(false);
  for (const state of ["backlog", "failed", "pr-open", "done", "cancelled"] as const) {
    const list = menu({ ...task, state, driving: undefined });
    expect(list.some(action => action.id.startsWith("pause-task"))).toBe(false);
    expect(list.some(action => action.id.startsWith("message-task"))).toBe(!["done", "cancelled"].includes(state));
  }
  for (const state of ["queued", "paused", "running", "needs-you", "waiting"] as const) expect(menu({ ...task, state, driving: undefined }).some(action => action.id.startsWith("pause-task"))).toBe(true);
});
