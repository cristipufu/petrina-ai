// Short in-app messages in the corner: what an action did, and notices with a way to view their item.

import { useCallback, useRef, useState } from "react";
import { Bell } from "lucide-react";
import type { Target } from "./notify/words";

export interface Toast {
  id: number;
  title: string;
  lines: readonly string[];
  /** What View opens: an inbox item, like a click on its notification. */
  target?: Target;
}

/** The three latest messages; each goes after six seconds. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const showToast = useCallback((title: string, lines: readonly string[], target?: Target) => {
    const id = (toastId.current += 1);
    setToasts((list) => [...list.slice(-2), { id, title, lines, ...(target ? { target } : {}) }]);
    setTimeout(() => setToasts((list) => list.filter((entry) => entry.id !== id)), 6000);
  }, []);
  const toast = useCallback((title: string, detail?: string) => showToast(title, detail ? [detail] : []), [showToast]);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((item) => item.id !== id)), []);
  return { toasts, showToast, toast, dismiss };
}

export function Toasts({ toasts, onView }: { toasts: readonly Toast[]; onView: (toast: Toast) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((entry) => (
        <div key={entry.id} className="toast">
          <span className="avatar tone-amber" style={{ width: 28, height: 28 }} aria-hidden="true">
            <Bell size={16} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="t">{entry.title}</div>
            {entry.lines.map((line, index) => (
              <div key={index} className="s">
                {line}
              </div>
            ))}
          </div>
          {entry.target && (
            <button className="btn small" onClick={() => onView(entry)}>
              View
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
