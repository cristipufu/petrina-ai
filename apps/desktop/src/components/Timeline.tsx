import { CircleAlert, CircleCheck, User } from "lucide-react";
import type { TimelineEntry } from "@petrina/core";
import { ago, type Lookup } from "../lib";
import { RoleAvatar } from "./bits";

/** Timeline rows: the time on the left, an icon for who or what, and the event in words. */
export function TimelineList({ entries, now, find }: { entries: readonly TimelineEntry[]; now: number; find: Lookup }) {
  return (
    <ol className="timeline">
      {entries.map((entry) => {
        const entryRole = find.role(entry.roleId);
        return (
          <li key={entry.id} className={`tl ${entry.tone}`}>
            <span className="when">{ago(entry.at, now)}</span>
            <span className="icon" aria-hidden="true">
              {entry.tone === "you" ? (
                <User size={14} />
              ) : entry.tone === "warn" ? (
                <CircleAlert size={14} />
              ) : entry.tone === "done" ? (
                <CircleCheck size={14} />
              ) : entryRole ? (
                <RoleAvatar role={entryRole} size={24} />
              ) : (
                <span className="dot" />
              )}
            </span>
            <span className="text">
              {entryRole && entry.tone !== "you" && <span className="sr-only">{entryRole.name}: </span>}
              {entry.productId && <span className="quiet-text">{find.product(entry.productId)?.name ?? entry.productId} · </span>}{entry.text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
