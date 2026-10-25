vi.mock("../../../src/notify/channels", () => {
  const unexpected = () => { throw new Error("This presentation test did not request a native notification."); };
  return { platform: () => "linux", browserPermission: () => "unsupported", useBrowserPermission: () => "unsupported", askBrowser: async () => "unsupported",
    BrowserNotices: class { show = unexpected; test = unexpected; waiting() {} },
    shell: { show: unexpected, test: unexpected, badge: unexpected, onClick: unexpected, onRelaunch: unexpected } };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: () => { throw new Error("This presentation test did not request a native desktop operation."); } }));
import { vi } from "vitest";
vi.mock("../../../src/engine", () => ({ mode: "demo", desktop: false, sim: {} }));
import { oneTaskFixture } from "../../fixtures/state";
import { expect, it } from "vitest";
import { journeyView, type State } from "@petrina/core";
import { startWords } from "../../../src/components/Journey";

const NOW = 1_000_000_000_000;

const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });

it("labels creation separately from the actual execution start", () => {
  const state = oneTaskFixture(NOW);
  const view = journeyView({ ...state.tasks[0]!, state: "cancelled", startedAt: undefined, createdAt: NOW - 7_200_000, journey: [] }, contextOf(state));
  expect(startWords(view, NOW)).toBe("Created 2h ago");
  expect(startWords({ ...view, start: { kind: "started", at: NOW - 60_000 } }, NOW)).toBe("Started 1m ago");
});
