import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState, historyItem, reviewStats, type Task, type TaskSource } from "@petrina/core";
import { Ask, Inbox } from "../src/components/Inbox";
import { History } from "../src/components/History";
import { ProductEditor } from "../src/components/ProductSettings";
import { NewTaskDialog } from "../src/components/NewTask";
import { TaskStart } from "../src/components/TaskStart";
import { ReviewView } from "../src/components/sheet/ReviewTab";
import { lookup } from "../src/lib";

const commands = vi.hoisted(() => ({ addTask: vi.fn(async () => "task"), addLessons: vi.fn(), setTaskStart: vi.fn(async () => {}), setTaskProducts: vi.fn(async () => {}), setTaskAddition: vi.fn(async () => {}), setTaskApproval: vi.fn(), requestChanges: vi.fn(), approve: vi.fn() }));
vi.mock("../src/engine", () => ({ mode: "demo", desktop: false, sim: commands, useEngineStatus: () => ({ link: "live" }), useUnsent: () => [] }));
let root: Root, host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });
const state = createDemoState(1_000_000_000);
async function render(node: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(node)); }
async function click(element: Element) { await act(async () => (element as HTMLElement).click()); }
function button(text: string): HTMLButtonElement { return [...host.querySelectorAll("button")].find((element) => element.textContent?.includes(text))!; }
function source(index: number): TaskSource { const product = state.products[index]!; return { product: { ...product, defaultBranch: "main" }, start: { kind: "default", branch: "main" }, destination: { mode: "pull-request", kind: "new-pr", repo: product.repo, branch: "main" }, confirmed: false }; }

describe("shared product controls", () => {
  it("resets lesson selections when the same offer changes, and handles duplicate lines independently", async () => {
    const task = state.tasks[0]!;
    const item = { id: "lessons", taskId: task.id, kind: "learnings" as const, title: "Lessons", body: "- First lesson\n- Second lesson", at: state.now, blocking: false };
    const show = (body: string) => <Ask item={{ ...item, body }} state={state} find={lookup(state)} onOpen={() => {}} />;
    await render(show(item.body));
    await click(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!);
    expect(button("Add 1 of 2")).toBeDefined();
    await act(async () => root.render(show("- Second lesson\n- Same lesson\n- Same lesson")));
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(box => box.checked)).toEqual([true, true, true]);
    await click(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!);
    await click(button("Add 2 of 3"));
    expect(commands.addLessons).toHaveBeenCalledExactlyOnceWith(item.id, [0, 2]);
  });

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

  it.each([false, true])("uses the supplied clock for %s shared-product check evidence", async shared => {
    const checks = { at: state.now - 180_000, results: [{ name: "Tests", command: "bun test", ms: 10, ok: true, output: "" }] };
    const task: Task = { ...state.tasks[0]!, checks, repositories: shared ? [{ productId: state.products[0]!.id, delivery: "pull-request", source: source(0), completedStages: [], checks }] : undefined };
    await render(<ReviewView task={task} now={state.now} find={lookup(state)} />);
    expect(host.textContent).toContain("run by Petrina 3m ago");
    await act(async () => root.render(<ReviewView task={task} now={state.now + 120_000} find={lookup(state)} />));
    expect(host.textContent).toContain("run by Petrina 5m ago");
  });
  it("offers an operable send-back form after shared release preparation fails", async () => {
    const task: Task = { ...state.tasks[0]!, state: "needs-you", statusLine: "Delivery preparation needs you", repositories: [0, 1].map((index) => ({ productId: state.products[index]!.id, source: source(index), delivery: index ? "release" : "pull-request", completedStages: [] })) };
    const item = { id: "release-preparation", taskId: task.id, kind: "delivery" as const, title: "Your delivery check", body: "Shop API: getting the release ready failed. Nothing was published. Your approved work is saved; try delivery again or send it back with a note.", at: state.now, blocking: false };
    const current = { ...state, tasks: [task], inbox: [item] };
    await render(<Inbox state={current} find={lookup(current)} overlay={false} selectedId={item.id} onOpen={() => {}} onOpenItem={() => {}} onFocus={() => {}} onClose={() => {}} />);
    expect(host.textContent).toContain("Shop API: getting the release ready failed");
    expect(host.querySelector(".ask-actions .btn.lead")).not.toBeNull();
    await click(button("Send back"));
    const note = host.querySelector<HTMLInputElement>('input[aria-label="What should change?"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(note, "Change the greeting before release");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => note.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(commands.requestChanges).toHaveBeenCalledWith(item.id, "Change the greeting before release");
  });

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
