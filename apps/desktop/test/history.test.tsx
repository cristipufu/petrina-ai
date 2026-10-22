import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState, reviewStats, Simulator, type HistoryPage, type HistoryQuery, type State, type Task, type UsageRequest, type WorkTurn } from "@petrina/core";
import { App } from "../src/App";

let simulator: Simulator;
let projection: State;
const page = vi.fn((query: HistoryQuery): HistoryPage | Promise<HistoryPage> => simulator.historyPage(query));
const details = vi.fn((id: string) => simulator.taskDetails(id));
const usage = vi.fn((request: UsageRequest) => simulator.usage(request));
const live = { link: "live", desktop: false };
const empty: never[] = [];
vi.mock("../src/engine", () => ({
  mode: "demo", desktop: false, startClock: () => () => {},
  useEngineStatus: () => live, useUnsent: () => empty,
  failureText: (error: unknown) => error instanceof Error ? error.message : String(error),
  useSim: () => useSyncExternalStore((fn) => simulator.subscribe(fn), () => projection),
  sim: new Proxy({}, { get: (_, name) => name === "synced" ? () => true : name === "historyPage" ? page : name === "taskDetails" ? details : name === "usage" ? usage : (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }),
}));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; page.mockClear(); details.mockClear(); usage.mockClear(); });
async function mount(path = "/history?demo", active = false, prepare?: (state: State) => State, prepareLog?: (sim: Simulator) => void) {
  history.replaceState(null, "", path);
  const base = createDemoState(1_000_000_000_000);
  const template = base.tasks.find((task) => task.id === "guest-checkout")!;
  const tasks: Task[] = Array.from({ length: 55 }, (_, index) => ({ ...template, id: `archive-${index}`, title: `Finished task ${index}`, state: "done", column: "done", holdsSlot: false, productId: index % 2 ? "shop" : "billing", finishedAt: base.now - (55 - index) * 60_000 }));
  if (active) tasks[0] = { ...tasks[0]!, state: "running", column: "building", finishedAt: undefined };
  const initial = { ...base, tasks, inbox: [], pool: { ...base.pool, paused: true } };
  simulator = new Simulator(prepare ? prepare(initial) : initial);
  prepareLog?.(simulator);
  // The live websocket contains no completed task bodies. Only an opened task may fetch one.
  projection = { ...simulator.getState(), tasks: simulator.getState().tasks.filter(task => task.state !== "done" && task.state !== "cancelled").map(task => ({ ...task, detailsOmitted: true, detailsRevision: "boot:1", timeline: [], session: [], journey: undefined })), history: { revision: 1, total: tasks.length, products: [], reviews: reviewStats([]), reviewsByProduct: {}, steps: [] } };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<App />));
}
async function click(selector: string) { await act(async () => host!.querySelector<HTMLElement>(selector)!.click()); }
async function typeQuery(value: string) { await act(async () => {
  const input = host!.querySelector<HTMLInputElement>('[role="combobox"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}); }
async function searchSettled() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); }); }
async function button(label: string) { await act(async () => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label)!.click()); }

const recordedTurn: WorkTurn = { id: "known", taskId: "archive-54", productId: "shop", stageId: "build", stageTitle: "Build", stageKind: "do", round: 1, fixing: false, roleId: "builder", toolId: "codex", profileId: "sol-high", sessionId: "session", reason: "first", startedAt: 1, endedAt: 2, end: "finished", mainOnly: false, helpers: 0, tokens: { total: 12_000 }, workMs: 450_000 };
const cardUsage = (index: number) => host!.querySelector(`[data-task-id="archive-${index}"] .history-usage`)?.textContent;

it("shows the same totals as task details without requesting usage or details for each card", async () => {
  await mount("/history?demo", false, undefined, sim => sim.workLog.addTurn(recordedTurn));
  expect(cardUsage(54)).toBe("12k tokens · 7m agent time");
  expect(details).not.toHaveBeenCalled();
  expect(usage.mock.calls.filter(([request]) => request.view === "task")).toHaveLength(0);
  await click('[data-task-id="archive-54"]');
  expect(host!.querySelector(".usage-total")?.textContent).toBe("12k tokens · 7m agent time");
});

it.each([
  { value: 30_000, atLeast: false, text: "under a minute" },
  { value: 30_000, atLeast: true, text: "> a few seconds" },
  { value: 420_000, atLeast: false, text: "7m" },
  { value: 3_900_000, atLeast: true, text: "> 1h 05m" },
])("keeps $text intact while its agent-time label can wrap", async ({ value, atLeast, text }) => {
  await mount("/history?demo", false, undefined, sim => {
    sim.workLog.addTurn({ ...recordedTurn, workMs: value });
    if (atLeast) sim.workLog.addTurn({ ...recordedTurn, id: "lost", end: "lost", workMs: undefined, tokens: undefined });
  });
  const line = host!.querySelector('[data-task-id="archive-54"] .history-usage')!;
  const time = line.lastElementChild!;
  expect(time.textContent).toBe(`${text} agent time`);
  expect(time.querySelector(".history-usage-figure")?.textContent).toBe(text);
  expect(time.querySelector(".history-usage-label")?.textContent).toBe("agent time");
  expect(line.firstElementChild?.textContent).toMatch(/tokens · $/);
});

it("labels partial and missing figures, and omits usage for requests that never started", async () => {
  await mount("/history?demo", false, state => ({ ...state, tasks: state.tasks.map((task, i) => i >= 43 && i <= 45 ? { ...task, state: "cancelled", startedAt: undefined, combinedInto: i === 43 ? "archive-54" : undefined } : task) }), sim => {
    const add = (index: number, extra: Partial<WorkTurn> = {}) => sim.workLog.addTurn({ ...recordedTurn, id: `turn-${index}-${extra.id ?? "known"}`, taskId: `archive-${index}`, ...extra });
    add(54); add(54, { id: "silent", tokens: undefined });
    add(53); add(53, { id: "lost", end: "lost", tokens: undefined, workMs: undefined });
    add(52, { end: "lost", tokens: undefined, workMs: undefined });
    add(51, { tokens: undefined });
    sim.workLog.markUntracked("archive-50", "shop");
    sim.workLog.markUntracked("archive-49", "shop"); add(49);
  });
  expect(cardUsage(54)).toBe("> 12k tokens · 15m agent time");
  expect(cardUsage(53)).toBe("> 12k tokens · > 7m agent time");
  expect(cardUsage(52)).toBe("Tokens not known · Agent time not known");
  expect(cardUsage(51)).toBe("Tokens not reported · 7m agent time");
  expect(cardUsage(50)).toBe("Tokens and agent time not recorded");
  expect(cardUsage(49)).toBe("> 12k tokens · > 7m agent time");
  for (const index of [43, 44, 45]) expect(cardUsage(index)).toBeUndefined();
  const calls = page.mock.calls.length;
  projection = { ...projection, now: projection.now + 86_400_000 };
  await act(async () => root!.render(<App />));
  expect(page).toHaveBeenCalledTimes(calls);
  expect(cardUsage(54)).toBe("> 12k tokens · 15m agent time");
});

it("refreshes late usage while History is open and keeps each task's totals through page and filter changes", async () => {
  await mount("/history?demo", false, undefined, sim => {
    for (let index = 0; index < 55; index++) sim.workLog.addTurn({ ...recordedTurn, taskId: `archive-${index}`, id: `use-${index}`, tokens: { total: index + 1 } });
    sim.workLog.addTurn({ ...recordedTurn, id: "late-last-turn", end: undefined, endedAt: undefined, tokens: { total: 1000 } });
  });
  expect(cardUsage(54)).toBe("55 tokens · 7m agent time");
  await button("Next");
  expect(cardUsage(30)).toBe("31 tokens · 7m agent time");
  expect(cardUsage(54)).toBeUndefined();
  await button("Previous");
  simulator.workLog.endTurn("late-last-turn", { end: "stopped", endedAt: 3 });
  projection = { ...projection, work: { ...projection.work!, version: projection.work!.version + 1 } };
  const calls = page.mock.calls.length;
  await act(async () => root!.render(<App />));
  expect(page).toHaveBeenCalledTimes(calls + 1);
  expect(cardUsage(54)).toBe("1.1k tokens · 15m agent time");
  expect(details).not.toHaveBeenCalled();
  expect(usage.mock.calls.filter(([request]) => request.view === "task")).toHaveLength(0);
  await act(async () => { history.replaceState(null, "", "/history?demo&product=shop&historyQuery=Finished%20task%203&historyStatus=marked-done"); window.dispatchEvent(new PopStateEvent("popstate")); });
  expect(page).toHaveBeenLastCalledWith({ includeUsage: true, productId: "shop", query: "Finished task 3", status: "marked-done", limit: 24 });
  expect(host!.querySelectorAll(".history-card")).toHaveLength(6);
  expect(cardUsage(39)).toBe("40 tokens · 7m agent time");
  expect(cardUsage(54)).toBeUndefined();
});

describe("History", () => {
  it("fetches only the open active task's full details, refreshes changed details and stops after closing", async () => {
    await mount("/tasks/archive-0?demo", true);
    expect(host!.querySelector(".task-workspace")).toBeTruthy();
    expect(details.mock.calls.map(([id]) => id)).toEqual(["archive-0"]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    expect(details).toHaveBeenCalledTimes(1);
    await act(async () => {
      projection = { ...projection, tasks: [{ ...projection.tasks[0]!, detailsRevision: "boot:2" }] };
      root!.render(<App />);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    expect(details).toHaveBeenCalledTimes(2);
    await click('.sheet [aria-label="Close"]');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    expect(details).toHaveBeenCalledTimes(2);
  });
  it("finds a finished task from the command palette without loading finished bodies into live state", async () => {
    await mount("/?demo");
    await click('.topbar [aria-label="Find tasks, products or actions"]');
    expect(page).not.toHaveBeenCalled();
    await typeQuery("Finished task 39");
    await searchSettled();
    expect(page).toHaveBeenLastCalledWith({ query: "Finished task 39", limit: 40 });
    expect(details).not.toHaveBeenCalled();
    expect(host!.querySelector('[role="option"][aria-selected="true"]')?.id).toBe("palette-task-archive-39");
    await act(async () => host!.querySelector<HTMLInputElement>('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(details).toHaveBeenCalledExactlyOnceWith("archive-39");
    expect(host!.querySelector(".sheet-title")?.textContent).toBe("Finished task 39");
    expect(projection.tasks).toHaveLength(0);
  });
  it("opens finished work for a matching product without loading every task into the palette", async () => {
    await mount("/?demo");
    await click('.topbar [aria-label="Find tasks, products or actions"]');
    await typeQuery("Shop");
    expect(host!.querySelector("#palette-product-shop")).not.toBeNull();
    expect(host!.querySelector("#palette-history-product-shop")?.textContent).toContain("Finished tasks in Shop");
    await click("#palette-history-product-shop");
    expect(location.pathname).toBe("/history");
    expect(new URL(location.href).searchParams.get("product")).toBe("shop");
    expect(page).toHaveBeenLastCalledWith({ includeUsage: true, productId: "shop", limit: 24 });
    expect(host!.querySelectorAll(".history-card")).toHaveLength(24);
    expect(details).not.toHaveBeenCalled();
  });
  it("bounds palette history results, keeps an explicit keyboard choice through late results, and ignores state streaming", async () => {
    await mount("/?demo");
    let finish!: (page: HistoryPage) => void;
    const deferred = new Promise<HistoryPage>((resolve) => { finish = resolve; });
    page.mockImplementationOnce(() => deferred);
    await click('.topbar [aria-label="Find tasks, products or actions"]');
    await typeQuery("Finished task");
    await searchSettled();
    await act(async () => host!.querySelector<HTMLInputElement>('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(host!.querySelector('[role="option"][aria-selected="true"]')?.id).toBe("palette-new-query");
    await act(async () => finish(simulator.historyPage({ query: "Finished task", limit: 40 })));
    expect(host!.querySelectorAll('[id^="palette-task-"]')).toHaveLength(40);
    expect(host!.querySelector('[role="option"][aria-selected="true"]')?.id).toBe("palette-new-query");
    expect(host!.textContent).toContain("More matches. Keep typing to narrow the list.");
    const calls = page.mock.calls.length;
    projection = { ...projection, now: projection.now + 1 };
    await act(async () => root!.render(<App />));
    await searchSettled();
    expect(page).toHaveBeenCalledTimes(calls);
    expect(details).not.toHaveBeenCalled();
  });
  it("loads one summary page, fetches only the opened task and returns to the same page", async () => {
    await mount();
    expect(page).toHaveBeenLastCalledWith({ includeUsage: true, limit: 24 });
    expect(host!.querySelectorAll(".history-card")).toHaveLength(24);
    expect(details).not.toHaveBeenCalled();
    expect(host!.textContent).toContain("55 tasks in history");
    expect(host!.querySelector(".history-card .history-outcome.unconfirmed")?.textContent).toBe("Marked as done · delivery not confirmed");
    await button("Next");
    expect(host!.querySelectorAll(".history-card")).toHaveLength(24);
    expect(new URL(location.href).searchParams.has("historyCursor")).toBe(true);
    expect(new URL(location.href).searchParams.has("historyPrevious")).toBe(false);
    const position = location.search;
    const id = host!.querySelector(".history-card")!.getAttribute("data-task-id")!;
    await click(".history-card");
    expect(details).toHaveBeenLastCalledWith(id);
    expect(host!.querySelector(".sheet-title")?.textContent).toBe("Finished task 30");
    expect(host!.querySelectorAll(".task-list-item")).toHaveLength(24);
    expect(new URL(location.href).searchParams.get("from")).toBe("history");
    expect(new URL(location.href).searchParams.get("historyCursor")).toBe(new URLSearchParams(position).get("historyCursor"));
    await click('.sheet [aria-label="Close"]');
    expect(location.pathname).toBe("/history");
    expect(location.search).toBe(position);
    expect(projection.tasks).toHaveLength(0);
    // Closing releases the fetched body. Reopening reads the current saved task afresh.
    await click('.history-card');
    expect(details).toHaveBeenCalledTimes(2);
    await click('.sheet [aria-label="Close"]');
    await button("Previous");
    expect(host!.querySelector(".history-card")?.getAttribute("data-task-id")).toBe("archive-54");
  });
  it("keeps product scope and search on the engine query, and restores a linked node", async () => {
    await mount("/history?demo&product=shop&historyQuery=Finished%20task%203");
    expect(page).toHaveBeenLastCalledWith({ includeUsage: true, productId: "shop", query: "Finished task 3", limit: 24 });
    expect(host!.querySelectorAll(".history-card")).toHaveLength(6);
    const step = simulator.taskDetails("archive-39")!.journey!.find((entry) => entry.roleId === "architect")!;
    const path = `/tasks/archive-39?demo&from=history&product=shop&historyQuery=Finished%20task%203&node=${encodeURIComponent(step.id)}`;
    await act(async () => { history.replaceState(null, "", path); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(details).toHaveBeenLastCalledWith("archive-39");
    expect(host!.querySelector("#journey-details-title")?.textContent).toContain("Architect");
    await click('.sheet [aria-label="Close"]');
    expect(location.pathname).toBe("/history");
    expect(new URL(location.href).searchParams.get("historyQuery")).toBe("Finished task 3");
    await click('.rail a[title="Board (B)"]');
    expect(host!.querySelector(".fold, .done-list, .history-card")).toBeNull();
    expect(host!.querySelector(".board")).not.toBeNull();
  });
});

it("shows exact routine runs across current work and paginated history, and restores the runs route", async () => {
  await mount("/routines/routine-one/runs?demo", false, state => ({ ...state, tasks: state.tasks.map((task, index) => ({ ...task, state: index === 0 ? "queued" : index === 1 ? "running" : index === 2 ? "cancelled" : "done", finishedAt: index < 2 ? undefined : task.finishedAt, maintenance: { routineId: index === 54 ? "other" : "routine-one", routineName: "Old routine name", scheduledAt: task.createdAt, queuedAt: task.createdAt, zone: "UTC", focus: "Inspect", input: "Inspect", role: state.roles[0]!, profile: state.profiles[0]!, product: state.products[0]! } })) }));
  expect(page).toHaveBeenLastCalledWith({ routineId: "routine-one", limit: 24 });
  expect(host!.querySelector("#routine-runs-title")?.textContent).toBe("Removed routine");
  expect(host!.querySelectorAll(".routine-runs article[data-task-id]")).toHaveLength(2);
  expect(host!.querySelectorAll(".history-card")).toHaveLength(24);
  expect(host!.textContent).toContain("52 tasks in history");
  expect(details).not.toHaveBeenCalled();
  await button("Next");
  const address = location.pathname + location.search;
  await click(".history-card");
  expect(new URL(location.href).searchParams.get("routine")).toBe("routine-one");
  expect(host!.querySelectorAll(".task-list-item")).toHaveLength(26);
  await click('.sheet [aria-label="Close"]');
  expect(location.pathname + location.search).toBe(address);
  await button("Previous");
  expect(host!.querySelectorAll(".history-card")).toHaveLength(24);
  await click('.rail a[title="Routines"]');
  expect(location.pathname).toBe("/routines");
  expect(host!.querySelector(".routine-runs")).toBeNull();
});

it("opens an unrelated Inbox task from routine runs without substituting the routine list", async () => {
  await mount("/routines/routine-one/runs?demo", false, state => {
    const task = { ...state.tasks[0]!, state: "needs-you" as const, column: "ready" as const, finishedAt: undefined, title: "Unrelated task" };
    return { ...state, tasks: [task, ...state.tasks.slice(1).map(task => ({ ...task, maintenance: { routineId: "routine-one", routineName: "Daily", scheduledAt: task.createdAt, queuedAt: task.createdAt, zone: "UTC", focus: "Inspect", input: "Inspect", role: state.roles[0]!, profile: state.profiles[0]!, product: state.products[0]! } }))] };
  });
  projection = { ...projection, inbox: [{ id: "unrelated-question", taskId: "archive-0", kind: "question", title: "Which change?", body: "Please inspect this task", at: projection.now, blocking: false }] };
  await act(async () => root!.render(<App />));
  await click('.topbar [aria-label^="Inbox,"]');
  await click('[data-inbox-id="unrelated-question"] .task-link');
  expect(new URL(location.href).searchParams.get("list")).not.toBe("history");
  expect(host!.querySelector(".sheet-title")?.textContent).toBe("Unrelated task");
  expect([...host!.querySelectorAll(".task-list-item")].map(item => item.textContent)).toEqual([expect.stringContaining("Unrelated task")]);
});

it("keeps a task you marked done unconfirmed after a later lookup finds its pull request merged", async () => {
  const pr = { number: 77, url: "https://github.com/acme/demo/pull/77", state: "merged" as const, openedAt: 1 };
  await mount("/history?demo", false, state => ({ ...state, tasks: state.tasks.map((task, index) => index === 54 ? { ...task, delivery: "pull-request", pr, cleanup: { markedDone: true, pullRequest: "none" } } : index === 53 ? { ...task, delivery: "pull-request", pr } : task) }));
  const cards = () => [...host!.querySelectorAll(".history-card")].map(card => ({ id: card.getAttribute("data-task-id"), outcome: card.querySelector(".history-outcome")!.textContent, unconfirmed: card.querySelector(".history-outcome")!.classList.contains("unconfirmed") }));
  expect(cards().slice(0, 2)).toEqual([
    { id: "archive-54", outcome: "Marked as done · delivery not confirmed", unconfirmed: true },
    { id: "archive-53", outcome: "Pull request #77 merged", unconfirmed: false },
  ]);
  await act(async () => { const select = host!.querySelector<HTMLSelectElement>('.history-status select')!; select.value = 'merged'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(cards().map(card => card.id)).toEqual(["archive-53"]);
});

it("keeps final status with search, pagination, task links and browser navigation", async () => {
  await mount("/history?demo&historyStatus=cancelled", false, state => ({ ...state, tasks: state.tasks.map((task, i) => ({ ...task, state: i < 30 ? "cancelled" : "done" })) }));
  expect(page).toHaveBeenLastCalledWith({ includeUsage: true, status: "cancelled", limit: 24 });
  expect(host!.querySelectorAll(".history-card")).toHaveLength(24);
  expect(host!.querySelector<HTMLSelectElement>('.history-status select')?.value).toBe("cancelled");
  await button("Next");
  expect(host!.querySelectorAll(".history-card")).toHaveLength(6);
  const address = location.pathname + location.search;
  await click(".history-card");
  expect(new URL(location.href).searchParams.get("historyStatus")).toBe("cancelled");
  await click('.sheet [aria-label="Close"]');
  expect(location.pathname + location.search).toBe(address);
  await act(async () => { const input = host!.querySelector<HTMLInputElement>('.history-search input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Finished task 2'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await button("Search");
  expect(page).toHaveBeenLastCalledWith({ includeUsage: true, status: "cancelled", query: "Finished task 2", limit: 24 });
  expect(new URL(location.href).searchParams.has("historyCursor")).toBe(false);
  await act(async () => { const select = host!.querySelector<HTMLSelectElement>('.history-status select')!; select.value = 'marked-done'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(page).toHaveBeenLastCalledWith({ includeUsage: true, status: "marked-done", query: "Finished task 2", limit: 24 });
  expect(host!.textContent).toContain("No finished tasks match these filters.");
  await act(async () => { history.replaceState(null, '', address); window.dispatchEvent(new PopStateEvent('popstate')); });
  expect(host!.querySelectorAll(".history-card")).toHaveLength(6);
  expect(host!.querySelector<HTMLSelectElement>('.history-status select')?.value).toBe("cancelled");
});
