import { useId, useRef, type KeyboardEventHandler, type ReactNode } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "./bits";

/** Creation and editing share placement, focus, scrolling and a footer that stays within reach. */
export function EditorPanel({ title, dialogLabel, caption, description, icon, children, footer, onClose, busy = false, closeLabel = "Close", className = "", bodyClassName = "", onKeyDown }: {
  title: string; dialogLabel?: string; caption?: string; description?: ReactNode; icon?: ReactNode; children: ReactNode; footer: ReactNode;
  onClose: () => void; busy?: boolean; closeLabel?: string; className?: string; bodyClassName?: string; onKeyDown?: KeyboardEventHandler<HTMLElement>;
}) {
  const panel = useRef<HTMLElement>(null), id = useId();
  const close = () => { if (!busy) onClose(); };
  useFocusTrap(panel, close);
  return <>
    <div className="scrim editor-scrim" onClick={close} />
    <section ref={panel} className={`sheet panel editor-panel ${className}`} role="dialog" aria-modal="true" aria-labelledby={id} aria-label={dialogLabel ?? title} aria-busy={busy || undefined} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="editor-header">
        {icon && <span className="editor-icon" aria-hidden="true">{icon}</span>}
        <div className="editor-heading">{caption && <p className="editor-caption">{caption}</p>}<h1 id={id}>{title}</h1>{description && <div className="editor-description">{description}</div>}</div>
        <button className="btn quiet small icon" aria-label={closeLabel} title="Close (Esc)" disabled={busy} onClick={close}><X size={18} aria-hidden="true" /></button>
      </header>
      <div className={`editor-body ${bodyClassName}`}><fieldset className="editor-fields" disabled={busy}>{children}</fieldset></div>
      <footer className="editor-footer">{footer}</footer>
    </section>
  </>;
}
