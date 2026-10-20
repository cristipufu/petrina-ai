import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createDemoState, type State } from "@petrina/core";
import { useNotices } from "../src/notify/useNotices";

const environment = vi.hoisted(() => ({ desktop: false, state: undefined as State | undefined, listeners: new Set<() => void>(), badge: vi.fn() }));
vi.mock("../src/engine", () => ({ mode: "engine", get desktop() { return environment.desktop; }, sim: { getState: () => environment.state!, synced: () => true, subscribe: (listener: () => void) => { environment.listeners.add(listener); return () => environment.listeners.delete(listener); } } }));
vi.mock("../src/notify/channels", () => ({
  platform: () => "mac", browserPermission: () => "denied",
  BrowserNotices: class { show() { return false; } waiting() {} },
  shell: { badge: environment.badge, onClick: async () => () => {}, onRelaunch: async () => () => {}, show: () => false },
}));

it.each([false, true])("excludes quiet screen requests from the %s desktop badge or browser title", async desktop => {
  environment.desktop = desktop; environment.badge.mockClear();
  const base = createDemoState(1_000_000_000), taskId = base.tasks[0]!.id;
  const screen = { id: "screen", taskId, kind: "screen" as const, title: "Screen", blocking: false, at: base.now };
  const question = { ...screen, id: "question", kind: "question" as const, title: "Question" };
  environment.state = { ...base, inbox: [screen, question] };
  function View() { useNotices({ onJump: () => {}, onToast: () => {} }); return null; }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<View />));
    if (desktop) expect(environment.badge).toHaveBeenLastCalledWith(1); else expect(document.title).toBe("(1) Petrina");
    await act(async () => { environment.state = { ...environment.state!, inbox: [screen] }; for (const listener of environment.listeners) listener(); });
    if (desktop) expect(environment.badge).toHaveBeenLastCalledWith(0); else expect(document.title).toBe("Petrina");
  } finally { await act(async () => root.unmount()); host.remove(); document.title = "Petrina"; }
});
