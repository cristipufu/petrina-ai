import { act, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDemoState, historyItem, Simulator, type HistoryItem, type Task } from "@petrina/core";
import { DependencyEditor, DependencyPicker, TaskDependencies, dependencyOutcome } from "../src/components/TaskDependencies";
import { NewTaskDialog } from "../src/components/NewTask";
import { Late, Lost } from "../src/commandFailures";

const commands = vi.hoisted(() => ({ addTask: vi.fn(), setAfter: vi.fn(), historyPage: vi.fn() }));
vi.mock("../src/engine", () => ({ mode: "demo", sim: commands, failureText: (failure: Error) => failure.message }));
let host: HTMLDivElement, root: Root, simulator: Simulator;
beforeEach(() => {
  const state = createDemoState(1_000_000_000_000);
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

it("uses bounded History pages, keeps selections when search fails, and closes the picker before its editor", async () => {
  vi.useFakeTimers();
  const a = add("Live foundation");
  const archived: HistoryItem = { ...historyItem(state().tasks[0]!), id: "archived", title: "Finished foundation", state: "done", blocksDependents: false };
  commands.historyPage.mockReturnValue({ items: [archived], total: 25, nextCursor: "next" });
  const change = vi.fn();
  await render(<DependencyPicker state={state()} ids={[a]} onChange={change} />);
  await click('[aria-label="Choose tasks to wait for"]');
  expect(commands.historyPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 24 }));
  await button("Show more");
  expect(commands.historyPage).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next", limit: 24 }));
  commands.historyPage.mockRejectedValue(new Error("History unavailable"));
  await type('[aria-label="Find tasks by title or product"]', "missing");
  await act(async () => vi.advanceTimersByTime(201));
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("History unavailable");
  expect(host.querySelector('.dependency-selection')!.textContent).toContain("Live foundation");
  const input = host.querySelector<HTMLInputElement>('[type="search"]')!;
  await act(async () => { input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(host.querySelector('.new-task-product-menu')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Choose tasks to wait for"]'));
  expect(change).not.toHaveBeenCalled();
});

it("disables direct and indirect dependents, preserves rejected edits, and becomes read-only when work starts", async () => {
  const a = add("Current task"), b = add("Direct follower"), c = add("Indirect follower"), d = add("Safe foundation");
  simulator.setAfter(b, [a]); simulator.setAfter(c, [b]);
  let task = simulator.taskDetails(a)!;
  const closed = vi.fn();
  await render(<DependencyEditor task={task} state={state()} onClose={closed} />);
  const labels = [...host.querySelectorAll<HTMLLabelElement>('.dependency-results label')];
  for (const title of ["Direct follower", "Indirect follower"]) {
    const row = labels.find((label) => label.textContent!.includes(title))!;
    expect(row.querySelector('input')!.disabled).toBe(true); expect(row.textContent).toContain("Already waiting on this task");
  }
  await act(async () => labels.find((label) => label.textContent!.includes("Safe foundation"))!.querySelector('input')!.click());
  commands.setAfter.mockRejectedValueOnce(new Error("Those tasks would wait for each other. Remove a prerequisite."));
  await button("Save changes");
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Remove a prerequisite");
  expect(host.querySelector('.dependency-selection')!.textContent).toContain("Safe foundation"); expect(closed).not.toHaveBeenCalled();
  task = { ...task, state: "running", startedAt: 1001 };
  await render(<DependencyEditor task={task} state={state()} onClose={closed} />);
  expect(host.querySelector('.dependency-selection')!.textContent).toContain("Safe foundation");
  expect(host.textContent).toContain("can no longer change");
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === "Save changes")!.disabled).toBe(true);
  expect(commands.setAfter).toHaveBeenCalledWith(a, [d]);
});

it("shows unavailable saved choices without losing them, links known prerequisites and saves clearing independently", async () => {
  const a = add("Foundation"), id = add("Dependent"); simulator.setAfter(id, [a]);
  const task = { ...simulator.taskDetails(id)!, after: [a, "removed"] };
  await render(<TaskDependencies task={task} state={state()} />);
  expect(host.querySelector('.dependency-selection a')!.getAttribute('href')).toContain(a);
  expect(host.textContent).toContain("Unavailable task");
  await button("Change prerequisites");
  expect(host.querySelector('[role="dialog"]')!.textContent).toContain("Unavailable task");
  await button("Clear all"); await button("Done");
  expect(simulator.taskDetails(id)!.after).toEqual([a]);
  await button("Save changes");
  expect(commands.setAfter).toHaveBeenCalledWith(id, []);
  expect(simulator.taskDetails(id)!.after).toEqual([]);
});

it("distinguishes unsuccessful and unresolved deliveries from landed prerequisites", () => {
  const a = add("Foundation"); const task = simulator.taskDetails(a)!;
  expect(dependencyOutcome({ ...task, state: "cancelled" })).toContain("Cancelled");
  expect(dependencyOutcome({ ...task, state: "done" })).toContain("delivery not confirmed");
  const pr = { number: 1, url: "https://example.test/1", openedAt: 1 };
  expect(dependencyOutcome({ ...task, state: "done", pr: { ...pr, state: "closed" } })).toContain("did not land");
  expect(dependencyOutcome({ ...task, state: "done", pr: { ...pr, state: "open" } })).toContain("not landed yet");
  expect(dependencyOutcome({ ...task, state: "done", pr: { ...pr, state: "merged" } })).toBe("Landed");
  // You marked it done: a pull request found later, saved or live, does not make it land.
  for (const state of ["open", "merged", "closed"] as const) {
    const marked = { ...task, state: "done" as const, pr: { ...pr, state }, cleanup: { markedDone: true } };
    expect(dependencyOutcome(marked)).toBe("Marked as done — delivery not confirmed");
    expect(dependencyOutcome(historyItem(marked))).toBe("Marked as done — delivery not confirmed");
  }
  const shared: Task = { ...task, state: "done" as const, repositories: [{ productId: "one", delivery: "local" as const, completedStages: [], landed: { branch: "main", sha: "abc" }, localUpdate: { branch: "main", sha: "abc", pushed: false } }] };
  expect(dependencyOutcome(shared)).not.toBe("Landed");
});

it("retries an uncertain prerequisite edit with the identical choices, while Cancel makes no edit", async () => {
  const a = add("Foundation"), b = add("Other foundation"), id = add("Dependent");
  const task = simulator.taskDetails(id)!;
  const closed = vi.fn();
  await render(<DependencyEditor task={task} state={state()} onClose={closed} />);
  await act(async () => [...host.querySelectorAll('.dependency-results label')].filter((row) => row.textContent!.includes("foundation") || row.textContent!.includes("Foundation")).forEach((row) => row.querySelector<HTMLInputElement>('input')!.click()));
  commands.setAfter.mockImplementationOnce((taskId, after) => { simulator.setAfter(taskId, after); throw new Lost("Confirmation lost"); });
  await button("Save changes");
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("same choices");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Choose tasks to wait for"]')!.disabled).toBe(true);
  expect(host.querySelectorAll('.dependency-selection li')).toHaveLength(2);
  await button("Retry confirmation");
  expect(commands.setAfter.mock.calls).toEqual([[id, [a, b]], [id, [a, b]]]);
  expect(closed).toHaveBeenCalledOnce();
  await act(async () => root.unmount()); root = createRoot(host);
  await render(<DependencyEditor task={simulator.taskDetails(id)!} state={state()} onClose={closed} />);
  await button("Clear all"); await button("Cancel");
  expect(simulator.taskDetails(id)!.after).toEqual([a, b]);
  expect(commands.setAfter).toHaveBeenCalledTimes(2);
});

it("keeps an archived selection through a failed compact lookup and lets the coordinator check it again", async () => {
  const id = add("Archived foundation");
  const archived: HistoryItem = { ...historyItem(simulator.taskDetails(id)!), state: "done", blocksDependents: false };
  commands.historyPage.mockRejectedValueOnce(new Error("Could not reach History")).mockResolvedValue({ items: [archived], total: 1 });
  const empty = { ...state(), tasks: [] };
  const changed = vi.fn();
  await render(<DependencyPicker state={empty} ids={[id]} onChange={changed} />);
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Could not reach History");
  expect(host.querySelector('.dependency-selection li')).not.toBeNull();
  await button("Try checking again");
  expect(host.querySelector('.dependency-selection')!.textContent).toContain("Archived foundation");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(commands.historyPage.mock.calls).toEqual([[{ taskId: id, limit: 1 }], [{ taskId: id, limit: 1 }]]);
  expect(changed).not.toHaveBeenCalled();
});

// A real click has a press before activation. In-flow search results must not disappear
// during that press and move the selected row or editor action away from the pointer.
async function pressBeforeClick(target: HTMLElement) {
  await act(async () => target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(host.querySelector('.dependency-results')).not.toBeNull();
  await act(async () => { target.focus(); target.click(); });
}

it("removes a selected prerequisite on the first click while the list is open", async () => {
  const a = add("Foundation"), id = add("Dependent"); simulator.setAfter(id, [a]);
  await render(<DependencyEditor task={simulator.taskDetails(id)!} state={state()} onClose={() => {}} />);
  await pressBeforeClick(host.querySelector<HTMLButtonElement>('[aria-label="Remove Foundation"]')!);
  expect(host.querySelector('.dependency-selection li')).toBeNull();
  await button("Save changes");
  expect(simulator.taskDetails(id)!.after).toEqual([]);
});

it.each(["Save changes", "Cancel"])("activates %s on the first click while the list is open", async (action) => {
  const a = add("Foundation"), id = add("Dependent");
  const closed = vi.fn();
  await render(<DependencyEditor task={simulator.taskDetails(id)!} state={state()} onClose={closed} />);
  await click('.dependency-results label:has(input:not(:disabled)) input');
  const target = [...host.querySelectorAll<HTMLButtonElement>('.editor-footer button')].find((button) => button.textContent === action)!;
  await pressBeforeClick(target);
  expect(closed).toHaveBeenCalledOnce();
  expect(simulator.taskDetails(id)!.after ?? []).toEqual(action === "Save changes" ? [a] : []);
});

it("rechecks an unavailable selection on the first click while the list is open", async () => {
  const id = add("Archived foundation");
  const archived = { ...historyItem(simulator.taskDetails(id)!), state: "done" as const };
  commands.historyPage.mockImplementation(query => query.taskId ? Promise.reject(new Error("History unavailable")) : { items: [], total: 0 });
  await render(<DependencyPicker state={{ ...state(), tasks: [] }} ids={[id]} onChange={() => {}} initiallyOpen />);
  commands.historyPage.mockImplementation(query => ({ items: query.taskId ? [archived] : [], total: query.taskId ? 1 : 0 }));
  await pressBeforeClick([...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === "Try checking again")!);
  expect(host.querySelector('.dependency-selection')!.textContent).toContain("Archived foundation");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it.each([false, true])("does not save an unchanged prerequisite selection (selected: %s)", async (selected) => {
  const a = add("Foundation"), id = add("Dependent");
  if (selected) simulator.setAfter(id, [a]);
  await render(<DependencyEditor task={simulator.taskDetails(id)!} state={state()} onClose={() => {}} />);
  const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === "Save changes")!;
  expect(save.disabled).toBe(true);
  const option = [...host.querySelectorAll<HTMLInputElement>('.dependency-results input')].find(input => !input.disabled)!;
  await act(async () => option.click());
  expect(save.disabled).toBe(false);
  await act(async () => option.click());
  expect(save.disabled).toBe(true);
  const before = simulator.taskDetails(id)!.timeline;
  await act(async () => save.click());
  expect(commands.setAfter).not.toHaveBeenCalled();
  expect(simulator.taskDetails(id)!.timeline).toEqual(before);
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


it("keeps a newly opened prerequisite list open after the opening click", async () => {
  const id = add("Dependent");
  function Launcher() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => flushSync(() => setOpen(true))}>Start after other tasks…</button>{open && <DependencyEditor task={simulator.taskDetails(id)!} state={state()} onClose={() => setOpen(false)} />}</>;
  }
  await render(<Launcher />);
  await button("Start after other tasks…");
  expect(host.querySelector('.dependency-results')).not.toBeNull();
});
