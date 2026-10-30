import { stepHighlight, type keyArea, type KeyArea, type Page, type State, type Task } from "@petrina/core";
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { clearFirstTaskDraft } from "./components/FirstRun";
import type { SheetTab } from "./components/TaskCard";
import { startClock } from "./engine";
import { useGlobalKeys } from "./globalKeys";
import { isTyping } from "./keyboard";
import { appActions, taskActions } from "./paletteActions";
import type { AppRoute } from "./routes";
import { applyTheme, type Theme } from "./theme";

type ActiveArea = ReturnType<typeof keyArea>;

export function useWorkspaceFocus({
  state,
  theme,
  onTheme,
  area,
  view,
  overlay,
  sheet,
  boardIds,
  inboxIds,
  currentBoardId,
  currentInboxId,
  sheetOrder,
  focusArea,
  inboxButton,
  inboxPanel,
  palette,
  paletteTask,
  shortcuts,
  modalWithoutShortcuts,
  singleKeys,
  focusedTask,
  historyPage,
  visible,
  sendAction,
  setBoardKeyboard,
  setBoardId,
  setInboxId,
  setOwner,
  setPalette,
  setShortcuts,
  setMessageFocus,
  openPalette,
  open,
  openBoard,
  openItem,
  openInbox,
  closeSheet,
  closeInbox,
  inboxKey,
  newTask,
  openSettings,
  move,
  go,
  pause,
  message,
  toast,
}: {
  state: State;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  area: ActiveArea;
  view: Page;
  overlay: boolean;
  sheet: AppRoute["sheet"];
  boardIds: readonly string[];
  inboxIds: readonly string[];
  currentBoardId: string | undefined;
  currentInboxId: string | undefined;
  sheetOrder: MutableRefObject<readonly string[]>;
  focusArea: MutableRefObject<KeyArea | undefined>;
  inboxButton: RefObject<HTMLButtonElement | null>;
  inboxPanel: RefObject<HTMLElement | null>;
  palette: boolean;
  paletteTask: Task | undefined;
  shortcuts: boolean;
  modalWithoutShortcuts: boolean;
  singleKeys: boolean;
  focusedTask: Task | undefined;
  historyPage: unknown;
  visible: (task: Task) => boolean;
  sendAction: (action: () => unknown, title: string, detail?: string) => Promise<boolean>;
  setBoardKeyboard: (value: boolean) => void;
  setBoardId: (id: string | undefined) => void;
  setInboxId: (id: string | undefined) => void;
  setOwner: (owner: KeyArea) => void;
  setPalette: (open: boolean) => void;
  setShortcuts: (open: boolean) => void;
  setMessageFocus: (taskId: string | undefined) => void;
  openPalette: () => void;
  open: (taskId: string, tab?: SheetTab, list?: "board" | "inbox" | "history", itemId?: string) => void;
  openBoard: (id: string) => void;
  openItem: (id: string) => void;
  openInbox: () => void;
  closeSheet: () => void;
  closeInbox: (keepButton: boolean) => void;
  inboxKey: () => void;
  newTask: () => void;
  openSettings: () => void;
  move: (task: Task, direction: -1 | 1) => void;
  go: (page: Page) => void;
  pause: (task: Task) => void;
  message: (task: Task) => void;
  toast: (title: string, detail?: string) => void;
}) {
  useEffect(() => startClock(), []);
  // Setup is done: a first task draft left behind (its reply was lost) has nothing to come back to.
  // Only this mode's draft: the demo never clears one still being written for the real engine.
  useEffect(() => clearFirstTaskDraft(), []);
  useEffect(() => applyTheme(theme), [theme]);
  const focusSnapshot = useRef<{ area: ActiveArea; id: string | undefined }>({ area, id: undefined });
  // While a pointer is pressed, a highlight it moves does not scroll: the button would move away before the click lands.
  const pressing = useRef(false);

  useEffect(() => {
    const down = () => {
      pressing.current = true;
      setBoardKeyboard(false);
    };
    const up = () => {
      pressing.current = false;
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("keydown", up, true);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("keydown", up, true);
      window.removeEventListener("blur", up);
    };
  }, [setBoardKeyboard]);

  const walk = (direction: -1 | 1) => {
    if (area === "board" || sheet?.list === "board") setBoardKeyboard(true);
    if (sheet) {
      if (!sheet.list) {
        toast("J and K walk the board or the inbox", "Open a task there to walk that list.");
        return;
      }
      if (sheet.list === "board" || sheet.list === "history") {
        const id = stepHighlight(boardIds, sheet.taskId, direction, sheetOrder.current);
        if (id) {
          setBoardId(id);
          open(id, sheet.tab, sheet.list);
        }
      } else {
        const id = stepHighlight(inboxIds, sheet.itemId, direction, sheetOrder.current);
        if (id) openItem(id);
      }
    } else if (area === "inbox") setInboxId(stepHighlight(inboxIds, currentInboxId, direction));
    else if (area === "board") setBoardId(stepHighlight(boardIds, currentBoardId, direction));
  };

  useEffect(() => {
    const id = area === "board" ? currentBoardId : area === "inbox" ? currentInboxId : undefined;
    const changed = focusSnapshot.current.area !== area || focusSnapshot.current.id !== id;
    const leftInbox = focusSnapshot.current.area === "inbox" && area !== "inbox";
    focusSnapshot.current = { area, id };
    // Button clicks and overlay Escape stay on the Inbox button; explicit board navigation moves on.
    if (leftInbox && document.activeElement === inboxButton.current && !focusArea.current) return;
    // Closing a palette or dialog restores its opener. Only explicit navigation moves focus.
    if (!changed && !focusArea.current) return;
    if (area !== "board" && area !== "inbox") return;
    const attr = area === "board" ? "data-task-id" : "data-inbox-id";
    const el = id
      ? Array.from(document.querySelectorAll<HTMLElement>(`[${attr}]`)).find((node) => node.getAttribute(attr) === id)
      : area === "inbox"
        ? inboxPanel.current
        : document.querySelector<HTMLElement>(view === "history" ? ".history-page" : ".board");
    if (id && !pressing.current) el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Give Tab a starting point at the highlighted item, without taking focus from a field.
    if (
      el
      && !palette
      && !modalWithoutShortcuts
      && !shortcuts
      && (focusArea.current === area || (!el.contains(document.activeElement) && !isTyping(document.activeElement as HTMLElement)))
    ) {
      el.focus({ preventScroll: true });
      focusArea.current = undefined;
    }
  }, [
    area,
    currentBoardId,
    currentInboxId,
    palette,
    modalWithoutShortcuts,
    shortcuts,
    historyPage,
    view,
    focusArea,
    inboxButton,
    inboxPanel,
  ]);

  useGlobalKeys({
    palette,
    modal: modalWithoutShortcuts || shortcuts,
    sheetOpen: Boolean(sheet),
    area,
    singleKeys,
    focusedTask,
    boardId: currentBoardId,
    inboxId: currentInboxId,
    togglePalette: () => {
      if (modalWithoutShortcuts) return;
      if (palette) setPalette(false);
      else openPalette();
    },
    closeSheet,
    // Over the board the inbox hides and hands focus to the Inbox button. Docked, it hands the keys to the
    // board, and off the board to nothing: no hidden Enter, and no palette handing them back on close.
    leaveInbox: () => {
      if (overlay) {
        closeInbox(true);
        return;
      }
      setOwner("board");
      if (inboxPanel.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    },
    newTask,
    openSettings,
    move,
    openBoard,
    openItem,
    inboxKey,
    go: (page) => {
      if (page === "board") setBoardKeyboard(true);
      go(page);
    },
    showShortcuts: () => setShortcuts(true),
    walk,
    pause,
    message,
  });

  const actions = appActions({
    state,
    singleKeys,
    newTask,
    openInbox,
    go,
    showShortcuts: () => setShortcuts(true),
    sendAction,
    theme,
    onTheme,
  });
  const forTask = taskActions({
    task: paletteTask,
    state,
    sheetOpen: sheet?.taskId === paletteTask?.id,
    open,
    message,
    focusMessage: setMessageFocus,
    pause,
    visible,
    sendAction,
  });
  return { actions, forTask };
}
