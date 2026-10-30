// Daily work first; product setup and reusable configuration stay together below it.
import { Bot, Boxes, CalendarClock, ChartColumn, History, LayoutGrid, Library, Settings } from "lucide-react";
import type { Page } from "@petrina/core";
import { mod } from "../keyboard";
import { followLink } from "../routes";

const GROUPS = [
  { label: "Work", items: [
    { page: "board", label: "Board", title: "Board (B)", Icon: LayoutGrid },
    { page: "history", label: "History", title: "History", Icon: History },
    { page: "agents", label: "Agents", title: "Agents (A)", Icon: Bot },
    { page: "analytics", label: "Analytics", title: "Analytics", Icon: ChartColumn },
  ] },
  { label: "Products and configuration", items: [
    { page: "products", label: "Products", title: "Products", Icon: Boxes },
    { page: "routines", label: "Routines", title: "Routines", Icon: CalendarClock },
    { page: "library", label: "Library", title: "Library (L)", Icon: Library },
  ] },
] as const;

export function Rail({ view, blocking, onGo, hrefFor }: { view: Page; blocking: number; onGo: (page: Page) => void; hrefFor: (page: Page) => string }) {
  return <nav className="rail" aria-label="Sections">
    {GROUPS.map(group => <div key={group.label} className="rail-group" role="group" aria-label={group.label}>
      {group.items.map(({
        page,
        label,
        title,
        Icon
      }) => <a
        key={page}
        href={hrefFor(page)}
        className={view === page ? "on" : ""}
        aria-current={view === page ? "page" : undefined}
        onClick={event => followLink(
        event,
        () => onGo(page)
      )}
        title={title}
      >
        <Icon size={20} aria-hidden="true" />{label}
        {page === "agents" && blocking > 0 && <span className="badge" aria-label={`${blocking} waiting on you`}>{blocking}</span>}
      </a>)}
    </div>)}
    <div className="rail-end" aria-hidden="true" />
    <a
      href={hrefFor("settings")}
      className={view === "settings" ? "on" : ""}
      aria-current={view === "settings" ? "page" : undefined}
      onClick={event => followLink(
      event,
      () => onGo("settings")
    )}
      title={`Settings (${mod},)`}
    ><Settings
      size={20}
      aria-hidden="true"
    />Settings</a>
  </nav>;
}
