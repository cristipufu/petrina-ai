import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState, reviewStats, Simulator, type HistoryPage, type HistoryQuery, type State, type Task } from "@petrina/core";
import { App } from "../src/App";

let simulator: Simulator;
let projection: State;
const page = vi.fn((query: HistoryQuery): HistoryPage | Promise<HistoryPage> => simulator.historyPage(query));
const details = vi.fn((id: string) => simulator.taskDetails(id));
const live = { link: "live", desktop: false };
const empty: never[] = [];
vi.mock("../src/engine", () => ({
  mode: "demo", desktop: false, startClock: () => () => {},
  useEngineStatus: () => live, useUnsent: () => empty,
  failureText: (error: unknown) => error instanceof Error ? error.message : String(error),
  useSim: () => useSyncExternalStore((fn) => simulator.subscribe(fn), () => projection),
  sim: new Proxy({}, { get: (_, name) => name === "synced" ? () => true : name === "historyPage" ? page : name === "taskDetails" ? details : (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }),
}));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; page.mockClear(); details.mockClear(); });
async function mount(path = "/history?demo", active = false, prepare?: (state: State) => State) {
  history.replaceState(null, "", path);
  const base = createDemoState(1_000_000_000_000);
  const template = base.tasks.find((task) => task.id === "guest-checkout")!;
  const tasks: Task[] = Array.from({ length: 55 }, (_, index) => ({ ...template, id: `archive-${index}`, title: `Finished task ${index}`, state: "done", column: "done", holdsSlot: false, productId: index % 2 ? "shop" : "billing", finishedAt: base.now - (55 - index) * 60_000 }));
  if (active) tasks[0] = { ...tasks[0]!, state: "running", column: "building", finishedAt: undefined };
  const initial = { ...base, tasks, inbox: [], pool: { ...base.pool, paused: true } };
  simulator = new Simulator(prepare ? prepare(initial) : initial);
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
    expect(page).toHaveBeenLastCalledWith({ productId: "shop", limit: 24 });
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
    expect(page).toHaveBeenLastCalledWith({ limit: 24 });
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
    expect(page).toHaveBeenLastCalledWith({ productId: "shop", query: "Finished task 3", limit: 24 });
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
