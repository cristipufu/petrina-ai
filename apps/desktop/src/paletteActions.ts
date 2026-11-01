// What the command palette offers: the app's own actions, and those for the task in focus when it opened.
// Their ids carry that task's, so a highlighted row never quietly becomes another task's.

import { queueOf, type Page, type State, type Task } from "@petrina/core";
import { GLOBAL_COMMANDS, mod, TASK_COMMANDS } from "./commands";
import type { PaletteAction } from "./components/CommandPalette";
import { sim } from "./engine";
import { setSingleKeys } from "./keyboard";
import { PAGE_CATALOG, pageShortcutDisplay, PALETTE_PAGE_ORDER } from "./pageCatalog";
import type { Theme } from "./theme";
import { themes } from "./themes";
import type { UpdateState } from "./updates";

export interface PaletteUpdateControl {
  readonly supported: boolean;
  readonly update: UpdateState;
  readonly autoCheck: boolean;
  readonly onCheck: () => void;
  readonly onInstall: () => void;
  readonly onRestart: () => void;
  readonly onToggleAuto: () => void;
}

export function appActions({
  state,
  singleKeys,
  newTask,
  switchProduct,
  openInbox,
  go,
  showShortcuts,
  sendAction,
  theme,
  onTheme,
  updates,
}: {
  state: State;
  singleKeys: boolean;
  newTask: () => void;
  switchProduct?: () => void;
  openInbox: () => void;
  go: (page: Page) => void;
  showShortcuts: () => void;
  sendAction: (action: () => unknown, title: string, detail?: string) => Promise<boolean>;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  updates?: PaletteUpdateControl;
}): PaletteAction[] {
  const updateActions: PaletteAction[] = updates?.supported
    ? [
        updates.update.status === "available" || updates.update.status === "failed"
          ? {
              id: "update-install",
              label: `Update to Petrina ${updates.update.info.version}`,
              detail: `Current version ${updates.update.info.current} · Restart when you choose`,
              shortcut: "↵",
              run: updates.onInstall,
            }
          : updates.update.status === "ready"
            ? {
                id: "update-restart",
                label: `Restart to finish updating to ${updates.update.info.version}`,
                shortcut: "↵",
                run: updates.onRestart,
              }
            : {
                id: "update-check",
                label: "Check for updates",
                shortcut: "↵",
                run: updates.onCheck,
              },
        {
          id: "update-auto",
          label: `Turn daily update checks ${updates.autoCheck ? "off" : "on"}`,
          shortcut: "↵",
          run: updates.onToggleAuto,
        },
      ]
    : [];
  return [
    {
      id: "new",
      label: GLOBAL_COMMANDS["new-task"].paletteLabel!,
      shortcut: GLOBAL_COMMANDS["new-task"].shortcutDisplay,
      run: () => newTask(),
    },
    ...(state.products.length > 0
      ? [
          {
            id: "switch-product",
            label: GLOBAL_COMMANDS["switch-product"].paletteLabel!,
            detail: `${state.products.length} product${state.products.length === 1 ? "" : "s"}`,
            shortcut: GLOBAL_COMMANDS["switch-product"].shortcutDisplay,
            run: () => switchProduct?.(),
          },
        ]
      : []),
    {
      id: "pool",
      label: state.pool.paused ? "Resume pool" : "Pause pool",
      shortcut: "↵",
      run: () => {
        void sendAction(
          () => sim.setPoolPaused(!state.pool.paused),
          state.pool.paused ? "Pool resumed" : "Pool paused",
          state.pool.paused ? "New stages can start." : "Running stages finish. Nothing new starts.",
        );
      },
    },
    {
      id: "limit",
      label: "Change the pool limit",
      detail: `Currently ${state.pool.limit} · Lowering never stops anyone`,
      shortcut: "↵",
      run: () => {},
    },
    {
      id: "inbox",
      label: GLOBAL_COMMANDS.inbox.paletteLabel!,
      shortcut: GLOBAL_COMMANDS.inbox.shortcutDisplay,
      run: openInbox,
    },
    ...PALETTE_PAGE_ORDER.map((page) => ({
      id: page,
      label: `Go to ${PAGE_CATALOG[page].label}`,
      shortcut: pageShortcutDisplay(page, mod) ?? "↵",
      run: () => go(page),
    })),
    {
      id: "shortcuts",
      label: GLOBAL_COMMANDS.shortcuts.paletteLabel!,
      shortcut: GLOBAL_COMMANDS.shortcuts.shortcutDisplay,
      run: showShortcuts,
    },
    {
      id: "toggle-keys",
      label: `Turn single-key shortcuts ${singleKeys ? "off" : "on"}`,
      shortcut: "↵",
      run: () => setSingleKeys(!singleKeys),
    },
    ...updateActions,
    ...themes.map((entry) => ({
      id: `theme-${entry.id}`,
      label: `Use the ${entry.name} theme`,
      detail: entry.id === theme.id ? `Current theme. ${entry.blurb}` : entry.blurb,
      shortcut: "↵",
      run: () => onTheme(entry),
    })),
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
    {
      id: `open-task-${task.id}`,
      label: TASK_COMMANDS.open.paletteLabel(task),
      shortcut: TASK_COMMANDS.open.shortcutDisplay,
      run: () => {
        if (!sheetOpen) open(task.id);
      },
    },
    ...(TASK_COMMANDS.message.enabled(task)
      ? [
          {
            id: `message-task-${task.id}`,
            label: TASK_COMMANDS.message.paletteLabel(task),
            shortcut: TASK_COMMANDS.message.shortcutDisplay,
            run: () => {
              if (sheetOpen) message(task);
              else {
                open(task.id, "session");
                focusMessage(task.id);
              }
            },
          },
        ]
      : []),
    ...(TASK_COMMANDS.pause.enabled(task)
      ? [
          {
            id: `pause-task-${task.id}`,
            label: TASK_COMMANDS.pause.paletteLabel(task),
            shortcut: TASK_COMMANDS.pause.shortcutDisplay,
            run: () => pause(task),
          },
        ]
      : []),
    ...(TASK_COMMANDS["move-top"].enabled(task) && queue[0]?.id !== task.id
      ? [
          {
            id: `top-task-${task.id}`,
            label: TASK_COMMANDS["move-top"].paletteLabel(task),
            shortcut: TASK_COMMANDS["move-top"].shortcutDisplay,
            run: () => {
              const hidden = queue
                .slice(0, queue.findIndex((entry) => entry.id === task.id))
                .filter((entry) => !visible(entry)).length;
              void sendAction(
                () => sim.moveToTop(task.id),
                `“${task.title}” moved to the top`,
                hidden ? `It passed ${hidden} hidden task${hidden === 1 ? "" : "s"}. Their order stays the same.` : undefined,
              );
            },
          },
        ]
      : []),
  ];
}
