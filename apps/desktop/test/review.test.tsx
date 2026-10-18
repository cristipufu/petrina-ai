import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoState, type Finding, type Vote } from "@petrina/core";
import { DesignView } from "../src/components/sheet/DesignTab";
import { ReviewView } from "../src/components/sheet/ReviewTab";
import { lookup } from "../src/lib";

function checked(votes: Vote[], extra: Partial<Finding> = {}) {
  const state = createDemoState(1_000_000_000);
  const task = { ...state.tasks[0]!, findings: [{ id: "finding", text: "An older finding", severity: "blocking" as const, status: "dismissed" as const, raisedBy: "opus-high", confirmedBy: [], votes, verification: { by: "sol-high", verdict: "not-a-bug" as const, reason: "The page already shows the greeting.", at: state.now }, ...extra }] };
  return renderToStaticMarkup(<ReviewView task={task} find={lookup(state)} />);
}

describe("actual voting tools", () => {
  it("distinguishes a builder's claim from the reopened finding and the older verification", () => {
    const html = checked([{ by: "sol-high", toolId: "codex", verdict: "real", reason: "The original problem was reproduced." }], {
      status: "open",
      verification: { by: "sol-high", verdict: "real", reason: "Checked the original code.", at: 1 },
      answer: { fixed: true, text: "Restricted the browser tools.", at: 2 },
    });
    expect(html).toContain("Builder reported a fix");
    expect(html).toContain("A later reviewer reopened this finding.");
    expect(html).toContain("Before the reported fix — Checked: real");
    expect(html).not.toContain("The builder fixed it");
  });

  it("keeps the previous verdict under earlier reviews when the changed code is checked again", () => {
    const html = checked([{ by: "sol-high", toolId: "codex", verdict: "not-a-bug", reason: "Checked the changed code." }], {
      earlierReviews: [{ at: 2, confirmedBy: [], verification: { by: "sol-high", verdict: "real", reason: "The original problem was reproduced.", at: 1 } }],
    });
    const host = document.createElement("div"); host.innerHTML = html;
    expect(host.querySelector("details")!.textContent).toContain("The original problem was reproduced.");
    expect(host.querySelector("details")!.textContent).toContain("Before the reported fix — Checked: real");
    expect(host.textContent).toContain("Checked: not a bug: 0 of 1 voter said it is real");
  });

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

it("labels an acceptance result that could not be checked without calling it a defect", () => {
  const state = createDemoState(1_000_000_000);
  const task = {
    ...state.tasks[0]!,
    findings: [{ id: "finding", text: "Could not verify acceptance check: A real session can write safely", severity: "blocking" as const, status: "unverified" as const, raisedBy: "sol-high", confirmedBy: [], evidence: "The account limit prevented a session." }],
  };
  const html = renderToStaticMarkup(<ReviewView task={task} find={lookup(state)} />);
  expect(html).toContain("Could not verify");
  expect(html).toContain("The account limit prevented a session.");
  expect(html).not.toContain("class=\"label bad\">Open");
});

it("shows why an acceptance item could not be checked and leaves its box unchecked", () => {
  const state = createDemoState(1_000_000_000);
  const task = {
    ...state.tasks[0]!,
    column: "ready" as const,
    brief: {
      summary: "Verify safe writes in a real session.",
      forUsers: [],
      areas: [],
      acceptance: [{ text: "A real session can write safely", verification: "blocked" as const, reason: "The account limit prevented a session." }],
      risks: [],
    },
  };
  const html = renderToStaticMarkup(<DesignView task={task} find={lookup(state)} />);
  expect(html).toContain("Could not verify · The account limit prevented a session.");
  expect(html).toContain('class="sr-only">Could not verify: </span>A real session can write safely');
  expect(html).not.toContain("box on");
});

describe("check cleanup", () => {
  it("shows when Petrina could not confirm that child processes stopped", () => {
    const state = createDemoState(1_000_000_000);
    const task = {
      ...state.tasks[0]!,
      findings: [],
      checks: {
        at: state.now,
        results: [{
          name: "Tests",
          command: "bun test",
          ms: 1_000,
          ok: false,
          cleanupIncomplete: true,
          output: "Petrina could not confirm every child process stopped. Some may still be running.",
        }],
      },
    };
    const html = renderToStaticMarkup(<ReviewView task={task} find={lookup(state)} />);
    expect(html).toContain("Petrina could not confirm every child process stopped. Some may still be running.");
  });
});
