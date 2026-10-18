import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  Bell,
  BookOpen,
  Bug,
  ChartColumn,
  Check,
  Compass,
  FlaskConical,
  Globe,
  Hammer,
  Lightbulb,
  Map as MapIcon,
  Megaphone,
  Palette,
  PenLine,
  Rocket,
  Scale,
  Search,
  Shield,
  Users,
  type LucideIcon,
} from "lucide-react";
import { LONG_PIPELINE, pipelineOf, stepTip, stripOf, type AgentProfile, type Product, type Role, type RoleIcon, type Task } from "@petrina/core";
import { profileText, type Lookup } from "../lib";

export const ROLE_ICONS: Record<RoleIcon, LucideIcon> = {
  map: MapIcon,
  book: BookOpen,
  compass: Compass,
  scale: Scale,
  palette: Palette,
  hammer: Hammer,
  flask: FlaskConical,
  search: Search,
  rocket: Rocket,
  shield: Shield,
  pen: PenLine,
  lightbulb: Lightbulb,
  megaphone: Megaphone,
  chart: ChartColumn,
  globe: Globe,
  users: Users,
  bug: Bug,
};

export function Logo({ size = 24 }: { size?: number }) {
  const id = `petrina-logo-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--logo-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-to)" }} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${id})`} />
      <circle cx="33" cy="26" r="10.5" fill="none" stroke="#fff" strokeWidth="5" />
      <path d="M22.5 26v23" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
      <circle cx="42.5" cy="45.5" r="3.4" fill="#fff" />
      <circle cx="50" cy="40.5" r="2.7" fill="#fff" fillOpacity=".8" />
      <circle cx="54.2" cy="33" r="2.1" fill="#fff" fillOpacity=".6" />
    </svg>
  );
}

export function RoleAvatar({ role, size = 22 }: { role: Role | undefined; size?: number }) {
  if (!role) return null;
  const Icon = ROLE_ICONS[role.icon];
  return (
    <span className={`avatar tone-${role.tone}`} style={{ width: size, height: size }} aria-hidden="true">
      <Icon size={Math.round(size * 0.58)} strokeWidth={2.2} />
    </span>
  );
}

/** The tool, model and effort as quiet text. Cards show the model; the sheet shows all three. */
export function ProfileText({ profile, find, full = false }: { profile: AgentProfile | undefined; find: Lookup; full?: boolean }) {
  if (!profile) return null;
  return (
    <span className="profile-text" title={full ? undefined : profileText(profile, find, true)}>
      {profileText(profile, find, full)}
    </span>
  );
}

export function ProductName({ product }: { product: Product | undefined }) {
  if (!product) return null;
  return (
    <span className={`product-name tone-${product.tone}`}>
      <i aria-hidden="true" />
      {product.name}
    </span>
  );
}

function progressLabel(task: Task): string {
  const steps = pipelineOf(task);
  return `Progress: ${steps.map((step) => `${step.label}${step.state === "done" ? " done" : step.state === "current" ? ", the current step" : ""}`).join(", ")}`;
}

/**
 * A card's own pipeline, quiet: done steps checked, the current one named, skipped ones absent.
 * It stays on one line: long plans tighten and fold finished steps into one check with a count.
 * Every step is named in a tooltip on hover and on keyboard focus ("Review, next"). The strip is
 * one tab stop; the arrow keys move between its steps, and Enter or a click opens the task.
 */
export function Pipeline({ task, onActivate }: { task: Task; onActivate?: () => void }) {
  const [focused, setFocused] = useState<number>();
  const all = pipelineOf(task);
  if (all.length === 0) return null;
  const steps = stripOf(all);
  const tabStop = focused ?? Math.max(0, steps.findIndex((step) => step.state === "current"));

  const onKeyDown = (event: ReactKeyboardEvent<HTMLOListElement>) => {
    const index = focused ?? tabStop;
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: steps.length - 1 }[event.key];
    if (target !== undefined) {
      event.preventDefault();
      (event.currentTarget.children[Math.max(0, Math.min(steps.length - 1, target))] as HTMLElement | undefined)?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate?.();
    }
  };

  return (
    <ol className={`pipeline ${all.length >= LONG_PIPELINE ? "long" : ""}`} aria-label="Progress" onClick={onActivate} onKeyDown={onKeyDown} onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setFocused(undefined)}>
      {steps.map((step, index) => (
        <li
          key={`${step.label}-${index}`}
          className={`${step.state === "current" ? `current ${task.state}` : step.state} ${step.folded ? "folded" : ""}`}
          tabIndex={index === tabStop ? 0 : -1}
          aria-label={stepTip(step)}
          data-tip={stepTip(step)}
          onFocus={() => setFocused(index)}
        >
          {step.folded && step.state === "next" ? (
            <span className="count" aria-hidden="true">
              +{step.folded.length}
            </span>
          ) : (
            <span className="mark" aria-hidden="true">
              {step.state === "done" && <Check size={10} strokeWidth={3} />}
            </span>
          )}
          {step.folded && step.state === "done" && (
            <span className="count" aria-hidden="true">
              {step.folded.length}
            </span>
          )}
          {step.state === "current" && (
            <span className="name" aria-hidden="true">
              {step.label}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The same pipeline in the task sheet, with every step named. */
export function Stepper({ task }: { task: Task }) {
  const steps = pipelineOf(task);
  if (steps.length === 0) return null;
  return (
    <ol className="stepper" aria-label={progressLabel(task)}>
      {steps.map((step, index) => (
        <li key={`${step.label}-${index}`} className={step.state === "current" ? `current ${task.state}` : step.state} aria-hidden="true">
          <span className="mark">{step.state === "done" ? <Check size={12} strokeWidth={3} /> : index + 1}</span>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

/** Sent when every open menu and popover should close: a notification's item is being opened. */
const DISMISS = "petrina:dismiss";

export function dismissPopovers(): void {
  window.dispatchEvent(new Event(DISMISS));
}

/**
 * Close a popover or menu on a click outside it, on Escape, or when a notification's item opens.
 * Escape from inside it hands focus back to the button that opens it, the first in `ref`.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const top = traps.at(-1);
        if (top && ref.current && !top.contains(ref.current)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (ref.current?.contains(document.activeElement)) ref.current.querySelector("button")?.focus();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(DISMISS, close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(DISMISS, close);
    };
  }, [ref, open, close]);
}

/** Something typed and not sent yet, in any text field inside `root`. */
export function hasTyping(root: Element | null): boolean {
  if (!root) return false;
  return Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")).some(
    (field) => (field instanceof HTMLTextAreaElement || ["text", "search", "url", "email"].includes(field.type)) && field.value.trim() !== "",
  );
}

/**
 * At the top of a dialog or task sheet while a notification's item waits for it to close: what
 * is waiting, and that it opens next. Nothing typed in the dialog is lost.
 */
export function WaitingLine({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <p className="waiting-line" role="status">
      <Bell size={16} aria-hidden="true" />
      <span>
        <strong>{text}.</strong> It opens when you're done here.
      </span>
    </p>
  );
}

const TABBABLE = "a[href], button, input, select, textarea, [tabindex]";
/** Open dialogs, the topmost last: only the topmost keeps focus. */
const traps: HTMLElement[] = [];

/**
 * Keep keyboard focus inside an open dialog: Tab after its last control comes back to its first,
 * Shift+Tab before its first goes to its last, and focus that dropped out of it (the button you
 * used disappeared) comes back on the next Tab. A dialog opened over it takes over until it closes,
 * Escape included: it closes the topmost dialog only. Focus moves in when it opens and goes back to
 * whatever had it before when it closes, or to `returnTo` when that is gone, then the dialog beneath it.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, onEscape?: () => void, returnTo?: () => HTMLElement | null): void {
  // Read while rendering, before the dialog's own autofocus moves it.
  const [opener] = useState(() => document.activeElement);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const fallback = useRef(returnTo);
  fallback.current = returnTo;
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    traps.push(box);
    if (!box.contains(document.activeElement)) box.focus();
    const onKey = (event: KeyboardEvent) => {
      if (traps.at(-1) !== box) return;
      if (event.key === "Escape" && escape.current && !event.defaultPrevented) {
        event.preventDefault();
        escape.current();
        return;
      }
      if (event.key !== "Tab") return;
      const stops = Array.from(box.querySelectorAll<HTMLElement>(TABBABLE)).filter(
        (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
      );
      const first = stops[0];
      const last = stops.at(-1);
      const at = document.activeElement;
      const inside = at instanceof HTMLElement && box.contains(at) && at !== box;
      if (!first || !last) {
        event.preventDefault();
        box.focus();
      } else if (event.shiftKey ? !inside || at === first : !inside || at === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      traps.splice(traps.indexOf(box), 1);
      // Only once the dialog is gone and focus went with it: never pull it from where someone moved it.
      const at = document.activeElement;
      if (box.isConnected || (at && at !== document.body)) return;
      // A click on the scrim can leave no opener. Return to the uncovered dialog in that case.
      const back = opener instanceof HTMLElement && opener.isConnected && opener !== document.body ? opener : fallback.current?.() ?? traps.at(-1);
      back?.focus();
    };
  }, [ref, opener]);
}

/**
 * The window's size as the layout sees it: CSS pixels at the normal text size. Browser zoom makes
 * it smaller, and so does enlarged text (a window twice as wide is needed for twice the text).
 */
export function viewportSize(): { width: number; height: number } {
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const scale = 16 / root;
  return { width: Math.round(window.innerWidth * scale), height: Math.round(window.innerHeight * scale) };
}

export function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(viewportSize);
  useEffect(() => {
    const onResize = () => setSize(viewportSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/**
 * Ask before something that cannot be taken back, or that loses what the coordinator typed. It opens
 * over everything, Escape or Cancel keeps things as they were, and focus goes back where it was.
 */
export function ConfirmDialog({ title, confirm, cancel = "Cancel", onConfirm, onCancel, children }: { title: string; confirm: string; cancel?: string; onConfirm: () => void; onCancel: () => void; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(box, onCancel);
  return (
    <>
      <div className="dialog-scrim" onClick={onCancel} />
      <div ref={box} className="dialog confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={children ? `${id}-body` : undefined} tabIndex={-1}>
        <h2 className="heading" id={`${id}-title`}>
          {title}
        </h2>
        {children && (
          <div className="confirm-body" id={`${id}-body`}>
            {children}
          </div>
        )}
        <div className="foot">
          <button className="btn quiet" autoFocus onClick={onCancel}>
            {cancel}
          </button>
          <button className="btn lead" onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </>
  );
}
