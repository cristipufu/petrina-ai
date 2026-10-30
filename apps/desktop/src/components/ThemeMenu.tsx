import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { themes, type Theme } from "../themes";
import { useDismiss } from "./bits";

/** The looks, grouped Light then Dark. One choice. Arrow keys move it. */
export function ThemeChoices({ theme, onTheme, onPicked, framed = false, label = "Theme", idPrefix }: {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  /** Called after a click, so a menu can close. Arrow keys change the look and leave it open. */
  onPicked?: () => void;
  /** A card of its own, for Settings. A menu already has a surface. */
  framed?: boolean;
  label?: string;
  /** Keeps the choice ids unique when the bar and Settings are both on screen. */
  idPrefix: string;
}) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, entry: Theme) => {
    const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const index = themes.findIndex((item) => item.id === entry.id);
    const next = themes[(index + delta + themes.length) % themes.length];
    if (!next) return;
    onTheme(next);
    queueMicrotask(() => document.getElementById(`${idPrefix}-${next.id}`)?.focus());
  };
  const groups = [
    ["Light", themes.filter((entry) => entry.mode === "light")],
    ["Dark", themes.filter((entry) => entry.mode === "dark")],
  ] as const;
  return (
    <div className={framed ? "theme-choices framed" : "theme-choices"} role="radiogroup" aria-label={label}>
      {groups.map(([heading, group]) => (
        <div key={heading} className="theme-group">
          <p className="theme-group-label">{heading}</p>
          {group.map((entry) => {
            const on = entry.id === theme.id;
            return (
              <button
                key={entry.id}
                id={`${idPrefix}-${entry.id}`}
                type="button"
                role="radio"
                aria-checked={on}
                className={on ? "theme-choice on" : "theme-choice"}
                onClick={() => {
                onTheme(entry);
                onPicked?.();
              }}
                onKeyDown={(event) => move(
                event,
                entry
              )}
              >
                <span className="theme-swatch" style={{ background: entry.colors.accent }} aria-hidden="true" />
                <span className="theme-copy">
                  <span className="theme-name">{entry.name}</span>
                  <span className="theme-blurb">{entry.blurb}</span>
                </span>
                {on && <Check size={16} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The top bar's theme button. The current look's name is in the label; the menu lists the rest. */
export function ThemeMenu({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  useDismiss(box, open, close);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, [open]);
  return (
    <div className="theme-menu" ref={box}>
      <button
        type="button"
        className="btn ghost icon"
        aria-label={`Theme, ${theme.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Theme, ${theme.name}`}
        onClick={() => setOpen((value) => !value)}
      >
        {theme.mode === "dark" ? <Moon size={18} /> : <Sun size={18} />}
      </button>
      {open && (
        <div className="popover theme-popover" role="dialog" aria-label="Theme">
          <ThemeChoices theme={theme} onTheme={onTheme} onPicked={close} idPrefix="theme-bar" />
        </div>
      )}
    </div>
  );
}
