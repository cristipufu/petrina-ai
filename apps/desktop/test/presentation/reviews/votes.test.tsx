import { oneTaskFixture } from "../../fixtures/state";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Finding, type Vote } from "@petrina/core";
import { ReviewView } from "../../../src/components/sheet/ReviewTab";
import { lookup } from "../../../src/lib";

function checked(votes: Vote[], extra: Partial<Finding> = {}) {
  const state = oneTaskFixture(1_000_000_000);
  const task = { ...state.tasks[0]!, findings: [{ id: "finding", text: "An older finding", severity: "blocking" as const, status: "dismissed" as const, raisedBy: "opus-high", confirmedBy: [], votes, verification: { by: "sol-high", verdict: "not-a-bug" as const, reason: "The page already shows the greeting.", at: state.now }, ...extra }] };
  return renderToStaticMarkup(<ReviewView now={state.now} task={task} find={lookup(state)} />);
}

describe("actual voting tools", () => {
  for (const unresolved of [false, true])
it(`explains an Important finding's ${unresolved ? "unresolved" : "pending"} verification with its actual tool count`, () => {
    const reason = "No ready independent tool could give the required third answer.";
    const html = checked([
      { by: "sol-xhigh", toolId: "codex", verdict: "real", reason: "An earlier answer corrected on the same tool." },
      { by: "sol-high", toolId: "codex", verdict: "not-a-bug", reason: "Could not reproduce." },
      { by: "grok-high", toolId: "grok", verdict: "nit", reason: "Only cosmetic." },
    ], { status: "open", verification: undefined, ...(unresolved ? { unresolved: { at: 1, reason } } : {}) });
    expect(html).toContain(unresolved ? "Still Important: verification is unresolved." : "Still Important: waiting for the remaining verifier answers.");
    expect(html).toContain("Votes from 2 tools: 1 minor, 1 not a bug. 1 of 2 say the problem is real.");
    expect(html).toContain("Could not reproduce.");
    expect(html).toContain("Only cosmetic.");
    expect(html).not.toContain("Checked:");
    expect(html).not.toContain("An earlier answer corrected");
    if (unresolved) expect(html).toContain(reason);
  });

  it("counts a partial ballot and keeps unrecorded tool identities unknown without inventing a final verdict", () => {
    const html = checked([{ by: "sol-high", toolId: "codex", verdict: "nit", reason: "Only cosmetic." }], { status: "open", verification: undefined });
    expect(html).toContain("Still Important: waiting for the remaining verifier answers.");
    expect(html).toContain("Votes from 1 tool: 1 minor.");
    expect(html).not.toContain("Checked:");
    const older = checked([{ by: "sol-high", verdict: "nit", reason: "An older answer with no recorded tool." }], { status: "open", verification: undefined });
    expect(older).toContain("The actual voting tools were not recorded.");
    expect(older).not.toContain("Votes from 1 tool");
  });

  it("keeps unresolved decisions and counts attributed to before a later reported fix", () => {
    const unresolved = { at: 1, reason: "The required third answer was unavailable." };
    const votes: Vote[] = [{ by: "sol-high", toolId: "codex", verdict: "not-a-bug", reason: "Could not reproduce." }, { by: "grok-high", toolId: "grok", verdict: "nit", reason: "Only cosmetic." }];
    const html = checked(votes, { status: "fixed", verification: undefined, unresolved, answer: { at: 2, fixed: true, text: "Repaired later." }, earlierReviews: [{ at: 2, confirmedBy: [], unresolved, votes }] });
    expect(html).toContain("Before the reported fix — verification is unresolved.");
    expect(html).toContain("Before the reported fix — Votes from 2 tools:");
    expect(html).toContain("Before the reported fix — verification was unresolved.");
    expect(html).toContain(unresolved.reason);
  });

  it("distinguishes a builder's claim from the reopened finding and the older verification", () => {
    const html = checked([{ by: "sol-high", toolId: "codex", verdict: "real", reason: "The original problem was reproduced." }], {
      status: "open",
      verification: { by: "sol-high", verdict: "real", reason: "Checked the original code.", at: 1 },
      answer: { fixed: true, text: "Restricted the browser tools.", at: 2 },
    });
    expect(html).toContain("Builder reported a fix");
    expect(html).toContain("A later reviewer reopened this finding.");
    expect(html).toContain("Before the reported fix — Checked: must be fixed in this change.");
    expect(html).toContain("Before the reported fix — Votes from 1 tool: 1 must be fixed in this change.");
    expect(html).toContain("Votes before the reported fix");
    expect(html).not.toContain("The builder fixed it");
  });

  it("keeps the previous verdict under earlier reviews when the changed code is checked again", () => {
    const html = checked([{ by: "sol-high", toolId: "codex", verdict: "not-a-bug", reason: "Checked the changed code." }], {
      earlierReviews: [{ at: 2, confirmedBy: [], verification: { by: "sol-high", verdict: "real", reason: "The original problem was reproduced.", at: 1 }, votes: [{ by: "opus-high", toolId: "claude-code", verdict: "pre-existing", reason: "The problem was there before." }] }],
    });
    const host = document.createElement("div"); host.innerHTML = html;
    const earlier = [...host.querySelectorAll("details")].find(details => details.querySelector("summary")?.textContent === "Earlier reviews")!;
    expect(earlier.textContent).toContain("The original problem was reproduced.");
    expect(earlier.textContent).toContain("Before the reported fix — Checked: must be fixed in this change.");
    expect(earlier.textContent).toContain("a real problem, already there before this change. The problem was there before.");
    expect(host.textContent).toContain("Checked: not a bug.");
    expect(host.textContent).toContain("Votes from 1 tool: 1 not a bug.");
  });

  it("uses the same independent tool count as the tally, retaining unknown historical votes", () => {
    const html = checked([
      { by: "opus-high", verdict: "real", reason: "An older reason without a proven actual voter." },
      { by: "sol-xhigh", toolId: "codex", verdict: "real", reason: "An earlier incomplete answer called this a real problem." },
      { by: "sol-high", toolId: "codex", verdict: "not-a-bug", reason: "Another recorded profile on the same tool." },
      { by: "grok-high", toolId: "grok", verdict: "real", reason: "Another independent tool confirmed the problem." },
    ]);
    expect(html).toContain("Votes from 2 tools: 1 must be fixed in this change, 1 not a bug. 1 of 2 say the problem is real.");
    expect(html).not.toContain("2 of 4 voters");
    expect(html).not.toContain("An earlier incomplete answer");
    expect(html).not.toContain("An older reason without");
    expect(html).toContain("Another recorded profile on the same tool.");
  });

  it("does not claim an actual voting tool for an older nominal vote", () => {
    const html = checked([{ by: "opus-high", verdict: "real", reason: "An older reason without a proven actual voter." }]);
    expect(html).toContain("actual voting tools were not recorded");
    expect(html).not.toContain("1 of 1 voter");
    expect(html).toContain("The page already shows the greeting.");
  });
});

describe("verdict explanations", () => {
  const tools = ["grok", "claude-code", "codex", "antigravity"];

  const profiles = ["grok-high", "opus-high", "sol-high", "argon-high"];

  const ballot = (verdicts: Vote["verdict"][]): Vote[] => verdicts.map((verdict, index) => ({ by: profiles[index]!, toolId: tools[index]!, verdict, reason: `Independent reason ${index + 1}` }));

  it.each([
    ["pre-existing", "a real problem, already there before this change", "3 already there before this change, 1 must be fixed in this change. All 4 say the problem is real."],
    ["not-a-bug", "not a bug", "3 not a bug, 1 must be fixed in this change. 1 of 4 say the problem is real."],
    ["nit", "a real but minor problem", "3 minor, 1 must be fixed in this change. All 4 say the problem is real."],
  ] as const)("explains real versus %s without treating other bug verdicts as rejection", (verdict, outcome, distribution) => {
    const host = document.createElement("div");
    host.innerHTML = checked(ballot(["real", verdict, verdict, verdict]), { verification: { by: "opus-high", verdict, at: 1, reason: "Recorded decision." } });
    expect(host.textContent).toContain(`Checked: ${outcome}.`);
    expect(host.textContent).toContain(`Votes from 4 tools: ${distribution}`);
    expect(host.textContent).not.toContain("voters said it is real");
    const details = host.querySelector("details")!;
    expect(details.querySelector("summary")!.textContent).toBe("Tool verdicts and reasons");
    expect(details.querySelectorAll("p")).toHaveLength(4);
    for (let i = 1; i <= 4; i++) expect(details.textContent).toContain(`Independent reason ${i}`);
  });

  for (const verdict of ["real", "pre-existing", "nit", "not-a-bug"] as const)
it.each([1, 2, 3])(`states the actual tool count for unanimous ${verdict} with %s tools`, count => {
    const html = checked(ballot(Array.from({ length: count }, () => verdict)));
    expect(html).toContain(`Votes from ${count} tool${count === 1 ? "" : "s"}: ${count} `);
  });

  it("shows a two-tool split using the recorded outcome, even when a tally would decide differently", () => {
    const html = checked(ballot(["real", "pre-existing"]));
    expect(html).toContain("Checked: not a bug.");
    expect(html).toContain("Votes from 2 tools: 1 must be fixed in this change, 1 already there before this change. All 2 say the problem is real.");
  });
});
