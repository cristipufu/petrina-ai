// What the command palette offers: the app's own actions, and those for the task in focus when it opened.
// Their ids carry that task's, so a highlighted row never quietly becomes another task's.

import { queueOf, type Page, type State, type Task } from "@petrina/core";
import type { PaletteAction } from "./components/CommandPalette";
import { sim } from "./engine";
import { mod, setSingleKeys } from "./keyboard";

export function appActions({ state, singleKeys, newTask, openInbox, go, showShortcuts, sendAction }: { state: State; singleKeys: boolean; newTask: () => void; openInbox: () => void; go: (page: Page) => void; showShortcuts: () => void; sendAction: (action: () => unknown, title: string, detail?: string) => Promise<boolean> }): PaletteAction[] {
  return [
    { id: "new", label: "New task", shortcut: `${mod}N`, run: () => newTask() },
    { id: "pool", label: state.pool.paused ? "Resume pool" : "Pause pool", shortcut: "↵", run: () => { void sendAction(() => sim.setPoolPaused(!state.pool.paused), state.pool.paused ? "Pool resumed" : "Pool paused", state.pool.paused ? "New stages can start." : "Running stages finish. Nothing new starts."); } },
    { id: "limit", label: "Change the pool limit", detail: `Currently ${state.pool.limit} · Lowering never stops anyone`, shortcut: "↵", run: () => {} },
    { id: "inbox", label: "Open the inbox", shortcut: "I", run: openInbox },
    ...(["board", "products", "agents", "analytics", "library", "settings"] as Page[]).map((page) => ({ id: page, label: `Go to ${page[0]!.toUpperCase()}${page.slice(1)}`, shortcut: ({ board: "B", products: "↵", agents: "A", analytics: "↵", library: "L", settings: `${mod},` })[page], run: () => go(page) })),
    { id: "shortcuts", label: "Keyboard shortcuts", shortcut: "?", run: showShortcuts },
    { id: "toggle-keys", label: `Turn single-key shortcuts ${singleKeys ? "off" : "on"}`, shortcut: "↵", run: () => setSingleKeys(!singleKeys) },
  ];
}

interface TaskContext {
  task: Task | undefined;
  state: State;
  sheetOpen: boolean;
  open: (taskId: string, tab?: "session") => void;
  message: (task: Task) => void;
  focusMessage: (taskId: string) => void;
  pause: (task: Task) => void;
  visible: (task: Task) => boolean;
  sendAction: (action: () => unknown, title: string, detail?: string) => Promise<boolean>;
}

export function taskActions({ task, state, sheetOpen, open, message, focusMessage, pause, visible, sendAction }: TaskContext): PaletteAction[] {
  if (!task) return [];
  const queue = queueOf(state.tasks);
  return [
    { id: `open-task-${task.id}`, label: `Open “${task.title}”`, shortcut: "↵", run: () => { if (!sheetOpen) open(task.id); } },
    { id: `message-task-${task.id}`, label: `Message “${task.title}”`, shortcut: "M", run: () => { if (sheetOpen) message(task); else { open(task.id, "session"); focusMessage(task.id); } } },
    { id: `pause-task-${task.id}`, label: `${task.state === "queued" ? (task.held ? "Release" : "Hold") : task.state === "paused" ? "Resume" : "Pause"} “${task.title}”`, shortcut: "P", run: () => pause(task) },
    ...(task.state === "queued" && queue[0]?.id !== task.id
      ? [
          {
            id: `top-task-${task.id}`,
            label: `Move “${task.title}” to top`,
            shortcut: "↵",
            run: () => {
              const hidden = queue.slice(0, queue.findIndex((entry) => entry.id === task.id)).filter((entry) => !visible(entry)).length;
              void sendAction(() => sim.moveToTop(task.id), `“${task.title}” moved to the top`, hidden ? `It passed ${hidden} hidden task${hidden === 1 ? "" : "s"}. Their order stays the same.` : undefined);
            },
          },
        ]
      : []),
  ];
}
