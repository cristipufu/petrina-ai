import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createDemoState, historyItem, reviewStats, type State, type Task } from "@petrina/core";
import { AgentsPage } from "../src/components/Pages";
import { Board } from "../src/components/Board";
import { PoolPanel } from "../src/components/Pool";
import { lookup } from "../src/lib";
import { taskActions } from "../src/paletteActions";
import { taskCommands } from "../src/taskCommands";

const commands = vi.hoisted(() => ({ pause: vi.fn(), resume: vi.fn(), setHeld: vi.fn(), usage: vi.fn(async () => undefined) }));
vi.mock("../src/engine", () => ({ mode: "demo", desktop: false, sim: commands, useEngineStatus: () => ({ link: "live" }), useUnsent: () => [] }));
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; vi.clearAllMocks(); });
async function render(node: React.ReactNode) { if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); } await act(async () => root!.render(node)); }
const initial = createDemoState(1_000_000_000);

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

it("keeps identical reviewer profiles in separate tiles with their own durations and waiting status", async () => {
  const since = (minutes: number) => initial.now - minutes * 60_000;
  const task: Task = { ...initial.tasks[0]!, state: "needs-you", holdsSlot: true, driving: undefined,
    agent: { roleId: "code-reviewer", profileId: "opus-high", since: since(1), step: 0, reviewKey: "first" },
    helpers: [{ roleId: "code-reviewer", profileId: "opus-high", since: since(5), step: 0, reviewKey: "second" }, { roleId: "code-reviewer", profileId: "opus-high", since: since(9), step: 0, reviewKey: "third" }],
    hunt: { stageId: "review", round: 1, reported: {}, work: { first: { attempts: 1, waiting: "Waiting for permission" }, second: { attempts: 1, todo: "Checking recovery" }, third: { attempts: 1, todo: "Checking nearby behavior" } } } };
  const state = { ...initial, tasks: [task], inbox: [], pool: { ...initial.pool, limit: 3 } };
  const errors = vi.spyOn(console, "error");
  try {
    await render(<AgentsPage state={state} find={lookup(state)} onOpen={() => {}} />);
    const tiles = [...host.querySelector('.page > .grid')!.querySelectorAll(':scope > .tile')];
    expect(tiles).toHaveLength(3);
    expect(tiles.map(tile => tile.querySelector('.foot .num')!.textContent)).toEqual(["1m", "5m", "9m"]);
    expect(tiles.map(tile => tile.classList.contains("waiting"))).toEqual([true, false, false]);
    expect(tiles.map(tile => tile.querySelector('.card-status')!.textContent)).toEqual(["Waiting for permission", "Checking recovery", "Checking nearby behavior"]);
    await render(<PoolPanel state={state} find={lookup(state)} onOpen={() => {}} onDone={() => {}} onAnalytics={() => {}} />);
    expect(host.querySelectorAll('.slot-row')).toHaveLength(3); expect(host.querySelectorAll('.slot-row .needs-you')).toHaveLength(1);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
  } finally { errors.mockRestore(); }
});

it("uses the same dependency eligibility for Board badges and free Agents and Pool slots", async () => {
  const dependency: Task = { ...initial.tasks[0]!, id: "dependency", state: "cancelled", holdsSlot: false };
  const blocked: Task = { ...initial.tasks[0]!, id: "blocked", title: "Blocked request", state: "queued", column: "queue", holdsSlot: false, held: false, priority: 0, after: [dependency.id], statusLine: "Waiting for another product to land" };
  const ready: Task = { ...blocked, id: "ready", title: "Ready request", priority: 1, after: [] };
  const state: State = { ...initial, tasks: [blocked, ready], inbox: [], pool: { ...initial.pool, limit: 2, paused: false }, history: { revision: 1, total: 1, products: [], reviews: reviewStats([]), reviewsByProduct: {}, steps: [], dependencies: [{ ...historyItem(dependency), blocksDependents: true }] } };
  const find = lookup(state);
  await render(<Board state={state} find={find} visible={() => true} selectedId={undefined} onOpen={() => {}} onFocus={() => {}} drafts={{}} onPlace={() => {}} onNewTask={() => {}} onShowInbox={() => {}} />);
  expect(host.querySelector('[data-task-id="blocked"] .next-up')).toBeNull();
  expect(host.querySelector('[data-task-id="blocked"] .card-status')!.textContent).toContain("Waiting for another product to land");
  expect(host.querySelector('[data-task-id="ready"] .next-up')).not.toBeNull();
  await render(<AgentsPage state={state} find={find} onOpen={() => {}} />);
  expect(host.textContent).toContain("Next up: Ready request"); expect(host.textContent).not.toContain("Next up: Blocked request");
  await render(<PoolPanel state={state} find={find} onOpen={() => {}} onDone={() => {}} onAnalytics={() => {}} />);
  expect(host.textContent).toContain("next up: Ready request"); expect(host.textContent).not.toContain("next up: Blocked request");
});
