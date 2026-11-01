// Daily work first; product setup and reusable configuration stay together below it.
import {
  Bot,
  Boxes,
  CalendarClock,
  ChartColumn,
  CircleAlert,
  CircleArrowUp,
  History,
  LayoutGrid,
  Library,
  RefreshCw,
  RotateCw,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { PAGES, type Page } from "@petrina/core";
import { mod } from "../commands";
import { PAGE_CATALOG, pageRailTitle, RAIL_GROUPS } from "../pageCatalog";
import { followLink } from "../routes";
import { installUpdate, restartToUpdate, useUpdate } from "../updates";

const PAGE_ICONS: Readonly<Record<Page, LucideIcon>> = {
  board: LayoutGrid,
  history: History,
  products: Boxes,
  routines: CalendarClock,
  agents: Bot,
  analytics: ChartColumn,
  library: Library,
  settings: Settings,
};

/** Quiet update control at the foot of the rail: appears only once a signed release is found. */
export function RailUpdateItem() {
  const update = useUpdate();
  switch (update.status) {
    case "available": {
      const label = `Download and install Petrina ${update.info.version} (you have ${update.info.current}); you choose when to restart`;
      return (
        <button type="button" className="rail-update" onClick={() => void installUpdate()} title={label} aria-label={label}>
          <CircleArrowUp size={20} aria-hidden="true" />
          Update
        </button>
      );
    }
    case "downloading": {
      const pct = update.progress == null ? "Updating" : `${Math.round(update.progress * 100)}%`;
      const label = `Downloading Petrina ${update.info.version}…`;
      return (
        <div className="rail-update busy" role="status" title={label} aria-label={label}>
          <RefreshCw size={20} className="spin" aria-hidden="true" />
          {pct}
        </div>
      );
    }
    case "ready": {
      const label = `Petrina ${update.info.version} is installed; restart to use it`;
      return (
        <button type="button" className="rail-update ready" onClick={() => void restartToUpdate()} title={label} aria-label={label}>
          <RotateCw size={20} aria-hidden="true" />
          Restart
        </button>
      );
    }
    case "failed": {
      const label = `Update to Petrina ${update.info.version} failed: ${update.error}. Click to try again.`;
      return (
        <button type="button" className="rail-update failed" onClick={() => void installUpdate()} title={label} aria-label={label}>
          <CircleAlert size={20} aria-hidden="true" />
          Retry
        </button>
      );
    }
    default:
      return null;
  }
}

const FOOTER_PAGES: readonly Page[] = PAGES.filter((page) => PAGE_CATALOG[page].railSection === "footer");

export function Rail({
  view,
  blocking,
  onGo,
  hrefFor,
}: {
  view: Page;
  blocking: number;
  onGo: (page: Page) => void;
  hrefFor: (page: Page) => string;
}) {
  const renderLink = (page: Page) => {
    const entry = PAGE_CATALOG[page];
    const Icon = PAGE_ICONS[page];
    return (
      <a
        key={page}
        href={hrefFor(page)}
        className={view === page ? "on" : ""}
        aria-current={view === page ? "page" : undefined}
        onClick={(event) => followLink(event, () => onGo(page))}
        title={pageRailTitle(page, mod)}
      >
        <Icon size={20} aria-hidden="true" />
        {entry.label}
        {entry.showBlockingBadge && blocking > 0 && (
          <span className="badge" aria-label={`${blocking} waiting on you`}>
            {blocking}
          </span>
        )}
      </a>
    );
  };

  return (
    <nav className="rail" aria-label="Sections">
      {RAIL_GROUPS.map((group) => (
        <div key={group.section} className="rail-group" role="group" aria-label={group.label}>
          {group.pages.map(renderLink)}
        </div>
      ))}
      <div className="rail-end" aria-hidden="true" />
      <RailUpdateItem />
      {FOOTER_PAGES.map(renderLink)}
    </nav>
  );
}
