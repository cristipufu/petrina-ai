import { useEffect, useSyncExternalStore } from "react";
import {
  acquireModalLayer,
  getModalLayers,
  hasBlockingLayer,
  subscribeModalLayers,
  type ModalLayerCounts,
  type ModalLayerKind,
} from "./modalLayerStore";

export { acquireModalLayer, getModalLayers, hasBlockingLayer, type ModalLayerCounts, type ModalLayerKind };

export function useModalLayer(kind: ModalLayerKind = "modal", active = true): void {
  useEffect(() => {
    if (!active) return;
    return acquireModalLayer(kind);
  }, [kind, active]);
}

export function useModalLayers(): ModalLayerCounts {
  return useSyncExternalStore(subscribeModalLayers, getModalLayers);
}

/** True when a blocking modal editor or confirmation dialog (`modal` layer) is open. */
export function useModalOpen(): boolean {
  return useModalLayers().modal > 0;
}

/** True when any transient popover or menu (`popover` layer) is open. */
export function usePopoverOpen(): boolean {
  return useModalLayers().popover > 0;
}
