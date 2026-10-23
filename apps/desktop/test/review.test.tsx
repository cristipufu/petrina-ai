import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoState, type Finding, type Task, type Vote } from "@petrina/core";
import { DesignView } from "../src/components/sheet/DesignTab";
import { Overview } from "../src/components/sheet/Overview";
import { ReviewView } from "../src/components/sheet/ReviewTab";
import { lookup } from "../src/lib";
import { acceptanceFixture, laterTester } from "./acceptanceFixture";

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
  for (const unresolved of [false, true]) it(`explains an Important finding's ${unresolved ? "unresolved" : "pending"} verification with its actual tool count`, () => {
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
  it("uses the demo tools' names for all four recorded voters", () => {
    const state = createDemoState(1_000_000_000);
    const task = state.tasks.find(task => task.findings.some(finding => finding.votes?.length))!;
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<ReviewView task={task} now={state.now} find={lookup(state)} />);
    const details = host.querySelector("details")!;
    expect(details.textContent).toContain("Grok · Grok 4.7");
    expect(details.textContent).toContain("Antigravity · Gemini 4 Argon");
    expect(details.textContent).toContain("Claude Code · Opus 5.5");
    expect(details.textContent).toContain("Codex · GPT-6.1 Sol");
  });
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
  for (const verdict of ["real", "pre-existing", "nit", "not-a-bug"] as const) it.each([1, 2, 3])(`states the actual tool count for unanimous ${verdict} with %s tools`, count => {
    const html = checked(ballot(Array.from({ length: count }, () => verdict)));
    expect(html).toContain(`Votes from ${count} tool${count === 1 ? "" : "s"}: ${count} `);
  });
  it("shows a two-tool split using the recorded outcome, even when a tally would decide differently", () => {
    const html = checked(ballot(["real", "pre-existing"]));
    expect(html).toContain("Checked: not a bug.");
    expect(html).toContain("Votes from 2 tools: 1 must be fixed in this change, 1 already there before this change. All 2 say the problem is real.");
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
  expect(html).toContain("Acceptance check");
  expect(html).not.toContain("Unverified check");
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
  task.journey = [{ id: "recorded-test", kind: "agent", roleId: "tester", round: 1, sub: 0, startedAt: 1, endedAt: 2,
    acceptanceChecks: [{ text: "A real session can write safely", result: "blocked", reason: "The account limit prevented a session." }],
  }];
  const html = renderToStaticMarkup(<DesignView task={task} find={lookup(state)} />);
  expect(html).toContain("Could not verify · The account limit prevented a session.");
  expect(html).toContain("Last recorded result: Could not verify");
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


it.each([false, true])("Design and Overview separate last recorded results from current verification, later Tester=%s", (later) => {
  const fixture = acceptanceFixture(true);
  const { state, task } = fixture;
  if (later) task.journey = [...task.journey!, laterTester(fixture)];
  const find = lookup(state);
  const views = [<DesignView task={task} find={find} />, <Overview task={task} state={state} find={find} onAboutNumbers={() => {}} onReadSession={() => {}} onPlan={() => {}} separateFlow />];
  for (const view of views) {
    const html = renderToStaticMarkup(view);
    expect(html).toContain(later ? "Current version partly verified" : "Current version not verified");
    expect(html.match(/Last recorded result: Passed/g)).toHaveLength(later ? 24 : 18);
    expect(html.match(/Last recorded result: Failed/g) ?? []).toHaveLength(later ? 0 : 7);
    expect(html.match(/box on/g) ?? []).toHaveLength(later ? 24 : 0);
    expect(html).toContain(later ? "New observation 24" : "Original observation 25");
    if (later) expect(html).toContain("Last recorded result: Could not verify · Account unavailable");
  }
});

it.each(["ready", "done"])("completion never fills unavailable acceptance evidence: %s", (stateName) => {
  const { state, task } = acceptanceFixture();
  task.column = "ready";
  if (stateName === "done") task.state = "done";
  delete task.journey![0]!.acceptanceChecks;
  task.acceptancePassed = true;
  const html = renderToStaticMarkup(<DesignView task={task} find={lookup(state)} />);
  expect(html).toContain("Current version not verified");
  expect(html.match(/Last recorded result: Unavailable/g)).toHaveLength(25);
  expect(html).not.toContain("box on");
});


it("both acceptance summaries show an unchanged single-product version as fully verified", () => {
  const fixture = acceptanceFixture(true);
  const { state, task } = fixture;
  const later = laterTester(fixture);
  later.acceptanceChecks = later.acceptanceChecks!.map((check) => ({ ...check, result: "pass", evidence: "Successful later probe", reason: undefined }));
  task.journey = [...task.journey!, later];
  expect(task.repository).toBeUndefined();
  const find = lookup(state);
  for (const view of [<DesignView task={task} find={find} />, <Overview task={task} state={state} find={find} onAboutNumbers={() => {}} onReadSession={() => {}} onPlan={() => {}} separateFlow />]) {
    const html = renderToStaticMarkup(view);
    expect(html).toContain("Recorded results apply to the current version");
    expect(html.match(/box on/g)).toHaveLength(25);
    expect(html.match(/Current version: Passed/g)).toHaveLength(25);
    expect(html).not.toContain("Current version not verified");
  }
});

it.each([false, true])("shows acceptance that has not run as pending, running=%s", (running) => {
  const { state, task, tester, base } = acceptanceFixture(true);
  task.journey = running ? [{ ...base, id: "running-test", kind: "agent", roleId: tester, endedAt: undefined, end: undefined }] : [];
  const find = lookup(state);
  for (const view of [<DesignView task={task} find={find} />, <Overview task={task} state={state} find={find} onAboutNumbers={() => {}} onReadSession={() => {}} onPlan={() => {}} separateFlow />]) {
    const html = renderToStaticMarkup(view);
    expect(html).toContain(running ? "Acceptance testing in progress" : "Acceptance testing not started");
    expect(html.match(running ? /Testing in progress/g : /Not tested yet/g)).toHaveLength(25);
    expect(html).not.toContain("Unavailable");
    expect(html).not.toContain("box on");
  }
});

it.each([false, true])("Overview shows Together only when shared lessons exist, lessons=%s", (lessons) => {
  const { state, task } = acceptanceFixture();
  task.repositories = [{ productId: task.productId, delivery: "local", completedStages: [] }, { productId: "second-product", delivery: "local", completedStages: [] }];
  task.sharedLessons = lessons ? [{ text: "Keep shared behavior consistent", roleId: "builder", profileId: "sol-high", at: state.now }] : [];
  const html = renderToStaticMarkup(<Overview task={task} state={state} find={lookup(state)} onAboutNumbers={() => {}} onReadSession={() => {}} onPlan={() => {}} separateFlow />);
  expect(html.includes("<h3>Together</h3>")).toBe(lessons);
  if (lessons) expect(html).toContain("Keep shared behavior consistent");
});


it("keeps missing acceptance history unavailable instead of saying testing never ran", () => {
  const { state, task } = acceptanceFixture();
  delete task.journey;
  task.state = "done";
  const html = renderToStaticMarkup(<DesignView task={task} find={lookup(state)} />);
  expect(html).toContain("Current version not verified");
  expect(html.match(/Last recorded result: Unavailable/g)).toHaveLength(25);
  expect(html).not.toContain("Not tested yet");
  expect(html).not.toContain("box on");
});
