import { oneTaskFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Task, type TaskSource } from "@petrina/core";
import { TaskStart } from "../../../src/components/TaskStart";

const commands = vi.hoisted(() => ({ addTask: vi.fn(async () => "task"), addLessons: vi.fn(), setTaskStart: vi.fn(async () => {}), setTaskProducts: vi.fn(async () => {}), setTaskAddition: vi.fn(async () => {}), setTaskApproval: vi.fn(), requestChanges: vi.fn(), approve: vi.fn() }));

vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: commands, useEngineStatus: () => ({ link: "live" }), useUnsent: () => [] }));

let root: Root, host: HTMLDivElement;

afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });

const state = oneTaskFixture(1_000_000_000);

async function render(node: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }

async function click(element: Element) { await act(async () => (element as HTMLElement).click()); }

function button(text: string): HTMLButtonElement { return [...host.querySelectorAll("button")].find((element) => element.textContent?.includes(text))!; }

function source(index: number): TaskSource { const product = state.products[index]!; return { product: { ...product, defaultBranch: "main" }, start: { kind: "default", branch: "main" }, destination: { mode: "pull-request", kind: "new-pr", repo: product.repo, branch: "main" }, confirmed: false }; }

describe("shared product controls", () => {
  it.each([false, true])("disables applying a %s shared-product edit while validation is in flight", async shared => {
    const task: Task = { ...state.tasks[0]!, worktree: undefined, workRows: shared ? [0, 1].map(index => ({ source: source(index), choice: { productId: state.products[index]!.id, startFrom: { kind: "default" }, delivery: "pull-request" } })) : undefined };
    const current = { ...state, tasks: [task], inbox: [{ id: "plan", kind: "plan" as const, taskId: task.id, title: "Plan", at: state.now, blocking: false }] };
    await render(<TaskStart task={task} state={current} />);
    await click(shared ? button("Change") : button("Change product or starting point"));
    await act(async () => root.render(<TaskStart task={{ ...task, workValidating: true }} state={current} />));
    expect(button("Apply choices").disabled).toBe(true);
    await click(button("Apply choices")); expect(commands.setTaskStart).not.toHaveBeenCalled();
    await act(async () => root.render(<TaskStart task={task} state={current} />));
    expect(button("Apply choices").disabled).toBe(false);
  });

  it("keeps omitted choices visible and returns focus after editing a product", async () => {
    const task: Task = { ...state.tasks[0]!, workRows: [0, 1].map((index) => ({ source: source(index), choice: { productId: state.products[index]!.id, startFrom: { kind: "default" }, delivery: "pull-request" }, change: index ? "omitted" : "added" })), worktree: undefined };
    const current = { ...state, tasks: [task], inbox: [{ id: "plan", kind: "plan" as const, taskId: task.id, title: "Plan", at: state.now, blocking: false }] };
    await render(<TaskStart task={task} state={current} />);
    expect(host.textContent).toContain("Left out by planner");
    const opener = host.querySelector<HTMLButtonElement>(`[aria-label="Change ${state.products[1]!.name}"]`)!;
    opener.focus(); await click(opener);
    await click(button("Apply choices for"));
    expect(commands.setTaskStart).toHaveBeenCalledWith(task.id, task.workRows![1]!.choice);
    expect(document.activeElement).toBe(opener);
  });
});
