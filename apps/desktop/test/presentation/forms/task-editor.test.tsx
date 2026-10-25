

import { stateFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewTaskDialog } from "../../../src/components/NewTask";

const add = vi.hoisted(() => vi.fn());

vi.mock("../../../src/engine", () => ({ mode: "demo", sim: { addTask: add }, failureText: (error: Error) => error.message }));

let host: HTMLDivElement, root: Root;

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); add.mockReset(); });

afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const type = async (value: string) => { const input = host.querySelector<HTMLInputElement>('#task-title')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); };

const click = async (name: string) => { const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === name || button.getAttribute('aria-label') === name)!; await act(async () => button.click()); };

const escape = async () => { await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); };

it("retains an edited task draft on Escape until discard is confirmed", async () => {
  const closed = vi.fn();
  await act(async () => root.render(<NewTaskDialog state={stateFixture(1000)} onClose={closed} onCreated={() => {}} />));
  await type('Keep this request'); await escape();
  expect(host.querySelector('[role=alertdialog]')).not.toBeNull(); expect(closed).not.toHaveBeenCalled();
  await click('Keep editing'); expect(host.querySelector<HTMLInputElement>('#task-title')!.value).toBe('Keep this request');
  await click('Close new task'); await click('Discard changes'); expect(closed).toHaveBeenCalledOnce();
});

it("blocks all editor close paths during a save and keeps one submission", async () => {
  const closed = vi.fn(), created = vi.fn(); let finish!: (id: string) => void;
  add.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
  await act(async () => root.render(<NewTaskDialog state={stateFixture(1000)} initialTitle="Save once" onClose={closed} onCreated={created} />));
  await click('Add to backlog ↵'); await escape();
  await act(async () => host.querySelector<HTMLElement>('.editor-scrim')!.click());
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Close new task"]')!.disabled).toBe(true);
  expect(closed).not.toHaveBeenCalled(); expect(add).toHaveBeenCalledOnce();
  await act(async () => finish('saved')); expect(created).toHaveBeenCalledOnce();
});

it("treats the empty form after Add another as a fresh draft", async () => {
  const closed = vi.fn(); add.mockResolvedValue("saved");
  await act(async () => root.render(<NewTaskDialog state={stateFixture(1000)} initialTitle="First task" onClose={closed} onCreated={() => {}} />));
  await click("Add another ⇧↵");
  expect(host.querySelector<HTMLInputElement>("#task-title")!.value).toBe("");
  await click("Close new task");
  expect(closed).toHaveBeenCalledOnce(); expect(host.querySelector("[role=alertdialog]")).toBeNull();
});
