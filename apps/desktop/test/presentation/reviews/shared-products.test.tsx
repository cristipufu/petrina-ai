import { oneTaskFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Task, type TaskSource } from "@petrina/core";
import { ReviewView } from "../../../src/components/sheet/ReviewTab";
import { lookup } from "../../../src/lib";

const commands = vi.hoisted(() => ({ addTask: vi.fn(async () => "task"), addLessons: vi.fn(), setTaskStart: vi.fn(async () => {}), setTaskProducts: vi.fn(async () => {}), setTaskAddition: vi.fn(async () => {}), setTaskApproval: vi.fn(), requestChanges: vi.fn(), approve: vi.fn() }));

vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: commands, useEngineStatus: () => ({ link: "live" }), useUnsent: () => [] }));

let root: Root, host: HTMLDivElement;

afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });

const state = oneTaskFixture(1_000_000_000);

async function render(node: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }

function source(index: number): TaskSource { const product = state.products[index]!; return { product: { ...product, defaultBranch: "main" }, start: { kind: "default", branch: "main" }, destination: { mode: "pull-request", kind: "new-pr", repo: product.repo, branch: "main" }, confirmed: false }; }

describe("shared product controls", () => {
  it.each([false, true])("uses the supplied clock for %s shared-product check evidence", async shared => {
    const checks = { at: state.now - 180_000, results: [{ name: "Tests", command: "bun test", ms: 10, ok: true, output: "" }] };
    const task: Task = { ...state.tasks[0]!, checks, repositories: shared ? [{ productId: state.products[0]!.id, delivery: "pull-request", source: source(0), completedStages: [], checks }] : undefined };
    await render(<ReviewView task={task} now={state.now} find={lookup(state)} />);
    expect(host.textContent).toContain("run by Petrina 3m ago");
    await act(async () => root.render(<ReviewView task={task} now={state.now + 120_000} find={lookup(state)} />));
    expect(host.textContent).toContain("run by Petrina 5m ago");
  });

  it("groups shared and unassigned findings under Together with separate builder answers", async () => {
    const task: Task = { ...state.tasks[0]!, repositories: [0, 1].map((index) => ({ productId: state.products[index]!.id, source: source(index), delivery: "pull-request", completedStages: [] })), findings: [{ id: "shared", text: "The two products disagree", productIds: state.products.slice(0, 2).map((product) => product.id), severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open", answers: {
      [state.products[0]!.id]: { fixed: true, text: "First product repaired", at: 1 },
      [state.products[1]!.id]: { fixed: false, text: "Second product still needs investigation", at: 2 },
    } }, { id: "unassigned", text: "Ownership needs a decision", severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" }] };
    await render(<ReviewView now={state.now} task={task} find={lookup(state)} />);
    const together = [...host.querySelectorAll("section")].find((section) => section.querySelector("h2")?.textContent === "Together")!;
    expect(together.textContent).toContain("The two products disagree"); expect(together.textContent).toContain("Ownership needs a decision");
    const shared = together.querySelector(".issue")!;
    expect(shared.textContent).toContain("Open");
    expect([...shared.querySelectorAll(".issue-response")].map(response => ({ title: response.querySelector("b")?.textContent, text: response.textContent }))).toEqual([
      { title: `${state.products[0]!.name}: Builder claims a fix`, text: `${state.products[0]!.name}: Builder claims a fixFirst product repaired` },
      { title: `${state.products[1]!.name}: Builder answered: not fixed`, text: `${state.products[1]!.name}: Builder answered: not fixedSecond product still needs investigation` },
    ]);
    expect(host.textContent).toContain("Product checks: Not run");
    expect(host.textContent).not.toContain("Every reviewer passed");
    for (const section of host.querySelectorAll(".repository-row")) expect(section.textContent).toContain("No findings assigned only to this product. Shared findings appear under Together.");
  });

  it.each([
    [-1, "Reviews start after the build."],
    [0, "No findings reported yet."],
    [1, "Nothing to fix. Every reviewer passed it."],
  ])("keeps another product's empty review accurate at stage %s without pointing to an empty Together", async (stageIndex, empty) => {
    const task: Task = { ...state.tasks[0]!, state: "running", stageIndex,
      plan: { rationale: "Review the products together", plannerProfileId: "sonnet-medium", stages: [{ id: "review", kind: "review-chain", roleId: "code-reviewer", title: "Review", profileIds: ["opus-high", "sol-high"] }] },
      repositories: [0, 1].map((index) => ({ productId: state.products[index]!.id, source: source(index), delivery: "pull-request", completedStages: [] })),
      findings: [{ id: "only-first-product", text: "A note for the first product", productIds: [state.products[0]!.id], severity: "suggestion", raisedBy: "petrina", confirmedBy: [], status: "open" }],
    };
    await render(<ReviewView now={state.now} task={task} find={lookup(state)} />);
    const products = host.querySelectorAll(".repository-row");
    expect(products[0]!.textContent).toContain("A note for the first product");
    expect(products[1]!.textContent).toContain(empty);
    expect(products[1]!.textContent).not.toContain("Shared findings appear under Together");
    const together = [...host.querySelectorAll("section")].find((section) => section.querySelector("h2")?.textContent === "Together")!;
    expect(together.textContent).toContain(empty);
    expect(together.querySelectorAll(".issue")).toHaveLength(0);
  });

  it("does not claim reviews or the deleted tests check passed before they ran", async () => {
    const task: Task = { ...state.tasks[0]!, stageIndex: -1, state: "running", findings: [], checks: undefined, repositories: [0, 1].map((index) => ({ productId: state.products[index]!.id, source: source(index), delivery: "pull-request", completedStages: [] })) };
    await render(<ReviewView now={state.now} task={task} find={lookup(state)} />);
    expect(host.textContent).not.toContain("passed");
    expect(host.textContent).not.toContain("Passed");
    expect(host.textContent).toContain("Deleted or skipped tests: Not run");
    expect(host.textContent).toContain("Product checks: Not run");
    for (const section of host.querySelectorAll(".repository-row")) expect(section.textContent).toContain("Reviews start after the build.");
    expect(host.textContent).not.toContain("No findings assigned only to this product");
    const together = [...host.querySelectorAll("section")].find((section) => section.querySelector("h2")?.textContent === "Together")!;
    expect(together.textContent).toContain("Reviews start after the build.");
  });

  it("keeps an empty review in progress distinct from completed review results", async () => {
    const task: Task = { ...state.tasks[0]!, plan: { rationale: "Review together", plannerProfileId: "sonnet-medium", stages: [{ id: "review", kind: "review-chain", roleId: "code-reviewer", title: "Review", profileIds: ["opus-high", "sol-high"] }] }, stageIndex: 0, state: "running", findings: [], repositories: [0, 1].map((index) => ({ productId: state.products[index]!.id, source: source(index), delivery: "pull-request", completedStages: [] })), hunt: { stageId: "review", round: 1, reported: {}, findings: 0 } };
    await render(<ReviewView now={state.now} task={task} find={lookup(state)} />);
    for (const section of host.querySelectorAll(".repository-row")) expect(section.textContent).toContain("No findings reported yet.");
    expect(host.textContent).not.toContain("Every reviewer passed");
    expect(host.textContent).not.toContain("No findings assigned only to this product");
  });
});
