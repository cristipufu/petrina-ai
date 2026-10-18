// The sections down the left edge of the window.

import { Bot, Boxes, ChartColumn, History, LayoutGrid, Library, Settings } from "lucide-react";
import type { Page } from "@petrina/core";
import { mod } from "../keyboard";
import { followLink } from "../routes";

export function Rail({ view, blocking, onGo, hrefFor }: { view: Page; blocking: number; onGo: (page: Page) => void; hrefFor: (page: Page) => string }) {
  return (
    <nav className="rail" aria-label="Sections">
      <a href={hrefFor("board")} className={view === "board" ? "on" : ""} aria-current={view === "board" ? "page" : undefined} onClick={(event) => followLink(event, () => onGo("board"))} title="Board (B)">
        <LayoutGrid size={20} aria-hidden="true" />
        Board
      </a>
      <a href={hrefFor("history")} className={view === "history" ? "on" : ""} aria-current={view === "history" ? "page" : undefined} onClick={(event) => followLink(event, () => onGo("history"))} title="History">
        <History size={20} aria-hidden="true" />
        History
      </a>
      <a href={hrefFor("products")} className={view === "products" ? "on" : ""} aria-current={view === "products" ? "page" : undefined} onClick={(event) => followLink(event, () => onGo("products"))} title="Products">
        <Boxes size={20} aria-hidden="true" />
        Products
      </a>
      <a href={hrefFor("agents")} className={view === "agents" ? "on" : ""} aria-current={view === "agents" ? "page" : undefined} onClick={(event) => followLink(event, () => onGo("agents"))} title="Agents (A)">
        <Bot size={20} aria-hidden="true" />
        Agents
        {blocking > 0 && (
          <span className="badge" aria-label={`${blocking} waiting on you`}>
            {blocking}
          </span>
        )}
      </a>
      <a href={hrefFor("analytics")} className={view === "analytics" ? "on" : ""} aria-current={view === "analytics" ? "page" : undefined} onClick={(event) => followLink(event, () => onGo("analytics"))} title="Analytics">
        <ChartColumn size={20} aria-hidden="true" />
        Analytics
      </a>
      <a href={hrefFor("library")} className={view === "library" ? "on" : ""} aria-current={view === "library" ? "page" : undefined} onClick={(event) => followLink(event, () => onGo("library"))} title="Library (L)">
        <Library size={20} aria-hidden="true" />
        Library
      </a>
      <div className="rail-end" aria-hidden="true" />
      <a href={hrefFor("settings")} className={view === "settings" ? "on" : ""} aria-current={view === "settings" ? "page" : undefined} onClick={(event) => followLink(event, () => onGo("settings"))} title={`Settings (${mod},)`}>
        <Settings size={20} aria-hidden="true" />
        Settings
      </a>
    </nav>
  );
}
