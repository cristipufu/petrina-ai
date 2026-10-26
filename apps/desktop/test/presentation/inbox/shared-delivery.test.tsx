vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));

import { setupObservation } from "../../fixtures/check-setup";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { oneTaskFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkProblem, recordedCheckBatch, type Task, type TaskSource } from "@petrina/core";
import { ReviewView } from "../../../src/components/sheet/ReviewTab";
import { Ask, Inbox } from "../../../src/components/Inbox";
import { lookup } from "../../../src/lib";

const commands = vi.hoisted(() => ({ addTask: vi.fn(async () => "task"), addLessons: vi.fn(), setTaskStart: vi.fn(async () => {}), setTaskProducts: vi.fn(async () => {}), setTaskAddition: vi.fn(async () => {}), setTaskApproval: vi.fn(), requestChanges: vi.fn(), approve: vi.fn(), rerunChecks: vi.fn() }));

vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: commands, useEngineStatus: () => ({ link: "live" }), useUnsent: () => [] }));

let root: Root, host: HTMLDivElement;

afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });

const state = oneTaskFixture(1_000_000_000);

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
});

/** Modeled presentation records: the native setup/runner owns execution evidence elsewhere. */
function verifiedWork(index: number, code = 0) {
  const productId = state.products[index]!.id, before = setupObservation(productId, 0, 100), after = setupObservation(productId, 0, 200);
  after.position = "after-checks";
  return { productId, source: source(index), delivery: "pull-request" as const, completedStages: [], checkSetup: after,
    checks: { at: 200, current: true, sha: after.input.sha, tree: after.input.tree, definition: after.input.definition,
      environment: { ...after.identity!, setupAttempts: { before: before.id, after: after.id } },
      results: [{ name: `${state.products[index]!.name} tests`, command: "tests", ok: code === 0, ms: 1,
        output: code ? "Original published command failure" : "Original published command pass", execution: completeCheckExecution(code), executor: after.executor }] } };
}

for (const code of [0, 7]) it(`ships verified remaining work while retaining published peer exit ${code} and invalidated setup in raw Review`, async () => {
  const published = { ...verifiedWork(0, code), pr: { number: 7, url: "https://github.com/acme/shop/pull/7", state: "open" as const, openedAt: 200 },
    checkSetupInvalidated: { id: "published-old-declaration", kind: "requirements-changed" as const, at: 250 } };
  published.checks.current = false;
  const remaining = verifiedWork(1);
  const task: Task = { ...state.tasks[0]!, state: "needs-you", column: "ready", holdsSlot: false, stageIndex: 2,
    findings: [], acceptanceUnverified: false, repositories: [published, remaining] };
  const item = { id: "remaining-delivery", taskId: task.id, kind: "delivery" as const, title: "Your delivery check", at: state.now, blocking: false };
  const current = { ...state, tasks: [task], inbox: [item] }, find = lookup(current), original = JSON.stringify(published);
  expect(recordedCheckBatch(remaining).kind).toBe("passed");
  expect(checkProblem(task)).toBe(code ? "failing" : "unverified");
  await render(<Ask item={item} state={current} find={find} onOpen={() => {}} />);
  expect(button("Run checks again")).toBeUndefined();
  expect(button("Open a pull request")).toBeDefined();
  await click(button("Open a pull request"));
  expect(commands.approve).toHaveBeenCalledExactlyOnceWith(item.id);
  expect(commands.rerunChecks).not.toHaveBeenCalled();
  await act(async () => root.render(<ReviewView task={task} now={state.now} find={find} />));
  const publishedRow = host.querySelector(".repository-row")!;
  expect(publishedRow.textContent).toContain("Local setup needs verification after changed inputs");
  expect(publishedRow.textContent).toContain(code ? "Failed" : "Passed");
  if (!code) await click([...publishedRow.querySelectorAll("button")].find(button => button.textContent === "Show the output")!);
  expect(publishedRow.querySelector(".issues pre.check-output")?.textContent).toBe(published.checks.results[0]!.output);
  expect(JSON.stringify(published)).toBe(original);
});

it("keeps a real unfinished peer failure on the check-rerun action after another product published", async () => {
  const published = { ...verifiedWork(0), pr: { number: 7, url: "https://github.com/acme/shop/pull/7", state: "open" as const, openedAt: 200 } };
  const remaining = verifiedWork(1, 7);
  const task: Task = { ...state.tasks[0]!, state: "needs-you", column: "ready", holdsSlot: false, stageIndex: 2,
    findings: [], acceptanceUnverified: false, repositories: [published, remaining] };
  const item = { id: "unfinished-failure", taskId: task.id, kind: "delivery" as const, title: "Your delivery check", at: state.now, blocking: false };
  const current = { ...state, tasks: [task], inbox: [item] };
  expect(recordedCheckBatch(remaining).kind).toBe("product-failed");
  await render(<Ask item={item} state={current} find={lookup(current)} onOpen={() => {}} />);
  expect(host.textContent).toContain("Your call: checks still failing");
  expect(button("Open a pull request")).toBeUndefined();
  await click(button("Run checks again"));
  expect(commands.rerunChecks).toHaveBeenCalledExactlyOnceWith(item.id);
  expect(commands.approve).not.toHaveBeenCalled();
});
