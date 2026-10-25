

import { oneTaskFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { historyItem, type Task, type TaskSource } from "@petrina/core";
import { History } from "../../../src/components/History";
import { lookup } from "../../../src/lib";

const commands = vi.hoisted(() => ({ addTask: vi.fn(async () => "task"), addLessons: vi.fn(), setTaskStart: vi.fn(async () => {}), setTaskProducts: vi.fn(async () => {}), setTaskAddition: vi.fn(async () => {}), setTaskApproval: vi.fn(), requestChanges: vi.fn(), approve: vi.fn() }));

vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: commands, useEngineStatus: () => ({ link: "live" }), useUnsent: () => [] }));

let root: Root, host: HTMLDivElement;

afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });

const state = oneTaskFixture(1_000_000_000);

async function render(node: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }

function source(index: number): TaskSource { const product = state.products[index]!; return { product: { ...product, defaultBranch: "main" }, start: { kind: "default", branch: "main" }, destination: { mode: "pull-request", kind: "new-pr", repo: product.repo, branch: "main" }, confirmed: false }; }

describe("shared product controls", () => {
  it("shows every product and delivery in a lightweight history card", async () => {
    const task: Task = { ...state.tasks[0]!, state: "done", repositories: [0, 1].map((index) => ({ productId: state.products[index]!.id, source: source(index), delivery: "local", completedStages: [], landed: { branch: index ? "release" : "main", sha: String(index) } })) };
    await render(<History page={{ items: [historyItem(task)], total: 1 }} reload={() => {}} onPosition={() => {}} find={lookup(state)} onFocus={() => {}} onOpen={() => {}} hrefFor={() => "#"} drafts={{}} />);
    expect(host.textContent).toContain(state.products[0]!.name);
    expect(host.textContent).toContain(state.products[1]!.name);
    expect(host.textContent).toContain("Committed locally to main");
    expect(host.textContent).toContain("Committed locally to release");
    expect(host.querySelectorAll(".history-card")).toHaveLength(1);
  });

  it.each([false, true])("describes cancelled shared work with partial delivery %s", async partial => {
    const task: Task = { ...state.tasks[0]!, state: "cancelled", repositories: [0, 1].map(index => ({ productId: state.products[index]!.id, source: source(index), delivery: "local", completedStages: [], landed: partial && index === 0 ? { branch: "main", sha: "a" } : undefined })) };
    await render(<History page={{ items: [historyItem(task)], total: 1 }} reload={() => {}} onPosition={() => {}} find={lookup(state)} onFocus={() => {}} onOpen={() => {}} hrefFor={() => "#"} drafts={{}} />);
    const outcome = host.querySelector(".history-outcome")!.textContent;
    if (partial) { expect(outcome).toContain("Cancelled"); expect(outcome).toContain("Committed locally to main"); expect(outcome).toContain(`${state.products[1]!.name}: Not delivered`); }
    else expect(outcome).toBe("Cancelled");
    expect(outcome).not.toContain("Delivery not confirmed");
  });
});
