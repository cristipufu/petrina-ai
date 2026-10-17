import { usageLines, type State } from "@petrina/core";
import { TOOL_COLORS } from "../lib";

/** Each tool's usage in plain words: how much of its limits is used, and who is out until when. */
export function UsageList({ state }: { state: State }) {
  const lines = usageLines(state, state.now);
  return (
    <div className="usage-list" role="list" aria-label="Usage by tool">
      {lines.map((line) => (
        <div key={line.toolId} className="usage-row" role="listitem">
          <i style={{ background: TOOL_COLORS[line.toolId] ?? "var(--slate)" }} aria-hidden="true" />
          <strong>{line.name}</strong>
          <span className={`label ${line.tone === "out" ? "bad" : line.tone === "near" ? "warn" : ""}`}>{line.text}</span>
        </div>
      ))}
    </div>
  );
}

/** What the top bar's pool button adds for a tool close to or past its limit, or undefined when all is well. */
export function usageNote(state: State): string | undefined {
  const lines = usageLines(state, state.now).filter((line) => line.tone !== "fine");
  return lines.length ? lines.map((line) => `${line.name}: ${line.text}`).join(". ") : undefined;
}
