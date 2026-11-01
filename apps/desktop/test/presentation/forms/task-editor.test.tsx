

import { stateFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewTaskDialog, TaskOptions } from "../../../src/components/NewTask";

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


it("keeps shared task options descriptions on hover and queue controls available by default", async () => {
  const position = vi.fn();
  await act(async () => root.render(<TaskOptions kind="feature" delivery="pull-request" position="bottom" onKind={() => {}} onDelivery={() => {}} onPosition={position} />));
  expect(host.querySelector('.kind-description')).toBeNull();
  expect(host.querySelector('[role=radio][title="Designed, built and reviewed"]')).not.toBeNull();
  expect(host.textContent).toContain('Place in the queue');
  await click('Top');
  expect(position).toHaveBeenCalledWith('top');
});

it("switches NewTaskDialog into Single agent mode for read-only and editing roles", async () => {
  add.mockResolvedValue("direct-1");
  const state = stateFixture(1000);
  await act(async () => root.render(<NewTaskDialog state={state} initialTitle="Audit cache keys" onClose={() => {}} onCreated={() => {}} />));
  await click("Single agent");
  expect(host.textContent).toContain("Choose one product to run a single-agent task.");

  await act(async () => root.render(<NewTaskDialog key="with-product" state={state} defaultProduct="shop" initialTitle="Audit cache keys" onClose={() => {}} onCreated={() => {}} />));

  expect(host.textContent).toContain("Show me the plan first");
  await click("Single agent");

  expect(host.textContent).not.toContain("Show me the plan first");
  expect(host.textContent).not.toContain("Kind of work");

  const roleSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Role"]')!;
  const profileSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Agent profile"]')!;
  expect(roleSelect).not.toBeNull();
  expect(profileSelect).not.toBeNull();

  // Select read-only Researcher: no delivery approval checkbox, shows read-only summary
  await act(async () => {
    roleSelect.value = "researcher";
    roleSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).toContain("Read-only · No delivery");
  expect(host.textContent).not.toContain("Ask me before shipping");

  await click("Ready for the queue");
  await click("Add to queue ↵");
  expect(add).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Audit cache keys",
      approvePlan: false,
      approveDelivery: false,
      backlog: false,
      direct: { roleId: "researcher", profileId: profileSelect.value },
    }),
  );

  // Switch to editing Builder: restores Ask me before shipping
  add.mockClear();
  await act(async () => root.render(<NewTaskDialog key="edit-direct" state={state} defaultProduct="shop" initialTitle="Quick copy tweak" onClose={() => {}} onCreated={() => {}} />));
  await click("Single agent");
  const editRoleSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Role"]')!;
  await act(async () => {
    editRoleSelect.value = "builder";
    editRoleSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).toContain("Ask me before shipping");
  await click("Add to backlog ↵");
  expect(add).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Quick copy tweak",
      approvePlan: false,
      backlog: true,
      direct: expect.objectContaining({ roleId: "builder" }),
    }),
  );
});
