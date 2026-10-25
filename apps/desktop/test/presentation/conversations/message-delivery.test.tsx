vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));

import { sessionFixture } from "../../fixtures/session";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Session, StepConversation } from "../../../src/components/Session";
import { TaskDrafts } from "../../../src/drafts";
import { lookup } from "../../../src/lib";

const send = vi.fn(), remove = vi.fn();

const connected = { link: "live" };

const unsent: never[] = [];

vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: { sendMessage: (...args: unknown[]) => send(...args), removeQueued: (...args: unknown[]) => remove(...args) }, useEngineStatus: () => connected, useUnsent: () => unsent }));

const now = 1_000_000_000_000;
afterEach(() => vi.clearAllMocks());

it("defaults both composers to live sending and keeps explicit waiting and stopping choices", async () => {
  const state = sessionFixture(now), task = state.tasks.find(task => task.id === "login-loop")!;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const drafts = new TaskDrafts(); drafts.set(task.id, "Check the guest view");
  try {
    await act(async () => root.render(<Session.Composer task={task} find={lookup(state)} drafts={drafts} focusRequest={false} onFocused={() => {}} />));
    expect([...host.querySelectorAll('[role="radio"]')].map(radio => radio.textContent?.trim())).toEqual(["Send now", "Wait", "Stop and send"]);
    expect(host.querySelector('[aria-checked="true"]')?.textContent).toBe("Send now");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(send).toHaveBeenLastCalledWith(task.id, "Check the guest view", "now");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("shows a task that is waiting on you as waiting, without live delivery choices", async () => {
  const state = sessionFixture(now);
  const waiting = state.tasks.find(task => task.id === "dark-mode")!;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const drafts = new TaskDrafts(); drafts.set(waiting.id, "Use the warm grey");
  const scroller = { current: null };
  try {
    await act(async () => root.render(<Session.Log task={waiting} state={state} find={lookup(state)} scroller={scroller} onTab={() => {}} />));
    expect(host.querySelector(".session-head")?.textContent).toContain("Waiting on you");
    expect(host.querySelector(".session-head")?.textContent).not.toContain("Working");
    await act(async () => root.render(<Session.Composer task={waiting} find={lookup(state)} drafts={drafts} focusRequest={false} onFocused={() => {}} />));
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(host.textContent).toContain("Delivered as soon as an agent starts on this task.");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(send).toHaveBeenLastCalledWith(waiting.id, "Use the warm grey", "now");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("keeps terminal takeover guidance when you are driving", async () => {
  const state = sessionFixture(now), task = state.tasks.find(task => task.id === "login-loop")!;
  task.driving = { since: now, roleId: task.agent!.roleId, profileId: task.agent!.profileId, toolId: "claude-code", head: "abc" };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const drafts = new TaskDrafts();
  const scroller = { current: null };
  try {
    await act(async () => root.render(<Session.Log task={task} state={state} find={lookup(state)} scroller={scroller} onTab={() => {}} />));
    expect(host.querySelector(".session-head")?.textContent).toContain("Paused while you drive");
    await act(async () => root.render(<Session.Composer task={task} find={lookup(state)} drafts={drafts} focusRequest={false} onFocused={() => {}} />));
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(host.textContent).toContain("You're driving in your terminal. Delivered when you hand back.");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("keeps accepted guidance visible once in the step, with removal disabled", async () => {
  const state = sessionFixture(now), task = state.tasks.find(task => task.id === "login-loop")!;
  task.queued = [{ id: "message", text: "Check the guest view", at: now, recipients: { first: true, second: false }, deliveries: { first: { state: "applied" }, second: { state: "accepted", toolId: "grok" } } }];
  const line = { id: "line", from: "you" as const, text: "Check the guest view", at: now, coordinatorMessageId: "message" };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<StepConversation lines={[line]} find={lookup(state)} now={now} live taskId={task.id} />));
    expect(host.querySelectorAll(".bubble")).toHaveLength(1);
    expect(host.textContent).toContain("Heard by 1 of 2 agents");
    expect(host.textContent).toContain("Accepted by 1 agent’s tool");
    expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("shows unsupported live guidance waiting in the step before it enters the transcript", async () => {
  const state = sessionFixture(now), task = state.tasks.find(task => task.id === "login-loop")!;
  task.queued = [{ id: "message", text: "Check the guest view", at: now, deliveries: { main: { state: "waiting", reason: "unsupported", toolId: "antigravity" } } }];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<StepConversation lines={[]} find={lookup(state)} now={now} live taskId={task.id} />));
    expect(host.textContent).toContain("cannot take live guidance");
    expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(remove).toHaveBeenLastCalledWith(task.id, "message");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
