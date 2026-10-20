import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoState, type Finding, type Task, type Vote } from "@petrina/core";
import { DesignView } from "../src/components/sheet/DesignTab";
import { Overview } from "../src/components/sheet/Overview";
import { ReviewView } from "../src/components/sheet/ReviewTab";
import { lookup } from "../src/lib";

function checked(votes: Vote[], extra: Partial<Finding> = {}) {
  const state = createDemoState(1_000_000_000);
  const task = { ...state.tasks[0]!, findings: [{ id: "finding", text: "An older finding", severity: "blocking" as const, status: "dismissed" as const, raisedBy: "opus-high", confirmedBy: [], votes, verification: { by: "sol-high", verdict: "not-a-bug" as const, reason: "The page already shows the greeting.", at: state.now }, ...extra }] };
  return renderToStaticMarkup(<ReviewView now={state.now} task={task} find={lookup(state)} />);
}

describe("empty review progress", () => {
  const state = createDemoState(1_000_000_000);
  const stages: NonNullable<Task["plan"]>["stages"] = [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"] },
    { id: "approval", kind: "gate", title: "Delivery check", roleId: "release-manager", gate: "delivery", profileIds: [] },
    { id: "delivery", kind: "do", title: "Delivery", roleId: "release-manager", profileIds: ["opus-high"] },
  ];
  const checks = { at: state.now, results: [{ name: "Tests", command: "bun test", ms: 1_000, ok: true, output: "" }] };
  const waiting = "Reviews start after the build.";
  const reviewing = "No findings reported yet.";
  const passed = "Nothing to fix. Every reviewer passed it.";
  const cases: { name: string; extra: Partial<Task>; message: string }[] = [
    { name: "before planning", extra: { stageIndex: -1 }, message: waiting },
    { name: "during the build", extra: { stageIndex: 0 }, message: waiting },
    { name: "before the first review report", extra: { stageIndex: 1, hunt: { stageId: "review", round: 1, reported: {}, findings: 0 } }, message: reviewing },
    { name: "while another reviewer is pending", extra: { stageIndex: 1, hunt: { stageId: "review", round: 1, reported: { "0": true }, findings: 0 } }, message: reviewing },
    { name: "before the review round settles", extra: { stageIndex: 1, hunt: { stageId: "review", round: 1, reported: { "0": true, "1": true }, findings: 0 } }, message: reviewing },
    { name: "at delivery approval", extra: { stageIndex: 2, state: "needs-you" }, message: passed },
    { name: "while publishing", extra: { stageIndex: 3 }, message: passed },
    { name: "while awaiting merge", extra: { stageIndex: 3, state: "pr-open" }, message: passed },
    { name: "after completion", extra: { stageIndex: 4, state: "done" }, message: passed },
    { name: "without a review in the plan", extra: { stageIndex: 4, state: "done", plan: { rationale: "No review", plannerProfileId: "sonnet-medium", stages: [] } }, message: waiting },
    { name: "before a later planned review", extra: { stageIndex: 2, plan: { rationale: "Two reviews", plannerProfileId: "sonnet-medium", stages: [...stages, { ...stages[1]!, id: "final-review" }] } }, message: reviewing },
  ];

  for (const kind of ["single product", "single product with checks", "several products"] as const) {
    for (const { name, extra, message } of cases) it(`shows ${name} for ${kind}`, () => {
      const task: Task = {
        ...state.tasks[0]!, state: "running", findings: [], hunt: undefined,
        plan: { rationale: "Review together", plannerProfileId: "sonnet-medium", stages },
        checks: kind === "single product with checks" ? checks : undefined,
        repositories: kind === "several products" ? state.products.slice(0, 2).map((product) => ({ productId: product.id, source: { product: { ...product, defaultBranch: "main" }, start: { kind: "default", branch: "main" }, destination: { mode: "pull-request", kind: "new-pr", repo: product.repo, branch: "main" }, confirmed: true }, delivery: "pull-request", completedStages: [], checks })) : undefined,
        ...extra,
      };
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(<ReviewView now={state.now} task={task} find={lookup(state)} />);
      const sections = kind === "several products" ? [...host.children] : [host];
      expect(sections).toHaveLength(kind === "several products" ? 3 : 1);
      for (const section of sections) {
        expect(section.textContent).toContain(message);
        for (const other of [waiting, reviewing, passed].filter((text) => text !== message)) expect(section.textContent).not.toContain(other);
      }
      if (kind === "several products") expect(sections[2]!.querySelector("h2")?.textContent).toBe("Together");
    });
  }
});

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

it("shows a tracked follow-up and one Petrina could not match", () => {
  const state = createDemoState(1_000_000_000);
  const card = state.tasks.find((task) => task.id === "footer-follow-up")!;
  const source = state.tasks.find((task) => task.id === card.followUp!.reports[0]!.taskId)!;
  const review = renderToStaticMarkup(<ReviewView now={state.now} task={source} find={lookup(state)} />);
  expect(review).toContain("Tracked in");
  expect(review).toContain(`/tasks/${card.id}`);
  expect(review).toContain("Not tracked. Petrina could not match it");
  expect(review).not.toContain("Tracked in Backlog");
  const overview = renderToStaticMarkup(<Overview separateFlow task={card} state={state} find={lookup(state)} onAboutNumbers={() => undefined} onReadSession={() => undefined} onPlan={() => undefined} />);
  for (const report of card.followUp!.reports) {
    expect(overview).toContain(report.text);
    expect(overview).toContain(report.steps);
    expect(overview).toContain(report.evidence);
    expect(overview).toContain(`/tasks/${report.taskId}`);
  }
  expect(overview).toContain("Queue for work");
  expect(overview).toContain("Products:");
});

it("labels an acceptance result that could not be checked without calling it a defect", () => {
  const state = createDemoState(1_000_000_000);
  const task = {
    ...state.tasks[0]!,
    findings: [{ id: "finding", text: "Could not verify acceptance check: A real session can write safely", severity: "blocking" as const, status: "unverified" as const, raisedBy: "sol-high", confirmedBy: [], evidence: "The account limit prevented a session." }],
  };
  const html = renderToStaticMarkup(<ReviewView now={state.now} task={task} find={lookup(state)} />);
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
    const html = renderToStaticMarkup(<ReviewView now={state.now} task={task} find={lookup(state)} />);
    expect(html).toContain("Petrina could not confirm every child process stopped. Some may still be running.");
  });
});
