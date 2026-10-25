vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));

import { oneTaskFixture } from "../../fixtures/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Task, type TaskSource } from "@petrina/core";
import { Ask, Inbox } from "../../../src/components/Inbox";
import { lookup } from "../../../src/lib";

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
