vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: {}, useEngineStatus: () => ({ link: "live" }), useUnsent: () => [] }));
import { vi } from "vitest";
vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));
import { oneTaskFixture } from "../../fixtures/state";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DesignView } from "../../../src/components/sheet/DesignTab";
import { Overview } from "../../../src/components/sheet/Overview";
import { ReviewView } from "../../../src/components/sheet/ReviewTab";
import { lookup } from "../../../src/lib";
import { acceptanceFixture, laterTester } from "../../fixtures/acceptance";

it("labels an acceptance result that could not be checked without calling it a defect", () => {
  const state = oneTaskFixture(1_000_000_000);
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
  const state = oneTaskFixture(1_000_000_000);
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
