import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoState, type Vote } from "@petrina/core";
import { ReviewView } from "../src/components/sheet/ReviewTab";
import { lookup } from "../src/lib";

function checked(votes: Vote[]) {
  const state = createDemoState(1_000_000_000);
  const task = { ...state.tasks[0]!, findings: [{ id: "finding", text: "An older finding", severity: "blocking" as const, status: "dismissed" as const, raisedBy: "opus-high", confirmedBy: [], votes, verification: { by: "sol-high", verdict: "not-a-bug" as const, reason: "The page already shows the greeting.", at: state.now } }] };
  return renderToStaticMarkup(<ReviewView task={task} find={lookup(state)} />);
}

describe("actual voting tools", () => {
  it("uses the same independent tool count as the tally, retaining unknown historical votes", () => {
    const html = checked([
      { by: "opus-high", verdict: "real", reason: "An older reason without a proven actual voter." },
      { by: "sol-xhigh", toolId: "codex", verdict: "real", reason: "An earlier incomplete answer called this a real problem." },
      { by: "sol-high", toolId: "codex", verdict: "not-a-bug", reason: "Another recorded profile on the same tool." },
      { by: "grok-high", toolId: "grok", verdict: "real", reason: "Another independent tool confirmed the problem." },
    ]);
    expect(html).toContain("1 of 2 voters said it is real");
    expect(html).not.toContain("2 of 4 voters");
  });

  it("does not claim an actual voting tool for an older nominal vote", () => {
    const html = checked([{ by: "opus-high", verdict: "real", reason: "An older reason without a proven actual voter." }]);
    expect(html).toContain("actual voting tools were not recorded");
    expect(html).not.toContain("1 of 1 voter");
    expect(html).toContain("The page already shows the greeting.");
  });
});
