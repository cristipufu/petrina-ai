import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState, Simulator } from "@petrina/core";
import { App } from "../src/App";

let simulator: Simulator;
const live = { link: "live", desktop: false };
const empty: never[] = [];
vi.mock("../src/engine", () => ({
  mode: "demo", desktop: false, startClock: () => () => {},
  useEngineStatus: () => live, useUnsent: () => empty,
  failureText: (error: unknown) => error instanceof Error ? error.message : String(error),
  useSim: () => useSyncExternalStore((fn) => simulator.subscribe(fn), () => simulator.getState()),
  sim: new Proxy({}, { get: (_, name) => name === "synced" ? () => true : (...args: unknown[]) => (simulator[name as keyof Simulator] as Function).apply(simulator, args) }),
}));
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; });
async function mount() {
  history.replaceState(null, "", "/?demo");
  const state = createDemoState(1_000_000_000_000);
  simulator = new Simulator({ ...state, tasks: [], inbox: [], pool: { ...state.pool, paused: true } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<App />));
}
async function click(selector: string) { await act(async () => host!.querySelector<HTMLElement>(selector)!.click()); }
async function button(label: string) { await act(async () => [...host!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label)!.click()); }
async function type(selector: string, value: string) {
  await act(async () => {
    const input = host!.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("reviewing a backlog task", () => {
  it("keeps an empty Backlog visible directly below Queue and offers to add a request", async () => {
    await mount();
    const queue = host!.querySelector("#section-queue")!.closest("section")!;
    const backlog = host!.querySelector("#section-backlog")!.closest("section")!;
    expect(queue.nextElementSibling).toBe(backlog);
    expect(host!.querySelector("#section-queue .n")?.textContent).toBe("0");
    expect(host!.querySelector("#section-backlog .n")?.textContent).toBe("0");
    expect(backlog.textContent).toContain("No requests awaiting review.");
    await button("Add a request");
    expect(host!.querySelector('[aria-label="When work starts"] [aria-checked="true"]')?.textContent).toBe("Review in backlog");
  });
  it("defaults to backlog, keeps saved edits through reopening, and queues the latest unsaved request explicitly", async () => {
    await mount();
    await click('.topbar button[title^="New task"]');
    expect(host!.querySelector('[aria-label="When work starts"] [aria-checked="true"]')?.textContent).toBe("Review in backlog");
    await type('[aria-label="What do you want done?"]', "Review before work");
    await type('textarea[aria-label="Details"]', "Original request");
    const add = [...host!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.startsWith("Add to backlog"))!;
    await act(async () => add.click());
    const id = simulator.getState().tasks[0]!.id;
    expect(simulator.getState().tasks[0]!.state).toBe("backlog");
    expect(host!.querySelector(`#section-backlog`)?.textContent).toContain("Backlog");
    await click(`.card[data-task-id="${id}"] .card-open`);
    await type(".backlog-request input", "Saved request title");
    await type(".backlog-request textarea", "Saved request detail");
    await button("Save changes");
    await click('.sheet [aria-label="Close"]');
    await click(`.card[data-task-id="${id}"] .card-open`);
    expect(host!.querySelector<HTMLInputElement>(".backlog-request input")!.value).toBe("Saved request title");
    expect(host!.querySelector<HTMLTextAreaElement>(".backlog-request textarea")!.value).toBe("Saved request detail");
    await type(".backlog-request input", "Ready request title");
    await type(".backlog-request textarea", "Requirements saved together with queueing");
    await button("Queue for work");
    const task = simulator.getState().tasks[0]!;
    expect(task).toMatchObject({ state: "queued", title: "Ready request title", description: "Requirements saved together with queueing", holdsSlot: false });
    expect(task.startedAt).toBeUndefined();
    expect(host!.querySelector(".backlog-request")).toBeNull();
    await click('.sheet [aria-label="Close"]');
    expect(host!.querySelector("#section-backlog .n")?.textContent).toBe("0");
    expect(host!.querySelector(`.card.queued[data-task-id="${id}"]`)?.textContent).toContain("Ready request title");
  });
});

it("selects backlog requests without opening them and queues one combined request", async () => {
  await mount();
  const productId = simulator.getState().products[0]!.id;
  let first = "", second = "";
  await act(async () => {
    first = simulator.addTask({ productId, title: "Fix one label", description: "First requirement", backlog: true });
    second = simulator.addTask({ productId, title: "Fix one gap", description: "Second requirement", backlog: true });
  });
  await button("Select tasks");
  await click('[aria-label="Include Fix one label"]');
  expect(host!.querySelector('.sheet')).toBeNull();
  await click('[aria-label="Include Fix one gap"]');
  await button("Combine and queue…");
  expect(host!.querySelector('[aria-label="Combine backlog tasks"]')?.textContent).toContain("2 original requests");
  await type('#combined-title', "Two small fixes");
  await button("Combine and queue");
  const queued = simulator.getState().tasks.find((task) => task.title === "Two small fixes")!;
  expect(queued.state).toBe("queued");
  expect(queued.description).toContain("First requirement");
  expect(queued.description).toContain("Second requirement");
  expect(simulator.taskDetails(first)!.combinedInto).toBe(queued.id);
  expect(simulator.taskDetails(second)!.combinedInto).toBe(queued.id);
  expect(host!.querySelector('[aria-label="Combine backlog tasks"]')).toBeNull();
  expect(host!.querySelector('.sheet')?.textContent).toContain("Original requests");
});
