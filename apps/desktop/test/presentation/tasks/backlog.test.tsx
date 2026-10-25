vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));
import { stateFixture } from "../../fixtures/state";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Simulator } from "@petrina/core";
import { Lost } from "../../../src/commandFailures";
import { App } from "../../../src/App";

let simulator: Simulator;

let loseCombineReply = false;

let loseAddAt = 0, addCalls = 0;

let holdAddReply: Promise<void> | undefined;

const live = { link: "live", desktop: false };

const empty: never[] = [];

vi.mock("../../../src/engine", () => ({
  mode: "demo", desktop: false, startClock: () => () => {},
  useEngineStatus: () => live, useUnsent: () => empty,
  failureText: (error: unknown) => error instanceof Error ? error.message : String(error),
  useSim: () => useSyncExternalStore((fn) => simulator.subscribe(fn), () => simulator.getState()),
  sim: new Proxy({}, { get: (_, name) => name === "synced" ? () => true : (...args: unknown[]) => {
    const result = (simulator[name as keyof Simulator] as Function).apply(simulator, args);
    if (name === "addTask") {
      addCalls++;
      if (holdAddReply) return holdAddReply.then(() => result);
    }
    return (name === "combineBacklog" && loseCombineReply) || (name === "addTask" && addCalls === loseAddAt) ? Promise.resolve(result).then(() => { throw new Lost("Confirmation was lost"); }) : result;
  } }),
}));

let root: Root | undefined;

let host: HTMLDivElement | undefined;

afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; loseCombineReply = false; loseAddAt = addCalls = 0; holdAddReply = undefined; });

async function mount() {
  history.replaceState(null, "", "/?demo");
  const state = stateFixture(1_000_000_000_000);
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
  it("ignores a second synchronous submission while the first confirmation is in flight", async () => {
    await mount(); await click('.topbar button[title^="New task"]'); await type('.title-input', "One request");
    let release!: () => void;
    holdAddReply = new Promise(resolve => { release = resolve; });
    const submit = host!.querySelector<HTMLButtonElement>('.new-task-submit .btn.lead')!;
    await act(async () => { submit.click(); submit.click(); });
    expect(addCalls).toBe(1); expect(simulator.getState().tasks).toHaveLength(1);
    await act(async () => release());
    expect(host!.querySelector('[aria-label="New task"]')).toBeNull();
  });

  it("confirms a partially saved batch after a lost reply without duplicating any task", async () => {
    await mount(); await click('.topbar button[title^="New task"]');
    const input = host!.querySelector<HTMLInputElement>('.title-input')!;
    await act(async () => {
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { getData: () => "First request\nSecond request\nThird request" } });
      input.dispatchEvent(paste);
    });
    loseAddAt = 2;
    await click('.new-task-submit .btn.lead');
    expect(simulator.getState().tasks).toHaveLength(2);
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain("Confirmation was lost");
    expect(host!.querySelector('[role="alert"]')?.textContent).not.toContain("Error:");
    expect(input.disabled).toBe(true);
    await click('.new-task-submit .btn.lead');
    expect(simulator.getState().tasks.map(task => task.title)).toEqual(["First request", "Second request", "Third request"]);
    expect(new Set(simulator.getState().tasks.map(task => task.clientId)).size).toBe(3);
    expect(addCalls).toBe(4); expect(host!.querySelector('[aria-label="New task"]')).toBeNull();
  });

  it("gives Add another a fresh request identity and returns focus to the title", async () => {
    await mount(); await click('.topbar button[title^="New task"]');
    await type('.title-input', "Same title"); await click('.new-task-submit .btn.quiet');
    expect(simulator.getState().tasks).toHaveLength(1);
    expect(document.activeElement).toBe(host!.querySelector('.title-input'));
    expect(host!.querySelector<HTMLInputElement>('.title-input')!.disabled).toBe(false);
    await type('.title-input', "Same title"); await click('.new-task-submit .btn.lead');
    expect(simulator.getState().tasks).toHaveLength(2);
    expect(new Set(simulator.getState().tasks.map(task => task.clientId)).size).toBe(2);
  });

  it("searches and selects several products without losing choices, and dismisses the picker before the dialog", async () => {
    await mount();
    await click('.topbar button[title^="New task"]');
    const [first, second] = simulator.getState().products;
    expect(host!.querySelector('[aria-label="Find products"]')).toBeNull();
    await click('[aria-label="Choose products"]');
    await type('[aria-label="Find products"]', first!.name);
    expect(host!.querySelectorAll('.new-task-product-choice')).toHaveLength(1);
    await click('.new-task-product-choice input');
    await type('[aria-label="Find products"]', second!.name);
    await click('.new-task-product-choice input');
    expect(host!.querySelector('.new-task-product-menu-foot')?.textContent).toContain('2 selected');
    await act(async () => host!.querySelector<HTMLInputElement>('[aria-label="Find products"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(host!.querySelector('.new-task-product-menu')).toBeNull();
    expect(host!.querySelector('[aria-label="New task"]')).not.toBeNull();
    expect(document.activeElement).toBe(host!.querySelector('[aria-label="Choose products"]'));
    expect(host!.querySelectorAll('.new-task-product-settings')).toHaveLength(2);
    await click('[aria-label="Choose products"]');
    expect(host!.querySelectorAll('.new-task-product-choice input:checked')).toHaveLength(2);
    await click('.new-task-product-choice input:checked');
    await button('Done');
    expect(host!.querySelectorAll('.new-task-product-settings')).toHaveLength(1);
    await type('[aria-label="What do you want done?"]', 'Only the remaining product');
    const add = [...host!.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.startsWith('Add to backlog'))!;
    await act(async () => add.click());
    expect(simulator.getState().tasks[0]!.workChoice).toEqual(expect.objectContaining({ productId: second!.id }));
  });

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

it("recognises a saved combination from the state update when the command confirmation is lost", async () => {
  await mount();
  const productId = simulator.getState().products[0]!.id;
  await act(async () => { simulator.addTask({ productId, title: "First small fix", backlog: true }); simulator.addTask({ productId, title: "Second small fix", backlog: true }); });
  await button("Select tasks");
  await click('[aria-label="Include First small fix"]');
  await click('[aria-label="Include Second small fix"]');
  await button("Combine and queue…");
  await type('#combined-title', "Saved despite lost reply");
  loseCombineReply = true;
  await button("Combine and queue");
  expect(host!.querySelector('[aria-label="Combine backlog tasks"]')).toBeNull();
  expect(simulator.getState().tasks.filter((task) => task.title === "Saved despite lost reply")).toHaveLength(1);
  expect(host!.querySelector('.sheet')?.textContent).toContain("Saved despite lost reply");
});

it("opens prerequisites from both More menus and preserves attempted choices when queued work starts", async () => {
  await mount();
  let current = "", foundation = "";
  await act(async () => {
    const productId = simulator.getState().products[0]!.id;
    current = simulator.addTask({ productId, title: "Queued request" });
    foundation = simulator.addTask({ productId, title: "Foundation", backlog: true });
  });
  await click(`.card[data-task-id="${current}"] [aria-label="More"]`);
  await button("Start after other tasks…");
  expect(host!.querySelector('[aria-label="Start after other tasks land"]')).not.toBeNull();
  expect(simulator.taskDetails(current)!.held).toBe(false);
  await act(async () => [...host!.querySelectorAll('.dependency-results label')].find((row) => row.textContent?.includes("Foundation"))!.querySelector<HTMLInputElement>('input')!.click());
  await button("Done"); await button("Save changes");
  expect(simulator.taskDetails(current)!.after).toEqual([foundation]);
  await click(`.card[data-task-id="${current}"] .card-open`);
  expect(host!.querySelector('.dependency-selection')!.textContent).toContain("Foundation");
  await click('.sheet-actions [aria-label="More"]');
  await button("Start after other tasks…");
  await button("Clear all");
  await act(async () => simulator.cancel(foundation));
  await act(async () => simulator.setPoolPaused(false));
  expect(simulator.taskDetails(current)!.startedAt).toBeDefined();
  expect(host!.querySelector('[aria-label="Start after other tasks land"]')).not.toBeNull();
  expect(host!.querySelector('[aria-label="Start after other tasks land"]')!.textContent).toContain("Your attempted choices are still shown");
  expect([...host!.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === "Save changes")!.disabled).toBe(true);
  expect(simulator.taskDetails(current)!.after).toEqual([foundation]);
});
