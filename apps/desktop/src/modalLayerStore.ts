/**
 * Active UI layers, reference-counted by the hooks that trap focus or dismiss popovers:
 * - `modal`: blocking editors and confirmation dialogs (`EditorPanel`, `ConfirmDialog`, take-over dialogs, etc.)
 * - `overlay`: top-level shortcut overlays (`CommandPalette`, `KeyboardShortcuts`)
 * - `popover`: transient menus and popovers (`useDismiss` when open, `ProductSwitcher` popover)
 * - `sheet`: the task workspace (`TaskSheet`), which keeps global navigation shortcuts active
 */
export type ModalLayerKind = "modal" | "overlay" | "popover" | "sheet";

export interface ModalLayerCounts {
  readonly modal: number;
  readonly overlay: number;
  readonly popover: number;
  readonly sheet: number;
}

let snapshot: ModalLayerCounts = { modal: 0, overlay: 0, popover: 0, sheet: 0 };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function acquireModalLayer(kind: ModalLayerKind): () => void {
  snapshot = { ...snapshot, [kind]: snapshot[kind] + 1 };
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    snapshot = { ...snapshot, [kind]: Math.max(0, snapshot[kind] - 1) };
    emit();
  };
}

export function getModalLayers(): ModalLayerCounts {
  return snapshot;
}

/** True when any dialog, overlay, popover, or task sheet is open above the page content. */
export function hasBlockingLayer(): boolean {
  return snapshot.modal > 0 || snapshot.overlay > 0 || snapshot.popover > 0 || snapshot.sheet > 0;
}

export function subscribeModalLayers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
