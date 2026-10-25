vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: {}, useEngineStatus: () => ({ link: "live" }), useUnsent: () => [] }));
import { vi } from "vitest";
vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoState } from "@petrina/core";
import { Overview } from "../../../src/components/sheet/Overview";
import { ReviewView } from "../../../src/components/sheet/ReviewTab";
import { lookup } from "../../../src/lib";

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
