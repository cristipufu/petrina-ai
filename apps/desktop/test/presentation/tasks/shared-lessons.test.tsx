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
import { expect, it } from "vitest";
import { Overview } from "../../../src/components/sheet/Overview";
import { lookup } from "../../../src/lib";
import { acceptanceFixture } from "../../fixtures/acceptance";

it.each([false, true])("Overview shows Together only when shared lessons exist, lessons=%s", (lessons) => {
  const { state, task } = acceptanceFixture();
  task.repositories = [{ productId: task.productId, delivery: "local", completedStages: [] }, { productId: "second-product", delivery: "local", completedStages: [] }];
  task.sharedLessons = lessons ? [{ text: "Keep shared behavior consistent", roleId: "builder", profileId: "sol-high", at: state.now }] : [];
  const html = renderToStaticMarkup(<Overview task={task} state={state} find={lookup(state)} onAboutNumbers={() => {}} onReadSession={() => {}} onPlan={() => {}} separateFlow />);
  expect(html.includes("<h3>Together</h3>")).toBe(lessons);
  if (lessons) expect(html).toContain("Keep shared behavior consistent");
});
