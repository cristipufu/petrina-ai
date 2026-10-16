import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import {
  BookOpen,
  Check,
  Compass,
  FlaskConical,
  Hammer,
  Map as MapIcon,
  Palette,
  Rocket,
  Scale,
  Search,
  type LucideIcon,
} from "lucide-react";
import { pipelineOf, stepTip, type AgentProfile, type Product, type Role, type RoleIcon, type Task } from "@petrina/core";
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
};

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="petrina-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8f7dff" />
          <stop offset="1" stopColor="#5338e6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#petrina-g)" />
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
 * Every step is named in a tooltip on hover and on keyboard focus ("Review, next"). The strip is
 * one tab stop; the arrow keys move between its steps, and Enter or a click opens the task.
 */
export function Pipeline({ task, onActivate }: { task: Task; onActivate?: () => void }) {
  const [focused, setFocused] = useState<number>();
  const steps = pipelineOf(task);
  if (steps.length === 0) return null;
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
    <ol className="pipeline" aria-label="Progress" onClick={onActivate} onKeyDown={onKeyDown} onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setFocused(undefined)}>
      {steps.map((step, index) => (
        <li
          key={`${step.label}-${index}`}
          className={step.state === "current" ? `current ${task.state}` : step.state}
          tabIndex={index === tabStop ? 0 : -1}
          aria-label={stepTip(step)}
          data-tip={stepTip(step)}
          onFocus={() => setFocused(index)}
        >
          <span className="mark" aria-hidden="true">
            {step.state === "done" && <Check size={10} strokeWidth={3} />}
          </span>
          {step.state === "current" && <span aria-hidden="true">{step.label}</span>}
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

/** Close a popover or menu on a click outside it or on Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ref, open, close]);
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
