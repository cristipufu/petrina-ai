

import { oneTaskFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewStats } from "@petrina/core";
import { ProductEditor } from "../../../src/components/ProductSettings";
import { NewTaskDialog } from "../../../src/components/NewTask";

const commands = vi.hoisted(() => ({ addTask: vi.fn(async () => "task"), addLessons: vi.fn(), setTaskStart: vi.fn(async () => {}), setTaskProducts: vi.fn(async () => {}), setTaskAddition: vi.fn(async () => {}), setTaskApproval: vi.fn(), requestChanges: vi.fn(), approve: vi.fn() }));

vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: commands, useEngineStatus: () => ({ link: "live" }), useUnsent: () => [] }));

let root: Root, host: HTMLDivElement;

afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });

const state = oneTaskFixture(1_000_000_000);

async function render(node: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }

async function click(element: Element) { await act(async () => (element as HTMLElement).click()); }

function button(text: string): HTMLButtonElement { return [...host.querySelectorAll("button")].find((element) => element.textContent?.includes(text))!; }

describe("shared product controls", () => {
  it("keeps product removal blocked when compact history records an unfinished shared delivery", async () => {
    const product = state.products[0]!;
    const current = { ...state, tasks: [], history: { revision: 1, total: 1, products: [{ productId: product.id, done: 0, cancelled: 1, shared: 1, blocked: 1 }], reviews: reviewStats([]), reviewsByProduct: {}, steps: [] } };
    await render(<ProductEditor product={product} state={current} onClose={() => {}} onRemoved={() => {}} />);
    expect(host.textContent).toContain("Resolve the unfinished shared deliveries");
    expect(host.querySelector<HTMLButtonElement>(".btn.danger")?.disabled).toBe(true);
    const resolved = { ...current, history: { ...current.history, products: [{ ...current.history.products[0]!, blocked: 0 }] } };
    await act(async () => root.render(<ProductEditor product={product} state={resolved} onClose={() => {}} onRemoved={() => {}} />));
    await click(button("Remove"));
    expect(host.textContent).toContain("No shared task history will be deleted.");
    expect(host.textContent).toContain("1 shared task stays");
    expect(host.querySelector<HTMLButtonElement>(".btn.danger")?.disabled).toBe(false);
  });

  it("preselects the current product and saves several independently chosen starting points", async () => {
    await render(<NewTaskDialog state={state} defaultProduct={state.products[0]!.id} initialTitle="A shared change" onClose={() => {}} onCreated={() => {}} />);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Choose products"]')!);
    const products = host.querySelector("fieldset")!;
    const checkboxes = products.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes[0]!.checked).toBe(true);
    await click(checkboxes[1]!);
    const delivery = host.querySelectorAll<HTMLSelectElement>(".repository-row select")[3]!;
    await act(async () => { delivery.value = "pull-request"; delivery.dispatchEvent(new Event("change", { bubbles: true })); });
    const start = host.querySelector<HTMLSelectElement>(`[aria-label="Start from for ${state.products[1]!.name}"]`)!;
    await act(async () => { start.value = "branch"; start.dispatchEvent(new Event("change", { bubbles: true })); });
    const name = host.querySelector<HTMLInputElement>(`[aria-label="Exact branch name for ${state.products[1]!.name}"]`)!;
    await act(async () => { name.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "release-2.x"); name.dispatchEvent(new Event("input", { bubbles: true })); name.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(button("Ready for the queue"));
    expect(button("Add to queue").disabled).toBe(false);
    await click(button("Add to queue"));
    expect(commands.addTask).toHaveBeenCalledWith(expect.objectContaining({ approvePlan: true, worksOn: [expect.objectContaining({ productId: state.products[0]!.id, startFrom: { kind: "default" } }), expect.objectContaining({ productId: state.products[1]!.id, startFrom: { kind: "branch", name: "release-2.x" } })] }));
  });

  it("allows no products, leaving the planner to propose the scope", async () => {
    await render(<NewTaskDialog state={state} initialTitle="Find the right products" onClose={() => {}} onCreated={() => {}} />);
    expect(host.textContent).toContain("Let the planner propose products");
    await click(button("Add to backlog"));
    expect(commands.addTask).toHaveBeenCalledWith(expect.objectContaining({ productId: "", worksOn: [], approvePlan: true, backlog: true }));
  });
});
