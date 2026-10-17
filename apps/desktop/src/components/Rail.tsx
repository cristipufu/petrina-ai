// The sections down the left edge of the window.

import { Bot, Boxes, ChartColumn, LayoutGrid, Library, Settings } from "lucide-react";
import type { Page } from "@petrina/core";
import { mod } from "../keyboard";

export function Rail({ view, blocking, onGo }: { view: Page; blocking: number; onGo: (page: Page) => void }) {
  return (
    <nav className="rail" aria-label="Sections">
      <button className={view === "board" ? "on" : ""} aria-current={view === "board" ? "page" : undefined} onClick={() => onGo("board")} title="Board (B)">
        <LayoutGrid size={20} aria-hidden="true" />
        Board
      </button>
      <button className={view === "products" ? "on" : ""} aria-current={view === "products" ? "page" : undefined} onClick={() => onGo("products")} title="Products">
        <Boxes size={20} aria-hidden="true" />
        Products
      </button>
      <button className={view === "agents" ? "on" : ""} aria-current={view === "agents" ? "page" : undefined} onClick={() => onGo("agents")} title="Agents (A)">
        <Bot size={20} aria-hidden="true" />
        Agents
        {blocking > 0 && (
          <span className="badge" aria-label={`${blocking} waiting on you`}>
            {blocking}
          </span>
        )}
      </button>
      <button className={view === "analytics" ? "on" : ""} aria-current={view === "analytics" ? "page" : undefined} onClick={() => onGo("analytics")} title="Analytics">
        <ChartColumn size={20} aria-hidden="true" />
        Analytics
      </button>
      <button className={view === "library" ? "on" : ""} aria-current={view === "library" ? "page" : undefined} onClick={() => onGo("library")} title="Library (L)">
        <Library size={20} aria-hidden="true" />
        Library
      </button>
      <button className={view === "settings" ? "on" : ""} aria-current={view === "settings" ? "page" : undefined} onClick={() => onGo("settings")} title={`Settings (${mod},)`}>
        <Settings size={20} aria-hidden="true" />
        Settings
      </button>
    </nav>
  );
}
