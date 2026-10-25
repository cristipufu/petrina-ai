import { oneTaskFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { historyItem, reviewStats, type State, type Task } from "@petrina/core";
import { TaskRuntimeWait } from "../../../src/components/TaskDependencies";

const commands = vi.hoisted(() => ({ historyPage: vi.fn() }));

vi.mock("../../../src/engine", () => ({ sim: commands, failureText: (error: Error) => error.message }));

const NOW = 1_000_000_000_000;

let host: HTMLDivElement, root: Root, state: State, task: Task, prerequisite: Task;

beforeEach(() => {
  state = oneTaskFixture(NOW);
  const template = state.tasks[0]!;
  prerequisite = { ...template, id: "fix", title: "Fix the capacity tests", state: "running", agent: undefined, repositories: undefined, pr: undefined, release: undefined, landed: undefined, localUpdate: undefined, maintenance: undefined };
  task = { ...template, id: "waiting", title: "Finish Linux validation", state: "waiting", agent: undefined, helpers: undefined, driving: undefined, repositories: undefined, journey: [], runtimeWait: { after: [prerequisite.id], reason: "Linux validation needs the capacity fix.", changes: [{ at: NOW - 100, before: [], after: [prerequisite.id], reason: "Linux validation needs the capacity fix.", requestId: "first-decision" }] } };
  state = { ...state, tasks: [task, prerequisite] };
  commands.historyPage.mockReset().mockResolvedValue({ items: [], total: 0 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const render = async (shown = task, snapshot = state) => { await act(async () => root.render(<TaskRuntimeWait task={shown} state={snapshot} />)); };

it("shows an active saved wait and its complete decision record without an editing control", async () => {
  await render();
  expect(host.textContent).toContain("The hold is active");
  expect(host.textContent).toContain(task.runtimeWait!.reason);
  expect(host.querySelector('[aria-label="Awaited tasks"] a')?.getAttribute("href")).toContain("/tasks/fix");
  expect(host.textContent).toContain("still in progress");
  expect(host.querySelector("summary")?.textContent).toBe("1 recorded change");
  expect(host.textContent).toContain("Before: None");
  expect(host.textContent).toContain("After: Fix the capacity tests");
  expect(host.textContent).toContain("Request reference: first-decision");
  expect(host.querySelector("button, input, textarea, select")).toBeNull();
});

it("distinguishes admitted work from a hold that is already active", async () => {
  const working: Task = { ...task, state: "running", agent: { roleId: "builder", profileId: state.profiles[0]!.id, since: NOW - 10, step: 0 } };
  await render(working);
  expect(host.textContent).toContain("The hold starts after the current work finishes");
  expect(host.textContent).not.toContain("The hold is active");
  await render(task);
  expect(host.textContent).toContain("The hold is active");
});

it("shows non-landing decisions using saved History facts and keeps their task links", async () => {
  const cancelled = historyItem({ ...prerequisite, state: "cancelled" });
  const snapshot = { ...state, tasks: [task], history: { revision: 1, total: 1, products: [], reviews: reviewStats([]), reviewsByProduct: {}, steps: [], dependencies: [{ ...cancelled, blocksDependents: false }] } };
  await render(task, snapshot);
  expect(host.textContent).toContain("Waiting for your decision");
  expect(host.textContent).toContain("cancelled · Your decision is needed");
  expect(host.querySelector('[aria-label="Awaited tasks"] a')?.getAttribute("href")).toContain("/tasks/fix");
  expect(commands.historyPage).not.toHaveBeenCalled();
});

it("retains the changes and their names after clearing a wait, including in History", async () => {
  commands.historyPage.mockResolvedValue({ items: [historyItem({ ...prerequisite, state: "done" })], total: 1 });
  const cleared: Task = { ...task, state: "done", runtimeWait: { ...task.runtimeWait!, after: [], reason: "Validation will be handled separately.", releasedAt: NOW, releaseReason: "You cleared the wait: Validation will be handled separately.", changes: [...task.runtimeWait!.changes, { at: NOW, before: [prerequisite.id], after: [], reason: "Validation will be handled separately.", requestId: "clear-decision" }] } };
  await render(cleared, { ...state, tasks: [] });
  expect(host.textContent).toContain("You cleared the wait");
  expect(host.textContent).toContain("Wait ended");
  expect(host.querySelector("summary")?.textContent).toBe("2 recorded changes");
  expect(host.textContent).toContain("Before: Fix the capacity tests");
  expect(host.textContent).toContain("After: None");
  expect(host.textContent).toContain("Request reference: clear-decision");
  expect(commands.historyPage).toHaveBeenCalledWith({ taskId: "fix", limit: 1 });
  expect(host.querySelector('[aria-label="Awaited tasks"]')).toBeNull();
});

it("shows an unavailable prerequisite honestly and leaves a no-wait task unchanged", async () => {
  await render(task, { ...state, tasks: [task] });
  expect(host.textContent).toContain("Unavailable task");
  expect(host.textContent).toContain("no longer available · Your decision is needed");
  await render({ ...task, runtimeWait: undefined });
  expect(host.textContent).toBe("");
});
