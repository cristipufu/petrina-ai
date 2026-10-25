

import { stateFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Simulator } from "@petrina/core";
import { NewTaskDialog } from "../../../src/components/NewTask";
import { Late, Lost } from "../../../src/commandFailures";

const commands = vi.hoisted(() => ({ addTask: vi.fn(), setAfter: vi.fn(), historyPage: vi.fn() }));

vi.mock("../../../src/engine", () => ({ mode: "demo", sim: commands, failureText: (failure: Error) => failure.message }));

let host: HTMLDivElement, root: Root, simulator: Simulator;

beforeEach(() => {
  const state = stateFixture(1_000_000_000_000);
  simulator = new Simulator({ ...state, tasks: [], inbox: [], pool: { ...state.pool, paused: true } });
  commands.addTask.mockReset().mockImplementation((input) => simulator.addTask(input));
  commands.setAfter.mockReset().mockImplementation((...args: Parameters<Simulator["setAfter"]>) => simulator.setAfter(...args));
  commands.historyPage.mockReset().mockImplementation((query) => simulator.historyPage(query));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

const state = () => simulator.getState();

const add = (title: string, product = 0) => simulator.addTask({ productId: state().products[product]!.id, title, backlog: true });

const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };

const click = async (selector: string) => { await act(async () => host.querySelector<HTMLElement>(selector)!.click()); };

const button = async (label: string) => { await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label)!.click()); };

const type = async (selector: string, value: string) => { await act(async () => { const node = host.querySelector<HTMLInputElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); };

it("preserves several prerequisites through scheduling and product changes, Add another and an uncertain creation reply", async () => {
  const a = add("Foundation"), b = add("Foundation", 1);
  await render(<NewTaskDialog state={state()} initialTitle="Follow both" onClose={() => {}} onCreated={() => {}} />);
  await click('[aria-label="Choose tasks to wait for"]');
  const rows = host.querySelectorAll('.dependency-results label');
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain(state().products[0]!.name);
  expect(rows[1]!.textContent).toContain(state().products[1]!.name);
  await act(async () => rows.forEach((row) => row.querySelector<HTMLInputElement>('input')!.click()));
  await button("Done");
  await button("Ready for the queue"); await button("Top"); await button("Review in backlog");
  await click('[aria-label="Choose products"]'); await click('.new-task-product-choice input');
  await button("Done");
  await click('.new-task-submit .btn.quiet');
  const created = state().tasks.find((task) => task.title === "Follow both")!;
  expect(created.after).toEqual([a, b]); expect(created.state).toBe("backlog"); expect(created.journey).toBeUndefined();
  expect(host.querySelectorAll('.dependency-selection li')).toHaveLength(2);
  await type('.title-input', "Another request");
  commands.addTask.mockImplementationOnce((input) => { simulator.addTask(input); throw new Lost("Reply lost"); });
  await click('.new-task-submit .btn.lead');
  const sent = commands.addTask.mock.calls.at(-1)![0];
  expect(host.querySelector('.new-task-submit .btn.lead')!.textContent).toContain("Retry confirmation");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Choose tasks to wait for"]')!.disabled).toBe(true);
  await click('.new-task-submit .btn.lead');
  expect(commands.addTask.mock.calls.at(-1)![0]).toBe(sent);
  expect(state().tasks.filter((task) => task.title === "Another request")).toHaveLength(1);
  expect(state().tasks.find((task) => task.title === "Another request")!.after).toEqual([a, b]);
});

it("keeps the same prerequisites on each pasted title and on a partial-batch confirmation retry", async () => {
  const a = add("Foundation"), b = add("Other foundation");
  await render(<NewTaskDialog state={state()} onClose={() => {}} onCreated={() => {}} />);
  await click('[aria-label="Choose tasks to wait for"]');
  await act(async () => host.querySelectorAll<HTMLInputElement>('.dependency-results input').forEach((input) => input.click()));
  await button("Done");
  await act(async () => {
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "First request\nSecond request\nThird request" } });
    host.querySelector('.title-input')!.dispatchEvent(paste);
  });
  commands.addTask.mockImplementationOnce((input) => simulator.addTask(input)).mockImplementationOnce((input) => { simulator.addTask(input); throw new Late("Reply lost"); });
  await click('.new-task-submit .btn.lead'); await click('.new-task-submit .btn.lead');
  const requests = state().tasks.filter((task) => task.title.endsWith("request"));
  expect(requests).toHaveLength(3);
  expect(requests.map((task) => task.after)).toEqual([[a, b], [a, b], [a, b]]);
  expect(new Set(requests.map((task) => task.clientId)).size).toBe(3);
});

it("unlocks choices after a definite refusal and does not recreate confirmed entries in a partial batch", async () => {
  const a = add("Foundation");
  await render(<NewTaskDialog state={state()} onClose={() => {}} onCreated={() => {}} />);
  await click('[aria-label="Choose tasks to wait for"]'); await click('.dependency-results input'); await button("Done");
  await act(async () => {
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "First request\nSecond request" } });
    host.querySelector('.title-input')!.dispatchEvent(paste);
  });
  commands.addTask.mockImplementationOnce((input) => simulator.addTask(input)).mockImplementationOnce(() => { throw new Error("Unknown task. Remove the unavailable prerequisite."); });
  await click('.new-task-submit .btn.lead');
  expect(host.querySelector<HTMLInputElement>('.title-input')!.value).toBe("Second request");
  expect(host.querySelector<HTMLInputElement>('.title-input')!.disabled).toBe(false);
  expect(host.querySelector('.new-task-submit .btn.lead')!.textContent).not.toContain("Retry confirmation");
  expect(host.querySelector('.dependency-selection')!.textContent).toContain("Foundation");
  await click('.new-task-submit .btn.lead');
  expect(state().tasks.filter((task) => task.title === "First request")).toHaveLength(1);
  expect(state().tasks.find((task) => task.title === "Second request")!.after).toEqual([a]);
});

it("keeps product removal reachable on the first click while its inline picker is open", async () => {
  const productId = state().products[0]!.id;
  await render(<NewTaskDialog state={state()} defaultProduct={productId} initialTitle="Request" onClose={() => {}} onCreated={() => {}} />);
  await click('.new-task-product-settings summary');
  await click('[aria-label="Choose products"]');
  const remove = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Remove product')!;
  await act(async () => remove.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  expect(host.querySelector('.new-task-product-menu')).not.toBeNull();
  await act(async () => { remove.focus(); remove.click(); });
  expect(host.querySelector('.new-task-product-settings')).toBeNull();
  expect(host.querySelector('.new-task-product-menu')).toBeNull();
});
